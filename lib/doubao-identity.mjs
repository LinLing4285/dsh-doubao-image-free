/**
 * 设备身份与 msToken 的规范化。
 * 
 * H3（2026-10-18）之后设备身份**显式传参**，这里保留的是纯函数与
 * 一个仅供兼容的进程级单例（`setDeviceIdentity` 已标废弃）。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */

/**
 * 图片接口的安全参数。
 *
 * 这一组值是实测可用的固定值，不是从某个账号推导出来的，也不能随机化：
 * device_id / web_id / fp 必须与豆包服务端接受的形态一致。
 */
/**
 * 默认设备身份：**刻意不存在**。
 *
 * 历史包袱说明：这里曾经硬编码过一套 `fps` / `deviceId` / `webId`（来自开发机
 * 的浏览器），并在 `setDeviceIdentity` 里作为缺失字段的兜底。后果是任何用户
 * 都发着同一个设备身份，服务端立刻判异常（详见 `currentDevice` 的说明）。
 *
 * 现在改为必须由用户自己的浏览器导入（`lib/browser-login.mjs`）。
 * 保留这个名字只是为了在测试里断言「它不存在」，避免有人又加回来。
 */
import { randomUUID } from "node:crypto";

import { CHROME_VERSION } from "./doubao-core.mjs";

export const NO_DEFAULT_DEVICE = null;

/**
 * 当前生效的设备身份 —— **已废弃的模块单例，仅为兼容旧调用点保留**。
 *
 * ## 为什么它必须消失（H3，2026-10-18）
 *
 * 这个变量是**进程级单例**。`withDoubaoAccount` 的账号循环里每一步都先
 * `setDeviceIdentity(account.device)` 再发请求，单线程串行时是对的；但
 * `await` 之间会切到别的请求，于是：
 *
 *   请求 A 用账号 1（设备 X）开始生图
 *   → 请求 B 用账号 2 把 currentDevice 覆盖成 Y
 *   → A 的后续 HTTP 请求带着 **Y 的 fp + 账号 1 的 cookie**
 *
 * 豆包侧看到「设备与账号错配」，直接判 `710022004` 人机校验。这也解释了
 * 长期查不清的「李鬼号会话数异常」——两个号在同一进程里被并发交叉使用。
 *
 * 另有第二个缺陷：旧 `applyDoubaoDevice` 只在账号**有** device 时才设，
 * 手工粘贴 cookie 进来的账号（没有 device）会悄悄沿用**上一个账号**的
 * 设备指纹去请求。
 *
 * ## 现在的做法
 *
 * `securityParams(device)` / `editSecurityParams(device)` 收显式参数，
 * 设备身份**随请求走**，不再有跨请求共享的可变状态。Host 侧把
 * `account.device` 一路传到 `generateImage({ device })` 等入口。
 *
 * 这个变量与 `setDeviceIdentity()` 保留只为「还没改完的旧调用点」不立刻炸，
 * 生产路径已经不再读它（`securityParams` 的 device 参数优先）。
 * 新代码不得使用。
 */
let currentDevice = null;

/**
 * 把一份原始设备记录规整成请求可用的形状（纯函数）。
 *
 * 只要求 `fps`（来自 cookie 的 s_v_web_id）——那是登录后一定有、且真的会被
 * 服务端看到的字段。其余字段页面根本不存（2026-10-17 实测：localStorage 与
 * cookie 里都没有 device_id / tea_uuid / web_id 独立项），**缺失就用空串**，
 * 不再整批拒绝，也不再回退到任何默认值。
 *
 * @param {object} [device] `{ fps, deviceId?, webId?, teaUuid?, pcVersion? }`
 * @returns {object|null} 规整后的设备身份；不像设备身份时返回 null
 */
export function normalizeDevice(device) {
  const looksLikeFp = device && typeof device === "object"
    && typeof device.fps === "string" && /^verify_[A-Za-z0-9_]{10,}$/.test(device.fps);
  if (!looksLikeFp) return null;
  const text = (value) => (typeof value === "string" ? value : "");
  return {
    fps: device.fps,
    deviceId: text(device.deviceId),
    webId: text(device.webId),
    teaUuid: text(device.teaUuid),
    pcVersion: /^\d+\.\d+(\.\d+)?$/.test(text(device.pcVersion)) ? device.pcVersion : "3.41.4",
  };
}

/**
 * 注入用户自己浏览器导入的设备身份（**已废弃，见 `currentDevice`**）。
 *
 * 保留是为了旧调用点不立刻炸；新代码请把 `device` 显式传给
 * `generateImage({ device })` / `editImage({ device })` / `generateVideo({ device })`。
 *
 * @param {object} [device] `{ fps, deviceId?, webId?, teaUuid?, pcVersion? }`
 */
export function setDeviceIdentity(device) {
  currentDevice = normalizeDevice(device);
}

/** 当前设备身份快照（测试与诊断用）。没导入过返回 null。 */
export function getDeviceIdentity() {
  return currentDevice ? { ...currentDevice } : null;
}

/** 是否已经导入了设备身份。生成前应先查这个，没有就提示用户登录。 */
export function hasDeviceIdentity() {
  return currentDevice !== null;
}

/**
 * `msToken` 的显式参数默认值。
 *
 * 空串表示**不发这个参数**。为什么不自己造：实测（2026-10-17，真实账号，
 * 四次各隔 20 秒）
 *   - 抓包里的真 msToken（168 字符）  → ✅ 出图
 *   - 自造的随机串（同长度、同字符集）   → ✗ 710022002「当前服务访问频繁」
 *   - 不带 msToken 参数              → ✅ 出图
 *   - 真 msToken 再试一次             → ✅ 出图
 * ⇒ 服务端校的是这个值的**真实性**，不是存在性。造一个假的比不传更糟。
 *
 * ## 为什么也要参数化
 *
 * 它和 `currentDevice` 一样是进程级单例，同样会被并发请求互相覆盖。虽然
 * 目前只有一个调用方按账号注入，但既然设备身份已经参数化了，`msToken`
 * 留着单例就是同一类隐患的下一次复发。
 */
export function normalizeMsToken(token) {
  return typeof token === "string" && token.length >= 100 ? token : "";
}

/**
 * 已废弃的 msToken 单例（同 `currentDevice`：只为兼容未迁移的调用点）。
 *
 * 生产路径优先用 `securityParams({ msToken })` 的显式参数；两者都没有时
 * 就不发这个参数——造一个假的比不传更糟。
 */
export let currentMsToken = "";

/** 已废弃：见 `normalizeMsToken`。仅为旧调用点保留。 */
export function setMsToken(token) {
  currentMsToken = normalizeMsToken(token);
}

/**
 * 图片接口的安全参数。
 *
 * @param {object} [options]
 * @param {object} [options.device] 设备身份；缺省时**回落到已废弃的单例**
 *   （`setDeviceIdentity` 注入的），仅为兼容未迁移的调用点。
 * @param {string} [options.msToken] 真实的 msToken；空串表示不发
 */
export function securityParams({ device, msToken } = {}) {
  /*
   * 设备身份优先用显式参数，没有才看单例（兼容期）。
   *
   * 没有身份就直接报错。不要退化成「发一组空值」或「借用一个默认身份」：
   * 前者必被风控拒绝且错误信息难懂，后者是把别人的设备身份发给服务端。
   */
  const resolved = normalizeDevice(device) ?? currentDevice;
  if (!resolved) {
    const missing = new Error("尚未导入设备身份：请先在插件里点「登录豆包」，用你自己的浏览器完成登录");
    /*
     * 打标志，让账号池知道「这是**这一个**账号的残缺，不是全局问题」。
     *
     * 场景：手工粘贴 cookie 进来的账号拿不到设备身份。它排在池首时如果直接终止，
     * 后面通过浏览器登录、身份齐全的账号就永远没机会出图——2026-10-17 实测踩到。
     */
    missing.missingDevice = true;
    throw missing;
  }
  const params = {
    aid: "582478", real_aid: "582478",
    device_id: resolved.deviceId, tea_uuid: resolved.teaUuid,
    web_id: resolved.webId,
    device_platform: "web", language: "zh", region: "CN", sys_region: "CN",
    pkg_type: "release_version", version_code: "20800",
    pc_version: "2.1.7", chromium_version: CHROME_VERSION,
    client_platform: "pc_client", runtime: "web", runtime_version: "3.5.4",
    samantha_web: "1", "use-olympus-account": "1",
    fp: resolved.fps,
    web_tab_id: randomUUID(),
  };
  // 没真值就不发：发假串会被判成异常请求（见 normalizeMsToken 的实测记录）。
  const token = normalizeMsToken(msToken) || currentMsToken;
  if (token !== "") params.msToken = token;
  return params;
}

/**
 * 新网页编辑协议使用浏览器形态，设备身份沿用插件自有值。
 *
 * @param {object} [options] 同 `securityParams`
 */
export function editSecurityParams(options = {}) {
  const { device_id, tea_uuid, web_id, fp, msToken } = securityParams(options);
  const resolved = normalizeDevice(options.device) ?? currentDevice;
  return {
    aid: "497858", real_aid: "497858", device_id, tea_uuid, web_id, fp,
    device_platform: "web", doubao_device_platform: "web", web_platform: "browser",
    pkg_type: "release_version", version_code: "20800",
    // 版本号也用真实浏览器的：抓包显示网页端是 3.41.4，写死 3.41.2 会被当成旧客户端。
    pc_version: resolved.pcVersion, doubao_pc_version: resolved.pcVersion,
    language: "zh", region: "CN", sys_region: "CN", samantha_web: "1",
    "use-olympus-account": "1", tz_name: "Asia/Shanghai", web_tab_id: randomUUID(),
    // 只有拿到真值才带；自造串会被判异常（见 normalizeMsToken 的实测记录）。
    ...(msToken === undefined ? {} : { msToken }),
  };
}

/**
 * 视频接口的安全参数。
 *
 * 与图片接口不同：新 GUI 端点把自己标识为桌面构建
 * （doubao_device_platform=desktop、pc_version=2.31.4、channel=win）。
 * 把图片那组参数发给 IM 端点会得到 710010703「调用下游服务器失败」。
 *
 * 这套值是**端点协议的一部分**（桌面构建标识），不是某个账号的设备身份，
 * 所以不从 `device` 取。但它同样收显式 `msToken`，不再读模块单例。
 *
 * @param {object} [options] 同 `securityParams`（只用到 msToken）
 */
