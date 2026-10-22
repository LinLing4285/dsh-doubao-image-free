/**
 * 豆包（www.doubao.com）网页版协议 — 纯 HTTP 直连实现。
 *
 * ## 本文件现在只是**汇总出口**（2026-10-19 拆分）
 *
 * 原实现有 2157 行，全部堆在这一个文件里。按依赖方向拆成 6 个模块后，
 * 这里只做 re-export，让 `import ... from "./lib/doubao.mjs"` 的既有调用方
 * **一行都不用改**。
 *
 * 模块层次（箭头指向被依赖方）：
 *
 *   core        常量、模型表、cookie 工具、尺寸换算、行级脱敏（无内部依赖）
 *   identity    设备身份与 msToken 规范化
 *   upstream    安全参数、请求体、SSE 解析、图片字节
 *   image       生图 / 图生图 / ImageX 上传 / SigV4
 *   video       生视频
 *   diag        只读会话诊断
 *
 * 依赖是**单向**的（`scripts/analyze-doubao-deps.mjs` 实测确认），
 * 所以不存在循环 import。
 *
 * ## 协议要点（历史说明，保留）
 *
 * 不含 HTTP 服务、不含子进程、不写日志文件：全部逻辑跑在调用方进程里，
 * 通过导出函数直接被 Host 侧调用。Cookie 由调用方传入（来自浏览器登录或
 * 手工粘贴），本模块不持久化任何凭据。
 *
 * 四条通路，均已实测定型：
 *
 *   1. 文生图 — POST /samantha/chat/completion（SSE）
 *   2. 无水印原图 — POST /creativity/resource/get_without_watermark
 *   3. 图生图 — 参考图先进 ImageX（SigV4 签名），再以 block_type 10052 引用
 *   4. 生视频 — 桌面 GUI 协议（/chat/completion + /im/message/chain_by_block）
 *
 * 风控说明：`710022004 + type=verify` 不是限速而是人机校验，纯 HTTP 解不开；
 * 兜底路径见 `lib/browser-image.mjs`。
 */

// ── core：常量、工具 ────────────────────────────────────────────────────
export {
  DOUBAO_IMAGE_MODELS,
  DOUBAO_IMAGE_MODELS_SUBSCRIBED,
  DOUBAO_RATIOS,
  DOUBAO_VIDEO_RATIOS,
  DEFAULT_VIDEO_MODEL,
  extractConversationId,
  scrubSensitiveLines,
  safeSnippet,
  parseCookieHeader,
  serializeCookieJar,
  absorbSetCookies,
  toRatio,
} from "./doubao-core.mjs";

// ── identity：设备身份 ──────────────────────────────────────────────────
export {
  NO_DEFAULT_DEVICE,
  normalizeDevice,
  setDeviceIdentity,
  getDeviceIdentity,
  hasDeviceIdentity,
  normalizeMsToken,
  setMsToken,
} from "./doubao-identity.mjs";

// ── upstream：HTTP 基础 ─────────────────────────────────────────────────
export { sniffMime, looksLikeAuthFailure } from "./doubao-upstream.mjs";

// ── image：生图 / 图生图 ────────────────────────────────────────────────
export { generateImage, editImage, deleteConversation, canonicalQuery, signImagex } from "./doubao-image.mjs";

// ── video：生视频 ───────────────────────────────────────────────────────
export { generateVideo, videoDimensions } from "./doubao-video.mjs";

// ── diag：只读诊断 + 合并后的 __internals ───────────────────────────────
export {
  diagRedact,
  parseConversationDiagnosis,
  fetchConversationDiagnosis,
  __internals,
} from "./doubao-diag.mjs";