/**
 * ChatGPT 网页版免费账户生图模块。
 *
 * 协议逐条移植自 fran0220/chatgpt2api（Go）：
 *   handler/pow.go     solvePoW / generateRequirementsToken —— 由 ./pow.mjs 复用，不重写
 *   handler/client.go  GenerateImage / buildConversationBody / doConversation
 *                      getSentinelTokens / parseSSE / extractImages
 *                      fetchConversationImages / getAttachmentURL / getDownloadURL
 *                      setHeaders / extractFileID / detectMIME
 *
 * 链路：
 *   1. POST {base}/sentinel/chat-requirements   body {"p": <requirements token>}
 *      -> { token, proofofwork: { required, seed, difficulty } }
 *   2. proofofwork.required 为真时 solvePoW(seed, difficulty) 得到 proof token
 *   3. POST {base}/conversation（**不是** /f/conversation），
 *      带 openai-sentinel-chat-requirements-token / openai-sentinel-proof-token，
 *      body 含 system_hints:["picture_v2"]，响应是 SSE 流
 *   4. 图片可能同步出现在 SSE 里；也可能 async_status>0，需要轮询
 *      GET {base}/conversation/{id}
 *   5. 图片本体：asset_pointer 前缀 sediment:// 走
 *      {base}/conversation/{cid}/attachment/{fileId}/download；
 *      file-service:// 走 {base}/files/download/{fileId}?conversation_id={cid}&inline=false；
 *      两者都返回 { download_url }，再带同一组风控头下载字节。
 *
 * 只使用 node: 内置模块。传输层是本文件自写的 HTTP/1.1 客户端，因为全局 fetch
 * （undici）在不引入第三方依赖的前提下无法走 http 代理，而 chatgpt.com 在本机必须走代理。
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { generateRequirementsToken, solvePoW, solveTurnstileToken } from "./pow.mjs";


/** 后端根地址；默认线上地址，可用 opts.baseUrl 覆盖（供离线自测）。 */
export const BASE_URL = "https://chatgpt.com/backend-api";

/** 与 Go 参考实现 defaultModel 一致。 */
export const DEFAULT_MODEL = "gpt-5-3";

/** 与 Go 参考实现 defaultUserAgent 一致（Chrome 146 / macOS）。 */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 300_000; // Go: sseTimeout 5 分钟
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

/* ---------------------------------------------- 回显上游正文前的行级过滤 */

/**
 * 命中即整行剔除。大小写不敏感。
 *
 * 判据是「这一行**提到了**凭据字段名」，不是「这一行看起来像凭据值」。
 * 后者要猜格式（长度？前缀？字符集？），必然漏；前者是确定性的字符串匹配。
 *
 * 本文件原有的注释写「构造带状态码与正文片段的错误，且绝不包含
 * accessToken / cookie」——那条注释描述的是「我没有主动泄露」，不是
 * 「不可能泄露」。某些网关会把请求头回显进响应体，这一层补的是后一半。
 */
const SENSITIVE_LINE =
  /authorization|cookie|access[_-]?token|refresh[_-]?token|session[_-]?id|bearer\s|set-cookie|api[_-]?key|secret/i;

/**
 * `name=value` 形态的凭据行。
 *
 * 关键词判据挡不住**多行回显的 Cookie**：每行只有一个 `name=value`，行内没有
 * "cookie" 这个词。本插件真实持有的 `__Secure-next-auth.session-token.0` /
 * `cf_clearance` / `__cf_bm` / `sid_guard` / `sessionid_ss` 都能绕过（2026-10-21 实测）。
 * 与 `lib/doubao-core.mjs` 的同名判据保持一致。
 */
const SENSITIVE_COOKIE_NAME =
  /(?:^|[._-])(?:sid|sids|uid|mfa|token|auth|secret)(?:[._-]|$)|session|csrf|clearance|passport|ttwid|odin|api[_-]?key|^cf_|^__cf|^_cfuvid$|^_dd_s|^oai-|^g_state$|^n_mh$|^ssid|^s_v_/i;

const COOKIE_ASSIGN = /^\s*([A-Za-z_][\w.\-]*)\s*=\s*\S/;

function isSensitiveLine(line) {
  if (SENSITIVE_LINE.test(line)) return true;
  const assign = COOKIE_ASSIGN.exec(line);
  return Boolean(assign && SENSITIVE_COOKIE_NAME.test(assign[1]));
}

/**
 * 把上游正文压成一段**可安全回显**的错误消息片段（M3）。
 *
 * 三件事一起做：剔除凭据行、压平空白、截断。顺序有讲究：**先剔行再压平**
 * ——先压平会把多行并成一行，凭据行就混进正常文本里再也分不出来了。
 *
 * @param {string} text 上游响应正文
 * @param {number} [max] 截断长度
 * @returns {string}
 */
export function safeSnippet(text, max = 300) {
  if (typeof text !== "string" || text === "") return "";
  const flat = text
    .split(/\r?\n/)
    .filter((line) => !isSensitiveLine(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return "";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const POLL_INTERVAL_MS = 3_000; // 轮询间隔
const POLL_MAX_MS = 180_000; // 轮询总预算
/**
 * 首次轮询前的等待。上游 SSE 刚结束时 conversation 文档尚未落库，立刻 GET 会撞
 * 瞬态 429（源头实现 basketikun/chatgpt2api 的 `image_poll_initial_wait_secs` 默认也是 10s）。
 */
const POLL_INITIAL_WAIT_MS = 10_000;

/**
 * Chrome 的 cipher 列表，**过 Cloudflare 风控的必要条件**。
 *
 * 2026-10-13 实测（POST /backend-api/sentinel/chat-requirements，经本机代理、同一出口 IP、
 * 同一组风控头、只改 TLS 配置）：
 *   Node 默认 OpenSSL 指纹 -> HTTP/1.1 403（Cloudflare 挑战页）
 *   加上本列表            -> HTTP/1.1 200（真实 sentinel token）
 * 顺序即 OpenSSL 在 ClientHello 中的宣告顺序，构成 JA3/JA4 指纹的一部分。
 * Go 参考实现要为此用第三方 uTLS 库（HelloChrome_Auto）；Node 内置 tls 通过本列表即可达到
 * 同样的效果，因此**不引入任何第三方依赖**。
 */
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

/* ------------------------------------------------------------------ *
 * 传输层：极简 HTTP/1.1 客户端（可选 http 代理 CONNECT）
 * ------------------------------------------------------------------ */

/** 把 proxyUrl 解析成 {host, port, authHeader}；空值返回 null。 */
function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  let u;
  try {
    u = new URL(proxyUrl);
  } catch {
    throw new Error(`非法的 proxyUrl：${String(proxyUrl).slice(0, 64)}`);
  }
  if (u.protocol !== "http:") {
    throw new Error(`暂不支持的代理协议 ${u.protocol}（目前只实现 http 代理的 CONNECT 隧道）`);
  }
  const port = Number(u.port || 80);
  let authHeader = "";
  if (u.username) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password ?? "");
    authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return { host: u.hostname, port, authHeader };
}

function netConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP 连接超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 在已建立的裸 socket 上做 TLS 握手。
 *
 * 两处刻意设置：
 *  - ALPN 只宣告 http/1.1：本客户端只会发 HTTP/1.1 文本，若协商到 h2 会导致协议错位。
 *  - ciphers 用 Chrome 列表：这是过 Cloudflare 风控的必要条件，见 CHROME_CIPHERS 注释。
 */
function tlsUpgrade(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS 握手超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const secured = tls.connect({
      socket,
      servername: host,
      ALPNProtocols: ["http/1.1"],
      ciphers: CHROME_CIPHERS,
      minVersion: "TLSv1.2",
    });
    secured.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secured);
    });
    secured.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** 读满一个 \r\n\r\n 前的响应头。返回 { head, rest }，rest 是头部之后已经到达的字节。 */
function readHead(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const cleanup = () => socket.off("data", onData);
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) {
        if (buf.length > MAX_HEADER_BYTES) {
          cleanup();
          reject(new Error("响应头过大"));
        }
        return;
      }
      cleanup();
      resolve({ head: buf.subarray(0, idx).toString("latin1"), rest: buf.subarray(idx + 4) });
    };
    socket.on("data", onData);
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.once("close", () => {
      cleanup();
      reject(new Error("连接在响应头到达前关闭"));
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`读取响应头超时（${timeoutMs}ms）`)));
  });
}

/** 经 http 代理建立到 target 的 CONNECT 隧道（明文 socket，之后由调用方决定是否 TLS）。 */
async function proxyTunnel(socket, host, port, authHeader, timeoutMs) {
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Proxy-Connection: keep-alive",
  ];
  if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);
  socket.write(lines.join("\r\n") + "\r\n\r\n");

  const { head, rest } = await readHead(socket, timeoutMs);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if (status !== 200) {
    throw new Error(`代理 CONNECT ${host}:${port} 失败：${head.split("\r\n")[0] || "无响应行"}`);
  }
  // readHead 移除最后一个 data 监听后 socket 已回到 paused，unshift 可安全回填。
  if (rest.length) socket.unshift(rest);
}

async function connectSocket(host, port, { isTls, proxy, timeoutMs }) {
  if (!proxy) {
    const plain = await netConnect(host, port, timeoutMs);
    return isTls ? await tlsUpgrade(plain, host, timeoutMs) : plain;
  }
  const tunnel = await netConnect(proxy.host, proxy.port, timeoutMs);
  try {
    await proxyTunnel(tunnel, host, port, proxy.authHeader, timeoutMs);
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
  return isTls ? await tlsUpgrade(tunnel, host, timeoutMs) : tunnel;
}

/**
 * 增量解析 HTTP chunked 编码。
 * @param {{buf: Buffer, needSize: boolean, remain: number}} st 跨次调用的状态
 * @returns {{out: Buffer, done: boolean, err: string|null}}
 */
function chunkStep(st, input) {
  if (input && input.length) {
    st.buf = st.buf.length ? Buffer.concat([st.buf, input]) : input;
  }
  const out = [];
  let done = false;
  let err = null;
  parse: for (;;) {
    if (st.needSize) {
      const idx = st.buf.indexOf("\r\n");
      if (idx < 0) break parse;
      const sizeLine = st.buf.subarray(0, idx).toString("latin1").split(";")[0].trim();
      st.buf = st.buf.subarray(idx + 2);
      if (!/^[0-9a-fA-F]{1,8}$/.test(sizeLine)) {
        err = `非法的 chunk 长度：${sizeLine.slice(0, 32)}`;
        break parse;
      }
      const size = parseInt(sizeLine, 16);
      if (size === 0) {
        done = true;
        break parse;
      }
      st.remain = size;
      st.needSize = false;
    }
    if (st.remain > 0) {
      if (st.buf.length === 0) break parse;
      const take = Math.min(st.remain, st.buf.length);
      out.push(st.buf.subarray(0, take));
      st.buf = st.buf.subarray(take);
      st.remain -= take;
      if (st.remain > 0) break parse;
    }
    // remain 归零后必须吃掉分块尾随的 CRLF
    if (st.buf.length < 2) break parse;
    st.buf = st.buf.subarray(2);
    st.needSize = true;
  }
  return { out: Buffer.concat(out), done, err };
}

/** 读完整响应体（chunked / content-length / 读到 EOF 三种模式）。 */
function readBody(socket, initial, headers) {
  return new Promise((resolve, reject) => {
    const chunked = String(headers["transfer-encoding"] || "").toLowerCase().includes("chunked");
    const declared =
      !chunked && headers["content-length"] !== undefined ? Number(headers["content-length"]) : null;
    const chunks = [];
    const st = { buf: Buffer.alloc(0), needSize: true, remain: 0 };
    let total = 0;
    let settled = false;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function onData(chunk) {
      if (chunked) {
        const step = chunkStep(st, chunk);
        if (step.err) return fail(new Error(step.err));
        if (step.out.length) {
          chunks.push(step.out);
          total += step.out.length;
        }
        if (total > MAX_BODY_BYTES) return fail(new Error("响应体过大"));
        if (step.done) return done(Buffer.concat(chunks));
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      if (declared !== null && total >= declared) {
        const all = Buffer.concat(chunks);
        return done(all.length === declared ? all : all.subarray(0, declared));
      }
      if (total > MAX_BODY_BYTES) return fail(new Error("响应体过大"));
    }

    function onEnd() {
      if (settled) return;
      if (chunked) return fail(new Error("chunked 响应未收到终止块就结束了"));
      const all = Buffer.concat(chunks);
      if (declared !== null && all.length < declared) {
        return fail(new Error(`响应体不完整：期望 ${declared} 字节，实际 ${all.length}`));
      }
      done(declared !== null ? all.subarray(0, declared) : all);
    }

    function onError(error) {
      fail(error);
    }

    function onClose() {
      if (!settled) onEnd();
    }

    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
    socket.on("close", onClose);
    if (initial && initial.length) onData(initial);
  });
}

/** 按 Content-Encoding 解压（我们在请求里发 identity，这里只是兜底）。 */
function decodeBody(body, encodingHeader) {
  const encoding = String(encodingHeader || "").toLowerCase().trim();
  if (!encoding || encoding === "identity") return body;
  if (encoding.includes("gzip")) return gunzipSync(body);
  if (encoding.includes("deflate")) return inflateSync(body);
  if (encoding.includes("br")) return brotliDecompressSync(body);
  return body;
}

/**
 * 发一个 HTTP/1.1 请求并把响应体完整读回。
 *
 * 注意：不使用 Connection 复用（每个请求一条连接，且显式 Connection: close），
 * 这是为了不在自写传输层里实现连接池；与本机对 chatgpt.com 的既有结论一致
 * （HTTP/1.1 可用，HTTP/2 协商在 Windows 上会失败）。
 *
 * @returns {Promise<{status:number, statusText:string, headers:Record<string,string>, body:Buffer}>}
 */
async function httpRequest({ method, url, headers: extraHeaders = {}, body, proxyUrl = "", timeoutMs = 60_000 }) {
  const u = new URL(url);
  const isTls = u.protocol === "https:";
  if (!isTls && u.protocol !== "http:") throw new Error(`不支持的 URL 协议：${u.protocol}`);
  const proxy = parseProxyUrl(proxyUrl);
  if (!isTls && proxy) throw new Error("http:// 目标不支持走代理（只实现了 https 的 CONNECT 隧道）");

  const port = Number(u.port || (isTls ? 443 : 80));
  const socket = await connectSocket(u.hostname, port, { isTls, proxy, timeoutMs });
  const hardTimer = setTimeout(
    () => socket.destroy(new Error(`请求超时（${timeoutMs}ms）`)),
    timeoutMs,
  );

  try {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    const headers = {
      Host: port === (isTls ? 443 : 80) ? u.hostname : `${u.hostname}:${port}`,
      "Accept-Encoding": "identity",
      Connection: "close",
      ...extraHeaders,
    };
    if (payload) headers["Content-Length"] = String(payload.length);

    const head =
      `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n") +
      "\r\n\r\n";
    socket.write(head);
    if (payload) socket.write(payload);

    const { head: rawHead, rest } = await readHead(socket, timeoutMs);
    const [statusLine, ...headerLines] = rawHead.split("\r\n");
    const statusMatch = /^HTTP\/1\.[01] (\d{3})\s*(.*)$/.exec(statusLine);
    if (!statusMatch) throw new Error(`非法的响应行：${statusLine.slice(0, 80)}`);
    const responseHeaders = {};
    for (const line of headerLines) {
      const idx = line.indexOf(":");
      if (idx > 0) responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const raw = await readBody(socket, rest, responseHeaders);
    return {
      status: Number(statusMatch[1]),
      statusText: statusMatch[2] || "",
      headers: responseHeaders,
      body: decodeBody(raw, responseHeaders["content-encoding"]),
    };
  } finally {
    clearTimeout(hardTimer);
    socket.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * 风控头 / 请求体 —— 逐条照抄 Go 的 setHeaders 与 buildConversationBody
 * ------------------------------------------------------------------ */

/**
 * 风控请求头。
 *
 * 基础字段照抄 Go 的 `setHeaders`；另有三项来自源头实现 basketikun/chatgpt2api
 * （`services/openai_backend_api.py` 的 `_build_fp` / `_headers`）：
 *   - `OAI-Session-Id`：Go 版不发，Python 版每账号固定一个；
 *   - `X-OpenAI-Target-Path` / `X-OpenAI-Target-Route`：Python 版对**每个**请求都带上
 *     目标路径，web 端据此做路由校验。
 * 这三项都是「多带不会坏」的头（老端点不看它们），所以无条件发送，不做开关。
 *
 * @param {object} opts
 * @param {string} [opts.targetPath] 请求路径（如 `/backend-api/conversation`）；
 *   提供时补 `X-OpenAI-Target-Path` / `X-OpenAI-Target-Route`。
 */
function buildHeaders({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, accept = "*/*", targetPath } = {}) {
  const headers = {
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "OAI-Device-Id": oaiDeviceId,
    "OAI-Language": "en-US",
    Origin: "https://chatgpt.com",
    Priority: "u=1, i",
    Referer: "https://chatgpt.com/",
    "Sec-CH-UA": '"Chromium";v="146", "Google Chrome";v="146", "Not?A_Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": UA,
  };
  if (oaiSessionId) headers["OAI-Session-Id"] = oaiSessionId;
  if (targetPath) {
    headers["X-OpenAI-Target-Path"] = targetPath;
    headers["X-OpenAI-Target-Route"] = targetPath;
  }
  // 缺省不发送 Cookie，避免把空串当成凭据送出去。
  if (cookieHeader) headers.Cookie = cookieHeader;
  // 跨域下载（CDN 预签名链接）不能带 Authorization，否则会被 CDN 拒绝。
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

/**
 * 从图片字节里读出宽高。
 *
 * 上游 Python 用 `PIL.Image.open(...).size`（`_upload_image` 第 926-927 行），
 * 这里用纯 JS 解析文件头做等价的事——只为了填 `/backend-api/files` 的
 * `width` / `height` 元数据，不需要像素级正确，但**不能瞎猜**：上游拿它算
 * 图片 token 用量，传 1×1 会让长图被当成小图。
 *
 * 解析不出来返回 `null`，由调用方兜底——不抛错。理由：尺寸只是元数据，
 * 为了它中断整条生图链路不值得。
 */
function readImageSize(data, mimeType = "") {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    /*
     * 最短的合法头是 GIF（13 字节就够读到宽高），所以门槛设在 12 而不是 24——
     * 一刀切 24 会把短 GIF 误判成「认不出」。
     */
    if (buf.length < 12) return null;
    // PNG：IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型，宽高在偏移 16。
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF：逻辑屏幕描述符在偏移 6，小端 uint16。
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // WebP：RIFF....WEBP，再按 VP8 / VP8L / VP8X 三种块各解一遍。
    if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const kind = buf.toString("ascii", 12, 16);
      if (kind === "VP8X" && buf.length >= 30) {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (kind === "VP8 " && buf.length >= 30) {
        // 关键帧起始码 9d 01 2a 之后是 14 位宽高（各取低 14 位）。
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (kind === "VP8L" && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG：逐段扫到 SOFn（0xC0-0xCF，排除 C4/C8/CC），段内偏移 5/7 是高/宽。
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
        const length = buf.readUInt16BE(offset + 2);
        if (length < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        offset += 2 + length;
      }
    }
    void mimeType;
    return null;
  } catch {
    return null;
  }
}

/**
 * 把一张参考图上传到 ChatGPT 文件服务，返回可在对话里引用的元数据。
 *
 * 三步（逐条对齐上游 Python `_upload_image`，
 * 上游 basketikun/chatgpt2api 的 `dl-openai_backend_api.py`:913-970）：
 *
 *   1. `POST {BASE_URL}/files` 申请上传位，拿 `upload_url` + `file_id`
 *   2. `PUT upload_url` 把字节写进 Azure Blob
 *   3. `POST {BASE_URL}/files/{file_id}/uploaded` 确认
 *
 * ## 为什么第 2 步不带 Authorization
 *
 * `upload_url` 落在 `*.oaiusercontent.com`（Azure Blob），是**第三方域**。
 * 把 `Bearer <accessToken>` 发给它不是「多带一个头」，而是把长期凭据交给
 * 一个只需要短期 SAS 签名的存储端点。上游同样只带 Azure 需要的几个头。
 *
 * 返回结构刻意与 `buildConversationBody` 的 `references` 元素一致，
 * 调用方拿到就能直接塞进去，不需要再做一次字段映射。
 */
async function uploadReferenceImage({
  accessToken,
  oaiDeviceId,
  oaiSessionId,
  cookieHeader = "",
  proxyUrl = "",
  baseUrl = BASE_URL,
  data,
  fileName = "reference.png",
  mimeType = "image/png",
  width,
  height,
  timeoutMs = 60_000,
}) {
  if (typeof accessToken !== "string" || !accessToken) throw new Error("缺少 accessToken");
  if (!data || typeof data.length !== "number" || data.length === 0) throw new Error("参考图为空");

  /*
   * 调用方常常只有 `{data, mediaType}`（工具路径读的是本地文件字节），
   * 拿不到宽高。这里自己从文件头解析，解析不出来才退 1×1——
   * 上游拿这对数字算图片 token 用量，能解就一定解。
   */
  const measured = readImageSize(data, mimeType) ?? {};
  const resolvedWidth = Math.max(1, Math.round(Number(width) || Number(measured.width) || 1));
  const resolvedHeight = Math.max(1, Math.round(Number(height) || Number(measured.height) || 1));

  const apiHeaders = buildHeaders({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader });
  // 申请上传位：file_size 必须是**真实字节数**，上游会拿它校验后续 PUT。
  const createResponse = await httpRequest({
    method: "POST",
    url: `${baseUrl}/files`,
    headers: { ...apiHeaders, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      file_name: fileName,
      file_size: data.length,
      use_case: "multimodal",
      width: resolvedWidth,
      height: resolvedHeight,
    }),
    proxyUrl,
    timeoutMs,
  });
  if (createResponse.status !== 200) throw httpFailure("files/create", createResponse);
  /*
   * `httpRequest` 返回的是 `{status, statusText, headers, body}`——`body` 是 Buffer，
   * **没有 `.json()` 方法**（它不是 fetch Response）。这里必须用 `parseJson`。
   */
  const created = parseJson("files/create", createResponse);
  const fileId = typeof created?.file_id === "string" ? created.file_id : "";
  const uploadUrl = typeof created?.upload_url === "string" ? created.upload_url : "";
  if (fileId === "" || uploadUrl === "") throw new Error("申请上传位失败：响应缺 file_id 或 upload_url");

  /*
   * 写 blob。只带 Azure 需要的头，**不带 Authorization / Cookie**（见函数注释）。
   * 成功状态是 201 Created，不是 200。
   */
  const putResponse = await httpRequest({
    method: "PUT",
    url: uploadUrl,
    headers: {
      "Content-Type": mimeType,
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2020-04-08",
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      Accept: "application/json, text/plain, */*",
    },
    body: data,
    proxyUrl,
    timeoutMs,
  });
  if (putResponse.status !== 201) throw httpFailure("files/upload", putResponse);

  // 确认上传完成，上游此后才会把该 file_id 当作可引用的附件。
  const doneResponse = await httpRequest({
    method: "POST",
    url: `${baseUrl}/files/${fileId}/uploaded`,
    headers: { ...apiHeaders, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
    proxyUrl,
    timeoutMs,
  });
  if (doneResponse.status !== 200) throw httpFailure("files/uploaded", doneResponse);

  return {
    fileId,
    fileName,
    mimeType,
    size: data.length,
    width: resolvedWidth,
    height: resolvedHeight,
  };
}

/** Go: buildConversationBody(prompt, conversationID, parentMsgID, dalleOp==nil)。 */
function buildConversationBody(prompt, { conversationId, parentMessageId = randomUUID(), model = DEFAULT_MODEL, references = [] } = {}) {
  /*
   * 字段清单逐项对齐上游 Python `_start_image_generation`
   * （上游 basketikun/chatgpt2api 的 `dl-openai_backend_api.py`:972-1046）。
   *
   * 2026-10-21 实测：少 `client_prepare_state` / `timezone` / `supported_encodings`
   * 这三项（我们原来发 `supported_encodings: []`、`timezone_offset_min: 420` +
   * `timezone: America/Los_Angeles`）会被上游判 422 `Invalid conversation body`。
   * 补齐后同一请求立刻变成 200 并正常出图。
   *
   * ## 参考图（2026-10-22）
   *
   * 有参考图时 `content` 必须从 `text` 换成 `multimodal_text`，parts 是
   * 「若干 `image_asset_pointer` + 末尾的提示词字符串」，同时在
   * `metadata.attachments` 里登记同一批文件。两处都要，缺一处上游会当作
   * 纯文生图（忽略图）或直接拒。
   *
   * 这与 `_start_image_generation` 的 `parts` / `content` / `metadata.attachments`
   * 三段一一对应；`asset_pointer` 的前缀是 `file-service://`（不是 sediment）。
   */
  const refs = Array.isArray(references) ? references : [];
  const metadata = {
    developer_mode_connector_ids: [],
    selected_github_repos: [],
    selected_all_github_repos: false,
    system_hints: ["picture_v2"],
    serialization_metadata: { custom_symbol_offsets: [] },
  };
  if (refs.length > 0) {
    metadata.attachments = refs.map((item) => ({
      id: item.fileId,
      mimeType: item.mimeType,
      name: item.fileName,
      size: item.size,
      width: item.width,
      height: item.height,
    }));
  }
  const content = refs.length > 0
    ? {
      content_type: "multimodal_text",
      parts: [
        ...refs.map((item) => ({
          content_type: "image_asset_pointer",
          asset_pointer: `file-service://${item.fileId}`,
          width: item.width,
          height: item.height,
          size_bytes: item.size,
        })),
        prompt,
      ],
    }
    : { content_type: "text", parts: [prompt] };
  const message = {
    id: randomUUID(),
    author: { role: "user" },
    create_time: Date.now() / 1000,
    content,
    metadata,
  };
  const body = {
    action: "next",
    messages: [message],
    parent_message_id: parentMessageId,
    model,
    client_prepare_state: "sent",
    timezone_offset_min: -480,
    timezone: "Asia/Shanghai",
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: ["picture_v2"],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 1200,
      page_height: 1072,
      page_width: 1724,
      pixel_ratio: 1.2,
      screen_height: 1440,
      screen_width: 2560,
      app_name: "chatgpt.com",
    },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
  };
  if (conversationId) body.conversation_id = conversationId;
  return body;
}

/* ------------------------------------------------------------------ *
 * 解析：SSE 图片 / asset_pointer / MIME
 * ------------------------------------------------------------------ */

/** Go: extractFileID —— 剥掉 file-service:// 或 sediment:// 前缀。 */
function extractFileId(pointer) {
  if (typeof pointer !== "string") return "";
  for (const prefix of ["file-service://", "sediment://"]) {
    if (pointer.startsWith(prefix)) return pointer.slice(prefix.length);
  }
  return "";
}

/**
 * 从单条消息里抽图片。
 *
 * 判据（2026-10-21 收紧，原先只看 content_type + status，会把**用户上传的参考图**
 * 当成生成结果下载）：
 *   1. `author.role` 必须是 `tool` 或 `assistant` —— `user` 消息里的
 *      `sediment://` 是输入附件，官方协议文档明确禁止当作输出图；
 *   2. `content.content_type === "multimodal_text"` 且 `status === "finished_successfully"`；
 *   3. part 是 `image_asset_pointer` 且 `asset_pointer` 带 `file-service://` 或 `sediment://`。
 *
 * ⚠️ 关于 `assistant` 这一侧：这是**本实现的主动放宽**，不是照抄上游。
 * 2026-10-21 核实源头实现 basketikun/chatgpt2api
 * （`services/protocol/conversation.py:566` 的 `is_image_tool_event`）：
 * `if author.get("role") != "tool": return False` —— **它只收 tool**。
 * 早先这段注释写「两种都收」，与源码不符，已改正。
 *
 * 之所以仍然保留 assistant：Go 版 `extractImages` 完全不看 role（更宽松），
 * Python 版只收 tool（更严格），两者矛盾；在拿不到真实出图样本的情况下，
 * 取「排除 user」这个两边都同意的下界，宁可多收 assistant 也不漏图。
 * 这条取舍已由 2026-10-22 的真实链路验证（GPT 免费账户图生图跑通）。
 */
function extractImagesFromMessage(message, conversationId) {
  if (!message || typeof message !== "object") return [];
  const role = typeof message.author?.role === "string" ? message.author.role : "";
  if (role !== "tool" && role !== "assistant") return [];
  const content = message.content;
  if (!content || content.content_type !== "multimodal_text") return [];
  if (message.status !== "finished_successfully") return [];
  if (!Array.isArray(content.parts)) return [];

  const images = [];
  for (const part of content.parts) {
    if (!part || typeof part !== "object") continue;
    if (part.content_type !== "image_asset_pointer") continue;
    const assetPointer = typeof part.asset_pointer === "string" ? part.asset_pointer : "";
    if (!assetPointer) continue;
    const fileId = extractFileId(assetPointer);
    if (!fileId) continue;
    images.push({
      fileId,
      assetPointer,
      genId: part.metadata?.dalle?.gen_id ?? null,
      revisedPrompt: part.metadata?.dalle?.prompt ?? null,
      width: part.width ?? null,
      height: part.height ?? null,
      messageId: message.id ?? null,
      conversationId: conversationId ?? null,
    });
  }
  return images;
}

/** 判断一个对象是不是「消息」形状（author.role + content 齐备）。 */
function looksLikeMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value.author?.role;
  if (typeof role !== "string" || role === "") return false;
  return Boolean(value.content && typeof value.content === "object");
}

/**
 * 从一个 SSE 事件里挖出所有消息对象。
 *
 * 上游同一份数据会以多种形态出现：
 *   - 旧形态：`{"message": {...}, "conversation_id": "..."}`
 *   - patch add：`{"p":"","o":"add","v":{"message":{...}}}`
 *   - 直接 add：`{"p":"/message","o":"add","v":{...message...}}`
 *   - 批量 patch：`{"p":"","o":"patch","v":[{...op...}, ...]}`
 *
 * 只认 `event.message` 会漏掉后三种（实测：官方文档的 patch 形态解析结果为 0 张图）。
 * 这里改成**有限深度的结构扫描**——比逐个猜路径稳，因为上游随时会加一层包装。
 * 深度上限 6 足够覆盖 batch patch 里的 op.v，又不会扫进 parts 之类的深层数据。
 */
function collectMessagesFromEvent(value, depth = 0, out = []) {
  if (depth > 6 || out.length > 32) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectMessagesFromEvent(item, depth + 1, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (looksLikeMessage(value)) {
    out.push(value);
    return out; // 消息内部不再往下扫（parts 里没有嵌套消息）
  }
  for (const key of ["message", "v", "data", "payload"]) {
    if (value[key] !== undefined) collectMessagesFromEvent(value[key], depth + 1, out);
  }
  return out;
}

/** 处理一条 `data:` 负载，就地更新解析状态。 */
function handleSseData(data, state) {
  if (data === "[DONE]") {
    state.done = true;
    return;
  }
  if (!data.startsWith("{")) return;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  if (!event || typeof event !== "object") return;
  if (typeof event.conversation_id === "string" && event.conversation_id) {
    state.conversationId = event.conversation_id;
  }
  if (typeof event.v?.conversation_id === "string" && event.v.conversation_id) {
    state.conversationId = event.v.conversation_id;
  }
  if (typeof event.async_status === "number" && event.async_status > 0) {
    state.asyncStatus = event.async_status;
  }
  // 策略拦截（官方文档 moderation 场景）：记下来，供调用方区分「被拒」与「解析失败」。
  if (event.type === "moderation" && event.moderation_response?.blocked === true) {
    state.blocked = true;
  }
  // 本轮是否调用过工具（server_ste_metadata）：没调工具又没有图片，基本就是被拒。
  if (event.type === "server_ste_metadata" && typeof event.metadata?.tool_invoked === "boolean") {
    state.toolInvoked = event.metadata.tool_invoked;
  }
  for (const message of collectMessagesFromEvent(event)) {
    state.images.push(...extractImagesFromMessage(message, state.conversationId));
  }
}

/**
 * 从一整段 SSE 文本里解析出 conversation_id / async_status / 图片。
 * 纯函数，便于离线自测。
 */
function parseSseForImages(sseText) {
  const state = {
    conversationId: null,
    asyncStatus: 0,
    images: [],
    done: false,
    blocked: false,
    toolInvoked: null,
  };
  for (const rawLine of String(sseText).split(/\r?\n/)) {
    if (state.done) break; // Go: 遇到 [DONE] 直接 break
    const line = rawLine.trimEnd();
    if (!line.startsWith("data:")) continue;
    handleSseData(line.slice(5).trimStart(), state);
  }
  return {
    conversationId: state.conversationId,
    asyncStatus: state.asyncStatus,
    images: state.images,
    blocked: state.blocked,
    toolInvoked: state.toolInvoked,
  };
}

/** 从 GET /conversation/{id} 的 {mapping} 里抽图片（Go: fetchConversationImages）。 */
function extractImagesFromConversation(conversation, conversationId) {
  const images = [];
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== "object") return images;
  for (const node of Object.values(mapping)) {
    if (node?.message) images.push(...extractImagesFromMessage(node.message, conversationId));
  }
  return images;
}

/** Go: detectMIME —— 先看魔数，再退回 Content-Type，最后兜底 image/png。 */
function detectMediaType(data, contentTypeHeader = "") {
  const type = String(contentTypeHeader).split(";")[0].trim().toLowerCase();
  if (data?.length >= 8) {
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
    ) {
      return "image/webp";
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return "image/gif";
  }
  if (type.startsWith("image/")) return type;
  return "image/png";
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** 构造带状态码与正文片段的错误，且绝不包含 accessToken / cookie。 */
function httpFailure(where, response) {
  /*
   * M3：正文片段先过 safeSnippet（剔凭据行 + 压平 + 截断）。
   * 某些网关会把请求头回显进响应体，届时 Authorization 里就是 accessToken。
   */
  const snippet = safeSnippet(response.body.toString("utf8"), 400);
  return new Error(`${where} 失败：HTTP ${response.status} ${response.statusText}${snippet ? ` — ${snippet}` : ""}`);
}

function parseJson(where, response) {
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch {
    const snippet = safeSnippet(response.body.toString("utf8"), 200);
    throw new Error(`${where} 返回的不是 JSON：${snippet}`);
  }
}

/**
 * 从 chatgpt.com 首页 HTML 里抠 PoW 资源。
 *
 * 源头实现 basketikun/chatgpt2api 的 `utils/pow.py: parse_pow_resources`：
 *   - `scriptSources`：所有 `<script src="...">`（PoW 配置槽 5 从里面随机挑一个）；
 *   - `dataBuild`：`<html data-build="...">`，取不到时退回从 script src 里正则匹配
 *     形如 `c/<build>/_` 的片段。
 *
 * 为什么要抓：旧实现把槽 5 写死成 `backend-api/sentinel/sdk.js`，而上游换构建后真实
 * 页面引用的是 `c/<build>/_/...` 形态；写死的地址与页面不一致会被判为异常客户端。
 * 抓不到就退回写死值——**这条链路失败不能让生图整体失败**。
 *
 * @param {string} html
 * @returns {{scriptSources: string[], dataBuild: string}}
 */
export function parsePowResources(html) {
  const text = typeof html === "string" ? html : "";
  const scriptSources = [...text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  let dataBuild = "";
  const buildAttr = /<html[^>]*data-build="([^"]*)"/.exec(text);
  if (buildAttr) {
    dataBuild = buildAttr[1];
  } else {
    for (const src of scriptSources) {
      const match = /c\/[^/]*\/_/.exec(src);
      if (match) {
        dataBuild = match[0];
        break;
      }
    }
  }
  return { scriptSources, dataBuild };
}

/** 预热首页并取回 PoW 资源；任何失败都降级为空资源（退回写死配置）。 */
async function bootstrap({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, proxyUrl, baseUrl, timeoutMs, report }) {
  report("bootstrap", "预热 chatgpt.com 首页以获取 PoW 资源");
  // 首页在 origin 根上，不在 /backend-api 下。
  const origin = new URL(baseUrl).origin;
  try {
    const response = await httpRequest({
      method: "GET",
      url: `${origin}/`,
      headers: {
        ...buildHeaders({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, accept: "text/html,application/xhtml+xml" }),
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      proxyUrl,
      timeoutMs,
    });
    if (response.status !== 200) {
      report("bootstrap", `首页返回 HTTP ${response.status}，PoW 资源退回默认值`);
      return { scriptSources: [], dataBuild: "" };
    }
    const resources = parsePowResources(response.body.toString("utf8"));
    report(
      "bootstrap",
      `拿到 ${resources.scriptSources.length} 个脚本引用${resources.dataBuild ? `，data-build=${resources.dataBuild}` : ""}`,
    );
    return resources;
  } catch (error) {
    report("bootstrap", `首页预热失败（${error?.message ?? error}），PoW 资源退回默认值`);
    return { scriptSources: [], dataBuild: "" };
  }
}

/**
 * 获取 sentinel token。
 *
 * 两条路径，**优先两步**：
 *
 *   1. 两步 `prepare` + `finalize`（源头实现 basketikun/chatgpt2api
 *      `openai_backend_api.py:2664` 的现行实现）。prepare 返回 proofofwork /
 *      turnstile / prepare_token，finalize 回传它们换取最终 `token` 与 `so_token`。
 *   2. 单步 `POST /sentinel/chat-requirements`（Go 版 fran0220/chatgpt2api
 *      `handler/client.go:490` 的旧实现）。
 *
 * 为什么要两条：两份上游实现**互相矛盾**——Python 已改两步，Go 仍用单步，
 * 而离线无法确认真实上游当前接受哪种。先试两步，只在 prepare 端点**不存在**
 * （404/405）时回退单步；其它失败一律抛出，避免把真实错误静默降级掉。
 *
 * 2026-10-21 之前本函数只有单步路径，且完全不处理 turnstile / so_token。
 */
async function getSentinelTokens({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, proxyUrl, baseUrl, timeoutMs, report, resources = {} }) {
  const requirementToken = generateRequirementsToken({
    scriptSources: resources.scriptSources,
    dataBuild: resources.dataBuild,
  });

  /** PoW 求解抽出来，两步/单步共用。 */
  const solveProof = (pow) => {
    if (!pow?.required) return "";
    if (!pow.seed || !pow.difficulty) throw new Error("sentinel 要求 PoW 但缺少 seed/difficulty");
    report("pow", `求解 PoW 挑战（difficulty=${pow.difficulty}）`);
    try {
      return solvePoW(pow.seed, pow.difficulty, {
        scriptSources: resources.scriptSources,
        dataBuild: resources.dataBuild,
      });
    } catch (error) {
      throw new Error(`求解 PoW 失败：${error?.message ?? error}`);
    }
  };

  /* ---------------------------------------------- 路径 1：prepare + finalize */
  report("sentinel", "请求 sentinel/chat-requirements/prepare（两步流程）");
  const prepareResponse = await httpRequest({
    method: "POST",
    url: `${baseUrl}/sentinel/chat-requirements/prepare`,
    headers: buildHeaders({
      accessToken,
      oaiDeviceId,
      oaiSessionId,
      cookieHeader,
      targetPath: "/backend-api/sentinel/chat-requirements/prepare",
    }),
    body: JSON.stringify({ p: requirementToken }),
    proxyUrl,
    timeoutMs,
  });

  // 404/405 ⇒ 上游没有这个端点，回退单步。其它状态码是真失败。
  if (prepareResponse.status !== 404 && prepareResponse.status !== 405) {
    if (prepareResponse.status !== 200) throw httpFailure("sentinel/chat-requirements/prepare", prepareResponse);
    const prepareData = parseJson("sentinel/chat-requirements/prepare", prepareResponse);

    if (prepareData?.arkose?.required) {
      throw new Error("sentinel 要求 arkose 验证，本实现不支持（上游 Python 版同样未实现）");
    }

    const proofToken = solveProof(prepareData?.proofofwork ?? {});

    let turnstileToken = "";
    const turnstile = prepareData?.turnstile ?? {};
    if (turnstile.required && turnstile.dx) {
      report("turnstile", "求解 turnstile 挑战");
      turnstileToken = solveTurnstileToken(turnstile.dx, requirementToken) ?? "";
      /*
       * 求解失败**不阻断**。
       *
       * 2026-10-21 实测：真实 prepare 下发的 dx 里根本没有 func3（写结果的指令），
       * 只有 func19 把几个槽位编码成 base64，且槽位号是浮点别名（98.64 / 46.5），
       * 求出来的是纯零字节。上游 Python 版对同一份数据同样会返回 None。
       * 而 finalize 带空 turnstile_token 依然返回 200 并给出 token ——
       * 说明服务端对免费账户并不强制。这里降级为「尽力求解、失败留空」，
       * 而不是把整条链路打断。
       */
      if (!turnstileToken) report("turnstile", "求解未产出 token（服务端允许留空），继续");
      else report("turnstile", `求解成功（${turnstileToken.length} 字符）`);
    }

    report("sentinel", "请求 sentinel/chat-requirements/finalize");
    const finalizeResponse = await httpRequest({
      method: "POST",
      url: `${baseUrl}/sentinel/chat-requirements/finalize`,
      headers: buildHeaders({
        accessToken,
        oaiDeviceId,
        oaiSessionId,
        cookieHeader,
        targetPath: "/backend-api/sentinel/chat-requirements/finalize",
      }),
      body: JSON.stringify({
        prepare_token: typeof prepareData?.prepare_token === "string" ? prepareData.prepare_token : "",
        proof_token: proofToken,
        turnstile_token: turnstileToken,
      }),
      proxyUrl,
      timeoutMs,
    });
    if (finalizeResponse.status !== 200) throw httpFailure("sentinel/chat-requirements/finalize", finalizeResponse);
    const finalizeData = parseJson("sentinel/chat-requirements/finalize", finalizeResponse);
    const chatToken = typeof finalizeData?.token === "string" ? finalizeData.token : "";
    if (!chatToken) throw new Error("sentinel finalize 响应缺少 token 字段");

    report("sentinel", "两步流程完成");
    return {
      chatToken,
      proofToken,
      powRequired: Boolean(prepareData?.proofofwork?.required),
      turnstileToken,
      soToken: typeof finalizeData?.so_token === "string" ? finalizeData.so_token : "",
      path: "prepare+finalize",
    };
  }

  /* ------------------------------------------------------ 路径 2：单步回退 */
  report("sentinel", `prepare 端点不可用（HTTP ${prepareResponse.status}），回退单步流程`);
  const response = await httpRequest({
    method: "POST",
    url: `${baseUrl}/sentinel/chat-requirements`,
    headers: buildHeaders({
      accessToken,
      oaiDeviceId,
      oaiSessionId,
      cookieHeader,
      targetPath: "/backend-api/sentinel/chat-requirements",
    }),
    body: JSON.stringify({ p: requirementToken }),
    proxyUrl,
    timeoutMs,
  });
  if (response.status !== 200) throw httpFailure("sentinel/chat-requirements", response);

  const data = parseJson("sentinel/chat-requirements", response);
  const chatToken = typeof data?.token === "string" ? data.token : "";
  if (!chatToken) throw new Error("sentinel 响应缺少 token 字段");
  const proofToken = solveProof(data?.proofofwork ?? {});
  return {
    chatToken,
    proofToken,
    powRequired: Boolean(data?.proofofwork?.required),
    turnstileToken: "",
    soToken: typeof data?.so_token === "string" ? data.so_token : "",
    path: "single-step",
  };
}

/** 图片本体地址：sediment:// 走 attachment API，其余走 files API（Go: extractImages 的分支）。 */
async function resolveDownloadUrl({ image, accessToken, oaiDeviceId, oaiSessionId, cookieHeader, proxyUrl, baseUrl, timeoutMs }) {
  const conversationId = image.conversationId;
  const isSediment = image.assetPointer.startsWith("sediment://");
  const path = isSediment
    ? `/backend-api/conversation/${conversationId}/attachment/${image.fileId}/download`
    : `/backend-api/files/download/${image.fileId}`;
  const url = isSediment
    ? `${baseUrl}/conversation/${conversationId}/attachment/${image.fileId}/download`
    : `${baseUrl}/files/download/${image.fileId}?conversation_id=${encodeURIComponent(conversationId ?? "")}&inline=false`;
  const response = await httpRequest({
    method: "GET",
    url,
    headers: buildHeaders({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, targetPath: path }),
    proxyUrl,
    timeoutMs,
  });
  if (response.status !== 200) {
    throw httpFailure(isSediment ? "attachment/download" : "files/download", response);
  }
  const data = parseJson("下载地址接口", response);
  if (!data?.download_url) throw new Error(`下载地址接口未返回 download_url（fileId=${image.fileId}）`);
  return data.download_url;
}

/**
 * 下载图片字节。
 *
 * 凭据边界：只有目标主机与 API 主机（baseUrl 的 host）相同时才携带
 * Authorization / Cookie。这里有**一处刻意偏离 Go 参考实现**——Go 的 setHeaders 是无条件加
 * Authorization 的，只有 302 跨主机时才由 net/http 剥掉，因此它的第一跳若直接落在 CDN 上，
 * 会把 ChatGPT 的 accessToken 发到第三方域名。图片下载地址多为预签名 URL（靠 query 串鉴权），
 * 不需要这个头，所以我们从一开始就不发，避免凭据外泄。
 */
async function downloadBinary({ url, accessToken, oaiDeviceId, cookieHeader, proxyUrl, timeoutMs, apiHost }) {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    const trusted = Boolean(apiHost) && target.hostname === apiHost;
    const headers = buildHeaders({
      accessToken: trusted ? accessToken : "",
      oaiDeviceId,
      cookieHeader: trusted ? cookieHeader : "",
    });

    const response = await httpRequest({ method: "GET", url: current, headers, proxyUrl, timeoutMs });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(response.headers.location, current).toString();
      continue;
    }
    if (response.status !== 200) throw httpFailure("下载图片", response);
    return { data: response.body, contentType: response.headers["content-type"] ?? "" };
  }
  throw new Error(`下载图片重定向次数超过 ${MAX_REDIRECTS} 次`);
}

/**
 * 生成一张图片。
 *
 * @param {object} opts
 * @param {string} opts.accessToken   ChatGPT accessToken（Bearer）
 * @param {string} [opts.oaiDeviceId] 设备 id，缺省随机 UUID
 * @param {string} [opts.cookieHeader] 完整 Cookie 头（含 __Secure-next-auth.session-token 等）
 * @param {string} opts.prompt        提示词
 * @param {string} [opts.proxyUrl]    http 代理，例如 http://127.0.0.1:7897；留空直连
 * @param {number} [opts.timeoutMs]   总超时，默认 300000
 * @param {(p:{stage:string,message:string}) => void} [opts.onProgress]
 * @param {string} [opts.baseUrl]     后端根地址（默认线上；离线自测用）
 * @param {number} [opts.pollIntervalMs] 异步轮询间隔，默认 3000
 * @param {number} [opts.pollInitialWaitMs] 首次轮询前的等待，默认 10000（见下方注释）
 * @returns {Promise<{data: Buffer, mediaType: string, raw: object}>}
 */
export async function generateImage(opts = {}) {
  const {
    accessToken,
    oaiDeviceId = randomUUID(),
    oaiSessionId = randomUUID(),
    cookieHeader = "",
    prompt,
    proxyUrl = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onProgress,
    baseUrl = BASE_URL,
    pollIntervalMs = POLL_INTERVAL_MS,
    pollInitialWaitMs = POLL_INITIAL_WAIT_MS,
    referenceImages = [],
  } = opts;

  if (typeof accessToken !== "string" || !accessToken) throw new Error("缺少 accessToken");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("缺少 prompt");
  const refs = Array.isArray(referenceImages) ? referenceImages : [];

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(5_000, deadline - Date.now());
  const report = (stage, message) => {
    try {
      onProgress?.({ stage, message });
    } catch {
      /* 进度回调的异常不允许影响主流程 */
    }
  };
  const call = { accessToken, oaiDeviceId, oaiSessionId, cookieHeader, proxyUrl, baseUrl };

  // 先预热首页拿 PoW 资源（抓不到就退回写死配置，不影响主流程）。
  const resources = await bootstrap({ ...call, timeoutMs: remaining(), report });

  const { chatToken, proofToken, powRequired, turnstileToken, soToken, path: sentinelPath } = await getSentinelTokens({
    ...call,
    timeoutMs: remaining(),
    report,
    resources,
  });

  /*
   * 参考图必须先全部上传完再提交对话：`buildConversationBody` 需要每张图的
   * `fileId` 才能拼 `image_asset_pointer`，而上传是三步网络往返，不能并发插在
   * 对话请求中间。
   *
   * 单张失败直接抛——半套参考图生成出来的图与用户给的不一致，比失败更糟。
   */
  const references = [];
  if (refs.length > 0) {
    report("upload", `上传参考图 0/${refs.length}`);
    for (let i = 0; i < refs.length; i += 1) {
      const item = refs[i] ?? {};
      references.push(await uploadReferenceImage({
        ...call,
        data: item.data,
        fileName: typeof item.fileName === "string" && item.fileName !== "" ? item.fileName : `reference-${i + 1}.png`,
        mimeType: typeof item.mimeType === "string" && item.mimeType !== "" ? item.mimeType : "image/png",
        width: item.width,
        height: item.height,
        timeoutMs: remaining(),
      }));
      report("upload", `上传参考图 ${i + 1}/${refs.length}`);
    }
  }

  report("conversation", "提交生图对话");
  const conversationBody = buildConversationBody(prompt, { references });
  const conversationResponse = await httpRequest({
    method: "POST",
    url: `${baseUrl}/conversation`,
    headers: {
      ...buildHeaders({
        ...call,
        accept: "text/event-stream",
        targetPath: "/backend-api/conversation",
      }),
      "openai-sentinel-chat-requirements-token": chatToken,
      ...(proofToken ? { "openai-sentinel-proof-token": proofToken } : {}),
      // 上游 Python 版对这两项有则必带（openai_backend_api.py:432-435）；空串不发。
      ...(turnstileToken ? { "openai-sentinel-turnstile-token": turnstileToken } : {}),
      ...(soToken ? { "openai-sentinel-so-token": soToken } : {}),
      // 流式请求的追踪头，上游 Python 版 _image_headers 里无条件加（第 593 行）。
      "X-Oai-Turn-Trace-Id": randomUUID(),
    },
    body: JSON.stringify(conversationBody),
    proxyUrl,
    timeoutMs: remaining(),
  });
  if (conversationResponse.status !== 200) throw httpFailure("conversation", conversationResponse);

  const sseText = conversationResponse.body.toString("utf8");
  const parsed = parseSseForImages(sseText);
  let { conversationId } = parsed;
  let images = parsed.images;
  let async = parsed.asyncStatus > 0;

  /*
   * 异步出图：轮询 GET /conversation/{id}，直到 mapping 里出现图片。
   *
   * 轮询**不能立刻开始**（2026-10-21 对齐源头实现 `_poll_image_results`）：
   * SSE 刚结束时上游的 conversation 文档还没落库，此时立刻 GET 会拿到一次
   * 瞬态 429，而旧实现把非 200 直接当致命错误抛出，于是「图其实成了却报失败」。
   * 源头实现的注释原文：ChatGPT image generation takes ~30s; polling immediately
   * wastes requests and trips a transient 429 the upstream returns within ~200ms
   * of the SSE stream closing (the conversation document is not yet committed)。
   */
  if (images.length === 0 && async) {
    if (!conversationId) throw new Error("生图为异步但 SSE 未给出 conversation_id");
    report("poll", `生图为异步模式，等待 ${Math.round(pollInitialWaitMs / 1000)}s 后轮询会话 ${conversationId}`);
    const pollDeadline = Math.min(Date.now() + POLL_MAX_MS, deadline);
    const firstWait = Math.min(pollInitialWaitMs, Math.max(0, pollDeadline - Date.now()));
    if (firstWait > 0) await sleep(firstWait);
    let polls = 0;
    while (images.length === 0) {
      if (Date.now() >= pollDeadline) throw new Error("等待异步生图超时（180s 内未出现图片）");
      polls += 1;
      const pollResponse = await httpRequest({
        method: "GET",
        url: `${baseUrl}/conversation/${conversationId}`,
        headers: buildHeaders({
          ...call,
          targetPath: `/backend-api/conversation/${conversationId}`,
        }),
        proxyUrl,
        timeoutMs: remaining(),
      });
      // 429/5xx 是「文档还没落库」的瞬态状态，退避后重试，不要当致命错误。
      if (pollResponse.status === 429 || pollResponse.status >= 500) {
        const backoff = Math.min(pollIntervalMs * 2 ** Math.min(polls - 1, 4), 16_000);
        report("poll", `第 ${polls} 次轮询：HTTP ${pollResponse.status}，${Math.round(backoff / 1000)}s 后重试`);
        await sleep(Math.min(backoff, Math.max(0, pollDeadline - Date.now())));
        continue;
      }
      if (pollResponse.status !== 200) throw httpFailure("GET conversation", pollResponse);
      const conversation = parseJson("GET conversation", pollResponse);
      images = extractImagesFromConversation(conversation, conversationId);
      if (images.length === 0) {
        report("poll", `第 ${polls} 次轮询：图片尚未就绪`);
        await sleep(Math.min(pollIntervalMs, Math.max(0, pollDeadline - Date.now())));
      }
    }
  }

  if (images.length === 0) {
    /*
     * 区分「被上游拒绝」与「解析失败」：有 assistant 文本 + 没调工具（或被 moderation
     * 拦截）说明模型拒绝了，此时把文本带出来；否则只能给出 SSE 片段。
     */
    const snippet = safeSnippet(sseText, 300);
    const rejected = parsed.blocked === true || parsed.toolInvoked === false;
    throw new Error(
      `${rejected ? "上游拒绝了本次请求" : "未从响应中解析到图片，模型可能拒绝了请求"}` +
        `${snippet ? ` — SSE 片段：${snippet}` : ""}`,
    );
  }

  const image = images[0];
  report("download", `获取图片下载地址（fileId=${image.fileId}）`);
  const downloadUrl = await resolveDownloadUrl({ image, ...call, timeoutMs: remaining() });
  const { data, contentType } = await downloadBinary({
    url: downloadUrl,
    ...call,
    apiHost: new URL(baseUrl).hostname,
    timeoutMs: remaining(),
  });

  report("done", `已取回 ${data.length} 字节`);
  return {
    data,
    mediaType: detectMediaType(data, contentType),
    raw: {
      conversationId,
      model: DEFAULT_MODEL,
      powRequired,
      sentinelPath,
      async,
      imageCount: images.length,
      fileId: image.fileId,
      genId: image.genId,
      revisedPrompt: image.revisedPrompt,
      downloadUrl,
      images,
    },
  };
}

/**
 * 把一段对话从 ChatGPT 侧边栏隐藏（等价于网页端的「删除」）。
 *
 * 上游实现（`basketikun/chatgpt2api` 的 `dl-openai_backend_api.py`:1056-1072）
 * 用的**不是 DELETE**，而是 `PATCH /backend-api/conversation/{id}` + body
 * `{"is_visible": false}`。网页端自己也走这条，别自己发明端点。
 *
 * 失败一律返回 `{ok:false, reason}`，**不抛**：生图已经成功，清理是附带动作，
 * 为了删不掉一个会话把整次生图判失败是错的。
 *
 * @param {object} opts
 * @param {string} opts.accessToken   ChatGPT accessToken（Bearer）
 * @param {string} opts.conversationId `generateImage` 返回的 `raw.conversationId`
 * @param {string} [opts.baseUrl]     后端根地址（默认线上；离线自测用）
 * @returns {Promise<{ok: true} | {ok: false, status?: number, reason: string}>}
 */
export async function deleteConversation(opts = {}) {
  const {
    accessToken,
    oaiDeviceId = randomUUID(),
    oaiSessionId = randomUUID(),
    cookieHeader = "",
    conversationId,
    proxyUrl = "",
    timeoutMs = 30_000,
    baseUrl = BASE_URL,
  } = opts;
  if (typeof conversationId !== "string" || conversationId === "") {
    return { ok: false, reason: "missing-conversation-id" };
  }
  /*
   * 路径只拼一次。
   *
   * `baseUrl` 已经含 `/backend-api`（`BASE_URL` 就是 `https://chatgpt.com/backend-api`），
   * 而 `X-OpenAI-Target-Route` 需要**带**前缀的完整路由。早先这里写了两份独立
   * 拼接（一份给头、一份给 url），改坏其中一份另一份照样正确——变异实验里
   * 这种「只改一个副本不影响行为」的写法会伪装成漏网，实际是代码里有冗余。
   * 现在只有 `suffix` 一份真相：url 拼 baseUrl，路由头补回 `/backend-api`。
   */
  const suffix = `/conversation/${conversationId}`;
  const headers = buildHeaders({ accessToken, oaiDeviceId, oaiSessionId, cookieHeader, targetPath: `/backend-api${suffix}` });
  // 上游把 Referer 指到该对话页；照抄，因为 web 端按 Referer 做路由校验。
  headers.Referer = `${baseUrl.replace(/\/backend-api$/, "")}/c/${conversationId}`;
  try {
    const response = await httpRequest({
      method: "PATCH",
      url: `${baseUrl}${suffix}`,
      headers,
      body: JSON.stringify({ is_visible: false }),
      proxyUrl,
      timeoutMs,
    });
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, status: response.status, reason: `http-${response.status}` };
  } catch (error) {
    return { ok: false, reason: error && error.message ? String(error.message) : String(error) };
  }
}

/** 仅供自测使用的内部导出。 */
export const __internals = {
  parseSseForImages,
  extractImagesFromMessage,
  extractImagesFromConversation,
  collectMessagesFromEvent,
  looksLikeMessage,
  parsePowResources,
  buildConversationBody,
  uploadReferenceImage,
  readImageSize,
  buildHeaders,
  detectMediaType,
  extractFileId,
  httpRequest,
  deleteConversation,
  chunkStep,
  parseProxyUrl,
  decodeBody,
  CHROME_CIPHERS,
  BASE_URL,
  DEFAULT_MODEL,
  UA,
  POLL_INITIAL_WAIT_MS,
};
