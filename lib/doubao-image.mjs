/**
 * 生图 / 图生图：文生图、ImageX 上传（SigV4 签名）、无水印原图。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
/* ------------------------------------------------------------- 图片：生图 */

/** POST 提示词到豆包，返回生成的图片条目。 */
import { createHash, createHmac, randomUUID } from "node:crypto";

import { CHAT_PATH, DEFAULT_IMAGE_MODEL, DEFAULT_TIMEOUT_MS, DOUBAO_BASE, EDIT_CHAT_PATH, EXT_OF_MIME, NOWM_PATH, UA, VIDEO_BOT_ID, extractConversationId, normalizeImageModel, parseCookieHeader, safeSnippet, toRatio } from "./doubao-core.mjs";
import { THREAD_DELETE_PATH, placeholderABogus } from "./doubao-core.mjs";
import { editSecurityParams, securityParams } from "./doubao-identity.mjs";
import { downloadImage, extractImages, imageRequestBody } from "./doubao-upstream.mjs";

export async function doubaoGenerate(cookieHeader, prompt, ratio, timeoutMs, identity = {}) {
  const qs = new URLSearchParams(securityParams(identity)).toString();
  const res = await fetch(`${DOUBAO_BASE}${CHAT_PATH}?${qs}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Origin: DOUBAO_BASE,
      Referer: `${DOUBAO_BASE}/chat`,
      "Agw-Js-Conv": "str",
      Cookie: cookieHeader,
    },
    body: JSON.stringify(imageRequestBody(prompt, ratio)),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // fetch() 会自动解 chunked，这里拿到的已是解码后的 SSE 正文。
  const text = await res.text();

  if (res.status !== 200) {
    const err = new Error(`豆包生图 HTTP ${res.status}：${safeSnippet(text)}`);
    err.status = res.status;
    throw err;
  }

  const { images, gatewayError } = extractImages(text);
  if (gatewayError) {
    /*
     * 回显前必须脱敏：`gatewayError` 是上游响应正文的前 500 字符，某些网关
     * 在调试模式下会把请求头回显进响应体，届时这里就是用户的 sessionid /
     * accessToken。同文件其余错误路径都走 `safeSnippet`，只有这条漏了。
     *
     * 只脱敏「拼进 Error message 的这一份」，不动 `gatewayError` 本体 ——
     * 它还供 `looksLikeAuthFailure` 等内部判据使用。
     */
    const err = new Error(`豆包 gateway-error：${safeSnippet(gatewayError, 500)}`);
    err.gateway = true;
    throw err;
  }
  if (images.length === 0) {
    const err = new Error(`豆包未返回图片（${text.length} 字节 SSE）`);
    err.noImage = true;
    throw err;
  }
  return images;
}

/** 用豆包自家 API 把图片 key 解析成无水印 2048px 原图 URL。 */
export async function doubaoNoWatermarkUrl(cookieHeader, key, timeoutMs = 60_000) {
  const res = await fetch(`${DOUBAO_BASE}${NOWM_PATH}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: DOUBAO_BASE,
      Referer: `${DOUBAO_BASE}/chat`,
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ uri: [key] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`get_without_watermark HTTP ${res.status}`);
  const json = await res.json();
  const entry = json?.data?.download_image?.[key];
  if (!entry?.url) throw new Error(`get_without_watermark 未返回 ${key} 的 url`);
  return entry.url;
}

/**
 * 删除一个豆包会话（让生图产生的会话不留在账号的对话列表里）。
 *
 * 为什么要删：`reuseConversation` 默认关，`false` 的语义是「每次新建会话」，
 * 但**不是**「用完就删」——实测账号里会越堆越多。社区实现
 * （doubao-free-api `images.ts:423`）也是在流传输完成后立刻 `removeConversation`。
 *
 * 参数细节全部来自实测（2026-10-20，真实账号 + 3 组对照，判据是删除后用
 * `chain_by_block` 复查封 2074 创造块）：
 *   - `a_bogus` **必须带**，哪怕内容随机：服务端只校验参数存在。
 *     不带 ⇒ HTTP 200 + 空响应体，会话不动（假成功，最容易误判）。
 *   - `msToken` 无关：单独带它无效，与 a_bogus 一起也不改变结果。
 *   - `aid` 用 497858。
 *
 * 失败不抛：生图已经成功了，删会话失败不该让用户以为图没生成。调用方拿到
 * `{ok:false, reason}` 自行决定要不要提示。
 *
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string}>}
 */
export async function deleteConversation(cookieHeader, conversationId, { device, msToken, timeoutMs = 15_000 } = {}) {
  const id = normalizeConversationId(conversationId);
  if (id === "") return { ok: false, reason: "invalid-conversation-id" };
  if (typeof cookieHeader !== "string" || cookieHeader.trim() === "") {
    return { ok: false, reason: "cookie-required" };
  }

  /*
   * `editSecurityParams` 在账号没有设备身份时会**抛错**
   * （`securityParams` 里 `missing.missingDevice = true; throw missing;`）。
   * 删除是清理动作，不能因为它把已经成功的生图连坐成失败——所以这里兜住，
   * 转成普通的 ok:false。
   *
   * 谁会走到这里：手工粘贴 cookie 的账号（没有 fps/deviceId），或者生图走的
   * 是 fallbackCookie（池为空）。
   */
  let params;
  try {
    params = { ...editSecurityParams({ device, msToken }), a_bogus: placeholderABogus() };
  } catch (error) {
    return { ok: false, reason: "device-identity-missing", detail: error?.message ?? String(error) };
  }
  let res;
  try {
    res = await fetch(`${DOUBAO_BASE}${THREAD_DELETE_PATH}?${new URLSearchParams(params).toString()}`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Origin: DOUBAO_BASE,
        Referer: `${DOUBAO_BASE}/chat/${id}`,
        "Agw-Js-Conv": "str",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ conversation_id: id }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: "network-error", detail: error?.message ?? String(error) };
  }

  const text = await res.text().catch(() => "");
  if (res.status !== 200) {
    return { ok: false, reason: "http-error", detail: `HTTP ${res.status} ${safeSnippet(text)}` };
  }
  /*
   * 空响应体是**失败**，不是成功。实测：缺 a_bogus 时服务端回 200 且正文为空，
   * 会话完全没动。真正的成功会回 `{"code":0,"msg":""}`。
   * 所以这里按「解析不出 code:0 就算失败」判，而不是按 HTTP 状态码。
   */
  let json = null;
  try { json = text === "" ? null : JSON.parse(text); } catch { /* 非 JSON：下面按失败处理 */ }
  if (json === null) return { ok: false, reason: "empty-response", detail: "响应体为空（缺 a_bogus 时会这样）" };
  const code = json.code ?? json.status_code;
  if (code !== 0) return { ok: false, reason: "server-rejected", detail: `code=${code} ${json.msg ?? json.message ?? ""}`.trim() };
  return { ok: true };
}

/** 优先取无水印原图，失败则回退到 image_ori / image_raw / image_thumb。 */
export async function resolveImageBytes(cookieHeader, item, identity = {}) {
  let url;
  try {
    url = await doubaoNoWatermarkUrl(cookieHeader, item.key);
  } catch {
    url = item.image_ori?.url ?? item.image_raw?.url ?? item.image_thumb?.url;
    if (!url) throw new Error(`无法为图片 ${item.key} 解析下载地址`);
  }
  const { buf, mime } = await downloadImage(url);
  return { buf, mime, watermarkFree: url.includes("wm0") };
}

/**
 * 把豆包返回的**全部**图片条目逐张解析成字节。
 *
 * 为什么必须逐张：豆包靠 prompt 里写明张数可以一次返回多张
 * （`extractImages` 已经把 `content.data[]` 全部收进 `images`）。早期调用处
 * 只取 `items[0]`，第 2 张起全部被丢弃 —— 用户看到的就是「说要 3 张只出 1 张」。
 *
 * 逐张失败的处理：**某一张解析失败不连累整批**，那一张跳过、其余照常返回
 * （豆包的 CDN 偶尔会单张超时）。全部失败才抛错，用第一张的错误当原因，
 * 保持与旧实现的错误语义一致。
 *
 * @param {string} cookieHeader
 * @param {Array<{key: string}>} items
 * @returns {Promise<Array<{data: Buffer, mediaType: string, watermarkFree: boolean, key: string}>>}
 */
export async function resolveAllImageBytes(cookieHeader, items, identity = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) throw new Error("豆包未返回任何图片条目");

  const resolved = [];
  let firstError = null;
  for (const item of list) {
    try {
      const { buf, mime, watermarkFree } = await resolveImageBytes(cookieHeader, item, identity);
      resolved.push({ data: buf, mediaType: mime, watermarkFree, key: String(item?.key ?? "") });
    } catch (error) {
      if (firstError === null) firstError = error;
    }
  }

  if (resolved.length === 0) {
    throw firstError ?? new Error("豆包返回的图片全部解析失败");
  }
  return resolved;
}

/**
 * 文生图。
 *
 * 走新网页协议 `/chat/completion`（与图生图同一端点，仅少一个附件块）——
 * 旧 `/samantha` 通道**响应里完全不含模型字段**，写进去的模型名既不生效
 * 也不回显，无法做模型切换。
 *
 * 豆包一次可以出多张（prompt 里写明张数即可）。返回值里 `data`/`mediaType`/
 * `watermarkFree` 是**第一张**（向后兼容旧调用），`items` 是全部图片。
 *
 * @param {object} opts
 * @param {string} opts.cookieHeader  登录后的 Cookie 头
 * @param {string} opts.prompt
 * @param {string} [opts.size]        OpenAI 风格尺寸，会吸附到豆包比例
 * @param {string} [opts.model]       模型显示名（见 DOUBAO_IMAGE_MODELS）；非法值吸附默认
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{data: Buffer, mediaType: string, watermarkFree: boolean, ratio: string, requestedRatio: string, requestModel: string, actualModel: string, items: Array<{data: Buffer, mediaType: string, watermarkFree: boolean, actualRatio: string}>, count: number}>}
 */
export async function generateImage({ cookieHeader, prompt, size, model, device, msToken, conversationId, timeoutMs = DEFAULT_TIMEOUT_MS, allowBrowserFallback = true }) {
  /*
   * 设备身份与 msToken 随请求走（H3）。
   *
   * `identity` 是这一整条调用链上的唯一载体：从 Host 侧的账号对象出发，
   * 经这里传给 doubaoGenerateV2 / resolveAllImageBytes，最终进 securityParams()。
   * 中途没有任何模块级可变状态，所以并发请求不会互相污染。
   */
  const identity = { device, msToken };
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("prompt 不能为空");
  if (!parseCookieHeader(cookieHeader).sessionid) {
    throw new Error("缺少 sessionid：请先在插件设置页完成豆包登录");
  }

  /*
   * 没给 size 时用 auto 而不是硬吸附到 1:1：新协议网页端默认就是 auto，
   * 由服务端按提示词自己取景，比强行 1:1 更贴近用户意图。
   */
  const requestedRatio = typeof size === "string" && size.trim() !== "" ? toRatio(size) : "auto";
  const requestModel = normalizeImageModel(model);

  const result = await doubaoGenerateV2(cookieHeader, text, timeoutMs, requestedRatio, requestModel, identity, conversationId, { allowBrowserFallback });
  const imagesV2 = result.images;
  const resolved = await resolveAllImageBytes(cookieHeader, imagesV2, identity);
  const ratioByKey = new Map(imagesV2.map((item) => [item.key, item.actualRatio]));
  const items = resolved.map((item) => ({ ...item, actualRatio: ratioByKey.get(item.key) ?? "" }));
  const first = items[0];
  return {
    // 向后兼容：旧调用只读这三个字段。
    data: first.data,
    mediaType: first.mediaType,
    watermarkFree: first.watermarkFree,
    ratio: first.actualRatio || requestedRatio,
    requestedRatio,
    requestModel,
    actualModel: result.modelEcho ?? "",
    items,
    count: items.length,
    /*
     * 实际会话 id：新建时会带回服务端分配的 id，复用时会回传传入的那个。
     * 上层据此把它记到账号上，下一次生图就能继续复用同一个会话，
     * 而不是每张图都在账号里留一个新会话。
     */
    conversationId: normalizeConversationId(result.conversationId) || normalizeConversationId(conversationId),
  };
}

/* ------------------------------------------------------- 图片：ImageX 上传 */

const IMAGEX_REGION = "cn-north-1";
const IMAGEX_SERVICE = "imagex";

/* ---------------------------------------------------- SigV4（AWS4 变体） */

const sha256hex = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (key, d) => createHmac("sha256", key).update(d).digest();
const encRfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export const canonicalQuery = (params) =>
  Object.keys(params).sort().map((k) => `${encRfc3986(k)}=${encRfc3986(String(params[k]))}`).join("&");

const SIGV4_EXCLUDED = [
  "authorization", "content-type", "content-length", "user-agent",
  "presigned-expires", "expect", "x-amzn-trace-id",
];

/**
 * 给 ImageX 请求签名。
 *
 * 注意这是 AWS4 变体（AWS4-HMAC-SHA256、X-Amz-Date、scope
 * `<date>/<region>/<service>/aws4_request`），尽管服务是火山引擎：
 * 上游 SDK 构造签名器时没传第三个 isVolcengine 参数，所以火山变体从未生效。
 * 照抄这一行为，否则 UploadAddress 请求会被拒。
 */
export function signImagex({ method, path, params, headers, body, creds }) {
  const xDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:\-]/g, "");
  const shortDate = xDate.slice(0, 8);

  const h = { ...headers, "X-Amz-Date": xDate };
  if (creds.sessionToken) h["x-amz-security-token"] = creds.sessionToken;
  const bodyStr = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  if (body !== undefined) h["X-Amz-Content-Sha256"] = sha256hex(bodyStr);

  const signable = (k) => k.startsWith("x-amz-") || !SIGV4_EXCLUDED.includes(k);
  const names = Object.keys(h).map((k) => k.toLowerCase()).filter(signable).sort();
  const canonicalHeaders =
    names
      .map((k) => {
        const real = Object.keys(h).find((x) => x.toLowerCase() === k);
        return `${k}:${String(h[real]).replace(/\s+/g, " ").trim()}`;
      })
      .join("\n") + "\n";

  const canonicalRequest = [
    method.toUpperCase(),
    path || "/",
    canonicalQuery(params),
    canonicalHeaders,
    names.join(";"),
    sha256hex(bodyStr),
  ].join("\n");

  const scope = `${shortDate}/${IMAGEX_REGION}/${IMAGEX_SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", xDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + creds.secretAccessKey, shortDate);
  const kSigning = hmac(hmac(hmac(kDate, IMAGEX_REGION), IMAGEX_SERVICE), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...h,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

async function doubaoPostJson(cookieHeader, path, body, timeoutMs = 60_000, identity = {}) {
  const res = await fetch(`${DOUBAO_BASE}${path}?${new URLSearchParams(securityParams(identity))}`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: DOUBAO_BASE,
      Referer: `${DOUBAO_BASE}/chat`,
      Cookie: cookieHeader,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** 把原始字节上传进豆包资源系统，返回资源 key。 */
export async function uploadToDoubao(cookieHeader, buf, ext, identity = {}) {
  /*
   * `identity` 必须显式传给 `doubaoPostJson`（它是第 5 个参数）。
   *
   * 2026-10-22 实测：这里原先只传了前 3 个参数，`identity` 落到默认值 `{}`，
   * 于是 `securityParams({})` 里 `normalizeDevice(undefined) ?? currentDevice(null)`
   * 拿不到任何设备身份 → 抛「尚未导入设备身份」。
   *
   * 后果是**图生图整条链路必失败**，而文生图正常（它不上传参考图、不走这里）。
   * 这个缺陷在纯文生图验收下完全看不出来——用户看到的报错还把原因指向了
   * 凭据缺失，实际凭据一直好好的。
   */
  const prep = await doubaoPostJson(cookieHeader, "/alice/resource/prepare_upload", {
    tenant_id: "5",
    scene_id: "5",
    resource_type: 1,
  }, undefined, identity);
  const d = prep.json?.data;
  if (!d?.upload_auth_token) {
    throw new Error(`豆包 prepare_upload 失败：${JSON.stringify(prep.json).slice(0, 200)}`);
  }
  const creds = {
    accessKeyId: d.upload_auth_token.access_key,
    secretAccessKey: d.upload_auth_token.secret_key,
    sessionToken: d.upload_auth_token.session_token,
  };
  const host = d.upload_host;
  const serviceId = d.service_id;
  const storeKey = `${d.upload_path_prefix}/${randomUUID().replace(/-/g, "")}${ext}`;

  const params = {
    Action: "ApplyImageUpload",
    Version: "2018-08-01",
    ServiceId: serviceId,
    NeedFallback: "true",
    FileSize: String(buf.length),
    FileExtension: ext,
    StoreKeys: storeKey,
    s: Math.random().toString(36).slice(2),
  };
  const headers = signImagex({
    method: "GET", path: "/", params, headers: { Host: host },
    body: undefined, creds,
  });
  const apply = await fetch(`https://${host}/?${canonicalQuery(params)}`, {
    method: "GET",
    headers: { ...headers, "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const applyText = await apply.text();
  if (apply.status !== 200) {
    throw new Error(`ApplyImageUpload HTTP ${apply.status}：${safeSnippet(applyText)}`);
  }
  const address = JSON.parse(applyText).Result.UploadAddress;
  const info = address.StoreInfos[0];

  const put = await fetch(`https://${address.UploadHosts[0]}/${info.StoreUri}`, {
    method: "PUT",
    headers: {
      Authorization: info.Auth,
      "Content-CRC32": "ignore",
      "Content-Type": "application/octet-stream",
      "User-Agent": UA,
    },
    body: buf,
    signal: AbortSignal.timeout(180_000),
  });
  if (!put.ok) {
    throw new Error(`参考图上传 PUT HTTP ${put.status}：${(await put.text()).slice(0, 200)}`);
  }

  const cparams = {
    Action: "CommitImageUpload",
    Version: "2018-08-01",
    ServiceId: serviceId,
    s: Math.random().toString(36).slice(2),
  };
  const cbody = { SessionKey: address.SessionKey, SuccessOids: [info.StoreUri] };
  const cheaders = signImagex({
    method: "POST", path: "/", params: cparams,
    headers: { Host: host, "Content-Type": "application/json" },
    body: cbody, creds,
  });
  const commit = await fetch(`https://${host}/?${canonicalQuery(cparams)}`, {
    method: "POST",
    headers: { ...cheaders, "User-Agent": UA },
    body: JSON.stringify(cbody),
    signal: AbortSignal.timeout(60_000),
  });
  const commitText = await commit.text();
  if (commit.status !== 200) {
    throw new Error(`CommitImageUpload HTTP ${commit.status}：${safeSnippet(commitText)}`);
  }
  const result = JSON.parse(commitText)?.Result;
  const committed = result?.Results?.[0];
  const plugin = result?.PluginResult?.[0];
  // 参照真机已验证的 image-bridge 实现：Commit 结果零校验也能出图，真实环境
  // 常见 UriStatus=2001、PluginResult 全零等形态。因此不抛错，改为逐项降级，
  // 每个降级点把实际值记进 meta.notes，便于真机再失败时定位具体字段。
  const notes = [];
  const uriFromResult = typeof committed?.Uri === "string" && committed.Uri ? committed.Uri : "";
  const storeUri = typeof committed?.StoreUri === "string" && committed.StoreUri
    ? committed.StoreUri : "";
  if (committed?.UriStatus !== 2000) {
    notes.push(`UriStatus=${JSON.stringify(committed?.UriStatus ?? null)}`);
  }
  if (plugin?.NotFound === true) notes.push("NotFound=true");
  let uri = uriFromResult;
  if (!uri && storeUri) {
    uri = storeUri;
    notes.push(`Uri 缺失，回退 StoreUri=${storeUri}`);
  }
  if (!uri) {
    throw new Error(`豆包 CommitImageUpload 未返回可用 Uri/StoreUri：${safeSnippet(commitText)}`);
  }
  const dimension = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  const width = dimension(plugin?.ImageWidth);
  const height = dimension(plugin?.ImageHeight);
  if (width === 0) notes.push(`ImageWidth=${JSON.stringify(plugin?.ImageWidth ?? null)}→0`);
  if (height === 0) notes.push(`ImageHeight=${JSON.stringify(plugin?.ImageHeight ?? null)}→0`);
  const fallbackFormat = ext.replace(/^\./, "") || "png";
  const format = typeof plugin?.ImageFormat === "string" && /^[a-z0-9]{2,8}$/i.test(plugin.ImageFormat)
    ? plugin.ImageFormat
    : fallbackFormat;
  if (format !== plugin?.ImageFormat) {
    notes.push(`ImageFormat=${JSON.stringify(plugin?.ImageFormat ?? null)} 回退 ${format}`);
  }
  return { uri, meta: { width, height, format, notes } };
}

/** 让豆包基于已上传的参考图改图。 */
export async function doubaoEdit(cookieHeader, prompt, ratio, referenceKeys, timeoutMs, identity = {}) {
  const attachments = referenceKeys.map((uri) => ({
    type: 1,
    identifier: randomUUID(),
    image: {
      name: "",
      uri,
      image_ori: { url: "", width: 0, height: 0, format: "", url_formats: {} },
    },
    parse_state: 1,
    review_state: 1,
    upload_status: 1,
    progress: 100,
    src: "",
  }));
  const block = {
    block_type: 10052,
    content: { attachment_block: { attachments, pc_event_block: "" } },
    block_id: "",
    parent_id: "",
    meta_info: [],
    append_fields: [],
  };

  const body = imageRequestBody(prompt, ratio);
  body.messages[0].content_blocks_v2 = [block];

  const res = await fetch(
    `${DOUBAO_BASE}${CHAT_PATH}?${new URLSearchParams(securityParams(identity))}`,
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Origin: DOUBAO_BASE,
        Referer: `${DOUBAO_BASE}/chat`,
        "Agw-Js-Conv": "str",
        Cookie: cookieHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  const text = await res.text();
  if (res.status !== 200) {
    const err = new Error(`豆包改图 HTTP ${res.status}：${safeSnippet(text)}`);
    err.status = res.status;
    throw err;
  }
  const { images, gatewayError } = extractImages(text);
  if (gatewayError) {
    // 同上：回显给用户/日志前脱敏，`gatewayError` 本体保持原样供内部判据用。
    const err = new Error(`豆包 gateway-error：${safeSnippet(gatewayError, 500)}`);
    err.gateway = true;
    throw err;
  }
  if (images.length === 0) {
    const err = new Error(`豆包未返回改图结果（${text.length} 字节 SSE）`);
    err.noImage = true;
    throw err;
  }
  return images;
}

/**
 * 由像素尺寸推一个可读的比例标签。
 *
 * 只报**能确认的**几档（1:1 / 4:3 / 3:4 / 16:9 / 9:16 / 3:2 / 2:3），
 * 容差 2%；都不是就退回 `宽x高` 原样——宁可给一个精确但陌生的字符串，
 * 也不要硬套一个更"好看"的错误档位。
 *
 * @param {number} width
 * @param {number} height
 * @returns {string} 比例标签；缺尺寸时返回空串
 */
export function ratioLabel(width, height) {
  if (!(width > 0) || !(height > 0)) return "";
  const actual = width / height;
  const candidates = [
    ["1:1", 1], ["4:3", 4 / 3], ["3:4", 3 / 4], ["16:9", 16 / 9],
    ["9:16", 9 / 16], ["3:2", 3 / 2], ["2:3", 2 / 3],
  ];
  for (const [label, target] of candidates) {
    if (Math.abs(actual - target) / target < 0.02) return label;
  }
  return `${width}x${height}`;
}

/**
 * 画幅比例白名单；网页端抓包已证实 `ability_param` 内有 ratio 字段。
 *
 * **重要：这个参数是「建议」不是「命令」。** 实测（2026-10-17，真实账号）：
 * 网页端自己请求 `ratio: "9:16"` 并成功出图，落盘图片的真实像素却是
 * 1728x2304（3:4）——服务端按画面内容取景，不保证给出请求的画幅。
 * 我们用 `1:1` / `16:9` 请求时同样拿到 1728x2304。
 *
 * 所以：
 *   - 不要向用户承诺「选了 9:16 就一定得到 9:16」
 *   - 任何「实际比例」都必须从图片字节量，不能拿 `gen_params.ratio` 当答案
 */
const EDIT_RATIOS = ["auto", "1:1", "4:3", "16:9", "9:16", "2:3", "3:4", "3:2"];

/** 非法或缺省的比例吸附为 auto，绝不把未证实值发给真实端点。 */
function normalizeEditRatio(ratio) {
  return EDIT_RATIOS.includes(ratio) ? ratio : "auto";
}

/**
 * 归一化「固定会话 id」。
 *
 * 只接受纯数字串（豆包会话 id 的实际形状，见 probe-list-conversations 的实测输出）。
 * 其它任何值一律当「没有」——绝不把可疑串发进请求体。
 */
export function normalizeConversationId(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return /^\d{6,}$/.test(text) ? text : "";
}

export function editRequestBodyV2(prompt, refFiles, ratio = "auto", model = DEFAULT_IMAGE_MODEL, conversationId = "") {
  /*
   * `local_conversation_id` 必须**每次调用都唯一**。
   *
   * 原来的 `local_${Date.now()}` 只有毫秒精度：同一毫秒内构造两次会撞出
   * 完全相同的 id。这不是理论问题——浏览器兜底会在 `postChatV2` 之后再构造
   * 一次 body（`tryBrowserFallback`），而服务端把「同一个 local_conversation_id
   * 再来一次」判成重放请求，回 `710020702 system error, extra:{is_replay:"true"}`，
   * 于是兜底静默失效（代码注释里记着这条实测，但 id 生成没跟上）。
   *
   * 加随机后缀后唯一性由 `randomUUID` 保证，与时间无关。
   * 保留 `local_` 前缀与时间戳，是为了让 id 仍然可读、可排序（排查时有用）。
   */
  const id = `local_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const block = (type, content) => ({
    block_type: type, content, block_id: randomUUID(), parent_id: "",
    meta_info: [], extra_info: {}, append_fields: [],
  });
  const attachments = refFiles.map(({ uri, meta }, index) => ({
    type: 1, identifier: randomUUID(),
    // 调用入口只有图片字节与 MIME，没有原始文件名；不可声称保留原名。
    name: `reference-${index + 1}.${meta.format.toLowerCase()}`,
    image: {
      uri, name: `reference-${index + 1}.${meta.format.toLowerCase()}`,
      image_ori: { url: "", width: meta.width, height: meta.height,
        format: meta.format.toLowerCase(), url_formats: {} },
    },
    parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: "",
  }));
  const makeMessage = (contentBlock) => ({
    local_message_id: randomUUID(), content_block: [contentBlock], message_status: 0,
    extra_info: {},
  });
  const messages = [];
  /*
   * 文生图也是这个端点：抓包证实无参考图时 messages **只有文本块**，
   * 少一个 10052 附件块。空数组仍塞一个空 attachment_block 会让服务端
   * 按「图生图但没图」处理，所以这里要整条省掉而不是留空块。
   */
  if (attachments.length > 0) {
    messages.push(makeMessage(block(10052, { attachment_block: { attachments, pc_event_block: "" } })));
  }
  messages.push(makeMessage(block(10000, { text_block: {
    text: prompt, icon_url: "", icon_url_dark: "", summary: "",
  }, pc_event_block: "" })));
  const generalTask = { server_do_compare: true };
  const conversationInit = { need_ack_conversation: true };
  /*
   * 固定会话：把生图发到**已存在**的会话里，而不是每次新建。
   *
   * 实测（2026-10-19）：
   *   - `conversation_id: "<已有>"` + `need_create_conversation: false`
   *     → 服务端接受，图正常出，SSE 回的会话 id 与传入的一致，**不新建会话**。
   *   - `conversation_id: ""` + `need_create_conversation: false`
   *     → 服务端**仍然新建**会话（实测）。
   *   所以「零会话」不可行，只能复用。
   *
   * 复用后账号里最多留 1 个生图会话，不必删任何东西——这是比「删得快」更干净的
   * 不留痕方向（删除本身会在服务端留下操作记录）。
   *
   * `local_conversation_id` 仍必须每次唯一：服务端按它判重放。
   */
  const reuseId = normalizeConversationId(conversationId);
  return {
    client_meta: {
      local_conversation_id: id, conversation_id: reuseId, bot_id: VIDEO_BOT_ID,
      last_section_id: "", last_message_index: null,
      local_permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION"].map((permission_name) => ({ permission_name, status: 3 })),
    },
    messages,
    option: {
      send_message_scene: "", create_time_ms: Date.now(), collect_id: randomUUID(),
      unique_key: randomUUID(), is_regen: false,
      need_create_conversation: reuseId === "",
      conversation_init_option: reuseId === "" ? conversationInit : {},
      model_config: { model_item_key: "", model_extra_params: {} },
      aggregate_params: {
        mention_skill_list: "[]", mention_plugin_list: "[]", mention_ext: "[{}]",
        conversation_mode: "1", mode_id: "", model_item_key: "", agent_mode: "",
        reasoning_effort: "", provider_id: "",
      },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true, message_from: 0,
      general_task_param: generalTask,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0 },
      is_old_user: true,
    },
    chat_ability: {
      ability_type: 3,
      ability_param: JSON.stringify({ ability_type: 1, ability_param: {
        model: normalizeImageModel(model), ratio: normalizeEditRatio(ratio),
        input_box_content: { user_input_content: prompt, reply_message_format: "生成图片：%s" },
      } }),
    },
    ext: {
      answer_with_suggest: "0", sub_conv_firstmet_type: "1",
      general_task_param: JSON.stringify(generalTask), collection_id: "", is_finish: "1",
      conversation_init_option: JSON.stringify(conversationInit), commerce_credit_config_enable: "0",
    },
  };
}

/**
 * 从 STREAM_ERROR 的 `extra.decision` 里读出风控决策类型。
 *
 * 结构是**双层转义**：`extra.decision` 是一个 JSON **字符串**，parse 之后
 * 里面的 `detail` 又是一层。实测样本：
 *   {"code":"10000","from":"shark_admin","type":"verify",
 *    "subtype":"semantic_reasoning","verify_scene":"doubao_message_web"}
 * `type=verify` 就是「必须人工过验证」，与普通限速不同。
 *
 * 解析失败一律返回空串——诊断信息不该让正常流程抛错。
 */
function readVerifyType(data) {
  const decision = data?.extra?.decision;
  if (typeof decision !== "string" || decision === "") return "";
  try {
    return String(JSON.parse(decision)?.type ?? "");
  } catch {
    return "";
  }
}

/** 只识别新网页协议的完成图片；两级 finish 均到达才可交付。 */
export function extractImagesV2(sseBody) {
  const images = new Map();
  let messageFinished = false;
  let answerFinished = false;
  let gatewayError = null;
  const failures = [];
  /*
   * 文字回复块（block_type 10000 等非 2074 块）的文本。
   *
   * 为什么要收：豆包生成失败时不总是给 `fail_code`——它常常**只回一句
   * 自然语言**（实测：「出了点问题，请稍后重试。」）。原实现 `continue`
   * 掉了所有非 2074 块，于是失败时只能报「未返回改图结果（无 status:2
   * 图片）」，对排查毫无价值。
   */
  const textBlocks = [];
  /** 服务端回报的模型显示名（`placeholder.description`），用于证明切换真的生效。 */
  const modelEchoes = [];
  /** 首条结构化流错误的 code / message（见上方赋值处的说明）。 */
  let streamErrorCode = "";
  let streamErrorMessage = "";
  /** 风控决策类型：`"verify"` 表示需要人工过验证码，空串表示不是风控。 */
  let streamVerifyType = "";
  for (const frame of sseBody.split(/\r?\n\r?\n/)) {
    const event = /^event:\s*(\S+)/m.exec(frame)?.[1];
    const raw = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!raw) continue;
    let data;
    try { data = JSON.parse(raw); } catch { continue; }
    if (event === "gateway-error" || event === "STREAM_ERROR" || data?.event_type === 2005) {
      gatewayError = JSON.stringify(data).slice(0, 500);
      /*
       * 单独留下结构化错误码/原因：`gatewayError` 是整段 JSON，塞进报错里
       * 用户只能看到一堆转义引号。实测最常见的两条是
       *   710012000 user invalid（登录失效）
       *   710022004 rate limited（**实为人机校验**，见 verifyType）
       * 上层要按 code 给出可操作的一句话，而不是让用户去读 JSON。
       */
      if (streamErrorCode === "") {
        streamErrorCode = String(data?.error_code ?? data?.code ?? "");
        streamErrorMessage = String(data?.error_msg ?? data?.message ?? "");
        streamVerifyType = readVerifyType(data);
      }
      continue;
    }
    if (event === "SSE_REPLY_END") {
      if (data.end_type === 1) messageFinished = true;
      if (data.end_type === 2) answerFinished = true;
    }
    if (event !== "STREAM_CHUNK") continue;
    /*
     * 模型回显：生成占位块里带 `placeholder.description`，值为本次实际使用的
     * 模型显示名（实测 "Seedream 4.5" / "Seedream 5.0 Flash"）。整帧文本搜即可——
     * 位置随块类型浮动，逐层找反而脆。
     */
    for (const hit of raw.matchAll(/"description"\s*:\s*"([^"]{1,64})"/g)) {
      if (/^Seedream\b/.test(hit[1])) modelEchoes.push(hit[1]);
    }
    for (const patch of data.patch_op ?? []) {
      if (patch?.patch_object !== 1) continue;
      for (const entry of patch.patch_value?.content_block ?? []) {
        if (entry?.block_type !== 2074) {
          // 非创造块：榨出可读文字（失败原因常在这里），不要整块丢弃。
          const text = blockPlainText(entry?.content);
          if (text) textBlocks.push(text);
          continue;
        }
        for (const creation of entry.content?.creation_block?.creations ?? []) {
          const image = creation?.image;
          /*
           * 失败信号的四个来源，缺一不可：
           *   image.tips / image.fail_code  —— 图片级
           *   creation.fail_code / creation.fail_msg —— 创造块级
           * 原实现漏了 `creation.fail_msg`，而实测错误详情恰恰写在那里。
           */
          const parts = [];
          if (image?.tips) parts.push(`tips=${image.tips}`);
          if (image?.fail_code) parts.push(`image.fail_code=${image.fail_code}`);
          if (creation?.fail_code) parts.push(`creation.fail_code=${creation.fail_code}`);
          if (creation?.fail_msg) parts.push(`creation.fail_msg=${creation.fail_msg}`);
          if (parts.length) failures.push(parts.join(" "));
          if (image?.status === 2 && typeof image.key === "string" && image.key) {
            /*
             * 流里同一张图可能反复 patch；以 key 去重。
             *
             * 尺寸来源（实测 2026-10-17，完整 SSE）：
             *   `image.placeholder` 带 `{width, height}`，与最终落盘像素一致，
             *   是最可信的一个；`image_ori` 给的是另一档尺寸（可能更大），
             *   只能当后备。
             *
             * 注意 `gen_params` 在 **`image` 里**，不是 `creation` 顶层——
             * 原实现读 `creation.gen_params` 永远拿到空串，于是上层只能拿
             * 请求值冒充实际比例（`ratio: actualRatio || requestedRatio`）。
             * 这里一并修正，并把从像素推出来的比例单独记成 `actualRatio`。
             */
            const placeholder = image.placeholder && typeof image.placeholder === "object" ? image.placeholder : {};
            const wide = Number(placeholder.width) || Number(image.image_ori?.width) || 0;
            const tall = Number(placeholder.height) || Number(image.image_ori?.height) || 0;
            const pixelRatio = ratioLabel(wide, tall);
            const requestedEcho = typeof image.gen_params?.ratio === "string" ? image.gen_params.ratio : "";
            images.set(image.key, {
              ...image,
              // 只有量得出像素时才敢说「实际比例」；量不出来就留空，绝不拿请求值顶替。
              actualRatio: pixelRatio,
              width: wide || undefined,
              height: tall || undefined,
              // 服务端回显的 gen_params.ratio（请求值副本），仅供排查。
              echoedRatio: requestedEcho,
            });
          }
        }
      }
    }
  }
  return {
    images: [...images.values()], messageFinished, answerFinished, gatewayError, failures, textBlocks,
    /** 服务端回报的实际模型名（去重）；为空表示服务端没回显。 */
    modelEcho: [...new Set(modelEchoes)].join(", "),
    /** 结构化流错误：`{code, message}`，空串表示没有。 */
    errorCode: streamErrorCode,
    errorMessage: streamErrorMessage,
    /** 风控决策类型（`"verify"` = 需要人工过验证）。 */
    verifyType: streamVerifyType,
    /** 豆包自己对本次生成的说明（失败原因通常在这里），已去重去空。 */
    replyText: [...new Set(textBlocks.filter((t) => t.trim() !== ""))].join(" / "),
  };
}

/**
 * 从块的 content 里榨出可读文字。
 *
 * 结构随块类型而变（字符串 / `{text}` / 嵌套对象），所以按常见字段逐个试，
 * 并递归一层。取不到就返回空串——**不抛错**，一个不认识的块不该拖垮整次解析。
 */
function blockPlainText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  for (const key of ["text", "content", "value", "message", "answer", "desc"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = blockPlainText(value);
      if (nested) return nested;
    }
  }
  return "";
}

/**
 * 发一次新网页协议请求，返回解析后的完整结果（不在这里判成败）。
 *
 * 文生图与图生图**是同一个端点**：抓包证实唯一区别是 messages 里有没有
 * 10052 附件块（`refFiles` 为空即文生图）。合并成一条通道，
 * 模型、比例、失败诊断只有一份实现，不会两边漂移。
 *
 * @param {string} kind 仅用于报错文案（"生图" / "改图"）
 */
/**
 * 被风控拦下时，改在真实浏览器里重发一次。
 *
 * 返回**重新解析后的**结果；任何失败都返回 null，让调用方接着走原来的报错路径 ——
 * 兜底本身绝不能把「新增一条失败路径」变成「改变原有语义」。
 *
 * 动态 import：浏览器模块只在真被风控时才加载，正常出图的用户不承担这部分开销。
 */
async function tryBrowserFallback({ cookieHeader, prompt, refFiles, ratio, model, identity, conversationId = "" }) {
  try {
    const { fetchViaBrowser } = await import("./browser-image.mjs");
    /*
     * **必须重新构造 body**，不能复用直连那一份。
     *
     * 实测（2026-10-18）：复用同一份 body 重发，服务端回
     *   `710020702 system error, extra:{is_replay:"true"}`
     * —— `local_conversation_id` / `local_message_id` 是随机 UUID，
     * 同一个 body 再发一次会被当成重放请求直接拒掉。
     */
    const retryBody = editRequestBodyV2(prompt, refFiles, ratio, model, conversationId);
    const retryQuery = new URLSearchParams(editSecurityParams(identity)).toString();
    const r = await fetchViaBrowser({ cookieHeader, body: JSON.stringify(retryBody), query: retryQuery });
    if (process.env.DBI_DEBUG_FALLBACK) {
      console.log(`[fallback] ok=${r.ok} status=${r.status} ms=${r.ms} message=${r.message ?? ""} textLen=${r.text?.length ?? 0}`);
    }
    if (!r.ok || r.status !== 200) return null;
    const retried = extractImagesV2(r.text);
    if (process.env.DBI_DEBUG_FALLBACK) {
      console.log(`[fallback] 重解析: images=${retried.images.length} gatewayError=${retried.gatewayError?.slice(0, 160)}`);
    }
    // 只有真的拿到图才算兜底成功；没图就当没发生过，让原错误照常抛出。
    return retried.images.length > 0 ? retried : null;
  } catch (e) {
    if (process.env.DBI_DEBUG_FALLBACK) console.log(`[fallback] 异常: ${e.message}`);
    return null;
  }
}

async function postChatV2(kind, cookieHeader, prompt, refFiles, timeoutMs, ratio, model, identity = {}, conversationId = "", options = {}) {
  /*
   * 是否允许「被风控时起真浏览器重发」。
   *
   * 调用方按「还有没有别的账号可换」决定：起一次浏览器要 10~20 秒，
   * 换号是毫秒级。池里还有账号时先换号，全部账号都被风控了才起浏览器 ——
   * 否则单号 verify 就会白起一次浏览器，而下一个号可能直接成功。
   *
   * 默认 true：没有账号池的调用方（单 cookie）本来就没有「换号」这条路，
   * 浏览器兜底是它唯一的自救手段，不能被默认值关掉。
   */
  const { allowBrowserFallback = true } = options;
  const body = editRequestBodyV2(prompt, refFiles, ratio, model, conversationId);
  const query = new URLSearchParams(editSecurityParams(identity)).toString();
  const res = await fetch(`${DOUBAO_BASE}${EDIT_CHAT_PATH}?${query}`, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/json", Accept: "text/event-stream",
      Origin: DOUBAO_BASE, Referer: `${DOUBAO_BASE}/chat/${body.client_meta.local_conversation_id}`,
      "Agw-Js-Conv": "str", Cookie: cookieHeader,
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status !== 200) {
    const err = new Error(`豆包${kind} HTTP ${res.status}：${safeSnippet(text)}`);
    err.status = res.status;
    throw err;
  }
  let result = extractImagesV2(text);

  /*
   * 风控兜底（2026-10-18 实证）。
   *
   * `710022004 + type=verify` 不是「等一会儿就好」的限速：实测该账号在 Node 直连下
   * 稳定 330~400ms 秒回 1053 字节，而**同一个请求体在浏览器页面里发，20 多秒跑完并出图**。
   * 已排除 a_bogus、请求头、出口 IP、HTTP 协议 —— 风控认的是「请求是否真的来自浏览器」，
   * 这一层在 Node 里伪造不出来。
   *
   * 所以这里不直接抛错，先在真实浏览器里重发一次；成功就继续走原流程（下游只认
   * `extractImagesV2` 的返回结构，不感知请求是从哪条路发的）。
   *
   * 图生图也走同一条兜底（2026-10-18 验证）：`refFiles[].uri` 是豆包 ImageX 的
   * 对象 key（`uploadToDoubao` 里 CommitImageUpload 返回的 StoreUri），
   * **上传在 postChatV2 之前就已完成**，请求体只是把现成的 uri 拼进 attachment_block。
   * 所以浏览器兜底复用同一个 uri 即可，不需要在页面里重新上传。
   */
  if (result.gatewayError && result.verifyType === "verify" && allowBrowserFallback) {
    const fallback = await tryBrowserFallback({ cookieHeader, prompt, refFiles, ratio, model, identity, conversationId });
    if (fallback) result = fallback;
  }
  if (result.gatewayError) {
    /*
     * 把结构化 code 翻译成一句能指导动作的话。
     *
     * 实测 710022004 的 `error_msg` 写的是 "rate limited"，但 `extra.decision`
     * 里 `type=verify / subtype=semantic_reasoning`——**这是人机校验，不是限速**。
     * 2026-10-17 实测：触发后纯 HTTP 等了两小时仍未恢复，说「等几分钟」
     * 会把用户引到错误的方向。真正的解法是去网页端过一次验证再回来。
     */
    const code = result.errorCode;
    const reason = result.errorMessage;
    /*
     * 是否真的被人机校验拦下，看 `verifyType`，不靠错误文案猜：
     *   - `710022004` + type=verify  ← 人机校验，纯 HTTP 解不开，要去网页端过验证
     *   - `710022002` 无 decision    ← 频率限制，等几分钟即可
     * 两者文案都是「频繁/稍后重试」，但解法完全不同，混起来会把人带错方向。
     *
     * 触发 verify 的已测原因（2026-10-17）：
     *   - 自造 `msToken`（服务端校验真伪，假串比不传更糟）
     *   - 复用别的请求的 `a_bogus`（签名与具体请求绑定）
     */
    const needHumanVerify = result.verifyType === "verify";
    const hint = needHumanVerify
      ? "豆包触发了人机校验（风控），纯 HTTP 无法自行解除：请到 doubao.com 网页端随便发一次生图、按提示完成验证，再回来重试"
      : code === "710022002" || /访问频繁|too many|rate limit/i.test(reason)
        ? "豆包限流了（短时间内请求过多），等几分钟再试"
        : code === "710012000" || /user invalid/i.test(reason)
          ? "豆包登录已失效，请在设置页重新扫码登录"
          : reason || "服务端返回了错误事件";
    const err = new Error(`豆包${kind}失败：${hint}（code=${code || "?"}）`);
    err.gateway = true;
    /*
     * 保留原始串：排查时仍需要它，但不再是给用户看的第一句话。
     *
     * **必须过 `safeSnippet`**：这个属性会随错误对象一路冒到工具的
     * 返回值和会话历史里，等于第二遍回显。网关在调试模式下会把请求头
     * 回显进响应体（`doubao-core.mjs` 的 `scrubSensitiveLines` 注释记了
     * 这条已观测行为），届时 `Cookie` / `Authorization` 就在这段正文里。
     */
    err.gatewayDetail = safeSnippet(result.gatewayError, 500);
    err.errorCode = code;
    err.needsHumanVerify = needHumanVerify;
    throw err;
  }
  if (!result.messageFinished || !result.answerFinished) {
    const incomplete = new Error(`豆包${kind}响应未正常完成（缺少消息或回答结束事件）`);
    /*
     * 打上结构化标志，供 index.js 的 isDoubaoSwitchable 判定「值得换个账号再试」。
     *
     * 账号失效（sessionid 无效）时豆包不返回 710012000，而是回这种空响应。
     * 不带标志的话，池里一个坏账号就能让后面所有好账号都没机会出图。
     */
    incomplete.incompleteReply = true;
    throw incomplete;
  }
  if (!result.images.length) {
    /*
     * 报错必须能指向原因，不能只说「没图」。
     *
     * 优先级：豆包自己的文字说明 > 结构化失败字段。实测失败时服务端常常
     * **只回一句自然语言**（「出了点问题，请稍后重试。」/ 订阅墙提示），
     * 此时结构化字段全为空——旧写法在这种情况下只会报「无 status:2 图片」。
     */
    /*
     * 拼进错误消息的两段都过 `safeSnippet`。
     *
     * `replyText` 是服务端原样回的自然语言，`failures` 是结构化失败字段
     * 拼出来的串——两者都可能夹带上游回显的请求头（见 `scrubSensitiveLines`
     * 注释）。这里截 300 而不是 500：它们要出现在给用户看的第一句话里，
     * 留太长会把真正的原因挤到屏幕外。
     */
    const detail = [
      result.replyText ? `豆包回复「${safeSnippet(result.replyText, 300)}」` : "",
      result.failures.length ? `失败字段：${result.failures.map((f) => safeSnippet(f, 300)).join("; ")}` : "",
    ].filter(Boolean).join("；");
    const err = new Error(`豆包未返回${kind}结果（${detail || "无 status:2 图片，且无失败说明"}）`);
    err.noImage = true;
    /*
     * 供上层区分「服务端明确拒绝」与「协议静默失效」。
     *
     * 挂到错误对象上同样算一次回显通道（工具返回值 / 会话历史），
     * 所以这里存的也是脱敏后的副本，不是原始串。
     */
    err.replyText = safeSnippet(result.replyText, 300);
    err.failures = result.failures.map((f) => safeSnippet(f, 300));
    err.requestModel = normalizeImageModel(model);
    throw err;
  }
  /*
   * 把「服务端实际使用的会话 id」一并带出。
   *
   * 复用请求时服务端原样回传传入的 id；新建时回传它新分配的 id。
   * 上层拿它写回账号，下一次就能继续复用同一个会话 —— 不再每张图都留一个会话。
   * `conversationId` 字段名与 `generateImage` 的返回值保持一致，避免两套叫法。
   */
  result.conversationId = extractConversationId(text) ?? normalizeConversationId(conversationId);
  return result;
}

export async function doubaoEditV2(cookieHeader, prompt, refFiles, timeoutMs, ratio = "auto", model, identity = {}, conversationId = "", options = {}) {
  return postChatV2("改图", cookieHeader, prompt, refFiles, timeoutMs, ratio, model, identity, conversationId, options);
}

/** 新协议文生图：同端点、无参考图。 */
async function doubaoGenerateV2(cookieHeader, prompt, timeoutMs, ratio = "auto", model, identity = {}, conversationId = "", options = {}) {
  return postChatV2("生图", cookieHeader, prompt, [], timeoutMs, ratio, model, identity, conversationId, options);
}

/**
 * 图生图（参考图引导）。
 *
 * 实测（2026-10-17，同图 + 同提示词连出三张，模型分别为 5.0 Flash / 4.5 / 4.0）：
 * 角色、姿势、招牌、尾巴全部保持一致，只换背景 —— 角色保留能力可用。
 * 但仍不承诺像素级保真：模型是重绘而非局部粘贴。
 *
 * @param {object} opts
 * @param {Array<{data: Buffer|Uint8Array, mediaType?: string}>} opts.images
 * @param {string} [opts.ratio] 期望比例（auto/1:1/4:3/16:9/9:16/2:3/3:4/3:2），
 *   写入 chat_ability.ability_param.ratio；非法或缺省吸附 auto。
 * @param {string} [opts.model] 模型显示名（见 DOUBAO_IMAGE_MODELS）；非法值吸附默认。
 */
export async function editImage({ cookieHeader, prompt, size, ratio, model, images, device, msToken, conversationId, timeoutMs = DEFAULT_TIMEOUT_MS, allowBrowserFallback = true }) {
  /** 见 generateImage 里的同名说明：身份随请求走，不读模块单例。 */
  const identity = { device, msToken };
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("prompt 不能为空");
  if (!parseCookieHeader(cookieHeader).sessionid) {
    throw new Error("缺少 sessionid：请先在插件设置页完成豆包登录");
  }
  const sources = (images ?? []).filter((i) => i && i.data && i.data.length > 0);
  if (sources.length === 0) throw new Error("至少需要一张参考图");

  // size 保留在公开签名中，但网页编辑协议只接受已证实的 auto。
  void size;
  const requestedRatio = normalizeEditRatio(ratio);
  const requestModel = normalizeImageModel(model);
  const uploaded = [];
  for (const source of sources) {
    const ext = EXT_OF_MIME[source.mediaType] ?? ".png";
    uploaded.push(await uploadToDoubao(cookieHeader, Buffer.from(source.data), ext, identity));
  }

  const result = await doubaoEditV2(cookieHeader, text, uploaded, timeoutMs, requestedRatio, requestModel, identity, conversationId, { allowBrowserFallback });
  const imagesV2 = result.images;
  const resolved = await resolveAllImageBytes(cookieHeader, imagesV2, identity);
  const ratioByKey = new Map(imagesV2.map((item) => [item.key, item.actualRatio]));
  const items = resolved.map((item) => ({ ...item, actualRatio: ratioByKey.get(item.key) ?? "" }));
  const first = items[0];
  const uploadNotes = uploaded.flatMap(({ meta }) => meta.notes ?? []);
  return {
    data: first.data,
    mediaType: first.mediaType,
    watermarkFree: first.watermarkFree,
    ratio: first.actualRatio,
    actualRatio: first.actualRatio,
    requestedRatio,
    requestModel,
    /** 服务端回显的实际模型（空字符串表示没回显，不等于没生效）。 */
    actualModel: result.modelEcho ?? "",
    references: uploaded.length,
    uploadNotes: uploadNotes.length > 0 ? uploadNotes : undefined,
    items,
    count: items.length,
    /** 见 generateImage 的同名字段：供上层写回账号，实现固定会话复用。 */
    conversationId: normalizeConversationId(result.conversationId) || normalizeConversationId(conversationId),
  };
}

