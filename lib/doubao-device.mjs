/**
 * 从真实浏览器导入豆包的**设备身份**。
 *
 * ## 为什么需要这个
 *
 * 豆包把 `fp` / `device_id` / `web_id` / `tea_uuid` 与 cookie 交叉校验。
 * 插件原先写死一套 2026-10 的旧身份，配任何真实 cookie 都会被判成异常请求：
 * 服务端 0.4 秒回 `710022004`（`type: verify`，进人机校验队列），永远不出图。
 *
 * 换成与 cookie 配套的真实身份后，同一个请求立刻变成 `710022002`
 * （「访问频繁」，普通频率限制）——即请求终于被当成正常用户了。
 *
 * ## 身份从哪来
 *
 * 1. `s_v_web_id` 存在 cookie 里，形如 `verify_xxx_yyy_zzz`，里面**已经包含**
 *    请求参数要的 `fp`（前两段）与 `web_id`（后三段）。
 *    实测：cookie `s_v_web_id = verify_mu1g1rj3_48qcGAQA_tTur_4orZ_8bP3_rtGxy3hADeUc`
 *          请求 `fp        = verify_mvbusezj_NAZSTpB1_...`（不同设备当然不同，
 *          但**同一设备上二者前半段一致**，所以按 cookie 推导是成立的）
 * 2. 剩余字段（`device_id` / `tea_uuid` / `pc_version`）从页面的 localStorage
 *    或 `window` 上取；取不到就沿用已有的值，只更新能确认的部分。
 *
 * ## 为什么不停留在「硬编码就当没事」
 *
 * 硬编码的身份属于别人的设备。带着别人的 `device_id` 配自己的 cookie，
 * 正是风控最典型的异常特征——这不是运气问题，是结构性的。
 */

import { evaluate, CdpConnection, cdpTargets } from "./cdp.mjs";

/**
 * 从 cookie 里的 `s_v_web_id` 推出 `fp` 与 `web_id`。
 *
 * `s_v_web_id` 的形态是 `verify_<4段>`：
 *   verify_mu1g1rj3_48qcGAQA_tTur_4orZ_8bP3_rtGxy3hADeUc
 *   └─ fp（前两段）─┘ └──── web_id（后三段，去掉下划线？）────┘
 *
 * 实测网页端的 `web_id` 是纯数字（7697477734046533120），不是从这里来的。
 * 所以本函数**只负责推 `fp`**，`web_id` 不猜。
 *
 * @param {string} sVWebId cookie 里的 s_v_web_id 值
 * @returns {string} 形如 `verify_xxx_yyy` 的 fp；推不出则空串
 */
export function fpFromSvWebId(sVWebId) {
  if (typeof sVWebId !== "string") return "";
  const parts = sVWebId.split("_");
  // verify + 至少两段式子串才够成 fp
  if (parts.length < 3 || parts[0] !== "verify") return "";
  return parts.slice(0, 3).join("_");
}

/**
 * 从 cookie 头里取某个 cookie 的值（L3：不再把 name 插进正则）。
 *
 * ## 为什么不用正则
 *
 * 旧实现是 ``new RegExp(`(?:^|;\\s*)${name}=([^;]*)`) `` —— 把 `name` 直接
 * 拼进正则源码。当前所有调用方都是内部常量（`sessionid`、`s_v_web_id`），
 * **当前不可利用**；但这是埋着的注入点：一旦将来有人传用户输入，正则元字符
 * 会导致匹配错乱，恶意构造还能触发 ReDoS。
 *
 * 改成逐段 `split(";")` 再比对（与 `lib/sessions.mjs` 的 `sessionIdOf` 同构）。
 * 字符串比较没有元字符概念，从根上不存在注入。
 *
 * @param {string} cookieHeader 形如 `a=1; b=2` 的 Cookie 头
 * @param {string} name cookie 名
 * @returns {string} 值；找不到返回空串
 */
export function cookieValue(cookieHeader, name) {
  const wanted = String(name ?? "").trim();
  if (wanted === "") return "";
  for (const part of String(cookieHeader ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    // 只 trim 键，值按原样保留（cookie 值里可以有除分号外的一切字符）。
    if (part.slice(0, eq).trim() !== wanted) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

/**
 * 在页面上下文里读设备身份。
 *
 * 这些键名是豆包网页端自己用的，写在 localStorage 里（豆包前端靠它做设备识别）。
 * 读不到就返回空串——**绝不编造**：宁可只更新 fp，也不拿随机数冒充真实身份。
 */
const PAGE_PROBE = `(() => {
  const read = (key) => {
    try { return String(window.localStorage.getItem(key) ?? ""); } catch { return ""; }
  };
  const num = (value) => (/^\\d{6,}$/.test(value) ? value : "");
  return JSON.stringify({
    deviceId: num(read("device_id") || read("deviceId") || ""),
    teaUuid: num(read("tea_uuid") || read("teaUuid") || ""),
    webId: num(read("web_id") || read("webId") || ""),
    pcVersion: (() => {
      const v = read("pc_version") || "";
      return /^\\d+\\.\\d+(\\.\\d+)?$/.test(v) ? v : "";
    })(),
  });
})()`;

/**
 * 连到已登录豆包的浏览器，读出设备身份。
 *
 * @param {number} port CDP 端口（豆包桌面端默认 19222，见 README）
 * @returns {Promise<{fps?: string, deviceId?: string, webId?: string, teaUuid?: string, pcVersion?: string}>}
 * @throws 连不上 / 页面里读不到时抛错，由调用方决定怎么提示
 */
export async function readDeviceIdentityFromBrowser(port = 19222, { timeoutMs = 15_000 } = {}) {
  const targets = await cdpTargets(port, { timeoutMs });
  const target = targets.find((item) => typeof item.url === "string" && item.url.startsWith("https://www.doubao.com"));
  if (!target) throw new Error("没找到已登录豆包的标签页，请先在浏览器里打开 www.doubao.com");

  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl, { timeoutMs });
  try {
    const raw = await evaluate(conn, PAGE_PROBE);
    let parsed = {};
    try { parsed = JSON.parse(raw) ?? {}; } catch { /* 页面没给合法 JSON，按下全体字段缺失处理 */ }
    /*
     * `fp` 取自页面 cookie 里的 `s_v_web_id`。
     *
     * 为什么不从调用方传进来的 cookieHeader 推：那份 cookie 可能来自别处
     * （手工粘贴 / 扫码登录），与这个浏览器**不是同一设备**，混用会造出
     * 「半真半假」的身份，比全用旧值更容易被风控盯上。既然连上了浏览器，
     * 就以这个浏览器的身份为准。
     */
    const sVWebId = await evaluate(conn, `document.cookie.split('; ').find(c => c.startsWith('s_v_web_id='))?.slice(11) ?? ""`);
    return { fps: fpFromSvWebId(sVWebId), ...parsed };
  } finally {
    conn.close();
  }
}
