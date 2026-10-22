/**
 * 续期协调层：把「该不该续 / 怎么续 / 续完存哪」串起来。
 *
 * 分四层，各管一件事：
 *   `credential-renew.mjs`    纯函数：算过期时间、判断是否该续
 *   `credential-browser.mjs`  只读读取：起浏览器把登录态重新读一遍
 *   `credential-sync.mjs`     本文件：判据 + 调用 + 落盘
 *   调用方（index.js / doubao.mjs / gpt-free.mjs）只管「我发现凭证快过期了，帮我续一下」
 *
 * ## 为什么不在后台定时跑
 * 常驻轮询要在进程活着时一直开着浏览器或定时器，代价和收益不成比例。
 * 这里的策略是**用到才续**：每次真正要发请求之前看一眼剩余有效期。
 *
 * ## 失败绝不阻断主流程
 * 续期是「提前准备好」，不是「必须成功」。续期失败时原凭证往往还有几小时
 * 到几天可用，让业务照常跑；真的不能用时业务层自己的错误处理更准确。
 */
import {
  REFRESH_MARGIN_MS,
  describeRemaining,
  doubaoSessionExpiresAtMs,
  jwtExpiresAtMs,
  remainingMs,
  shouldRefresh,
} from "./credential-renew.mjs";
import { renewDoubaoOnce, renewGptOnce } from "./credential-browser.mjs";

/**
 * 豆包：检查账号池里每个账号的 `sid_guard`，快过期的就续。
 *
 * 续的是**浏览器里的那一个登录态**，所以只有「当前浏览器登录的那个账号」
 * 能被续上。多个账号时其余账号要用户自己去登 —— 这里如实报告，不假装成功。
 *
 * @param {object} opts
 * @param {{accounts: object[], activeId?: string}} opts.pool 账号池快照
 * @param {(input: {cookieHeader: string, device: object, msToken?: string}) => Promise<any>} opts.persist 写回账号池
 * @param {string} [opts.profileDir]
 * @param {number} [opts.marginMs]
 * @param {(input: {key: string, userDataDir?: string}) => Promise<{cookieHeader: string, device: object, msToken?: string}>} [opts.renew]
 *   真正执行续期的函数。**默认才是拉起浏览器**；传进来就完全用它。
 *   存在的意义：让单元测试能验证「续期后的写回 / 句柄校验 / 失败降级」
 *   而不产生任何真实副作用 —— 早期版本的测试直接调真实路径，
 *   结果每跑一次变异测试就反复拉起浏览器（用户看到窗口一直在闪）。
 * @returns {Promise<{ok: boolean, refreshed: string[], skipped: object[], reason?: string}>}
 */
export async function ensureDoubaoFresh({ pool, persist, profileDir, marginMs = REFRESH_MARGIN_MS, renew = renewDoubaoOnce } = {}) {
  const accounts = Array.isArray(pool?.accounts) ? pool.accounts : [];
  if (accounts.length === 0) return { ok: false, refreshed: [], skipped: [], reason: "empty-pool" };

  const due = [];
  const skipped = [];
  for (const account of accounts) {
    const expiresAt = doubaoSessionExpiresAtMs(account?.cookieHeader);
    /*
     * 读不到 `sid_guard` 的账号永远续不回来：浏览器里不会凭空出现一个
     * 已经失效的登录态。把它当「待续」只会白起一次浏览器，然后发现
     * 浏览器里的 sessionid 对不上而失败 —— 这里直接跳过并如实记录。
     *
     * （这与 `shouldRefresh` 的 `unknownPolicy:"refresh"` 不同：那个默认值
     *   是为「能读到凭证但读不出过期时间」准备的，豆包这边读不到 sid_guard
     *   就是凭证本身不完整。）
     */
    if (expiresAt <= 0) {
      skipped.push({ id: account?.id ?? "", remaining: "未知（无 sid_guard，需重新登录）" });
      continue;
    }
    if (shouldRefresh(expiresAt, { marginMs })) due.push({ account, expiresAt });
    else skipped.push({ id: account?.id ?? "", remaining: describeRemaining(expiresAt) });
  }

  // 都没到点：不做任何事，这是常态。
  if (due.length === 0) return { ok: true, refreshed: [], skipped, reason: "not-due" };

  let fresh;
  try {
    fresh = await renew({ key: "doubao", userDataDir: profileDir });
  } catch (error) {
    return { ok: false, refreshed: [], skipped, reason: withRemaining(error, due) };
  }

  /*
   * 浏览器里只有一个登录态。只有它的 sessionid 与某个待续账号一致时才写回，
   * 否则会把账号 A 的 cookie 写到账号 B 名下 —— 那是错配，比不续更糟。
   */
  const sessionId = cookieValue(fresh.cookieHeader, "sessionid");
  const target = due.find(({ account }) => account?.id === sessionId);
  if (!target) {
    return { ok: false, refreshed: [], skipped, reason: `浏览器里的账号（${short(sessionId)}）不在待续名单里` };
  }

  try {
    await persist?.({ cookieHeader: fresh.cookieHeader, device: fresh.device, msToken: fresh.msToken });
  } catch (error) {
    return { ok: false, refreshed: [], skipped, reason: `续期成功但写回失败：${error.message}` };
  }
  return { ok: true, refreshed: [sessionId], skipped, reason: "ok" };
}

/**
 * GPT：token 是 JWT，过期时间就在 `exp` 里。
 *
 * @param {object} opts
 * @param {{accessToken?: string}} opts.credential 当前凭据
 * @param {(input: {accessToken: string, cookieHeader: string, oaiDeviceId?: string}) => Promise<any>} opts.persist
 * @param {string} [opts.userDataDir]
 * @param {number} [opts.marginMs]
 * @param {(cookieHeader: string) => string} [opts.deviceIdOf] 从 cookie 里取 oai-device-id
 * @param {(input: {key: string, userDataDir?: string}) => Promise<{accessToken: string, cookieHeader: string}>} [opts.renew]
 *   同 `ensureDoubaoFresh` 的 `renew`：默认才拉浏览器，测试里换成假的。
 * @returns {Promise<{ok: boolean, remaining?: string, reason?: string}>}
 */
export async function ensureGptFresh({ credential, persist, userDataDir, marginMs = REFRESH_MARGIN_MS, deviceIdOf, renew = renewGptOnce } = {}) {
  const expiresAt = jwtExpiresAtMs(credential?.accessToken);
  if (!shouldRefresh(expiresAt, { marginMs })) {
    return { ok: true, remaining: describeRemaining(expiresAt), reason: "not-due" };
  }

  let fresh;
  try {
    fresh = await renew({ key: "gpt", userDataDir });
  } catch (error) {
    return { ok: false, remaining: describeRemaining(expiresAt), reason: error.message };
  }

  const nextExpiresAt = jwtExpiresAtMs(fresh.accessToken);
  // 读到的 token 比现有的还旧（例如页面缓存），不写回，免得把好凭证换掉。
  if (nextExpiresAt > 0 && expiresAt > 0 && nextExpiresAt <= expiresAt) {
    return { ok: false, remaining: describeRemaining(expiresAt), reason: "浏览器里的 token 不比现有的新，保持原样" };
  }

  try {
    const oaiDeviceId = typeof deviceIdOf === "function" ? deviceIdOf(fresh.cookieHeader) : "";
    await persist?.({ accessToken: fresh.accessToken, cookieHeader: fresh.cookieHeader, oaiDeviceId });
  } catch (error) {
    return { ok: false, remaining: describeRemaining(nextExpiresAt), reason: `续期成功但写回失败：${error.message}` };
  }
  return { ok: true, remaining: describeRemaining(nextExpiresAt), reason: "ok" };
}

/** 从 cookie 头里取某个名字的值。 */
function cookieValue(cookieHeader, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(cookieHeader ?? ""));
  return m ? m[1] : "";
}

function short(id) {
  return id ? `${id.slice(0, 8)}…` : "(空)";
}

function withRemaining(error, due) {
  const remain = due.map(({ account, expiresAt }) => `${short(account?.id)} ${describeRemaining(expiresAt)}`).join("、");
  const message = error && error.message ? error.message : String(error);
  return `${message}（原凭证剩余：${remain}）`;
}

/** 供设置页显示：单个豆包账号还剩多久。 */
export function doubaoRemainingText(cookieHeader) {
  return describeRemaining(doubaoSessionExpiresAtMs(cookieHeader));
}

/** 供设置页显示：GPT token 还剩多久。 */
export function gptRemainingText(accessToken) {
  return describeRemaining(jwtExpiresAtMs(accessToken));
}

export { remainingMs };
