/**
 * 豆包协议的**基础设施**：常量、模型表、cookie 工具、尺寸换算、行级脱敏。
 * 
 * 这一层没有任何内部依赖 —— 所有上层模块都可以安全引用它。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
/**
 * 豆包（www.doubao.com）网页版协议 — 纯 HTTP 直连实现。
 *
 * 不含 HTTP 服务、不含子进程、不写日志文件：全部逻辑跑在调用方进程里，
 * 通过导出函数直接被 Host 侧调用。Cookie 由调用方传入（来自扫码登录或
 * 手工粘贴），本模块不持久化任何凭据。
 *
 * 三条通路，均已实测定型：
 *
 *   1. 文生图 — POST /samantha/chat/completion（SSE）
 *      body.messages[0] 的 content_type=2009 是「图片技能」开关，
 *      content 是 JSON 字符串 { text, ratio }。回复里 event_type 2001 +
 *      content_type 2010 携带图片 key。
 *
 *   2. 无水印原图 — POST /creativity/resource/get_without_watermark
 *      传入图片 key，返回 cgen_wm0 模板的 URL，即 2048px 无水印原图。
 *      这是豆包自家 API，不是绕过，水印开关本来就在网页端。
 *
 *   3. 图生图 — 参考图必须先进入豆包自己的资源系统（ImageX 上传），
 *      再以 block_type 10052（BLOCK_ATTACHMENT）的形式引用：
 *        POST /alice/resource/prepare_upload      取 STS 凭据
 *        GET  {host}/?Action=ApplyImageUpload     SigV4 签名，取上传地址
 *        PUT  https://{UploadHosts[0]}/{StoreUri}
 *        POST {host}/?Action=CommitImageUpload    SigV4 签名，取 resource Uri
 *        POST /chat/completion                    双消息 content_block + chat_ability
 *      签名用的是 AWS4 变体（不是火山引擎变体）——见 signImagex 注释。
 *
 *   4. 生视频 — 走新的桌面 GUI 协议：POST /chat/completion + 轮询
 *      POST /im/message/chain_by_block（block_type 2074）。与图片完全不同的
 *      一套安全参数与请求体，见 videoSecurityParams / videoRequestBody。
 *
 * 风控说明：旧 /samantha/* 通道实测可用；新 /chat/completion 未在插件侧
 * 用真实账号验证，msToken/a_bogus 是否必需尚未知，失败明确报错不回落旧通道。
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";



export const DOUBAO_BASE = "https://www.doubao.com";
export const CHAT_PATH = "/samantha/chat/completion";
export const EDIT_CHAT_PATH = "/chat/completion";
/**
 * 网页端图片模型下拉里的显示名，即 `chat_ability.ability_param.model` 的取值。
 *
 * 实测（2026-10-17，真实账号抓包 + 插件侧回放）：
 *   - 服务端按这个**显示名字符串**选模型，前后空一格都不行。
 *   - 生效证据是 SSE 里的 `placeholder.description` 原样回显该字符串。
 *   - 免费账号用 Pro 会得到订阅墙文字（「这是豆包订阅标准套餐专属能力」），
 *     不是报错——调用方要把这句话透给用户，否则用户只看到「没出图」。
 */
export const DOUBAO_IMAGE_MODELS = ["Seedream 5.0 Flash", "Seedream 4.5", "Seedream 4.0"];

/** 需要订阅、免费账号不可用的模型。单列出来是为了给出准确原因而不是笼统失败。 */
export const DOUBAO_IMAGE_MODELS_SUBSCRIBED = ["Seedream 5.0 Pro"];

/** 全部合法模型名（含付费），用于把非法值吸附回默认而不是直接发给服务端。 */
const ALL_IMAGE_MODELS = [...DOUBAO_IMAGE_MODELS, ...DOUBAO_IMAGE_MODELS_SUBSCRIBED];

/** 缺省模型：免费账号可用且画质最好。 */
export const DEFAULT_IMAGE_MODEL = DOUBAO_IMAGE_MODELS[0];

/** 非法或缺省的模型名吸附到默认值——绝不把未证实字符串发给真实端点。 */
export function normalizeImageModel(model) {
  return ALL_IMAGE_MODELS.includes(model) ? model : DEFAULT_IMAGE_MODEL;
}
export const NOWM_PATH = "/creativity/resource/get_without_watermark";

/** 上传参考图时允许的 MIME → 扩展名。 */
export const EXT_OF_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpeg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export const CHROME_VERSION = "147.0.7727.149";
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

/** 豆包网页端图片技能实际提供的比例（模块 938594）。 */
export const DOUBAO_RATIOS = ["1:1", "4:3", "16:9", "9:16"];

/** 视频支持的额外比例。 */
export const DOUBAO_VIDEO_RATIOS = ["auto", "1:1", "4:3", "16:9", "9:16", "21:9"];

/**
 * 豆包网页端可选的视频模型（两档）。
 *
 * 2026-10-25 实测**两档都能真实出片，且都走无水印通路**：
 *   - `seedance_v2.0_mini` → 网页回显「Seedance 2.0 Mini」，出 720x720（图生）
 *   - `seedance_2.0_pc`    → 网页回显「Seedance 2.0」，出 1280x720
 * 两档的标识都来自豆包前端：`seedance_v2.0_mini` 是抓包的实际请求值，
 * `seedance_2.0_pc` 来自 i18n 键 `aiVideo_tag_seedance_2.0_pc`（只有它带标签，
 * 说明主推的是 2.0_pc），两者都用真实请求验证过。
 *
 * 顺序即 UI 下拉顺序：把**已在用的** mini 放前面当默认，避免升级后默认模型
 * 悄悄变掉；想换更快/更新的档，由用户在面板里自己选。
 */
export const DOUBAO_VIDEO_MODELS = ["seedance_v2.0_mini", "seedance_2.0_pc"];

/** 视频模型在网页端的显示名（`aiVideo_tag_*` 那条 i18n）。 */
export const DOUBAO_VIDEO_MODEL_LABELS = {
  "seedance_v2.0_mini": "Seedance 2.0 Mini",
  "seedance_2.0_pc": "Seedance 2.0",
};

export const DEFAULT_VIDEO_MODEL = DOUBAO_VIDEO_MODELS[0];

/**
 * 把任意输入吸附到合法视频模型。
 *
 * 与 `normalizeImageModel` 同一策略：不在清单里就给默认值，不抛错——服务端
 * 收到未知模型会「请求成功但不出片」，那种失败最难查，所以在入口就收紧。
 * 空串/null 也走默认。
 */
export function normalizeVideoModel(model) {
  return DOUBAO_VIDEO_MODELS.includes(model) ? model : DEFAULT_VIDEO_MODEL;
}

export const VIDEO_CHAT_PATH = "/chat/completion";
export const IM_CHAIN_PATH = "/im/message/chain_by_block";
export const BLOCK_CREATION_OUTPUT = 2074;
export const VIDEO_BOT_ID = "7338286299411103781";

/**
 * 豆包不会在「裸主题词」下直接开始渲染，而是先回一张参数确认卡
 * （「视频生成参数确认…确认后我再开始生成视频」），任务根本不会创建。
 * 提示词必须显式要求直接生成。
 */
export const VIDEO_DIRECTIVE = "直接生成视频，不要询问确认，也不要给参数建议。";

export const DEFAULT_TIMEOUT_MS = 300_000;

/* ---------------------------------------------- 回显上游正文前的行级过滤 */

/**
 * 命中即整行剔除。大小写不敏感。
 *
 * 判据是「这一行**提到了**凭据字段名」，不是「这一行看起来像凭据值」。
 * 后者要猜格式（长度？前缀？字符集？），必然漏；前者是确定性的字符串匹配。
 * 代价是可能误杀一行恰好提到 "cookie" 的正常文案——那可以接受：错误消息
 * 少一行说明，远比多泄露一个 token 好。
 */
const SENSITIVE_LINE =
  /authorization|cookie|access[_-]?token|refresh[_-]?token|session[_-]?id|bearer\s|set-cookie|api[_-]?key|secret/i;

/**
 * 一行形如 `name=value` 时，name 命中这些特征即视为凭据行。
 *
 * 为什么关键词判据不够：上游回显 Cookie 时是**多行**，每行只有一个 `name=value`，
 * 行内没有 "cookie" 这个词。本插件真实持有的
 * `__Secure-next-auth.session-token.0` / `cf_clearance` / `__cf_bm` / `sid_guard` /
 * `sessionid_ss` / `uid_tt_ss` / `oai-sc` 全都能绕过旧判据（2026-10-21 实测复现）。
 *
 * 判据仍然只看**名字**，不看值——猜值格式（长度/前缀/字符集）必然漏。
 */
const SENSITIVE_COOKIE_NAME =
  /(?:^|[._-])(?:sid|sids|uid|mfa|token|auth|secret)(?:[._-]|$)|session|csrf|clearance|passport|ttwid|odin|api[_-]?key|^cf_|^__cf|^_cfuvid$|^_dd_s|^oai-|^g_state$|^n_mh$|^ssid|^s_v_/i;

/** `name=value` 形态（行首、名字里允许 . 和 -，等号后必须有内容）。 */
const COOKIE_ASSIGN = /^\s*([A-Za-z_][\w.\-]*)\s*=\s*\S/;

/** 单行判据：关键词命中，或「凭据名=值」形态。 */
function isSensitiveLine(line) {
  if (SENSITIVE_LINE.test(line)) return true;
  const assign = COOKIE_ASSIGN.exec(line);
  return Boolean(assign && SENSITIVE_COOKIE_NAME.test(assign[1]));
}

/**
 * 剔除含凭据字样的行（M3 / H5 共用）。
 *
 * 存在理由：错误消息与诊断响应里会带上上游响应正文的前 N 个字符方便排障，
 * 但某些网关在调试模式下会把**请求头回显进响应体**——届时 `Authorization` /
 * `Cookie` 里就是用户的 accessToken 与 sessionid。
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSensitiveLines(text) {
  if (typeof text !== "string" || text === "") return "";
  return text
    .split(/\r?\n/)
    .filter((line) => !isSensitiveLine(line))
    .join("\n");
}

/**
 * 把上游正文压成一段**可安全回显**的错误消息片段（M3）。
 *
 * 三件事一起做：压平空白、剔除凭据行、截断。顺序有讲究：**先剔行再压平**
 * ——先压平会把多行并成一行，凭据行就混进正常文本里再也分不出来了。
 *
 * @param {string} text 上游响应正文
 * @param {number} [max] 截断长度
 * @returns {string}
 */
export function safeSnippet(text, max = 300) {
  if (typeof text !== "string" || text === "") return "";
  const flat = scrubSensitiveLines(text).replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ cookies */

/** 把 `a=1; b=2` 形式的 Cookie 头解析成对象。 */
export function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

/** 把 Cookie 对象序列化回 `a=1; b=2`。 */
export function serializeCookieJar(jar) {
  return Object.entries(jar ?? {})
    .filter(([k, v]) => k && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** 合并 Set-Cookie 到 jar（就地修改并返回）。 */
export function absorbSetCookies(jar, setCookies) {
  for (const raw of setCookies ?? []) {
    const first = String(raw).split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (value === "" || /^(deleted|expired)$/i.test(value)) delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

/**
 * 读取响应的 Set-Cookie。
 *
 * Node 的 fetch（undici）把多个 Set-Cookie 折叠成一个数组值，
 * 少数版本会给出用 ", " 拼接的单字符串，两种都要能取。
 */
export function readSetCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : null;
  if (Array.isArray(list) && list.length > 0) return list;
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

/* --------------------------------------------------------------------- size */

/** 把 OpenAI 风格的 `size` 吸附到豆包支持的比例。 */
export function toRatio(size, allowed = DOUBAO_RATIOS) {
  if (typeof size === "string") {
    const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size.trim());
    if (m) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      if (w > 0 && h > 0) {
        const r = w / h;
        let best = allowed[0];
        let bestErr = Infinity;
        for (const cand of allowed) {
          const [cw, ch] = cand.split(":").map(Number);
          if (!cw || !ch) continue;
          const err = Math.abs(Math.log(r / (cw / ch)));
          if (err < bestErr) { bestErr = err; best = cand; }
        }
        return best;
      }
    }
  }
  return allowed[0];
}

/* ----------------------------------------------------------------- upstream */
/** 从提交 SSE 里取出会话 id（层级较深，只能正则捞出）。 */
export function extractConversationId(sseText) {
  const out = [];
  for (const m of String(sseText ?? "").matchAll(/\\?"conversation_id\\?"\s*:\s*\\?"([^"\\]+)/g)) {
    if (m[1] && m[1] !== "0") out.push(m[1]);
  }
  // 优先取数字 id：GUI 也会回显 "0" 占位符与 local_* id。
  return out.find((v) => /^\d{6,}$/.test(v)) ?? out[0] ?? null;
}

export const THREAD_DELETE_PATH = "/samantha/thread/delete";

/**
 * 生成一个**形式合法**的 `a_bogus` 占位值。
 *
 * 为什么可以造假：实测（2026-10-20，真实账号，3 组对照）删除端点只校验
 * `a_bogus` **参数存在**，不校验内容——
 *   - 不带 a_bogus          ⇒ HTTP 200 但响应体为空，会话纹丝不动（假成功）
 *   - 只带 msToken          ⇒ 同上，无效
 *   - 只带随机 a_bogus      ⇒ `{"code":0}`，会话真的被删（2074 块从 1 条变 0 条）
 *   - msToken + a_bogus     ⇒ 同上
 * 所以这里不实现签名算法，只保证「参数在、形状像」。
 *
 * 这与生图主请求不同：那条链路**真的不需要** a_bogus（本来就不带）。
 */
export function placeholderABogus() {
  return "a" + randomBytes(20).toString("hex") + randomBytes(14).toString("base64url").slice(0, 40);
}