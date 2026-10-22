/**
 * ChatGPT sentinel Proof-of-Work solver.
 *
 * 配置槽结构移植自 fran0220/chatgpt2api handler/pow.go（Go），但**槽 5 / 槽 6 改为可注入**
 * —— 源头实现 basketikun/chatgpt2api（Python `utils/pow.py` 的 `build_pow_config`）是从
 * chatgpt.com 首页 HTML 里现场抓 `<script src>` 与 `data-build`，而不是写死 sdk.js。
 * 写死会在上游换构建后失配，见 `lib/gpt-free.mjs` 的 bootstrap。
 *
 * Uses only node: builtins — sha3-512 is native in OpenSSL 3.x, so no
 * third-party hash dependency is needed.
 */

import { createHash, randomUUID, randomInt, randomBytes } from "node:crypto";

const MAX_ITERATIONS = 500_000;

/** 兜底脚本地址：首页抓不到任何 `<script src>` 时用它（Python 版同名常量）。 */
export const DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const SCREEN_SIZES = [3000, 4000, 3120, 4160];
const CORE_COUNTS = [8, 16, 24, 32];

const NAVIGATOR_KEYS = [
  "registerProtocolHandler\u2212function registerProtocolHandler() { [native code] }",
  "storage\u2212[object StorageManager]",
  "locks\u2212[object LockManager]",
  "appCodeName\u2212Mozilla",
  "permissions\u2212[object Permissions]",
  "share\u2212function share() { [native code] }",
  "webdriver\u2212false",
  "managed\u2212[object NavigatorManagedData]",
  "canShare\u2212function canShare() { [native code] }",
  "vendor\u2212Google Inc.",
  "mediaDevices\u2212[object MediaDevices]",
  "vibrate\u2212function vibrate() { [native code] }",
  "storageBuckets\u2212[object StorageBucketManager]",
  "mediaCapabilities\u2212[object MediaCapabilities]",
  "getGamepads\u2212function getGamepads() { [native code] }",
  "bluetooth\u2212[object Bluetooth]",
  "cookieEnabled\u2212true",
  "virtualKeyboard\u2212[object VirtualKeyboard]",
  "product\u2212Gecko",
  "xr\u2212[object XRSystem]",
  "clipboard\u2212[object Clipboard]",
  "unregisterProtocolHandler\u2212function unregisterProtocolHandler() { [native code] }",
  "productSub\u221220030107",
  "login\u2212[object NavigatorLogin]",
  "vendorSub\u2212",
  "getInstalledRelatedApps\u2212function getInstalledRelatedApps() { [native code] }",
  "webkitGetUserMedia\u2212function webkitGetUserMedia() { [native code] }",
  "appName\u2212Netscape",
  "presentation\u2212[object Presentation]",
  "onLine\u2212true",
  "mimeTypes\u2212[object MimeTypeArray]",
  "credentials\u2212[object CredentialsContainer]",
  "serviceWorker\u2212[object ServiceWorkerContainer]",
  "keyboard\u2212[object Keyboard]",
  "gpu\u2212[object GPU]",
  "doNotTrack",
  "clearAppBadge\u2212function clearAppBadge() { [native code] }",
  "serial\u2212[object Serial]",
  "requestMIDIAccess\u2212function requestMIDIAccess() { [native code] }",
  "requestMediaKeySystemAccess\u2212function requestMediaKeySystemAccess() { [native code] }",
  "pdfViewerEnabled\u2212true",
  "language\u2212zh-CN",
  "setAppBadge\u2212function setAppBadge() { [native code] }",
  "geolocation\u2212[object Geolocation]",
  "userAgentData\u2212[object NavigatorUAData]",
  "getUserMedia\u2212function getUserMedia() { [native code] }",
  "sendBeacon\u2212function sendBeacon() { [native code] }",
  "hardwareConcurrency\u221232",
  "windowControlsOverlay\u2212[object WindowControlsOverlay]",
  "scheduling\u2212[object Scheduling]",
];

const DOCUMENT_KEYS = ["_reactListeningo743lnnpvdg", "location"];

const WINDOW_KEYS = [
  "0", "window", "self", "document", "name", "location", "customElements",
  "history", "navigation", "locationbar", "menubar", "personalbar",
  "scrollbars", "statusbar", "toolbar", "status", "closed", "frames",
  "length", "top", "opener", "parent", "frameElement", "navigator",
  "origin", "external", "screen", "innerWidth", "innerHeight", "scrollX",
  "pageXOffset", "scrollY", "pageYOffset", "visualViewport", "screenX",
  "screenY", "outerWidth", "outerHeight", "devicePixelRatio",
  "clientInformation", "screenLeft", "screenTop", "styleMedia", "onsearch",
  "isSecureContext", "trustedTypes", "performance", "onappinstalled",
  "onbeforeinstallprompt", "crypto", "indexedDB", "sessionStorage",
  "localStorage", "onbeforexrselect", "onabort", "onbeforeinput",
  "onbeforematch", "onbeforetoggle", "onblur", "oncancel", "oncanplay",
  "oncanplaythrough", "onchange", "onclick", "onclose",
  "oncontentvisibilityautostatechange", "oncontextlost", "oncontextmenu",
  "oncontextrestored", "oncuechange", "ondblclick", "ondrag", "ondragend",
  "ondragenter", "ondragleave", "ondragover", "ondragstart", "ondrop",
  "ondurationchange", "onemptied", "onended", "onerror", "onfocus",
  "onformdata", "oninput", "oninvalid", "onkeydown", "onkeypress",
  "onkeyup", "onload", "onloadeddata", "onloadedmetadata", "onloadstart",
  "onmousedown", "onmouseenter", "onmouseleave", "onmousemove",
  "onmouseout", "onmouseover", "onmouseup", "onmousewheel", "onpause",
  "onplay", "onplaying", "onprogress", "onratechange", "onreset",
  "onresize", "onscroll", "onsecuritypolicyviolation", "onseeked",
  "onseeking", "onselect", "onslotchange", "onstalled", "onsubmit",
  "onsuspend", "ontimeupdate", "ontoggle", "onvolumechange", "onwaiting",
  "onwebkitanimationend", "onwebkitanimationiteration",
  "onwebkitanimationstart", "onwebkittransitionend", "onwheel",
  "onauxclick", "ongotpointercapture", "onlostpointercapture",
  "onpointerdown", "onpointermove", "onpointerrawupdate", "onpointerup",
  "onpointercancel", "onpointerover", "onpointerout", "onpointerenter",
  "onpointerleave", "onselectstart", "onselectionchange",
  "onanimationend", "onanimationiteration", "onanimationstart",
  "ontransitionrun", "ontransitionstart", "ontransitionend",
  "ontransitioncancel", "onafterprint", "onbeforeprint", "onbeforeunload",
  "onhashchange", "onlanguagechange", "onmessage", "onmessageerror",
  "onoffline", "ononline", "onpagehide", "onpageshow", "onpopstate",
  "onrejectionhandled", "onstorage", "onunhandledrejection", "onunload",
  "crossOriginIsolated", "scheduler", "alert", "atob", "blur", "btoa",
  "cancelAnimationFrame", "cancelIdleCallback", "captureEvents",
  "clearInterval", "clearTimeout", "close", "confirm", "createImageBitmap",
  "fetch", "find", "focus", "getComputedStyle", "getSelection",
  "matchMedia", "moveBy", "moveTo", "open", "postMessage", "print",
  "prompt", "queueMicrotask", "releaseEvents", "reportError",
  "requestAnimationFrame", "requestIdleCallback", "resizeBy", "resizeTo",
  "scroll", "scrollBy", "scrollTo", "setInterval", "setTimeout", "stop",
  "structuredClone", "webkitCancelAnimationFrame",
  "webkitRequestAnimationFrame", "chrome", "caches", "cookieStore",
  "ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute",
  "launchQueue", "documentPictureInPicture", "getScreenDetails",
  "queryLocalFonts", "showDirectoryPicker", "showOpenFilePicker",
  "showSaveFilePicker", "originAgentCluster", "onpageswap",
  "onpagereveal", "credentialless", "speechSynthesis", "onscrollend",
  "webkitRequestFileSystem", "webkitResolveLocalFileSystemURL",
  "sendMsgToSolverCS", "webpackChunk_N_E", "__next_set_public_path__",
  "next", "__NEXT_DATA__", "__SSG_MANIFEST_CB", "__NEXT_P",
  "_N_E", "regeneratorRuntime", "__REACT_INTL_CONTEXT__", "DD_RUM", "_",
  "filterCSS", "filterXSS", "__SEGMENT_INSPECTOR__", "__NEXT_PRELOADREADY",
  "Intercom", "__MIDDLEWARE_MATCHERS", "__STATSIG_SDK__",
  "__STATSIG_JS_SDK__", "__STATSIG_RERENDER_OVERRIDE__",
  "_oaiHandleSessionExpired", "__BUILD_MANIFEST", "__SSG_MANIFEST",
  "__intercomAssignLocation", "__intercomReloadLocation",
];

const uuid = () => randomUUID();
const pick = (a) => a[randomInt(a.length)];
/** Uniform float in [0,1) from 53 random bits (crypto.randomInt caps at 2^48). */
const randFloat = () => {
  const b = randomBytes(7);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return Number(v >> 3n) / Number(1n << 53n);
};

/** Replicates Go's time.Format("Mon Jan 02 2006 15:04:05") in America/New_York. */
function getParseTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("weekday")} ${get("month")} ${get("day")} ${hour}:${get("minute")}:${get("second")} GMT-0500 (Eastern Standard Time)`;
}

/**
 * 构造 sentinel PoW 配置的 18 个槽位。
 *
 * @param {string} [userAgent]
 * @param {Date} [now]
 * @param {{scriptSources?: string[], dataBuild?: string}} [resources]
 *   `scriptSources` / `dataBuild` 来自 chatgpt.com 首页 HTML（见 gpt-free.mjs 的
 *   `parsePowResources`）。留空则退回写死的 sdk.js，与旧版行为一致。
 */
function buildConfig(userAgent = UA, now = new Date(), resources = {}) {
  const ms = now.getTime();
  const perfCounter = (ms % 1_000_000) + randFloat();
  const epochOffset = ms - perfCounter;
  const scriptSources = Array.isArray(resources.scriptSources) ? resources.scriptSources : [];
  const scriptSource = scriptSources.length > 0 ? pick(scriptSources) : DEFAULT_POW_SCRIPT;
  return [
    pick(SCREEN_SIZES),            // 0
    getParseTime(now),             // 1
    4294705152,                    // 2 constant
    0,                             // 3 nonce_i (dynamic)
    userAgent,                     // 4
    scriptSource,                  // 5 页面实际的 sdk.js 地址
    resources.dataBuild ?? "",     // 6 dpl（页面 data-build）
    "en-US",                       // 7
    "en-US,es-US,en,es",           // 8
    0,                             // 9 nonce_j (dynamic)
    pick(NAVIGATOR_KEYS),          // 10
    pick(DOCUMENT_KEYS),           // 11
    pick(WINDOW_KEYS),             // 12
    perfCounter,                   // 13
    uuid(),                        // 14
    "",                            // 15
    pick(CORE_COUNTS),             // 16
    epochOffset,                   // 17
  ];
}

/**
 * Build the three static JSON fragments around indices [3] and [9], so the
 * hot loop only splices in the two counters. Mirrors pow.go exactly.
 */
function splitFragments(config) {
  const json = (v) => JSON.stringify(v);
  const p1 = json(config.slice(0, 3));       // "[a,b,c]"
  const mid = json(config.slice(4, 9));      // "[e,f,g,h,i]"
  const tail = json(config.slice(10));       // "[k,...,r]"

  const static1 = p1.slice(0, -1) + ",";                 // "[a,b,c,"
  const static2 = "," + mid.slice(1, -1) + ",";          // ",e,f,g,h,i,"
  const static3 = "," + tail.slice(1);                   // ",k,...,r]"
  return { static1, static2, static3 };
}

function assemble(static1, static2, static3, i, j) {
  return static1 + String(i) + static2 + String(j) + static3;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64ToBytes = (s) => Buffer.from(s, "base64");

/* ── SHA3-512 ────────────────────────────────────────────────────────
 *
 * 为什么不能只用 `node:crypto`：
 *
 * 桌面端 DSH 是 Electron 44.7.0（内置 Node **24.21.0**），但它的
 * `process.versions.openssl` 报 `0.0.0` —— 用的是 Chromium 的 **BoringSSL**，
 * 而 BoringSSL **不提供 SHA-3**。`createHash("sha3-512")` 直接抛
 * `Digest method not supported`。
 *
 * 官方 Node 用 OpenSSL 3.x，所以同一份代码在 CLI 里跑得通、在桌面端必炸 ——
 * 2026-10-22 用户实测报「求解 PoW 失败：Digest method not supported」，
 * 而本地测试全绿，正是踩了这个环境差异。
 *
 * 策略：运行时探测一次原生支持（有就用，快），没有就退回下面这份纯 JS
 * Keccak-f[1600] 实现（FIPS 202）。两条路输出必须逐字节相同，测试里对照验证。
 */

/** Keccak 轮常数（24 轮 × 64 位，按 lo/hi 交错展开）。 */
const KECCAK_RC = new Uint32Array([
  0x00000001, 0x00000000, 0x00008082, 0x00000000,
  0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000,
  0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000,
  0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000,
  0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000,
  0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000,
  0x80000001, 0x00000000, 0x80008008, 0x80000000,
]);

/** Rho 旋转偏移，按 lane 下标 `x + 5y` 排列。 */
const KECCAK_RHO = new Uint8Array([
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]);

/**
 * Keccak-f[1600] 置换，原地改写 25 个 lane。
 * 状态用 50 个 32 位整数表示：`s[2i]` = lane i 的低 32 位，`s[2i+1]` = 高 32 位。
 */
function keccakF1600(s) {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < 24; round += 1) {
    // θ：列奇偶校验
    for (let x = 0; x < 5; x += 1) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x += 1) {
      const i1 = 2 * ((x + 1) % 5);
      const i4 = 2 * ((x + 4) % 5);
      const dlo = c[i4] ^ ((c[i1] << 1) | (c[i1 + 1] >>> 31));
      const dhi = c[i4 + 1] ^ ((c[i1 + 1] << 1) | (c[i1] >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= dlo;
        s[2 * (x + y) + 1] ^= dhi;
      }
    }
    // ρ（旋转）+ π（换位）：B[y, 2x+3y] = rot(A[x, y], r[x, y])
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const i = x + 5 * y;
        let r = KECCAK_RHO[i];
        let lo = s[2 * i];
        let hi = s[2 * i + 1];
        if (r >= 32) {
          const tmp = lo;
          lo = hi;
          hi = tmp;
          r -= 32;
        }
        if (r > 0) {
          const nlo = (lo << r) | (hi >>> (32 - r));
          const nhi = (hi << r) | (lo >>> (32 - r));
          lo = nlo;
          hi = nhi;
        }
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        b[2 * j] = lo;
        b[2 * j + 1] = hi;
      }
    }
    // χ：行内非线性混合
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        const i = x + y;
        const i1 = ((x + 1) % 5) + y;
        const i2 = ((x + 2) % 5) + y;
        s[2 * i] = b[2 * i] ^ (~b[2 * i1] & b[2 * i2]);
        s[2 * i + 1] = b[2 * i + 1] ^ (~b[2 * i1 + 1] & b[2 * i2 + 1]);
      }
    }
    // ι：注入轮常数
    s[0] ^= KECCAK_RC[2 * round];
    s[1] ^= KECCAK_RC[2 * round + 1];
  }
}

/** SHA3-512 纯 JS 实现（FIPS 202，rate = 72 字节，输出 64 字节）。 */
function sha3_512_pure(data) {
  const RATE = 72;
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const padLen = RATE - (input.length % RATE);
  const padded = Buffer.alloc(input.length + padLen);
  input.copy(padded);
  // SHA3 的域分隔符是 0x06（不是 SHAKE 的 0x1f），末字节置 0x80 表示结束。
  padded[input.length] ^= 0x06;
  padded[padded.length - 1] ^= 0x80;

  const state = new Uint32Array(50);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let i = 0; i < RATE / 8; i += 1) {
      state[2 * i] ^= padded.readUInt32LE(offset + i * 8);
      state[2 * i + 1] ^= padded.readUInt32LE(offset + i * 8 + 4);
    }
    keccakF1600(state);
  }

  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i += 1) {
    out.writeUInt32LE(state[2 * i], i * 8);
    out.writeUInt32LE(state[2 * i + 1], i * 8 + 4);
  }
  return out;
}

/**
 * 原生 `sha3-512` 是否可用。
 *
 * 只在模块加载时探测一次。Electron（BoringSSL）会抛 `Digest method not supported`，
 * 官方 Node（OpenSSL 3.x）正常。
 */
const NATIVE_SHA3 = (() => {
  try {
    createHash("sha3-512").update("probe").digest();
    return true;
  } catch {
    return false;
  }
})();

/**
 * SHA3-512。优先用原生实现，环境不支持时退回纯 JS。
 * @param {Buffer|string|Uint8Array} data
 * @returns {Buffer} 64 字节摘要
 */
function sha3_512(data) {
  if (NATIVE_SHA3) return createHash("sha3-512").update(data).digest();
  return sha3_512_pure(data);
}

/** Lexicographic byte compare, matching bytesLE (a <= b). */
function bytesLE(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return a.length <= b.length;
}

/**
 * Solve a sentinel proof-of-work challenge.
 * @returns {string} proof token, prefixed "gAAAAAB"
 */
export function solvePoW(seed, difficulty, opts = {}) {
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
  const config =
    opts.config ??
    buildConfig(opts.userAgent ?? UA, opts.now ?? new Date(), {
      scriptSources: opts.scriptSources,
      dataBuild: opts.dataBuild,
    });
  const { static1, static2, static3 } = splitFragments(config);

  const diffBytes = Buffer.from(difficulty, "hex");
  if (diffBytes.length === 0) throw new Error(`invalid difficulty hex: ${difficulty}`);
  const diffLen = diffBytes.length;
  const seedBytes = Buffer.from(seed, "utf8");

  for (let i = 0; i < maxIterations; i++) {
    const assembled = assemble(static1, static2, static3, i, i >> 1);
    const encoded = b64(assembled);
    const hash = sha3_512(Buffer.concat([seedBytes, Buffer.from(encoded, "utf8")]));
    if (bytesLE(hash.subarray(0, diffLen), diffBytes)) {
      return "gAAAAAB" + encoded;
    }
  }

  const fallback = b64(JSON.stringify(seed));
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallback;
}

/** The requirement token for /sentinel/chat-requirements ("p" field). */
export function generateRequirementsToken(opts = {}) {
  const config =
    opts.config ??
    buildConfig(opts.userAgent ?? UA, opts.now ?? new Date(), {
      scriptSources: opts.scriptSources,
      dataBuild: opts.dataBuild,
    });
  const { static1, static2, static3 } = splitFragments(config);
  const assembled = assemble(static1, static2, static3, 0, 0);
  return "gAAAAAC" + b64(assembled);
}

/* ------------------------------------------------------------------ *
 * turnstile 求解器
 * ------------------------------------------------------------------ */

/**
 * 逐条移植自源头实现 basketikun/chatgpt2api 的 `utils/turnstile.py`。
 *
 * 为什么需要：上游 `sentinel/chat-requirements/prepare` 可能返回
 * `turnstile: { required: true, dx: "<base64>" }`，dx 解码后再与 `p` 做 XOR
 * 得到一段「虚拟机字节码」，解释执行后产出 turnstile token，finalize 时回传。
 * 没有它，遇到 turnstile 挑战就只能报错。
 *
 * 与原实现的差异：原版用 Python 的 `str`/`float` 做类型判断，JS 里数字统一是
 * number，字符串是 string，语义等价；`time.time_ns()` 换成 `performance.now()`
 * 的纳秒等价物（用 `process.hrtime.bigint()`，它才是真正的单调时钟）。
 */

/** Python `_turnstile_to_str` 的 JS 等价物。 */
function turnstileToString(value) {
  if (value === null || value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    const special = {
      "window.Math": "[object Math]",
      "window.Reflect": "[object Reflect]",
      "window.performance": "[object Performance]",
      "window.localStorage": "[object Storage]",
      "window.Object": "function Object() { [native code] }",
      "window.Reflect.set": "function set() { [native code] }",
      "window.performance.now": "function () { [native code] }",
      "window.Object.create": "function create() { [native code] }",
      "window.Object.keys": "function keys() { [native code] }",
      "window.Math.random": "function random() { [native code] }",
    };
    return Object.prototype.hasOwnProperty.call(special, value) ? special[value] : value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(",");
  }
  return String(value);
}

/** 按 key 循环 XOR（Python 版按码点运算；这里同样按码点，不用 Buffer，避免 UTF-8 多字节差异）。 */
function xorString(text, key) {
  if (!key) return text;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/** 模拟 Python 的 OrderedMap：`add` 只在键不存在时追加，`values` 保留最后一次赋值。 */
function makeOrderedMap() {
  return {
    keys: [],
    values: new Map(),
    add(key, value) {
      const k = String(key);
      if (!this.values.has(k)) this.keys.push(k);
      this.values.set(k, value);
    },
  };
}

/**
 * 求解 turnstile token。
 *
 * @param {string} dx  prepare 响应里的 base64 字节码
 * @param {string} p   本次请求的 requirements token（用作 XOR 密钥）
 * @returns {string|null} 成功返回 token，失败返回 null（调用方按「没有 turnstile」处理）
 */
export function solveTurnstileToken(dx, p) {
  let tokenList;
  try {
    const decoded = Buffer.from(String(dx), "base64").toString("utf8");
    tokenList = JSON.parse(xorString(decoded, String(p ?? "")));
  } catch {
    return null;
  }
  if (!Array.isArray(tokenList)) return null;

  const startedNs = process.hrtime.bigint();
  const map = new Map();
  let result = "";

  const num = (v) => (typeof v === "number" ? v : Number(v));

  const func1 = (e, t) => {
    map.set(num(e), xorString(turnstileToString(map.get(num(e))), turnstileToString(map.get(num(t)))));
  };
  const func2 = (e, t) => {
    map.set(num(e), t);
  };
  const func3 = (e) => {
    result = Buffer.from(turnstileToString(e), "utf8").toString("base64");
  };
  const func5 = (e, t) => {
    const current = map.get(num(e));
    const incoming = map.get(num(t));
    if (Array.isArray(current)) {
      map.set(num(e), [...current, incoming]);
      return;
    }
    const numericish = (v) => typeof v === "string" || typeof v === "number";
    if (numericish(current) || numericish(incoming)) {
      map.set(num(e), turnstileToString(current) + turnstileToString(incoming));
      return;
    }
    map.set(num(e), "NaN");
  };
  const func6 = (e, t, n) => {
    const tv = map.get(num(t));
    const nv = map.get(num(n));
    if (typeof tv === "string" && typeof nv === "string") {
      const value = `${tv}.${nv}`;
      map.set(num(e), value === "window.document.location" ? "https://chatgpt.com/" : value);
    }
  };
  const func7 = (e, ...args) => {
    const target = map.get(num(e));
    const values = args.map((arg) => map.get(num(arg)));
    if (typeof target === "string" && target === "window.Reflect.set") {
      const [obj, keyName, val] = values;
      if (obj && typeof obj.add === "function") obj.add(String(keyName), val);
    } else if (typeof target === "function") {
      target(...values);
    }
  };
  const func8 = (e, t) => {
    map.set(num(e), map.get(num(t)));
  };
  const func14 = (e, t) => {
    map.set(num(e), JSON.parse(turnstileToString(map.get(num(t)))));
  };
  const func15 = (e, t) => {
    map.set(num(e), JSON.stringify(map.get(num(t))));
  };
  const func17 = (e, t, ...args) => {
    const callArgs = args.map((arg) => map.get(num(arg)));
    const target = map.get(num(t));
    if (target === "window.performance.now") {
      const elapsedNs = process.hrtime.bigint() - startedNs;
      map.set(num(e), (Number(elapsedNs) + Math.random()) / 1e6);
    } else if (target === "window.Object.create") {
      map.set(num(e), makeOrderedMap());
    } else if (target === "window.Object.keys") {
      if (callArgs.length > 0 && callArgs[0] === "window.localStorage") {
        map.set(num(e), [
          "STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4",
          "STATSIG_LOCAL_STORAGE_STABLE_ID",
          "client-correlated-secret",
          "oai/apps/capExpiresAt",
          "oai-did",
          "STATSIG_LOCAL_STORAGE_LOGGING_REQUEST",
          "UiState.isNavigationCollapsed.1",
        ]);
      }
    } else if (target === "window.Math.random") {
      map.set(num(e), Math.random());
    } else if (typeof target === "function") {
      map.set(num(e), target(...callArgs));
    }
  };
  const func18 = (e) => {
    map.set(num(e), Buffer.from(turnstileToString(map.get(num(e))), "base64").toString("utf8"));
  };
  const func19 = (e) => {
    map.set(num(e), Buffer.from(turnstileToString(map.get(num(e))), "utf8").toString("base64"));
  };
  const func20 = (e, t, n, ...args) => {
    if (map.get(num(e)) === map.get(num(t))) {
      const target = map.get(num(n));
      if (typeof target === "function") target(...args.map((arg) => map.get(num(arg))));
    }
  };
  const func21 = () => {};
  const func23 = (e, t, ...args) => {
    const current = map.get(num(e));
    const target = map.get(num(t));
    if (current !== null && current !== undefined && typeof target === "function") target(...args);
  };
  const func24 = (e, t, n) => {
    const tv = map.get(num(t));
    const nv = map.get(num(n));
    if (typeof tv === "string" && typeof nv === "string") {
      map.set(num(e), `${tv}.${nv}`);
    }
  };

  map.set(1, func1);
  map.set(2, func2);
  map.set(3, func3);
  map.set(5, func5);
  map.set(6, func6);
  map.set(7, func7);
  map.set(8, func8);
  map.set(9, tokenList);
  map.set(10, "window");
  map.set(14, func14);
  map.set(15, func15);
  map.set(16, p);
  map.set(17, func17);
  map.set(18, func18);
  map.set(19, func19);
  map.set(20, func20);
  map.set(21, func21);
  map.set(23, func23);
  map.set(24, func24);

  for (const token of tokenList) {
    try {
      if (!Array.isArray(token)) continue;
      const fn = map.get(num(token[0]));
      if (typeof fn === "function") fn(...token.slice(1));
    } catch {
      /* 单条指令失败不中断，与 Python 版一致 */
    }
  }
  return result || null;
}

export const __internals = {
  buildConfig, splitFragments, assemble, bytesLE, sha3_512, b64, b64ToBytes,
  sha3_512_pure, keccakF1600, NATIVE_SHA3,
  getParseTime, UA, MAX_ITERATIONS, DEFAULT_POW_SCRIPT,
  turnstileToString, xorString, solveTurnstileToken,
};

