/**
 * 凭据自动续期的通用骨架。
 *
 * ## 为什么需要
 * 两边凭证都会过期，而且来源都是「浏览器里的登录态」：
 *   - GPT：`accessToken`（JWT，实测 5.8 天）+ `__Secure-next-auth.session-token`
 *     cookie（约 3 个月）。token 过期后**无法用 refreshToken 换新**（OpenAI 的
 *     `/api/auth/session` 不下发 refreshToken，也没有公开的刷新端点），
 *     唯一出路是带着仍然有效的 session cookie 重新读一次页面。
 *   - 豆包：`sessionid` + `sid_guard`。`sid_guard` 的格式是
 *     `sessionid|签发时间戳|有效期秒数|到期日文本`，实测有效期 30 天。
 *
 * 两边的共同点：**只要浏览器 profile 里的登录态还在，就能无感重新取一遍**。
 *
 * ## 设计
 * 不在后台常驻轮询（那是白白消耗资源），而是**使用时判断**：
 *   1. 调用前先看凭证剩余有效期；
 *   2. 低于阈值才触发续期；
 *   3. 续期失败不阻断主流程 —— 原凭证往往还能用几分钟到几小时，
 *      真正的失败留给业务层按自己的错误码处理。
 *
 * ## 阈值
 * `REFRESH_MARGIN_MS` 取 2 天：比 GPT token 的 5.8 天寿命短得多，
 * 留出足够余量给「这一次续期失败、下次还有机会」。
 */

/** 剩余有效期低于这个值就触发续期。 */
export const REFRESH_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/** 单次续期最多等多久（拉起浏览器 + 读页面）。 */
export const REFRESH_TIMEOUT_MS = 90_000;

/**
 * 从 JWT 里读 `exp`（秒）。读不出来返回 0，视为「不知道」而不是「已过期」。
 * @param {string} token
 * @returns {number} 过期时刻的毫秒时间戳；0 表示无法判断
 */
export function jwtExpiresAtMs(token) {
  const text = String(token ?? "");
  const parts = text.split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * 解析豆包 `sid_guard` 得到过期时刻。
 *
 * 实测格式（2026-10-18）：
 *   `e5f40738...|1792230085|2592000|Mon,+16-Nov-2026+09:41:25+GMT`
 *     [0] sessionid  [1] **签发**时间戳(秒)  [2] 有效期(秒)  [3] 到期日文本
 *
 * 注意 [1] 是**签发时间**不是到期时间 —— 把 [1] 当到期会得到「已经过期」的
 * 假结论（本文件的第一版就这么错过）。到期 = 签发 + 有效期。
 *
 * @param {string} cookieHeader 完整 cookie 头
 * @returns {number} 过期时刻的毫秒时间戳；0 表示无法判断
 */
export function doubaoSessionExpiresAtMs(cookieHeader) {
  const m = /(?:^|;\s*)sid_guard=([^;]+)/.exec(String(cookieHeader ?? ""));
  if (!m) return 0;
  let value = m[1];
  try {
    value = decodeURIComponent(value);
  } catch {
    /* 保持原样 */
  }
  const parts = value.split("|");
  if (parts.length < 3) return 0;
  const issued = Number(parts[1]);
  const lifetime = Number(parts[2]);
  if (!Number.isFinite(issued) || !Number.isFinite(lifetime) || issued <= 0 || lifetime <= 0) return 0;
  return (issued + lifetime) * 1000;
}

/**
 * 还剩多少毫秒；返回 0 表示「无法判断」（不当作已过期）。
 * @param {number} expiresAtMs
 * @param {number} [now]
 */
export function remainingMs(expiresAtMs, now = Date.now()) {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return 0;
  return expiresAtMs - now;
}

/**
 * 是否该续期。
 *
 * `unknownPolicy`：
 *   - `"refresh"`（默认）：读不到过期时间就续一次 —— 宁可多跑一次浏览器，
 *     也不要拿一个可能已经死掉的凭证去撞墙。
 *   - `"keep"`：读不到就当作还有效，什么也不做。
 * @param {number} expiresAtMs
 * @param {{marginMs?: number, now?: number, unknownPolicy?: "refresh"|"keep"}} [opts]
 */
export function shouldRefresh(expiresAtMs, opts = {}) {
  const { marginMs = REFRESH_MARGIN_MS, now = Date.now(), unknownPolicy = "refresh" } = opts;
  const expiresAt = Number(expiresAtMs);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return unknownPolicy === "refresh";
  return now + marginMs >= expiresAt;
}

/**
 * 串行化：同一时刻只允许一次续期在跑。
 *
 * 两个并发的生图请求同时发现 token 要过期，不应该起两个浏览器。
 * 后到的调用等待前一次的结果并复用。
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function createSingleFlight(task) {
  /** @type {Promise<any> | null} */
  let inflight = null;
  return function run() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        return await task();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}

/** 带超时的 promise 包装；超时不取消底层任务，只让调用方尽快返回。 */
export async function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 人类可读的剩余时间，用于 UI 与日志。
 * @param {number} expiresAtMs
 * @param {string[]} [units] 需要的单位，默认天/小时
 */
export function describeRemaining(expiresAtMs, units = ["天", "小时"]) {
  const ms = remainingMs(expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return "未知";
  if (ms <= 0) return "已过期";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const parts = [];
  if (units.includes("天") && days > 0) parts.push(`${days} 天`);
  if (units.includes("小时") && hours > 0) parts.push(`${hours} 小时`);
  return parts.length ? parts.join(" ") : "不到 1 小时";
}
