/**
 * dsh-doubao-image —— 把网页版豆包与网页版 ChatGPT 免费账户的生图能力接进 DSH。
 *
 * 本文件是 Host 半：注册两个工具（`doubao_image` / `gpt_image`）、给 Client 设置页
 * 提供一组同源 HTTP 路由，并把登录凭据存进 DSH 的 credentials record 半。
 * 渲染半在 client.js 里，两者只通过下面的 BASE 前缀通信。
 *
 * 网络实现全部在 lib/ 下（纯 `node:` 内置模块，0 第三方运行时依赖）：
 *   lib/doubao.mjs     豆包生图 / 图生图 / 生视频
 *   lib/gpt-free.mjs   ChatGPT 免费账户生图（自写 HTTP/1.1 客户端，为走代理）
 *   lib/cdp.mjs        Edge 远程调试客户端（读 GPT accessToken，不用 Playwright）
 *   lib/sessions.mjs   credentials record 存取
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateImage as doubaoGenerateImage, editImage as doubaoEditImage,
  deleteConversation as doubaoDeleteConversation,
  generateVideo as doubaoGenerateVideo, fetchConversationDiagnosis, describeVideoWatermark,
  uploadToDoubao as doubaoUploadToDoubao,
  DOUBAO_IMAGE_MODELS, DOUBAO_IMAGE_MODELS_SUBSCRIBED,
  DOUBAO_VIDEO_MODELS, DOUBAO_VIDEO_MODEL_LABELS,
} from "./lib/doubao.mjs";
import { readDeviceIdentityFromBrowser } from "./lib/doubao-device.mjs";
import { normalizeDevice } from "./lib/doubao-identity.mjs";
import { generateImage as gptGenerateImage, deleteConversation as gptDeleteConversation } from "./lib/gpt-free.mjs";
import { cdpTargets, cdpVersion, fetchChatGptSession, getCookies, CdpConnection, waitForCdp } from "./lib/cdp.mjs";
import { createSessionStore } from "./lib/sessions.mjs";
import { BrowserLoginSession, DOUBAO_DEBUG_PORT, DOUBAO_PROFILE_DIR, resetProfile } from "./lib/browser-login.mjs";
import { ensureDoubaoFresh, ensureGptFresh } from "./lib/credential-sync.mjs";
import { fetchInspirationImageCached, findSource, loadCatalog, publicCatalog, safeImagePath } from "./lib/inspiration.mjs";
import { createGalleryStore } from "./lib/gallery-store.mjs";

/** Cordis 插件名。 */
export const name = "doubao-image";

/**
 * 需要宿主注入的服务。
 *
 * `tools` / `webServer` / `attachments` 是硬依赖；`credentials` 故意不在这里
 * ——它是可选的（见 sessions.mjs 的降级设计），靠 ctx.get() 动态取。
 */
export const inject = ["tools", "webServer", "attachments"];

/** 设置页 / 路由统一前缀。Client 半硬编码同一字符串。 */
const BASE = "/plugins/dsh-doubao-image-free";

const ROUTE_STATUS = `${BASE}/api/status`;
const ROUTE_DOUBAO_DEVICE = `${BASE}/api/doubao/device`;
/**
 * 重置豆包登录 profile 的路由（L2，2026-10-18）。
 *
 * `lib/browser-login.mjs` 早就导出了 `resetProfile()`，但**全项目没有调用点**
 * ——设备身份被风控锁死时，用户唯一的出路是手动去 `%TEMP%` 删目录。这不是
 * 漏洞，是「自救入口缺失」：出问题的人恰好是最不知道要删哪个目录的人。
 *
 * 所以补一个 POST 路由，让界面上有个按钮可点。
 */
const ROUTE_DOUBAO_RESET_PROFILE = `${BASE}/api/doubao/reset-profile`;
/**
 * 豆包桌面端的 CDP 端口。
 *
 * **必须是常量，不能由请求体指定**（H4，2026-10-18）。允许 `body.port` 等于
 * 给任何能发 POST 的页面一个本机端口探测器：打 9222/9333 能读别的浏览器的
 * cookie，打任意端口能从连接结果反推本机开了哪些服务。
 */
const DOUBAO_DEVICE_CDP_PORT = 19222;
const ROUTE_DOUBAO_BROWSER_LOGIN = `${BASE}/api/doubao/browser-login`;
const ROUTE_DOUBAO_SESSION = `${BASE}/api/doubao/session`;
const ROUTE_DOUBAO_COOKIE = `${BASE}/api/doubao/cookie`;
/**
 * POST /api/doubao/accounts —— 账号池操作（切换当前账号 / 备注名）。
 *
 * 与 `/session` 分开：那条是「登录态」的增删，这条只改「用哪个号」，
 * 让同一个入口既能切号又能改名，客户端不必为两个小动作记两条路由。
 */
const ROUTE_DOUBAO_ACCOUNTS = `${BASE}/api/doubao/accounts`;
/**
 * POST /api/doubao/new-conversation —— 换一个新的生图会话（界面上的「+」）。
 *
 * 打开「固定会话」开关后，所有生图都进同一个会话。用户想换风格时，
 * 清掉账号上记住的会话 id 即可 —— 下一次生图会新建一个会话并记住它。
 *
 * **只清当前账号的记录，不接受任何参数**：会话 id 由服务端生成，
 * 客户端不可能知道「该换成哪个」，也不该能指定。
 */
const ROUTE_DOUBAO_NEW_CONVERSATION = `${BASE}/api/doubao/new-conversation`;
const ROUTE_GPT_EDGE_LOGIN = `${BASE}/api/gpt/edge-login`;
const ROUTE_GPT_TOKEN = `${BASE}/api/gpt/token`;
const ROUTE_GPT_SESSION = `${BASE}/api/gpt/session`;
const ROUTE_IMAGE = `${BASE}/api/image`;
/**
 * GET 取图（裸字节），给 tldraw 的 asset `src` 用。
 *
 * 见该路由处的注释：tldraw 不接受 `blob:`，画布资产必须是 http URL。
 */
const ROUTE_IMAGE_RAW = `${BASE}/api/image/raw`;
/**
 * POST 取视频（裸字节），画廊「视频」栏的 `<video src>` 与灯箱播放用。
 *
 * **为什么不能复用 `/api/image`**：那条走 `ctx.attachments.readImage`，
 * 入参是 `ImageAttachmentRef`（要求 `mediaType` + `width` + `height`），
 * 而视频是 `ctx.attachments.saveFile` 存的 `FileAttachmentRef`，只有
 * `attachmentId` / `name` / `bytes` —— 拿视频引用去调 readImage 必然失败。
 * 文件只能用 `readFileStream` 读，所以这里另开一条。
 */
const ROUTE_VIDEO = `${BASE}/api/video`;
const ROUTE_IMPORT = `${BASE}/api/import`;
const ROUTE_REGENERATE = `${BASE}/api/regenerate`;
const ROUTE_INSPIRATION = `${BASE}/api/inspiration`;
const ROUTE_INSPIRATION_IMAGE = `${BASE}/api/inspiration/image`;
/**
 * 只读诊断：拉取某条豆包会话的原始创造块，用于定位
 * 「图生图请求送达豆包但豆包返回失败」的真实服务端原因。
 *
 * 只调 `chain_by_block` 拉历史，不发起任何生成、不消耗额度。
 */
const ROUTE_DIAG_CONVERSATION = `${BASE}/api/diag/conversation`;
/**
 * 画廊持久化路由（2026-10-20 新增）。
 *
 * 存在的理由：客户端的 IndexedDB 按 origin 隔离，而 origin 含端口。
 * DSH web 每次启动端口可能不同，换一次端口就是一个空库 —— 用户的工作区
 * 没变、图也没删，画廊却空了。所以权威副本放服务端。
 *
 * 归属判定（哪条属于哪个工作区）留在客户端：只有它知道当前工作区的完整
 * 判据（workspaceId + 路径 + 会话 id 列表）。服务端只做原样存取。
 */
const ROUTE_GALLERY = `${BASE}/api/gallery`;

/**
 * 解析 DSH home 目录。
 *
 * 为什么不用 `@deepseek-ai/dsh-home-paths`：它是 peerDependency，运行时由
 * 宿主注入确实可用，但**静态 import 会让所有 host 侧测试崩在模块加载阶段**
 * （项目自身没有 node_modules 安装它）。改成动态 import 又要把整条初始化
 * 链路改成异步，得不偿失。
 *
 * 这里的实现与官方逐字同义（读过 `dsh-home-paths/lib/index.js:73-82`）：
 * `$DSH_HOME`（非空白）优先，否则 `~/.dsh`。官方多做的只有 `~` 前缀展开，
 * 而环境变量里不会出现 `~`。
 */
function resolveGalleryHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return join(homedir(), ".dsh");
}

/** 从 cookie 头里取某个名字的值（取不到返回空串）。 */
function cookieOf(cookieHeader, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(String(cookieHeader ?? ""));
  return m ? m[1] : "";
}

/** 扫码会话的有效期：与服务端二维码一致，超时后必须重新取码。 */
/** 导入本地图的请求体上限。dataUrl 是 base64，比原图大 4/3，留足余量。 */
const MAX_IMPORT_BODY_BYTES = 24 * 1024 * 1024;
/**
 * 参考图（`reference_images`，图生图 / 图生视频）的字节上限。
 *
 * 与 `MAX_IMPORT_BODY_BYTES`（24 MiB）同量级但略小：这些字节要**再上传一次**
 * 到 ImageX，上限太大等于让一次工具调用把内存和上行带宽都占满。
 */
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
/** Edge 登录的总超时（用户手动登录，给足时间）。 */
const EDGE_LOGIN_TIMEOUT_MS = 300_000;
/** 浏览器登录（含扫码/密码输入）给足时间，超时后自动关窗口。 */
const BROWSER_LOGIN_TIMEOUT_MS = 300_000;
/** CDP 调试端口与独立用户目录，避免污染用户日常 Edge 配置。 */
const EDGE_DEBUG_PORT = 9333;
const EDGE_USER_DATA_DIR = join(tmpdir(), "dsh-doubao-image-edge");

/** 本机只有 Edge；按顺序探测常见安装位置。 */
const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** 视频 prompt 必须显式要求直接生成，否则豆包只回参数确认卡、不创建任务。 */
const VIDEO_PROMPT_SUFFIX = "直接生成视频，不要询问确认，也不要给参数建议。";

const DEFAULT_DOUBAO_SIZE = "1024x1024";

/**
 * 缺省生图模型。
 *
 * 取 `DOUBAO_IMAGE_MODELS[0]`：它是 lib 侧 normalizeImageModel 的缺省值，
 * 两处必须是同一个来源——写死字面量会让「设置页显示 A、实际请求 B」。
 */
const DEFAULT_DOUBAO_MODEL = DOUBAO_IMAGE_MODELS[0];

/**
 * 工作区落盘的默认子目录。
 *
 * **刻意不用官方 `dsh-image-gen` 那个目录名**：两个插件各写各的文件，
 * 混进同一个目录后，用户既分不清哪张图是哪个通道出的，想单独清理其中一个
 * 插件的产物也无从下手。这里用本插件自己的名字，边界清楚。
 */
const DEFAULT_WORKSPACE_FOLDER = "dsh-doubao-image-free";

/**
 * 拼给模型看的「图在哪」提示。
 *
 * 这一句是消除「模型满盘找图」的关键，措辞对齐官方
 * `dsh-image-gen`（`lib/index.js:29137-29141`）：先声明图已附到对话，
 * 再给路径，最后**明确叫模型别再去找**。少了最后这句，模型仍然会
 * 惯性去 glob 一遍工作区 —— 实测它就是这么烧掉两分半的。
 */
const imagePathHint = (savedTo, saveError) => {
  if (typeof savedTo === "string" && savedTo !== "") {
    return `图已附在本条回复里，并已另存到工作区：${savedTo}。不要再去读取或搜索图片文件，直接回复用户即可。`;
  }
  if (typeof saveError === "string" && saveError !== "") {
    return `图已附在本条回复里（另存到工作区失败：${saveError}）。不要再去读取或搜索图片文件，直接回复用户即可。`;
  }
  return "图已附在本条回复里，没有本地文件路径。不要再去读取或搜索图片文件，直接回复用户即可。";
};

/* ------------------------------------------------------------------ 小工具 */

const errText = (error) => (error instanceof Error ? error.message : String(error));

/**
 * 模型一句话描述：回显优先于请求值。
 *
 * 服务端 `placeholder.description` 回显了实际模型，就照实说；没回显只能说
 * 「请求了 X」，不能替服务端保证生效。
 */
function describeModel(result) {
  const echoed = typeof result?.actualModel === "string" ? result.actualModel : "";
  const requested = typeof result?.requestModel === "string" ? result.requestModel : "";
  if (echoed !== "") return `实际 ${echoed}`;
  if (requested !== "") return `请求 ${requested}（服务端未回显）`;
  return "未知";
}

/**
 * 同源校验：设置页由本机 web 服务托管，跨站请求必须拒掉。
 *
 * 这是插件全部路由的**唯一**防线：插件路由在 `/plugins/...` 前缀下，不经过
 * 宿主 `/api` 的 browser-trust fence（`dsh-client-connection/lib/index.js:14`
 * 的 `API_PATH = "/api"`，`:830-843` 的 prefix 路由），所以宿主那套判据
 * （loopback 白名单 / parseAuthority / sec-fetch-site）在这里一概不生效。
 *
 * 旧实现有三个口子，全部补上：
 *   1. **没有 Host 白名单** ⇒ DNS rebinding：`evil.com` 解析到 127.0.0.1 后，
 *      `host = "evil.com:PORT"`、`origin = "http://evil.com:PORT"`，
 *      `origin === \`http://${host}\`` 成立，同源校验直接放行。
 *   2. **缺 Origin 就放行** ⇒ `<img src>` / `<script src>` 这类跨站子资源请求
 *      不带 Origin，`/api/diag/conversation` 可被任意网页盲触发（借用户身份
 *      打上游，并污染设备身份）。
 *   3. **不查 sec-fetch-site** ⇒ 现代浏览器会带这个头，它比 Origin 更难伪造。
 *
 * 判据按「先白名单、再 Origin、最后 sec-fetch-site」排列：Host 不在白名单时
 * 后面两项一概不看——连请求目标都不对，别的证据没有意义。
 */

/**
 * 允许的 Host：本机回环的三种写法，必须带端口。
 *
 * 为什么必须带端口：DSH 的 web 服务跑在动态端口上（19387 之类），
 * 不带端口的 `localhost` 不是本服务的地址。反过来，一旦放行裸主机名，
 * `evil.com:PORT` 这种「域名 + 正确端口」的 rebinding 形态仍会被挡，
 * 但 `localhost` 与 `127.0.0.1` 之间的差异也就不必再纠结。
 */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i;

/** Host 是否指向本机回环（且端口合法）。 */
function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const match = LOOPBACK_HOST.exec(host.trim());
  if (match === null) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536;
}

/**
 * Origin 是否与 Host 同源。
 *
 * 只认 http/https，且 host 部分必须等于 req.headers.host。
 *
 * **大小写必须归一**：`new URL("http://LOCALHOST:19387").host` 返回
 * `"localhost:19387"`（URL 解析器会小写化主机名），而 `req.headers.host`
 * 保留客户端发来的原样大小写。不归一就会出现「合法请求被判成跨站」。
 *
 * **桌面协议桥兼容（2026-10-28 真实事故，app.asar main.js forwardWebRequest）**：
 * Electron `protocol.handle` 把 `dsh-app://app` 的请求转发到本地 HTTP 服务时，
 * **明确删除 host/origin/cookie/sec-fetch-site 四个头**，只注入宿主签发的
 * auth cookie。所以桌面端转发过来的请求必然 `Origin=undefined` 且
 * `Sec-Fetch-Site=undefined`，本函数走不到（它要求 Origin 存在）。这条兼容
 * 分支在 `sameOrigin()` 里（缺 Origin 且缺 site 时调 `ctx.connection
 * .requestRejection(req)`），不放宽这里——Origin 存在时仍是严格同源比对。
 */
function originMatchesHost(origin, host) {
  if (typeof origin !== "string" || origin === "") return false;
  if (origin.trim().toLowerCase() === "null") return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // `URL.host` 含端口；与 Host 头比较（两者都可能是 [::1]:port 形态）。
  return parsed.host.toLowerCase() === host.trim().toLowerCase();
}

/**
 * 桌面协议桥兼容分支：用宿主 Connection 的认证入口判这条请求能否放行。
 *
 * 判据是**宿主认证**，不是插件自己发明的标记。`requestRejection` 的签名
 * 是 `ConnectionTrustRequest { headers }`（不需要 url），返回
 * `401 | 403 | undefined`——undefined 表示「这条请求可以接受」（签名 Cookie
 * 通过 + live Peer 在场 + Host/Origin 围栏通过）。
 *
 * 任何异常 / service 缺失 / 非 undefined 返回一律拒（fail-closed）。
 */
function hostAdmissionAllows(req, ctx) {
  const connection = ctx?.get?.("connection");
  if (connection === undefined || typeof connection.requestRejection !== "function") return false;
  try {
    return connection.requestRejection(req) === undefined;
  } catch {
    return false;
  }
}

function sameOrigin(req, ctx) {
  const host = req.headers.host;
  /*
   * 第一道：Host 必须是本机回环。
   *
   * 缺 Host 一律拒绝——HTTP/1.1 要求 Host 必填，缺了要么是畸形请求，
   * 要么是刻意构造的。旧实现在这里直接放行，是整个漏洞的入口。
   */
  if (!isLoopbackHost(host)) return false;

  const site = req.headers["sec-fetch-site"];
  /*
   * 第二道：sec-fetch-site 明确说跨站就拒。
   *
   * `cross-site` 是浏览器自己打的标记，脚本改不了。它比 Origin 更可靠：
   * `<img src>` 这类请求不带 Origin，但带 `sec-fetch-site: cross-site`。
   */
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return false;

  const origin = req.headers.origin;
  /*
   * 第三道：缺 Origin 时，只接受「浏览器明确说这是同源 / 直接访问」的请求。
   *
   * 旧实现缺 Origin 就放行，等于对所有跨站子资源请求敞开。现在要求
   * sec-fetch-site 是 same-origin / none：
   *   - `same-origin`：同源页面发起的 fetch/XHR（正常路径）
   *   - `none`：用户在地址栏直接打开（顶层导航）
   *
   * **`same-site` 必须拒**，虽然它听起来更安全。`sec-fetch-site` 是按
   * **site**（host，端口不参与）判定的，所以「本机另一个端口的网页」打过来
   * 报的就是 `same-site` —— 实测确认：从 `http://127.0.0.1:19478` 的页面
   * 用 `fetch(..., {mode:"no-cors"})` 与表单 POST 打 `127.0.0.1:19477`，
   * 浏览器给的都是 `sec-fetch-site: same-site`（不是 cross-site）。
   * 早期版本把 `same-site` 放进白名单，注释写「只可能来自 localhost 与
   * 127.0.0.1 的写法差异」—— 那个推理是错的，它恰恰是「同主机跨端口」，
   * 也就是本机任何网页都能打插件接口。插件自己的前端与宿主永远同源
   * （相对路径 `/plugins/dsh-doubao-image/...`），用不到 same-site。
   */
  if (origin === undefined) {
    /*
     * `site` 存在时**必须**在白名单里。
     *
     * 注意不能写成 `site !== ""` 才查白名单：空串是「头存在但值为空」，
     * 与「头不存在」是两件事。前者是畸形请求（浏览器不会发），应当拒绝；
     * 后者是老浏览器/非浏览器客户端 —— 它们我们**也一律拒绝**，因为浏览器
     * 之外的进程本来就不该拿这条路由（要 token 才能解决，见上）。
     * 早期版本写成 `site !== ""` 才查，导致空串直接 return true —— 变异
     * 测试用 `sec-fetch-site: ""` 把它抓了出来。
     */
    if (typeof site === "string") {
      const normalized = site.toLowerCase();
      return normalized === "same-origin" || normalized === "none";
    }
    /*
     * Origin 与 Sec-Fetch-Site **都**缺失：桌面协议桥（app.asar main.js
     * forwardWebRequest）明确删除 host/origin/cookie/sec-fetch-site 四头后
     * 注入宿主签发的 auth cookie 转发，必然走到这里。区分桌面桥与 curl
     * / 跨站脚本的唯一可靠凭据是宿主自己的认证结果：
     * `ctx.connection.requestRejection(req)`（Host/Origin 围栏 + 签名
     * Cookie + live Peer 校验，dsh-client-connection lib/index.js:737-749）。
     * 返回 undefined（无拒绝）才放行；401/403、service 缺失、抛错一律拒。
     * 这条分支只在两个头都缺失时走到，其余判据不动。
     */
    return hostAdmissionAllows(req, ctx);
  }

  return originMatchesHost(origin, host);
}

/**
 * 状态变更路由（POST / DELETE）的额外校验。
 *
 * `sameOrigin()` 已经挡住了跨站来源，这里再加一条：浏览器明确标了
 * `cross-site` 就拒。看上去与 sameOrigin 重复，但两条路由的判据是**独立**
 * 演进的——把状态变更的判据单独写出来，将来放宽 sameOrigin（例如为了
 * 支持某种新的同源形态）时，不会连带放宽写操作。
 */
function allowsStateChange(req, ctx) {
  if (!sameOrigin(req, ctx)) return false;
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.toLowerCase() === "cross-site") return false;
  return true;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/**
 * 图片 MIME 白名单。与 attachments 服务的 imageLimits.mediaTypes 保持一致，
 * 不直接用服务返回的集合是因为画廊这条路由在服务不可用时也要能优雅报错。
 */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * 严格解析客户端传来的 attachment ref。
 *
 * 这是画廊取图的唯一入口，必须自己校验而不是把对象直接转给 readImage：
 * 服务端只应当接受形状完整的 ref，任何一个字段类型不对都说明请求是伪造的
 * 或不兼容的，此时应当 400 而不是让底层抛错。校验规则照抄 dsh-image-gen
 * 的 parseImageAttachmentRef（它是同一套 Attachment 服务的既有消费者）。
 */
function parseImageAttachmentRef(value) {
  const ref = isRecord(value) ? value : undefined;
  if (ref === undefined) return undefined;
  if (typeof ref.attachmentId !== "string" || !IMAGE_MEDIA_TYPES.has(ref.mediaType)) return undefined;
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) return undefined;
  if (!isPositiveInt(ref.width) || !isPositiveInt(ref.height)) return undefined;
  if (ref.name !== undefined && typeof ref.name !== "string") return undefined;
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(typeof ref.name === "string" ? { name: ref.name } : {}),
  };
}

/**
 * 校验并归一化一个**文件**引用（视频）。
 *
 * 与 `parseImageAttachmentRef` 的区别是字段集：`saveFile` 只回
 * `attachmentId` / `name` / `bytes`，没有 `mediaType` 与像素尺寸。
 * 这里**不补默认值**——补了会让调用方以为 Host 保证过那个字段。
 *
 * @returns {{attachmentId: string, name: string, bytes: number} | undefined}
 */
function parseVideoAttachmentRef(value) {
  const ref = isRecord(value) ? value : undefined;
  if (ref === undefined) return undefined;
  if (typeof ref.attachmentId !== "string" || ref.attachmentId === "") return undefined;
  if (typeof ref.name !== "string" || ref.name === "") return undefined;
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) return undefined;
  return { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes };
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    // 设置页最大只提交凭据字符串，1 MiB 足够且能挡住异常请求。
    if (size > 1024 * 1024) {
      reject(new Error("请求体过大"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

/**
 * 带自定义上限的请求体读取。
 *
 * 为什么另开一个而不是给 `readBody` 加参数：默认 1 MiB 那条是**设置页凭据**
 * 的防线，所有凭据路由都依赖它；而导入本地图必须收下几 MB 的 base64。
 * 把上限做成参数会让每个调用点都要自证「我传的是对的」，容易改错一处就
 * 把凭据路由的防线抬高。
 */
const readBodyLimited = (req, maxBytes) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      reject(new Error("请求体过大"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});

/**
 * 解析 `data:image/png;base64,…`。
 *
 * 只接受白名单 MIME（拒绝 svg —— 它能在同源下执行脚本），并校验 base64
 * 解出来的字节数。返回 `{buf, mediaType}` 或 undefined。
 */
function parseImageDataUrl(value) {
  if (typeof value !== "string") return undefined;
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  if (match === null) return undefined;
  const mediaType = match[1];
  let buf;
  try {
    buf = Buffer.from(match[2], "base64");
  } catch {
    return undefined;
  }
  if (buf.byteLength === 0) return undefined;
  return { buf, mediaType };
}

/** 解析 JSON 请求体；同时强制 content-type，避免表单跨站提交。 */
async function jsonBody(req) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    return { error: "json-required" };
  }
  try {
    const parsed = JSON.parse(await readBody(req));
    return { body: parsed && typeof parsed === "object" ? parsed : {} };
  } catch {
    return { error: "invalid-request" };
  }
}

/** 从 base64 文本猜图片 MIME（Edge CDP 抓到的 cookie 里没有这个信息时用）。 */
function sniffPngOrJpeg(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return "image/png";
}

/** 本地图片扩展名 → MIME；交给 editImage 上传时决定 ImageX 的扩展名。 */
function mediaTypeOfFile(file) {
  switch (extname(file).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

/**
 * 图片 MIME → 落盘文件名扩展名（多图时给每张一个可区分的名字）。
 *
 * 命名只影响 attachment 的展示名与画廊里的可读性，不参与任何解析，
 * 所以拿不准就退回 `.png`，不抛错。
 */
function extOfMime(mediaType) {
  switch (String(mediaType ?? "").toLowerCase()) {
    case "image/jpeg": return ".jpg";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return ".png";
  }
}

/**
 * 按文件头判图片 MIME（**不信扩展名**）。
 *
 * 为什么要它：`reference_images` 给的是本地路径，扩展名可以被随意写。
 * 一个叫 `a.png` 的文本文件若被当成 PNG 上传，ImageX 会收下，豆包那边
 * 才报错，错误信息还指不到我们这层。所以先把字节读出来自己看一眼。
 *
 * 为什么自己写而不复用 `lib` 的 `sniffMime`：那个函数在
 * `lib/doubao-upstream.mjs` 里，且只认 JPEG / PNG / WebP 三种（它服务的是
 * 下载回来的图）。这里要连 GIF 一起认，而且 `index.js` 与 `lib` 之间刻意
 * 保持「只有入口函数」的依赖面——测试桩替换整条 import 时，多引一个名字
 * 就多一个静默 undefined 的机会。
 */
function sniffImageMediaType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6) {
    const head = buf.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return "";
}

/**
 * 参考图允许被读取的范围：会话工作区根。
 *
 * 顺序与 `saveAllToWorkspace` 一致（`exec.agent.session.header.cwd`），
 * 再补宿主也提供的 `exec.workspace.root`，都没有才退回进程 cwd。
 * 退回 cwd 不是「放宽」而是「仍有边界」：测试用例的 cwd
 * 就是仓库根；不带 `exec.agent` 的调用方（脚本、HTTP 路由）也都在这里。
 */
function referenceImageRoot(exec) {
  const fromWorkspace = exec?.workspace?.root;
  if (typeof fromWorkspace === "string" && fromWorkspace.trim() !== "") return fromWorkspace;
  const fromSession = exec?.agent?.session?.header?.cwd;
  if (typeof fromSession === "string" && fromSession.trim() !== "") return fromSession;
  return process.cwd();
}

/**
 * 读一张参考图，返回 `{ absolute, data, mediaType }`。
 *
 * 三道关，缺一不可：
 * 1. **工作区边界**——`reference_images` 是模型给的字符串。不设边界的话
 *    它能传 `C:\Users\<user>\.ssh\id_rsa`，内容会被 POST 到第三方存储。
 * 2. **大小上限**——先 `stat` 再 `readFile`。反过来等于先把大文件读进内存
 *    再拒绝，防不住 OOM。
 * 3. **字节嗅探**——`mediaType` 由文件头决定，不由扩展名决定。
 *
 * 纯词法边界检查（`relative` + `..` 判据）与 `workspaceImageDir` 同款。
 * 这里没有再 `realpath` 一次：这些是**读**不是写，读到的字节不会被写到
 * 边界外的位置，逃逸目标（把数据带出去）由上面第 1 关和后端的白名单堵。
 */
async function readReferenceImage(file, exec) {
  const raw = String(file ?? "").trim();
  if (raw === "") throw new Error("参考图路径不能为空");
  const root = resolve(referenceImageRoot(exec));
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, absolute);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) {
    throw new Error(`参考图 ${absolute} 不在会话工作区（${root}）内：请先把图片放进工作区再引用`);
  }
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    throw new Error(`读取参考图失败 ${absolute}：${errText(error)}`);
  }
  if (!info.isFile()) throw new Error(`参考图 ${absolute} 不是普通文件`);
  if (info.size === 0) throw new Error(`参考图 ${absolute} 是空文件`);
  if (info.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(`参考图 ${absolute} 有 ${info.size} 字节，超过上限 ${MAX_REFERENCE_IMAGE_BYTES} 字节（20 MiB）`);
  }
  let data;
  try {
    data = await readFile(absolute);
  } catch (error) {
    throw new Error(`读取参考图失败 ${absolute}：${errText(error)}`);
  }
  const mediaType = sniffImageMediaType(data);
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(`参考图 ${absolute} 不是受支持的图片格式（只认 PNG / JPEG / WebP / GIF）`);
  }
  return { absolute, data, mediaType };
}

/**
 * 画幅比例 → OpenAI 风格尺寸（`doubao_image` 的 `size` 入参）。
 *
 * 为什么要过一道尺寸：重新生成路由从客户端收到的只有 `ratio`
 * （画廊条目里存的就是这个字段），而生成通道吃的是 `size`。这里做一次映射，
 * 让 lib 的 `toRatio` 吸附回同一比例 —— 中间经过 size 是为了复用既有入参形状，
 * 不是为了转换单位。
 *
 * 认不出的比例返回 undefined（交给 `cfg().image.defaultSize` 兜底），
 * 不猜一个「差不多」的值。
 */
function ratioToSize(ratio) {
  switch (String(ratio ?? "").trim()) {
    case "1:1": return "1024x1024";
    case "4:3": return "1024x768";
    case "3:4": return "768x1024";
    case "16:9": return "1280x720";
    case "9:16": return "720x1280";
    default: return undefined;
  }
}

/* -------------------------------------------------------------------- 配置 */

/**
 * schemastery 只在 profile 运行时装着；开发目录里没有 node_modules 布局。
 * 这里做一次容错加载：解析得到就用真 schema（设置页能渲染表单、宿主能按
 * 默认值填 config），解析不到就退回同形的普通对象——此时 `apply()` 仍能跑，
 * 只是设置页拿不到表单描述。这不是降级运行，而是让「没装 DSH 的离线自测」
 * 也能验收工具与路由注册。
 *
 * `DSH_DBI_SCHEMASTERY` 是**只给离线自测用的**显式入口：指向一份真实的
 * schemastery 包目录，让自测能在开发目录里验证 `role("secret")` 这类
 * schema 元数据（否则那段代码在测试里根本不执行，等于没有断言）。
 * 生产环境不会设这个变量。
 */
const z = await import(process.env.DSH_DBI_SCHEMASTERY || "@deepseek-ai/schemastery")
  .then((mod) => mod.default ?? mod)
  .catch(() => null);

/** 各段默认值；有 schema 时由 schema 展开，无 schema 时直接当字面量用。 */
const CONFIG_DEFAULTS = {
  doubao: {
    cookieHeader: "",
    autoRefresh: false,
    autoSwitchAccount: true,
  },
  gpt: {
    accessToken: "",
    cookieHeader: "",
    oaiDeviceId: "",
    proxyUrl: "http://127.0.0.1:7897",
    timeoutMs: 300_000,
  },
  video: {
    enabled: false,
    model: "seedance_v2.0_mini",
    defaultDurationSec: 5,
    removeWatermark: true,
  },
  image: {
    timeoutMs: 300_000,
    defaultSize: DEFAULT_DOUBAO_SIZE,
    model: DEFAULT_DOUBAO_MODEL,
    saveToWorkspace: true,
    workspaceFolder: DEFAULT_WORKSPACE_FOLDER,
    // 默认关：保持「每次新建会话」的旧行为，用户需要时才打开固定会话。
    reuseConversation: false,
  },
  gallery: {
    enabled: true,
  },
};

/**
 * 插件配置。
 *
 * Config 里的凭据字段是「手工粘贴」入口的镜像；真实凭据以 credentials
 * record 为准，Config 值只作 fallback。
 */
export const Config = z
  ? z.object({
    doubao: z.object({
      cookieHeader: z.string().role("secret").default("").description("手工粘贴的豆包 Cookie 头（sessionid 必需）"),
      autoRefresh: z.boolean().default(false).description("Cookie 失效时自动重新拉起扫码登录"),
      autoSwitchAccount: z.boolean().default(true)
        .description("当前账号失败时自动换下一个账号重试。关掉后只用当前账号——测试用的号不会被悄悄换成主号"),
    }).default(CONFIG_DEFAULTS.doubao),
    gpt: z.object({
      accessToken: z.string().role("secret").default("").description("手工粘贴的 ChatGPT accessToken"),
      cookieHeader: z.string().role("secret").default("").description("chatgpt.com 的 Cookie 头"),
      oaiDeviceId: z.string().default("").description("oai-device-id 设备指纹，留空则随机生成"),
      proxyUrl: z.string().default("http://127.0.0.1:7897").description("访问 chatgpt.com 的代理地址"),
      timeoutMs: z.number().default(300_000).description("GPT 生图的整体超时（毫秒）"),
    }).default(CONFIG_DEFAULTS.gpt),
    video: z.object({
      enabled: z.boolean().default(false).description("是否允许调用豆包生视频"),
      /*
       * 用 `z.string()` 而不是 `z.enum(...)`：旧配置里可能存着任意字符串，
       * enum 会让整段配置校验失败（用户会看到「配置损坏」而不是「模型名不认识」）。
       * 真正的收紧在 `normalizeVideoModel`（lib/doubao-core.mjs）——不在清单里
       * 就吸附到默认档，且工作台每次生成都能覆盖这个值。
       */
      model: z.string().default(DOUBAO_VIDEO_MODELS[0])
        .description(`默认视频模型，可选：${DOUBAO_VIDEO_MODELS.join(" / ")}`),
      defaultDurationSec: z.number().default(5).description("视频默认时长（秒）"),
      /*
       * 水印开关。
       *
       * 豆包生成视频时同时产出两条流：带水印的 `download_url`（lr=video_gen_watermark_dyn）
       * 与无水印的 `get_without_watermark` 流（lr=unwatermarked）。两条流是不同
       * 的 TOS 对象，字节不同，不是靠 URL 参数现渲染的。
       *
       * 默认开 = 取无水印那条。用户反馈「不知道怎么去水印」就是这个开关存在
       * 的意义：不必知道接口细节，这里关掉就拿到带水印文件（例如要投稿到
       * 需要标注 AI 生成来源的平台）。
       *
       * 关掉时**不会**去调 get_without_watermark，直接下 download_url —— 少一次
       * 请求，也避免有人以为「关了开关还在偷偷去水印」。
       */
      removeWatermark: z.boolean().default(true).description("去掉视频水印（关闭则保留豆包烧录的水印）"),
    }).default(CONFIG_DEFAULTS.video),
    image: z.object({
      timeoutMs: z.number().default(300_000).description("生图的整体超时（毫秒）"),
      defaultSize: z.string().default(DEFAULT_DOUBAO_SIZE).description("默认尺寸，会吸附到豆包支持的图片比例"),
      model: z.string().default(DEFAULT_DOUBAO_MODEL)
        .description(`默认生图模型，可选：${DOUBAO_IMAGE_MODELS.join(" / ")}`),
      saveToWorkspace: z.boolean().default(true).description("生成后把图片另存一份到会话工作区，便于模型与用户按路径引用"),
      workspaceFolder: z.string().default(DEFAULT_WORKSPACE_FOLDER).description("工作区内的落盘子目录（相对路径，留空表示工作区根目录）"),
      /*
       * 固定会话开关。
       *
       * 关（默认）：每次生图新建一个豆包会话 —— 各次互不影响，但账号里会累积会话。
       * 开：所有生图都进同一个会话，账号里只留 1 个。
       *
       * 默认关是有意的：会话是「多轮对话」的容器，服务端可能按历史理解当前提示词。
       * 实测同一会话内「橘猫」→「雪山」没有串味，
       * 但一次实验不足以证明长期无影响，所以默认保持旧行为，由用户按需打开。
       */
      reuseConversation: z.boolean().default(false)
        .description("所有生图都发到同一个豆包会话（账号里只留 1 个会话；关掉则每次新建）"),
    }).default(CONFIG_DEFAULTS.image),
    gallery: z.object({
      enabled: z.boolean().default(true).description("是否启用画廊"),
    }).default(CONFIG_DEFAULTS.gallery),
  }).default(CONFIG_DEFAULTS).volatile()
  : CONFIG_DEFAULTS;



/* --------------------------------------------------------- GPT Edge 登录 */

/** 找一个可用的 Edge 可执行文件。 */
function findEdgeExecutable() {
  for (const candidate of EDGE_CANDIDATES) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * 「拉起 Edge 登录」的状态机，供 POST/GET 两条路由共享。
 *
 * 用户手动在 Edge 里登录后，我们通过 CDP 读 accessToken 与 cookie。
 * 这里不做任何自动化输入——只负责起浏览器、等、读。
 */
class GptEdgeLoginSession {
  #proc = null;
  #conn = null;
  #status = "idle";
  #message = "";
  #token = "";
  #cookieHeader = "";
  #oaiDeviceId = "";
  #deadline = 0;
  #polling = null;
  #generation = 0;

  /**
   * 起浏览器并进入 waiting；重复调用会先收掉上一轮再重新拉起。
   *
   * 「只能拉起一次」的成因有两层：
   * 1) 上一轮失败后旧 Edge 进程还活着，它占着同一个 user-data-dir，新进程会被
   *    Edge 判定为「已有实例」而立刻退出，CDP 端口连不上 —— 表现就是再点没反应。
   *    所以这里先 dispose 再起新的，并用 generation 让上一轮的轮询循环自然退出。
   * 2) 状态机短路：用户关掉窗口（或登录失败）后 #status 仍是 waiting，而 #watch
   *    要等满 300 秒才转 error —— 这期间再点会被上面的 waiting 分支直接挡回。
   *    所以 waiting 分支必须先探活：浏览器还在就提示等待，不在了就重拉。
   */
  async start() {
    if (this.#status === "waiting" && (await this.#alive())) {
      return { ok: true, status: "waiting", message: this.#message || "请在打开的窗口里完成登录" };
    }

    // 清掉上一轮的进程与轮询；失败重试必须走这里。
    this.dispose();

    const exe = findEdgeExecutable();
    if (!exe) return { ok: false, status: "error", message: "未找到 Microsoft Edge，可改用手工粘贴 Token" };

    try {
      await mkdir(EDGE_USER_DATA_DIR, { recursive: true });
    } catch {
      // 目录已存在或权限受限；spawn 失败时会在下面的状态里体现。
    }

    const generation = ++this.#generation;
    this.#status = "waiting";
    this.#message = "已打开 Edge，请在该窗口登录 ChatGPT";
    this.#token = "";
    this.#cookieHeader = "";
    this.#deadline = Date.now() + EDGE_LOGIN_TIMEOUT_MS;

    const child = spawn(exe, [
      `--remote-debugging-port=${EDGE_DEBUG_PORT}`,
      `--user-data-dir=${EDGE_USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "https://chatgpt.com/",
    ], {
      // 沙箱下 piped stdio 可能被拒；我们也不需要它的输出。
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    });
    child.on("error", (error) => {
      if (generation !== this.#generation) return;
      this.#status = "error";
      this.#message = `启动 Edge 失败：${errText(error)}`;
    });
    child.unref();
    this.#proc = child;

    this.#polling = this.#watch(generation).catch((error) => {
      if (generation !== this.#generation) return;
      this.#status = "error";
      this.#message = errText(error);
    });
    return { ok: true, status: "waiting", message: this.#message };
  }

  /**
   * 后台轮询：等 CDP 起来，然后反复尝试读会话，直到读到或超时。
   *
   * 每一轮都刷新 #message，让设置页能看到「还在等」而不是一片静止——
   * 网络不稳时登录失败往往没有明确报错，界面若无进度就完全无从判断。
   */
  async #watch(generation) {
    try {
      await waitForCdp(EDGE_DEBUG_PORT, { timeoutMs: 30_000, intervalMs: 500 });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#status = "error";
      this.#message = `未能连上浏览器调试端口（${errText(error)}）；可再点一次或改用手工粘贴 Token`;
      return;
    }

    let rounds = 0;
    while (Date.now() < this.#deadline && this.#status === "waiting" && generation === this.#generation) {
      rounds += 1;
      const left = Math.max(0, Math.ceil((this.#deadline - Date.now()) / 1000));
      this.#message = `已打开 Edge，请在窗口内登录 ChatGPT（第 ${rounds} 次检测，剩余 ${left}s）`;
      try {
        const found = await this.#readSession();
        if (found) {
          this.#status = "done";
          this.#message = "已读取到 ChatGPT 登录凭据";
          return;
        }
      } catch {
        // 页面还没跳转到 chatgpt.com 或标签页正在重建；下一轮再试。
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (this.#status === "waiting" && generation === this.#generation) {
      this.#status = "error";
      this.#message = "等待登录超时，请重试或改用手工粘贴 Token";
    }
  }

  /**
   * 从当前页面读一次凭据。
   *
   * 直接用 cdpTargets 挑 chatgpt.com 的标签页，而不是 attachFirstPage：后者会
   * 绑到第一个页面（可能是 about:blank 或扩展页），拿不到会话。
   */
  async #readSession() {
    const targets = await cdpTargets(EDGE_DEBUG_PORT);
    const page = targets.find((t) => t.type === "page" && typeof t.url === "string" && t.url.includes("chatgpt.com") && t.webSocketDebuggerUrl);
    if (!page) return false;

    const conn = await CdpConnection.connect(page.webSocketDebuggerUrl);
    try {
      const session = await fetchChatGptSession(conn);
      const token = typeof session?.accessToken === "string" ? session.accessToken : "";
      if (!token || token.startsWith("ERROR:")) return false;

      const cookies = await getCookies(conn, ["https://chatgpt.com/"]);
      const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      // oai-device-id 是申请 sentinel token 时用的设备指纹，优先取页面里的真值。
      const deviceId = cookies.find((c) => c.name === "oai-device-id")?.value ?? randomUUID();

      this.#token = token;
      this.#cookieHeader = header;
      this.#oaiDeviceId = deviceId;
      return true;
    } finally {
      conn.close();
    }
  }

  /**
   * 探活：CDP 端口还在响应就认为浏览器还开着。
   *
   * 用户可能已经关掉窗口，此时 #status 仍是 waiting、进程句柄也已失效；
   * 只看状态会让「再点一次」永远被挡回，所以真去问一次端口。
   */
  async #alive() {
    if (this.#proc && this.#proc.exitCode !== null) return false;
    try {
      await cdpVersion(EDGE_DEBUG_PORT, { timeoutMs: 1_500 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 当前状态；waiting 时先探活。
   *
   * 用户直接关掉 Edge 窗口是最常见的失败方式：不探活的话这里会一直回
   * waiting，客户端轮询停不下来、界面永远转圈且没有任何提示。
   */
  async status() {
    if (this.#status === "waiting" && !(await this.#alive())) {
      this.dispose();
      this.#status = "error";
      this.#message = "浏览器窗口已关闭，未读到登录凭据；可再点一次重新拉起";
    }
    return { ok: this.#status === "done", status: this.#status, message: this.#message };
  }

  /** 登录成功后由路由取出凭据；取出即清空内存副本。 */
  take() {
    const value = { accessToken: this.#token, cookieHeader: this.#cookieHeader, oaiDeviceId: this.#oaiDeviceId };
    this.#token = "";
    return value;
  }

  /** 关闭我们起的那个 Edge；不碰用户自己开的实例。 */
  dispose() {
    this.#generation += 1;
    this.#conn?.close();
    this.#conn = null;
    if (this.#proc && this.#proc.exitCode === null) {
      try {
        this.#proc.kill();
      } catch {
        // 进程可能已退出。
      }
    }
    this.#proc = null;
    this.#polling = null;
  }
}

/* ---------------------------------------------------------------- 插件主体 */

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} config 已由宿主按 Config 解析过的配置
 */
export function apply(ctx, config) {
  /**
   * 取当前配置（已与默认值合并）。
   *
   * 两个坑，任一没绕过都会让**所有配置读成 undefined**：
   *
   * 1. 宿主 cordis 的 `resolveConfig()` 走的是
   *    `runtime.Config["~standard"].validate(config)`，而顶层 schema 带了
   *    `.volatile()` ⇒ 返回值是 schemastery 的 **Volatile 包装对象**，
   *    字段不直接暴露，只有 `get()`（实测 `Object.keys(v) === ["get"]`）。
   *    判据与官方插件一致：`dsh-soul-md/index.js:136` 的
   *    `typeof config.get === "function" ? config.get() : config`。
   * 2. 默认值必须取自 `CONFIG_DEFAULTS` 这个普通对象字面量，
   *    **不能写 `Config.doubao`** —— `Config` 是 schemastery 的 schema 函数，
   *    子 schema 不作为属性挂载（实测 `Config.doubao === undefined`），
   *    展开成 `{}` 后默认值全部静默丢失。
   */
  const cfg = () => {
    let raw = config;
    if (raw && typeof raw.get === "function") {
      try {
        raw = raw.get();
      } catch {
        raw = undefined;
      }
    }
    const merged = raw ?? {};
    return {
      doubao: { ...CONFIG_DEFAULTS.doubao, ...merged.doubao },
      gpt: { ...CONFIG_DEFAULTS.gpt, ...merged.gpt },
      video: { ...CONFIG_DEFAULTS.video, ...merged.video },
      image: { ...CONFIG_DEFAULTS.image, ...merged.image },
      gallery: { ...CONFIG_DEFAULTS.gallery, ...merged.gallery },
    };
  };

  const sessions = createSessionStore(ctx);

  /**
   * 画廊存储。
   *
   * 放服务端而不是只放客户端 IndexedDB：后者按 origin 隔离，而 origin 含端口，
   * DSH web 换一次端口就是一个空库。用户工作区没变、图也没删，画廊却空了。
   *
   * 路径沿用 DSH 惯例（`$DSH_HOME/storages/<插件名>/`），与
   * `cost-meter/ledger.json`、`session_projcache/*.json` 同构。
   */
  const galleryStore = createGalleryStore(join(resolveGalleryHome(), "storages", "dsh-doubao-image", "gallery.json"));
  /** 浏览器登录会话；同一时刻只允许一个，见路由里的 already-running 判断。 */
  let browserLogin = null;
  const edgeSession = new GptEdgeLoginSession();

  ctx.effect(() => () => {
    edgeSession.dispose();
  }, "dsh-doubao-image: 释放登录会话");

  /* ---------------------------------------------------------- 凭据解析 */

  /**
   * 真实凭据以 credentials record 为准，设置页里手工粘贴的值（Config 镜像）作为
   * fallback——这样「没登录但临时贴了个 cookie」也能直接跑。
   */
  /**
   * 把某个账号存下来的真实设备身份注入 lib（每次生成前调用）。
   *
   * 为什么必须做：豆包把 `fp` / `device_id` / `web_id` / `tea_uuid` 与 cookie
   * 交叉校验。用 lib 里那套硬编码的旧身份配真实 cookie，服务端 0.4 秒就回
   * `710022004 verify`（异常请求，进人机校验队列），永远不出图。
   *
   * 必须**按账号**注入：每个账号的 fp 来自它自己的浏览器会话，混用等于把
   * A 的指纹套在 B 的 cookie 上，同样会被判异常。
   */
  /**
   * 把一个账号的设备身份与 msToken 组装成**随请求传递**的参数（H3）。
   *
   * ## 为什么不再 `setDeviceIdentity(account.device)`
   *
   * 旧实现把设备身份写进 lib 的**进程级单例**。`withDoubaoAccount` 的账号循环
   * 里，每一步先 set 再 await——而 await 之间会切到别的请求，于是：
   *
   *   请求 A 用账号 1（设备 X）开始生图
   *   → 请求 B 用账号 2 把单例覆盖成 Y
   *   → A 的后续 HTTP 请求带着 **Y 的 fp + 账号 1 的 cookie**
   *
   * 豆包侧看到「设备与账号错配」，直接判 `710022004` 进人机校验。
   *
   * 现在身份从账号对象一路显式传下去（`identity` → `securityParams(identity)`），
   * 中途没有任何跨请求共享的可变状态。
   *
   * @param {object} account 账号对象
   * @returns {{device?: object, msToken?: string}} 直接展开进生成入参
   */
  const doubaoIdentityOf = (account, options = {}) => ({
    ...(account?.device && typeof account.device === "object" ? { device: account.device } : {}),
    ...(typeof account?.msToken === "string" && account.msToken !== "" ? { msToken: account.msToken } : {}),
    /*
     * 固定会话（默认关，由 `image.reuseConversation` 控制）。
     *
     * 生图默认每次新建一个会话，用久了账号里会堆一堆「一只橘猫」这类测试会话。
     * 打开开关后把会话 id 记在账号上并复用，账号里就只保留 1 个生图会话 ——
     * 不必删任何东西（删除本身还会在服务端留操作记录）。
     *
     * 默认关的理由：会话是多轮对话的容器，服务端可能按历史理解当前提示词。
     * 实测同一会话内「橘猫」→「雪山」没有串味，但一次实验不足以证明长期无影响。
     *
     * 实测依据见 `lib/doubao-image.mjs` 的 `editRequestBodyV2`：
     * `conversation_id` 非空 + `need_create_conversation: false` 服务端会复用。
     */
    ...(options.reuseConversation === true
      && typeof account?.conversationId === "string" && account.conversationId !== ""
      ? { conversationId: account.conversationId }
      : {}),
  });

  /**
   * 按「当前账号 → 其余账号」的顺序排出生图候选。
   *
   * 顺序的语义是「先试谁的号」：当前账号打头，失败才轮到其它账号。
   * 当前账号指到不存在的 id 时退回第一个账号，不让整个池失效。
   */
  const doubaoAccountCandidates = (stored) => {
    const accounts = Array.isArray(stored?.accounts) ? stored.accounts : [];
    if (accounts.length > 1 && stored.activeId) {
      const active = accounts.find((a) => a.id === stored.activeId);
      if (active) return [active, ...accounts.filter((a) => a.id !== active.id)];
    }
    return accounts.slice();
  };

  /**
   * 这个错误值不值得换下一个账号再试。
   *
   * 只认「换号能解决」的那几类：限流、人机校验、登录失效。参数错、参考图
   * 不可读之类的错误换谁都一样，继续轮换只会把整个池的额度烧一遍。
   *
   * 判据只用**结构化错误码**，不看 `gateway` 也不看文案：
   *   - `gateway` 只表示「这个错误来自网关 STREAM_ERROR 事件」，参数错误同样
   *     带这个标志（`lib/doubao.mjs` 的 postChatV2 对所有错误事件都置 true）。
   *     拿它当可换判据，一次参数错误就会试遍所有账号——这条已由测试守住。
   *   - 文案不可靠：「invalid param」里含 verify 子串，正则匹配会误判。
   */
  const isDoubaoSwitchable = (error) => {
    if (!error) return false;
    if (error.needsHumanVerify === true) return true;
    /*
     * 「响应未正常完成」也换号。
     *
     * 2026-10-17 实测：把一个 sessionid 无效的账号放进池里当当前账号，豆包**不返回**
     * `710012000`，而是回一个没有消息块、没有结束事件的异常 SSE。此时错误对象上
     * 既没有 `errorCode` 也没有 `gateway` 标志，旧判据全部落空 —— 结果是整个池只试了
     * 第一个（坏的）账号就报失败，后面两个好账号根本没机会出图。
     *
     * 为什么敢把这一类算作可换：它是**服务端没给出有效回答**，而账号是唯一随迭代
     * 变化的变量（请求体、设备身份、签名都由各账号自己带）。参数类错误会走
     * `gateway` 分支并带结构化 code，落到这里的只能是「连回答都没拿到」。
     */
    if (error.incompleteReply === true) return true;
    /*
     * 这个账号缺设备身份（典型：手工粘贴 cookie 进来的账号）也要换号。
     * 缺身份是**单个账号**的残缺，不是整池的问题；不换的话，排在它后面的
     * 正常账号永远没机会出图。
     */
    if (error.missingDevice === true) return true;
    const code = String(error.errorCode ?? "");
    // 710022002 限流 / 710022004 人机校验 / 710012000 登录失效
    return code === "710022002" || code === "710022004" || code === "710012000";
  };

  /**
   * 把一个操作跑遍账号池，直到某个账号成功。
   *
   * 返回 `{result, account, attempts}`；全部失败时抛出最后一个错误，
   * 并把每个账号的失败原因挂在 `error.attempts` 上——只报最后一个账号的错
   * 会让用户以为「只有 B 有问题」，实际上 A 可能也挂了。
   */
  const withDoubaoAccount = async (stored, run) => {
    const candidates = doubaoAccountCandidates(stored);
    const attempts = [];
    /*
     * 关掉「自动切换账号」时只用当前这一个号。
     *
     * 为什么要有这个开关：换号在用户不知情的情况下发生，而每个号在豆包那边
     * 是**不同的会话空间**——测试时最怕的就是「我以为在用小号，其实悄悄用主号
     * 出了图、留了会话」。关掉之后失败就失败，绝不替你换号。
     */
    const autoSwitch = cfg().doubao.autoSwitchAccount !== false;
    const ordered = autoSwitch ? candidates : candidates.slice(0, 1);
    for (let index = 0; index < ordered.length; index += 1) {
      const account = ordered[index];
      /*
       * 「后面还有号可换」——交给 run 决定要不要起浏览器兜底。
       *
       * 起一次真浏览器要 10~20 秒，换号是毫秒级。池里还有账号时先换号，
       * 全部账号都被风控了才起浏览器；否则单号 verify 会白起一次浏览器，
       * 而下一个号可能直接成功。
       */
      const hasMoreAccounts = index < ordered.length - 1;
      try {
        const result = await run(account, { hasMoreAccounts });
        if (attempts.length > 0) {
          // 轮换过的请求要告诉用户用了哪个账号，否则「刚才那几张是谁出的」无从回答。
          void sessions.touchDoubaoAccount(account.id).catch?.(() => {});
        }
        return { result, account, attempts };
      } catch (error) {
        attempts.push({
          accountId: account.id,
          label: account.label ?? "",
          errorCode: String(error?.errorCode ?? ""),
          message: error instanceof Error ? error.message : String(error),
          switchable: isDoubaoSwitchable(error),
        });
        if (!isDoubaoSwitchable(error)) break;
      }
    }
    const last = attempts[attempts.length - 1];
    /*
     * 关掉自动切换却仍有「换号能解决」的错误时，必须说清楚是开关挡住的，
     * 否则用户只会看到「失败了」，不知道其实还有别的号可以试。
     */
    const blockedBySwitchOff = !autoSwitch
      && candidates.length > 1
      && isDoubaoSwitchable(last);
    const error = new Error(
      blockedBySwitchOff
        ? `${last?.message ?? "豆包请求失败"}（已关闭「自动切换账号」，没有尝试其它 ${candidates.length - 1} 个账号）`
        : attempts.length > 1
          ? `豆包账号池全部失败（试了 ${attempts.length} 个账号）：${attempts.map((a) => `${a.label || a.accountId}: ${a.message}`).join("；")}`
          : (last?.message ?? "豆包未登录：请先在设置页完成登录"),
    );
    error.attempts = attempts;
    error.errorCode = last?.errorCode ?? "";
    error.switchBlocked = blockedBySwitchOff;
    throw error;
  };

  /**
   * 读豆包账号池，并给出「池为空时退回配置里的单 cookie」的兜底。
   *
   * 账号池是增强，不该让配置文件里的老用法失效：没存过账号时仍然读
   * `cfg().doubao.cookieHeader`，行为与改动前逐字一致。
   */
  /**
   * 读豆包账号池，并给出「池为空时退回配置里的单 cookie」的兜底。
   *
   * 账号池是增强，不该让配置文件里的老用法失效：没存过账号时仍然读
   * `cfg().doubao.cookieHeader`，行为与改动前逐字一致。
   *
   * ## 顺带续期
   *
   * 读到池子之后先看一眼各账号的 `sid_guard` 剩余时间，快过期的触发一次
   * 浏览器续期（`lib/credential-sync.mjs`）。没到点时这一步是**纯计算**，
   * 耗时 0ms、不起浏览器，所以放在每次生图前都不会有代价。
   *
   * 续期失败**不影响本次生图**：原 cookie 通常还能用；真不能用时，
   * 生图请求自己会报错并进入账号轮换。
   */
  const resolveDoubaoPool = async () => {
    let stored = await sessions.readDoubao();
    if (stored?.accounts?.length) {
      const outcome = await ensureDoubaoFresh({
        pool: stored,
        // 同 GPT：生图路径只在 cookie 真过期时才续，避免提前 48 小时就把浏览器弹出来。
        marginMs: 0,
        persist: (input) => sessions.upsertDoubaoAccount(input),
      }).catch((error) => ({ ok: false, reason: error?.message ?? String(error) }));
      if (outcome.refreshed?.length) {
        // 续期改变了 pool，重新读一次，让调用方拿到新 cookie。
        stored = (await sessions.readDoubao()) ?? stored;
        console.info(`豆包凭据已续期：${outcome.refreshed.map((id) => id.slice(0, 8)).join(",")}`);
      } else if (outcome.ok === false && outcome.reason && outcome.reason !== "not-due") {
        console.info(`豆包凭据续期未成功（不影响本次生成）：${outcome.reason}`);
      }
      return { pool: stored, fallbackCookie: "" };
    }
    return { pool: null, fallbackCookie: (cfg().doubao.cookieHeader ?? "").trim() };
  };

  /**
   * 记住「这一轮真正用的号」。
   *
   * 设置页只靠 `activeId` 判断「当前」是不够的：生图是**按候选顺序逐个试**的，
   * 当前账号失败时会静默轮到下一个，界面上那个蓝标却还停在已经失败的那个号上。
   * 所以每次生图后把**真正出图的那个**记为当前账号，让界面与事实一致。
   *
   * 只在「用的号 ≠ 当前号」时才写，避免每张图都改一次凭据文件。
   */
  const markActiveDoubaoAccount = async (accountId) => {
    if (!accountId) return;
    const stored = await sessions.readDoubao().catch(() => null);
    if (!stored?.accounts?.length) return;
    if (stored.activeId === accountId) return;
    if (!stored.accounts.some((a) => a.id === accountId)) return;
    const result = await sessions.setActiveDoubaoAccount(accountId);
    if (result?.ok) console.info(`当前豆包账号已跟随出图账号切换：${accountId.slice(0, 8)}`);
  };

  /**
   * 记住某个账号的固定生图会话。
   *
   * 生图成功后把服务端实际用的会话 id 写回账号，下一次生图就复用同一个，
   * 账号里只会留 1 个生图会话（详见 `editRequestBodyV2` 的实测注释）。
   *
   * **写失败不阻断生图**：图已经出了，记不住会话只是下次多建一个会话，
   * 不该让用户为一次凭据写盘失败丢掉这张图。
   */
  const rememberDoubaoConversation = async (accountId, conversationId) => {
    if (!accountId) return;
    const value = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!/^\d{6,}$/.test(value)) return;
    try {
      const stored = await sessions.readDoubao();
      const current = stored?.accounts?.find((a) => a.id === accountId);
      // 已经记着同一个会话就不写盘：每张图都改凭据会造成写放大。
      if (!current || current.conversationId === value) return;
      const result = await sessions.setDoubaoConversationId(accountId, value);
      if (result?.ok && result.changed) {
        console.info(`已记住豆包固定会话：${value}（后续生图复用，不再新建）`);
      }
    } catch (error) {
      console.warn(`记住豆包会话失败（不影响本次出图）：${error?.message ?? error}`);
    }
  };

  /**
   * 结果里那句「用哪个账号出的」。
   *
   * 只有一个账号时也写出来：用户挂了几个号之后，最常问的就是「这张是谁的额度」。
   * 轮换过就把前面失败的原因一并带上，否则「为什么突然换号了」无从判断。
   */
  const accountNote = (account, pool, attempts) => {
    if (!account) return "";
    const index = pool.accounts.findIndex((a) => a.id === account.id);
    const name = account.label || `账号 ${index + 1}`;
    if (attempts.length === 0) return `，账号 ${name}`;
    const failed = attempts.map((a) => `${a.label || a.accountId}（${a.message}）`).join("、");
    return `，账号 ${name}（前 ${attempts.length} 个失败：${failed}）`;
  };

  /**
   * 读 GPT 凭据，顺带在 accessToken 快过期时续一次。
   *
   * token 是 JWT，过期时间就在 `exp` 里，判断零成本；没到点时不起浏览器。
   * 续期失败同样不阻断：原 token 只要还没真过期就照常能用。
   */
  const resolveGptCredential = async () => {
    const stored = await sessions.readGpt();
    const c = cfg().gpt;
    const current = {
      accessToken: (stored?.accessToken || c.accessToken || "").trim(),
      cookieHeader: stored?.cookieHeader || c.cookieHeader || "",
      oaiDeviceId: stored?.oaiDeviceId || c.oaiDeviceId || "",
      proxyUrl: c.proxyUrl ?? "",
      timeoutMs: c.timeoutMs ?? 300_000,
    };

    // 只有 token 非空才值得续：空 token 说明用户还没登录，续也续不出东西。
    if (current.accessToken) {
      /*
       * 生图路径**只在 token 真的过期时**才续，不用默认的 48 小时提前量。
       *
       * 2026-10-22 用户实测报「点击生图会突然拉起浏览器」：默认
       * `REFRESH_MARGIN_MS` 是 48 小时，而 GPT accessToken 当时只剩约 33 小时，
       * 于是**每次生图**都判定「该续了」→ `renewGptFromBrowser` →
       * `spawn(browser, …, { windowsHide: false })` ⇒ 弹出一个可见浏览器窗口，
       * 最长还要等 90 秒。token 明明还能用。
       *
       * 这里传 `marginMs: 0`：token 没过期就一个字都不动。真过期时再续
       * （那时弹出浏览器是必要的——不续就完全用不了），失败也不影响报错路径，
       * 用户会看到「请先完成 GPT 登录」的提示。
       */
      const outcome = await ensureGptFresh({
        credential: current,
        userDataDir: EDGE_USER_DATA_DIR,
        marginMs: 0,
        persist: (input) => sessions.writeGpt(input),
        deviceIdOf: (cookieHeader) => cookieOf(cookieHeader, "oai-device-id"),
      }).catch((error) => ({ ok: false, reason: error?.message ?? String(error) }));
      if (outcome.reason === "ok") {
        const next = await sessions.readGpt();
        if (next?.accessToken) {
          current.accessToken = next.accessToken;
          current.cookieHeader = next.cookieHeader || current.cookieHeader;
          current.oaiDeviceId = next.oaiDeviceId || current.oaiDeviceId;
          console.info(`GPT 凭据已续期，剩余 ${outcome.remaining}`);
        }
      } else if (outcome.ok === false) {
        console.info(`GPT 凭据续期未成功（不影响本次生成）：${outcome.reason}`);
      }
    }
    return current;
  };

  /**
   * 出图后把 ChatGPT 侧的对话隐藏掉（用户 2026-10-25 要求「gpt 生完图要自动删除会话」）。
   *
   * 抽成一个函数是因为它有**两条**调用路径（工具 `gpt_image` 与 `/api/regenerate`），
   * 而清理语义必须一致：删不掉不回滚出图，只把失败原因带回去。
   *
   * @returns {Promise<null | {conversationId: string, ok: false, reason: string}>}
   *   `null` 表示无需清理或清理成功——只有**失败**才值得进返回值。
   */
  const cleanupGptConversation = async ({ credential, conversationId }) => {
    const id = typeof conversationId === "string" ? conversationId.trim() : "";
    if (id === "") return null;
    const deleted = await gptDeleteConversation({
      accessToken: credential.accessToken,
      cookieHeader: credential.cookieHeader,
      oaiDeviceId: credential.oaiDeviceId,
      proxyUrl: credential.proxyUrl,
      timeoutMs: 30_000,
      conversationId: id,
    });
    if (deleted.ok) return null;
    console.info(`GPT 会话清理未成功（不影响出图）：${deleted.reason}`);
    return { conversationId: id, ok: false, reason: deleted.reason };
  };

  /* ------------------------------------------------------------ 图片落盘 */

  /**
   * 把生成的字节存成 attachment，返回**引用对象**（不是渲染块）。
   *
   * 引用对象会原样进 tool 返回值，因此它的每个字段都必须在 `output.schema`
   * 里声明：宿主 `createSuccessResult`（`dsh-tools/lib/index.js:3541-3544`）
   * 用 `validateJsonSchemaValue` 校验**整个返回值**，schema 里写
   * `additionalProperties: false` 时多一个字段就整次调用失败，报
   * `"value.attachment" is not a declared property`。
   *
   * 字段名以真实服务为准（`dsh-attachment-local/lib/index.js:337-348`）：
   * `attachmentId` / `mediaType` / `width` / `height` / `bytes`，降采样时另带
   * `originalDimensions`；显示名是 `name`。**没有 `byteSize`**。
   *
   * 图片进对话靠 `render` 返回 `{type:"image", attachment}`，不是靠这里。
   */
  const attachImage = async (buf, mediaType, attachmentName) => {
    return ctx.attachments.saveImage({ data: buf, mediaType, name: attachmentName });
  };

  /**
   * 把 `generateImage` / `editImage` 返回的**全部**图片落盘。
   *
   * 为什么必须全部落盘：豆包一次可以出多张（prompt 里写明张数即可），
   * 早期只落 `result.data`（第一张），第 2 张起在客户端根本看不到 —— 用户
   * 看到的症状是「要了 3 张只给 1 张」。这里逐张 `saveImage`，返回数组。
   *
   * 向后兼容：`result.items` 缺失时（老版本返回值 / 别的通道）退回 `result.data`
   * 单张，行为与旧实现一致。
   *
   * @returns {Promise<Array<{attachment: object, mediaType: string, watermarkFree: boolean}>>}
   */
  const attachAllImages = async (result, nameOf) => {
    const items = Array.isArray(result?.items) && result.items.length > 0
      ? result.items
      : [{ data: result?.data, mediaType: result?.mediaType, watermarkFree: result?.watermarkFree }];
    const saved = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || !item.data || item.data.length === 0) continue;
      const mediaType = item.mediaType ?? result?.mediaType ?? "image/png";
      saved.push({
        attachment: await attachImage(item.data, mediaType, nameOf(i, mediaType)),
        mediaType,
        watermarkFree: item.watermarkFree === true,
        ...(typeof item.actualRatio === "string" ? { actualRatio: item.actualRatio } : {}),
        // 保留原始字节：工作区落盘要用。attachment 引用里没有字节，
        // 想再读回来得走一次存储层，不如在这里顺带带上。
        data: item.data,
      });
    }
    if (saved.length === 0) throw new Error("豆包返回的图片全部无法落盘");
    return saved;
  };

  /**
   * 工作区内的图片目录绝对路径。
   *
   * 目录可以嵌套，但**必须留在工作区内**：绝对路径与 `..` 段一律拒绝。
   * 这一遍是纯词法检查，是必要条件不是充分条件 ——
   * `saveImageToWorkspace` 还会再核对一次磁盘上的真实路径，防止符号链接逃逸。
   */
  const workspaceImageDir = (workspaceRoot, folder) => {
    const trimmed = (folder ?? "").trim();
    const root = resolve(workspaceRoot);
    const dir = trimmed === "" ? root : resolve(root, trimmed);
    const rel = relative(root, dir);
    const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) throw new Error(`落盘子目录 '${folder}' 必须留在会话工作区内`);
    return dir;
  };

  /**
   * 生成图片在工作区内的文件名。
   *
   * 前缀 `doubao-image-` 是本插件自己的，**刻意不与官方 `dsh-image-gen` 的
   * `image-<hash8>.ext` 同形**：两者都往工作区写文件，前缀一样的话单看
   * 文件名分不出通道，批量清理时也容易误删。取 attachmentId 前 8 位十六
   * 进制作为区分（attachmentId 形如 `sha256:abcdef...`，先剥前缀再截断；
   * 不足 8 位右补 0，保证名字长度稳定）。
   */
  const workspaceImageName = (attachmentId, mediaType) => {
    const raw = String(attachmentId ?? "");
    const bare = raw.startsWith("sha256:") ? raw.slice(7) : raw;
    const stem = bare.slice(0, 8).padEnd(8, "0");
    return `doubao-image-${stem}.${extOfMime(mediaType).replace(/^\./, "")}`;
  };

  /**
   * 把图片字节另存进会话工作区，返回绝对路径。
   *
   * **为什么必须做这件事**：attachment 只活在 DSH 的附件库里，模型拿到的
   * 返回值里**没有任何文件路径**。实测症状是模型看到「生图完成」后满盘
   * `Get-ChildItem -Recurse` 找图，翻两分半钟一无所获，最后无法回复用户
   * （2026-10-15 用户反馈）。官方 `dsh-image-gen` 正是靠这个落盘 +
   * 在 render 文本里报出 `savedTo` 来消除这个问题的。
   *
   * 写入是「先写 staging 再 rename」的原子替换，且两次校验目录未逃逸
   * （`mkdir` 之后再核对一次，防止中途被换成符号链接）。
   */
  const saveImageToWorkspace = async ({ workspaceRoot, folder, attachmentId, mediaType, data, signal }) => {
    const dir = workspaceImageDir(workspaceRoot, folder);
    signal?.throwIfAborted?.();
    const realRoot = await realpath(resolve(workspaceRoot));
    const name = workspaceImageName(attachmentId, mediaType);
    const target = join(dir, name);
    const staging = join(dir, `.${name}.${process.pid}-${randomUUID()}.tmp`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(staging, data, { flag: "wx", signal });
      signal?.throwIfAborted?.();
      await rename(staging, target);
    } catch (error) {
      await unlink(staging).catch(() => {});
      throw error;
    }
    // 落盘后确认没跑到工作区外（`..` 之外还有符号链接这条路径）。
    const realDir = await realpath(dir);
    const rel = relative(realRoot, realDir);
    if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      await unlink(target).catch(() => {});
      throw new Error(`落盘目录 '${folder}' 解析后位于工作区之外`);
    }
    return target;
  };

  /**
   * 最近一次在工具调用里见到的工作区根。
   *
   * HTTP 路由（`/api/regenerate`）没有 `exec.agent`，拿不到会话的 cwd；
   * 官方 `dsh-image-gen` 用的是同一个办法（`lib/index.js:28320`
   * `getActiveWorkspaceRoot` 读它自己维护的 `knownWorkspaceRoots`）。
   * 只有经过一次工具调用才会有值 —— 没值时就不落盘，不猜。
   */
  let lastWorkspaceRoot = "";

  /**
   * 给一批已落盘的 attachment 补上工作区路径。
   *
   * 返回 `savedTo` 数组（与入参等长，失败项为 undefined）与非空的
   * `saveError`。**落盘失败绝不能让整次生图失败** —— 图已经在
   * attachment 里了，用户能看到图；路径只是锦上添花。
   */
  const saveAllToWorkspace = async (saved, exec) => {
    const paths = [];
    let saveError;
    if (cfg().image.saveToWorkspace === false) return { paths, saveError };
    const workspaceRoot = exec?.agent?.session?.header?.cwd;
    if (typeof workspaceRoot === "string" && workspaceRoot.trim() !== "") lastWorkspaceRoot = workspaceRoot;
    if (lastWorkspaceRoot === "") return { paths, saveError };
    for (const item of saved) {
      try {
        paths.push(await saveImageToWorkspace({
          workspaceRoot: lastWorkspaceRoot,
          folder: cfg().image.workspaceFolder,
          attachmentId: item.attachment?.attachmentId,
          mediaType: item.mediaType,
          data: item.data,
          signal: exec?.signal,
        }));
      } catch (error) {
        paths.push(undefined);
        if (saveError === undefined) saveError = errText(error);
      }
    }
    return { paths, saveError };
  };

  /**
   * 把非图片字节（视频）存成 attachment 文件引用。
   *
   * **不能用 `saveImage`**：它只接受 `image/png|jpeg|webp|gif`
   * （`dsh-attachment-local/lib/index.js` 的 `mediaTypes` 白名单），
   * `video/mp4` 会被 `detectImage` 判为
   * `Unsupported or malformed image data.`（实测）。
   * `saveFile` 不校验类型、按字节原样落盘，返回 `{attachmentId, name, bytes}`
   * ——**没有 mediaType / width / height**，所以 schema 必须用 oneOf 分形态。
   */
  const attachFile = async (buf, attachmentName) => {
    return ctx.attachments.saveFile({ data: buf, name: attachmentName });
  };

  /**
   * attachment 引用的 JSON Schema 片段。
   *
   * 必须用**对象级** `required: [...]` 数组：`dsh-image-gen` 里那种属性级
   * `required: true` 是它自带转换层的私有写法，本机 `assertSupportedJsonSchema`
   * 直接判为 `unsupported JSON schema`（实测）。对象级写法既能通过校验，
   * 也能真正抓到缺字段（实测缺 bytes 时报 missing required property）。
   *
   * 图片与文件（视频）两种形态字段集不同，只能用 `oneOf` 表达；
   * `oneOf` 不能与同级 `type`/`properties` 共存（`dsh-tools/lib/index.js:142-150`
   * 的 `ONE_OF_SIBLING_KEYWORDS`），所以这里只写 `oneOf`。实测：合法图片、
   * 合法文件各自匹配唯一分支；给文件引用多带一个 mediaType 则两个分支都不匹配，
   * 报 `must match exactly one oneOf branch (matched 0)`。
   */
  const IMAGE_REF_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["attachmentId", "mediaType", "width", "height", "bytes"],
    properties: {
      attachmentId: { type: "string" },
      mediaType: { type: "string" },
      width: { type: "integer" },
      height: { type: "integer" },
      bytes: { type: "integer" },
      name: { type: "string" },
      originalDimensions: {
        type: "object",
        additionalProperties: false,
        required: ["width", "height"],
        properties: {
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
    },
  };

  /** `saveFile` 的返回形态：只有 `attachmentId` / `name` / `bytes`。 */
  const FILE_REF_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["attachmentId", "name", "bytes"],
    properties: {
      attachmentId: { type: "string" },
      name: { type: "string" },
      bytes: { type: "integer" },
    },
  };

  /** 豆包工具用：图片或视频文件，二选一。 */
  const ATTACHMENT_SCHEMA = { oneOf: [IMAGE_REF_SCHEMA, FILE_REF_SCHEMA] };

  /**
   * 生成一张（或多张）图并把全部结果落盘 —— 工具与 `/api/regenerate` 共用。
   *
   * 抽出来的理由：`doubao_image` 工具与「重新生成」路由要的是**同一件事**
   * （跑通道 → 逐张落盘 → 组返回体）。抄一份到路由里，两边的多图处理迟早漂移。
   *
   * @param {object} opts
   * @param {"doubao"|"gpt"} opts.provider
   * @param {string} opts.prompt
   * @param {string} [opts.size]
   * @param {string} [opts.ratio] 仅图生图：画幅原值透传给 lib（auto/1:1/4:3/16:9/9:16/2:3/3:4/3:2），缺省由 lib 吸附 auto；生成链路不传
   * @param {string} [opts.model] 豆包生图模型显示名（模型切换）；缺省取设置里的 image.model
   * @returns {Promise<{attachment: object, extraAttachments?: object[], count: number, mediaType: string, model: string, ratio: string, watermarkFree: boolean, provider: string, summary: string, requestModel?: string, actualModel?: string, requestedRatio?: string}>}
   */
  const runGeneration = async ({ provider, prompt, size, ratio, model, exec, images }) => {
    if (provider === "gpt") {
      const credential = await resolveGptCredential();
      if (!credential.accessToken) {
        throw new Error("请先在设置页完成 GPT 登录（点击「拉起浏览器登录」或手工粘贴 accessToken）");
      }
      /*
       * GPT 免费通道支持图生图（2026-10-22 实测）。
       *
       * 链路：先把参考图逐张上传到 `/backend-api/files`（三步：申请 → PUT blob
       * → 确认），拿 `fileId`；再把对话 body 的 content 换成 `multimodal_text`，
       * parts 里放 `image_asset_pointer`（`file-service://{fileId}`）+ 提示词。
       * 与上游 Python `_upload_image` / `_start_image_generation` 逐字段对齐。
       *
       * 这里只做形状转换（`{data, mediaType}` → 带文件名的引用），宽高由
       * lib 从图片头解析——Host 侧的 `images` 里本来就没有尺寸。
       */
      const referenceImages = Array.isArray(images)
        ? images.map((item, index) => ({
          data: item.data,
          mimeType: typeof item.mediaType === "string" && item.mediaType !== "" ? item.mediaType : "image/png",
          fileName: `reference-${index + 1}${extOfMime(item.mediaType)}`,
        }))
        : [];
      const result = await gptGenerateImage({
        accessToken: credential.accessToken,
        cookieHeader: credential.cookieHeader,
        oaiDeviceId: credential.oaiDeviceId,
        prompt,
        proxyUrl: credential.proxyUrl,
        timeoutMs: credential.timeoutMs,
        referenceImages,
      });
      const raw = result.raw ?? {};
      /**
       * 生完就删会话（用户 2026-10-25 要求）。
       *
       * GPT 免费通道每生一张图都会在账号里新建一个对话，不清理会一直堆。
       * `deleteConversation` 发的是 `PATCH {is_visible:false}`（上游同款），
       * **失败不抛**：图已经出了，删除只是清理动作，不能因此把整次生图判失败。
       * 失败原因回传给上层，让用户知道要去网页手动删哪一个。
       */
      const cleanup = await cleanupGptConversation({
        credential,
        conversationId: raw.conversationId,
      });
      /**
       * GPT 免费通道**实测一次只能出一张**（用户确认），所以这里不循环、
       * 也不吐 `extraAttachments` —— 无中生有多图会让上层以为还有第 2 张。
       */
      const attachment = await attachImage(result.data, result.mediaType, "gpt-image");
      const one = [{ attachment, mediaType: result.mediaType, watermarkFree: false, data: result.data }];
      const { paths, saveError } = await saveAllToWorkspace(one, exec);
      return {
        attachment,
        count: 1,
        mediaType: result.mediaType,
        model: String(raw.model ?? ""),
        ratio: "",
        watermarkFree: false,
        provider: "gpt",
        ...(paths[0] === undefined ? {} : { savedTo: paths[0] }),
        ...(saveError === undefined ? {} : { saveError }),
        ...(cleanup === null ? {} : { conversationCleanup: cleanup }),
        summary: [
          `ChatGPT 免费账户出图完成（model=${raw.model ?? "?"}${raw.revisedPrompt ? `，改写后的提示词：${raw.revisedPrompt}` : ""}）。`,
          imagePathHint(paths[0], saveError),
        ].join(""),
      };
    }

    /*
     * 模型只有豆包通道有；GPT 免费通道的模型由服务端固定。
     * 缺省回落到设置里的 image.model，保证「设置页选了 4.5」与「实际请求 4.5」
     * 是同一个值，而不是设置只影响界面文案。
     */
    const requestedModel = typeof model === "string" && model !== "" ? model : cfg().image.model;
    /*
     * 固定会话开关（默认关）。
     *
     * 关：`doubaoIdentityOf` 不带 conversationId ⇒ 每次新建会话，各次互不影响。
     * 开：带上账号记住的会话 id ⇒ 所有生图进同一个会话，账号里只留 1 个。
     */
    const reuseConversation = cfg().image.reuseConversation === true;
    const { pool, fallbackCookie } = await resolveDoubaoPool();
    const callDoubao = (cookieHeader, identity = {}, options = {}) => (images ? doubaoEditImage : doubaoGenerateImage)({
      cookieHeader,
      ...identity,
      prompt,
      ...(images ? { images } : {}),
      size: size || cfg().image.defaultSize,
      model: requestedModel,
      ...(images && ratio !== undefined ? { ratio } : {}),
      timeoutMs: cfg().image.timeoutMs,
      /*
       * 池里还有别的号可换时，先别起浏览器（10~20 秒），换号是毫秒级。
       * 没有池（单 cookie）时 hasMoreAccounts 恒为 false，浏览器兜底照常启用。
       */
      allowBrowserFallback: !options.hasMoreAccounts,
    });
    const { result, account, attempts } = pool
      ? await withDoubaoAccount(pool, (a, options) => callDoubao(
        a.cookieHeader,
        doubaoIdentityOf(a, { reuseConversation }),
        options,
      ))
      : { result: await callDoubao(fallbackCookie), account: null, attempts: [] };
    const saved = await attachAllImages(
      result,
      (index, mediaType) => `doubao-image-${index + 1}${extOfMime(mediaType)}`,
    );
    // 出图成功 ⇒ 这个号就是「真正在用的号」，让设置页的蓝标跟上事实。
    await markActiveDoubaoAccount(account?.id);
    /*
     * 会话去向，两个开关互斥：
     *
     * 固定会话（默认关）：记住这次会话 id，下次生图复用它，账号里只留 1 个。
     * 非固定会话（默认）：**用完就删**。不删的话每次生图都会在账号里堆一个
     *   会话，用户翻豆包时会看到一堆「一只可爱的小花猫…」的垃圾对话。
     *   注意 `reuseConversation: false` 此前只表示「不复用」，并没有删除，
     *   所以这条路径一直是漏的（2026-10-20 用户反馈实测）。
     *
     * 删除失败**不影响生图结果**：图已经拿到手了，删会话是清理动作。
     * 只把失败原因放进返回值，让用户能判断是不是又堆会话了。
     */
    let conversationCleanup = null;
    if (reuseConversation) {
      await rememberDoubaoConversation(account?.id, result?.conversationId);
    } else if (typeof result?.conversationId === "string" && result.conversationId !== "") {
      const deleted = await doubaoDeleteConversation(
        account?.cookieHeader ?? fallbackCookie,
        result.conversationId,
        { device: account?.device, timeoutMs: cfg().image.timeoutMs },
      );
      if (!deleted.ok) conversationCleanup = { conversationId: result.conversationId, ...deleted };
    }
    const extra = saved.slice(1).map((item) => item.attachment);
    const { paths, saveError } = await saveAllToWorkspace(saved, exec);
    return {
      attachment: saved[0].attachment,
      ...(extra.length === 0 ? {} : { extraAttachments: extra }),
      count: saved.length,
      mediaType: saved[0].mediaType,
      model: result.requestModel ?? "",
      // 请求模型与（服务端回显的）实际模型分开报，不能拿前者冒充后者。
      ...(typeof result.requestModel === "string" ? { requestModel: result.requestModel } : {}),
      ...(typeof result.actualModel === "string" && result.actualModel !== "" ? { actualModel: result.actualModel } : {}),
      ratio: result.ratio,
      ...(images ? { itemRatios: saved.map((item, index) => item.actualRatio ?? (index === 0 && !Array.isArray(result.items) ? result.ratio : "")) } : {}),
      ...(typeof result.requestedRatio === "string" ? { requestedRatio: result.requestedRatio } : {}),
      watermarkFree: saved[0].watermarkFree,
      provider: "doubao",
      /*
       * 会话清理失败才报。成功不占字段：这是清理动作，不该让用户以为
       * 生图结果里多了一个需要关心的东西。失败时给出 conversationId，
       * 用户才能去豆包手动删掉那一个。
       */
      ...(conversationCleanup === null ? {} : { conversationCleanup }),
      /*
       * 用了哪个账号要说出来：多账号时「这张是谁的额度出的」是用户真正关心的
       * 信息，藏在日志里等于没说。
       */
      ...(account
        ? {
            accountId: account.id,
            accountLabel: account.label || `账号 ${pool.accounts.findIndex((a) => a.id === account.id) + 1}`,
            switchCount: attempts.length,
            ...(attempts.length === 0
              ? {}
              : { switchedFrom: attempts.map((a) => ({ accountLabel: a.label || a.accountId, message: a.message })) }),
          }
        : {}),
      // 多图时给全部路径，客户端与模型都能看到每张落在哪。
      ...(paths[0] === undefined ? {} : { savedTo: paths[0] }),
      ...(paths.length > 1 ? { savedToAll: paths.filter((p) => typeof p === "string") } : {}),
      ...(saveError === undefined ? {} : { saveError }),
      summary: [
        /*
         * 模型的措辞必须区分「回显确认」与「仅请求」——服务端不回显时说成
         * 「用了 X」就是在替服务端作证。实测两条链路都会回显 placeholder，
         * 但网络异常时可能缺失，届时宁可说「未确认」。
         */
        images
          ? `豆包图生图完成（参考图 ${result.references} 张，请求比例 ${result.requestedRatio ?? "auto"}，实际比例 ${result.ratio || "未知（服务端未回显）"}，模型 ${describeModel(result)}，共 ${saved.length} 张${saved[0].watermarkFree ? "，无水印" : ""}${accountNote(account, pool, attempts)}）。`
          : `豆包生图完成（比例 ${result.ratio || "未知"}，模型 ${describeModel(result)}，共 ${saved.length} 张${saved[0].watermarkFree ? "，无水印" : ""}${accountNote(account, pool, attempts)}）。`,
        imagePathHint(paths.length === 1 ? paths[0] : paths.length > 1 ? paths.join("、") : undefined, saveError),
      ].join(""),
    };
  };

  /* ---------------------------------------------------------- 工具：豆包 */

  /**
   * 生成一条视频（文生 / 图生）—— 工具与 `/api/regenerate` 共用。
   *
   * 抽出来的理由与 `runGeneration` 相同：`doubao_image` 工具与工作台
   * 「图生视频」入口要的是**同一件事**（上传参考图 → 跑视频通道 → 落盘 →
   * 组返回体）。抄一份到路由里，两边的会话清理与无水印判定迟早漂移。
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string} [opts.ratio] 请求画幅；有参考图时服务端会忽略它
   * @param {number} [opts.duration] 秒；缺省取设置里的 video.defaultDurationSec
   * @param {Array<{data: Buffer, mediaType: string, ext: string}>} [opts.references]
   *   参考图原始字节。**必须在函数内上传**（而不是让调用方先传好），
   *   因为上传与生成必须用同一个账号的 cookie —— 多号池换号时分成两步
   *   就会出现「A 号上传的图，B 号拿着 uri 去生成」，服务端认不出这张图。
   * @param {object} [opts.exec]
   * @returns {Promise<object>}
   */
  const runVideoGeneration = async ({ prompt, ratio, duration, model, references = [], exec }) => {
    const { pool, fallbackCookie } = await resolveDoubaoPool();
    exec?.signal?.throwIfAborted?.();
    const callVideo = async (cookieHeader, identity = {}) => {
      const uploaded = [];
      for (const ref of references) {
        uploaded.push(await doubaoUploadToDoubao(cookieHeader, ref.data, ref.ext, identity));
      }
      return doubaoGenerateVideo({
        cookieHeader,
        ...identity,
        prompt: `${prompt}。${VIDEO_PROMPT_SUFFIX}`,
        ratio: ratio ?? "auto",
        duration: duration ?? cfg().video.defaultDurationSec,
        model: model ?? cfg().video.model,
        references: uploaded,
        removeWatermark: cfg().video.removeWatermark !== false,
        timeoutMs: cfg().image.timeoutMs,
        signal: exec?.signal,
      });
    };
    const outcome = pool
      ? await withDoubaoAccount(pool, (a) => callVideo(a.cookieHeader, doubaoIdentityOf(a)))
      : { result: await callVideo(fallbackCookie), account: null, attempts: [] };
    const result = outcome.result;
    const attachment = await attachFile(result.data, "doubao-video.mp4");
    /**
     * 视频的会话清理：与生图同一条规则。
     *
     * **为什么视频必须删**：视频生成同样会新建一个豆包会话，而它的
     * 提示词被拼上了 `VIDEO_PROMPT_SUFFIX`，留在账号里比图片会话更难看。
     * 视频分支**不复用会话**（`doubaoIdentityOf` 没传 `reuseConversation`，
     * 视频也不需要多轮上下文），所以每生成一次就多一个，不删会无限堆积。
     *
     * 删除失败不影响出片：视频已经落盘了，这是清理动作。失败原因
     * 放进返回值，用户才知道要去豆包手动删哪一个。
     */
    let cleanup = null;
    if (typeof result?.conversationId === "string" && result.conversationId !== "") {
      const deleted = await doubaoDeleteConversation(
        outcome.account?.cookieHeader ?? fallbackCookie,
        result.conversationId,
        { device: outcome.account?.device, timeoutMs: cfg().image.timeoutMs },
      );
      if (!deleted.ok) cleanup = { conversationId: result.conversationId, ...deleted };
    }
    /**
     * `fileHostPath` 给出落盘文件的绝对路径。视频没有图片那样的对话内
     * 渲染块，用户只能自己去打开文件，所以必须把这个路径回传。
     * 它是同步方法；宿主 attachment 后端不支持文件存储时返回 undefined。
     */
    const hostPath = ctx.attachments.fileHostPath?.(attachment) ?? "";
    /**
     * 图生视频时 `ratio` 是**请求值**，服务端会忽略它、按参考图取景
     * （实测：请求 16:9 + 512x512 参考图 → 实际 720x720）。所以有参考图
     * 时 summary 报的是实测像素，不是 `result.ratio`。
     */
    const isFromImage = result.fromImage === true;
    const sizeNote = isFromImage
      ? `${result.width ?? "?"}x${result.height ?? "?"}（跟随参考图，请求的画幅 ${result.ratio} 被忽略）`
      : result.ratio;
    return {
      attachment,
      mediaType: result.mediaType,
      ratio: result.ratio,
      width: result.width,
      height: result.height,
      watermarkFree: result.watermarkFree === true,
      duration: result.duration,
      model: result.model,
      path: hostPath,
      fromImage: isFromImage,
      summary: `豆包已生成${isFromImage ? "图生" : ""}视频（${sizeNote}，${result.duration}s，model=${result.model}${accountNote(outcome.account, pool, outcome.attempts)}）。${describeVideoWatermark(result, cfg().video.removeWatermark !== false)}`,
      ...(cleanup === null ? {} : { conversationCleanup: cleanup }),
    };
  };

  ctx.tools.register({
    name: "doubao_image",
    description:
      "用网页版豆包（豆包 App 的网页端）生成、编辑图片或生成视频。默认文生图；给出 reference_images（本地图片路径）时按图生图处理。"
      + "注意：豆包的图生图会重绘整张画面（背景与视角可能改变），不要向用户承诺「保留原图」。"
      + "mode=video 时若同时给出 reference_images，则走图生视频（以参考图为第一帧的构图来源）；"
      + "图生视频的画幅跟随参考图，此时 ratio 会被服务端忽略。"
      + "视频生成需要先在插件设置页打开开关。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "画面描述，中文效果最好" },
        size: { type: "string", description: "文生图目标尺寸，如 1024x1024 / 1280x720；图生图固定请求 auto，实际比例以服务端回显为准" },
        reference_images: { type: "array", items: { type: "string" }, description: "本地参考图路径（图生图 / 图生视频）；给出后自动走编辑模式，mode=video 时走图生视频" },
        mode: { type: "string", enum: ["auto", "generate", "edit", "video"], description: "缺省 auto：有参考图则编辑，否则生成。video 生成短视频（带 reference_images 即图生视频）" },
        model: {
          type: "string",
          enum: [...DOUBAO_IMAGE_MODELS, ...DOUBAO_IMAGE_MODELS_SUBSCRIBED],
          description: `生图模型，缺省取设置值（${DEFAULT_DOUBAO_MODEL}）。`
            + `${DOUBAO_IMAGE_MODELS.join(" / ")} 免费账号可用；`
            + `${DOUBAO_IMAGE_MODELS_SUBSCRIBED.join(" / ")} 需要豆包订阅套餐，免费账号会收到订阅提示。`
            + "不同模型出图风格差异明显，同一提示词可换模型重试。",
        },
        ratio: { type: "string", description: "视频比例：auto / 1:1 / 4:3 / 16:9 / 9:16 / 21:9。图生视频时该参数被服务端忽略（画幅跟随参考图）" },
        edit_ratio: { type: "string", description: "仅图生图：画幅请求值，缺省 auto；可选 auto / 1:1 / 4:3 / 16:9 / 9:16 / 2:3 / 3:4 / 3:2。`ratio` 已被视频占用，图生图用本参数" },
        duration: { type: "integer", description: "视频时长（秒），1-10，默认取设置值" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "mediaType", "summary", "attachment"],
        properties: {
          kind: { type: "string" },
          mediaType: { type: "string" },
          ratio: { type: "string" },
          watermarkFree: { type: "boolean" },
          references: { type: "integer" },
          duration: { type: "number" },
          model: { type: "string" },
          requestModel: { type: "string", description: "请求声明的模型，并非服务端确认的实际模型" },
          actualModel: { type: "string", description: "服务端确认的实际模型；字段缺失表示服务端未回显（不等于没生效）" },
          requestedRatio: { type: "string", description: "仅图生图：实际发给服务端的画幅请求值（auto / 1:1 / 4:3 / 16:9 / 9:16 / 2:3 / 3:4 / 3:2）" },
          itemRatios: { type: "array", items: { type: "string" }, description: "仅图生图：与 attachment、extraAttachments 顺序对齐的逐图实际比例；空串表示未知" },
          /** 视频落盘的真实路径（图片不需要：图片靠 image 块直接显示）。 */
          path: { type: "string" },
          summary: { type: "string" },
          /** 图片另存到工作区后的绝对路径（第 1 张）。 */
          savedTo: { type: "string" },
          /** 多图时全部工作区路径。 */
          savedToAll: { type: "array", items: { type: "string" } },
          /** 另存到工作区失败时的原因；失败不影响出图。 */
          saveError: { type: "string" },
          /** 本次生成的**图片张数**（豆包可一次出多张）。视频恒为 1。 */
          count: { type: "integer" },
          attachment: ATTACHMENT_SCHEMA,
          /**
           * 全部图片（第一张之外的那些）。第一张仍放在 `attachment` 里，
           * 保持与旧客户端/旧 schema 的兼容。
           *
           * schema 严格模式（`additionalProperties: false`）下必须显式声明
           * 每一个字段，否则 `dsh-tools` 的返回值校验会让整次调用失败。
           */
          extraAttachments: { type: "array", items: IMAGE_REF_SCHEMA },
          /*
           * 账号归属信息。
           *
           * 这些字段是 `runGeneration()`（`index.js:1581-1590`）一直在返回的
           * ——「多账号时这张图是谁的额度出的」是用户真正关心的信息。但 schema
           * 严格模式（`additionalProperties: false`）下没声明的字段会让整次
           * 调用失败：2026-10-20 实测 `doubao_image` 连错三次、图完全出不来。
           *
           * `switchedFrom` 是同一个雷的延时引信：只有当发生换号
           * （`attempts.length > 0`）时才会进返回体。当前池里第一个号就成功，
           * 所以它没炸——但只补前三个字段，换号时就会变成它单独报错。
           */
          /** 实际出图的豆包账号 id（账号池为空时字段缺失）。 */
          accountId: { type: "string" },
          /** 账号显示名；未命名时是「账号 N」。 */
          accountLabel: { type: "string" },
          /** 为出图共尝试了几个账号（0＝第一个就成功，未换号）。 */
          switchCount: { type: "integer" },
          /** 换过号时才出现：每个失败账号的显示名与失败原因。 */
          switchedFrom: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["accountLabel", "message"],
              properties: {
                accountLabel: { type: "string" },
                message: { type: "string" },
              },
            },
          },
          /*
           * 会话清理失败时才出现。
           *
           * 生图成功后会顺手删掉豆包会话（避免账号里堆垃圾对话）；删不掉
           * 不影响出图，但必须让用户知道——否则他以为没留痕。
           *
           * **必须在这里声明**：`additionalProperties: false` 下未声明的字段
           * 会让宿主 `dsh-tools` 的返回值校验把整次调用判失败（同一个雷
           * 2026-10-20 炸过一次，见上方 accountId 的注释）。
           */
          conversationCleanup: {
            type: "object",
            additionalProperties: false,
            required: ["conversationId", "ok", "reason"],
            properties: {
              conversationId: { type: "string" },
              ok: { type: "boolean" },
              reason: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
      /**
       * 图片返回 `{type:"image", attachment}` 让 DSH 直接渲染；
       * 视频**不能**这么做——客户端的 image 卡
       * （`dsh-client-ui-tool/lib/client.js:2735` 的 `imageReferences`）
       * 要求 attachment 带 `mediaType`/`width`/`height`，而 `saveFile`
       * 只回 `{attachmentId, name, bytes}`，会退化成通用卡片。
       * 视频改为纯文本 + 落盘路径，让用户自己打开。
       */
      /**
       * 工具结果的可读文本。
       *
       * **绝不返回 `{type:"image"}` 块**。这是踩过的坑：内置渲染器
       * （`dsh-client-ui-chat/lib/client.js:5932` 的 `AssistantMarkdown`
       * `case "image"`）会渲染结果内容里的 image 块，于是同一张图被画两次
       * —— 一次由内置渲染器（助手消息区），一次由本插件的卡片/提升节点。
       * 实测症状：web 端两张图、桌面端一张（桌面端没装本插件，只剩内置那张）。
       *
       * 官方 `dsh-image-gen` 的 render 同样**只返回文本**
       * （`lib/index.js:3105-3108`），图片完全靠 `presentationMeta` 投影
       * attachment，再由卡片与提升节点渲染。
       */
      render: (_args, value) => {
        const blocks = [{ type: "text", text: value.summary }];
        if (value.kind === "video" && value.path) {
          blocks.push({ type: "text", text: `视频文件：${value.path}` });
        }
        return blocks;
      },
      /**
       * 投影给客户端的卡片元数据。
       *
       * 为什么必须有：内置 image 卡只认 `read_image`
       * （`dsh-client-ui-tool/lib/client.js:2825` 硬判 `call?.name !== "read_image"`），
       * 普通工具返回的 image 块**没有任何渲染器** —— 实测症状是工具成功、
       * 对话里却不显示图。客户端的自定义 toolview 卡片靠这里的 meta
       * 拿到提示词与落盘路径。
       *
       * 宿主只在顶层调用时投影（`dsh-tools/lib/index.js:3554`
       * `exec.parent === void 0`），且**抛错会让整次调用失败**，所以全部字段
       * 都做类型收敛，不直接透传原始值。
       */
      presentationMeta: (args, value) => {
        // 只有图片才有合法的 image ref；视频是 saveFile 产物（无 mediaType/
        // width/height），parseImageAttachmentRef 返回 undefined。
        // **必须条件展开**：宿主会对 meta 做 JSON 快照，值为 undefined 的键
        // 在往返后直接消失，造成「投影出去的形状」与「读回来的形状」不一致。
        const attachment = parseImageAttachmentRef(value?.attachment);
        /**
         * 视频引用走单独字段，**不复用 `attachment`**。
         *
         * 理由：客户端的 `imageAttachmentFromMeta` 拿 `mediaType` 在
         * `IMAGE_MEDIA_TYPES` 里做白名单校验，视频引用没有那个字段，
         * 混进 `attachment` 只会被丢掉；而如果放宽那个白名单，就等于让
         * 任意文件冒充图片。分成两个字段，两种形状各自校验，谁也不用
         * 迁就谁。
         */
        const videoAttachment = parseVideoAttachmentRef(value?.attachment);
        /**
         * 第 2 张起的图。客户端 `imageResultsFromMeta` 优先读这个数组，
         * 没有时再退回单个 `attachment` —— 所以老客户端不会因此变砖。
         * 每一项都要过与第一张相同的形状校验，坏项直接丢掉。
         */
        const attachments = Array.isArray(value?.extraAttachments)
          ? value.extraAttachments.map((item) => parseImageAttachmentRef(item)).filter((item) => item !== undefined)
          : [];
        return {
          plugin: "dsh-doubao-image",
          prompt: typeof args?.prompt === "string" ? args.prompt : "",
          provider: "doubao",
          kind: typeof value?.kind === "string" ? value.kind : "image",
          model: typeof value?.model === "string" ? value.model : "",
          ...(typeof value?.requestModel === "string" ? { requestModel: value.requestModel } : {}),
          ...(typeof value?.actualModel === "string" && value.actualModel !== "" ? { actualModel: value.actualModel } : {}),
          ...(typeof value?.requestedRatio === "string" ? { requestedRatio: value.requestedRatio } : {}),
          ...(Array.isArray(value?.itemRatios) ? { itemRatios: value.itemRatios.map((ratio) => typeof ratio === "string" ? ratio : "") } : {}),
          ratio: typeof value?.ratio === "string" ? value.ratio : "",
          path: typeof value?.path === "string" ? value.path : "",
          // 视频时长（秒）：画廊视频卡上要显示，生图没有这个字段。
          ...(typeof value?.duration === "number" && isFinite(value.duration) ? { duration: value.duration } : {}),
          /*
           * 视频的宽高与免水印标记。
           *
           * 视频的 `attachment` 只有 attachmentId/name/kind/bytes，没有
           * mediaType 也没有宽高，所以卡片上那个「720x720」「无水印」只能靠
           * 记录级字段。这条路径是**会话历史回填**（重开旧会话时卡片自动
           * 入库），漏了它就会出现「刚生成的有角标、重开会话后角标没了」。
           *
           * `watermarkFree` 按布尔类型透传：`false` 是「知道带水印」，缺失
           * 是「不知道」，两者在 UI 上不同。
           */
          ...(typeof value?.width === "number" && isFinite(value.width) ? { width: value.width } : {}),
          ...(typeof value?.height === "number" && isFinite(value.height) ? { height: value.height } : {}),
          ...(typeof value?.watermarkFree === "boolean" ? { watermarkFree: value.watermarkFree } : {}),
          // 工作区落盘路径投影给客户端：卡片上要显示「这张图存在哪」。
          ...(typeof value?.savedTo === "string" && value.savedTo !== "" ? { savedTo: value.savedTo } : {}),
          ...(attachment === undefined ? {} : { attachment }),
          ...(videoAttachment === undefined ? {} : { videoAttachment }),
          ...(attachments.length === 0 ? {} : { attachments }),
        };
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("`prompt` 不能为空");

      const mode = args.mode ?? "auto";
      const referenceImages = Array.isArray(args.reference_images) ? args.reference_images.filter((p) => typeof p === "string" && p.trim()) : [];
      const wantEdit = mode === "edit" || (mode === "auto" && referenceImages.length > 0);

      if (mode === "video") {
        if (!cfg().video.enabled) {
          throw new Error("视频功能已在设置页关闭：请在 dsh-doubao-image-free 设置里打开「视频生成」后重试");
        }
        /**
         * 参考图 → 图生视频。
         *
         * 2026-10-23 实测：这个端点**接受**参考图，但请求体里参考图必须
         * 单独占一条 message（`videoRequestBody` 里已处理）。有参考图时
         * 服务端忽略 `ratio`，画幅跟随参考图 —— 所以下面 summary 用的是
         * `result.width x result.height`，不是 `result.ratio`。
         */
        const videoRefs = [];
        for (const file of referenceImages) {
          /*
           * 读取前先过 `readReferenceImage`：工作区边界 + 20 MiB 上限 +
           * 按文件头嗅探 MIME。这里**不能再退回 `mediaTypeOfFile`**——
           * 扩展名是调用方可控的，`foo.png` 里可以是任意字节。
           */
          const ref = await readReferenceImage(file, exec);
          videoRefs.push({ data: ref.data, mediaType: ref.mediaType, ext: extOfMime(ref.mediaType) });
        }
        const generated = await runVideoGeneration({
          prompt,
          ratio: args.ratio ?? "auto",
          duration: args.duration,
          model: cfg().video.model,
          references: videoRefs,
          exec,
        });
        return { kind: "video", ...generated };
      }

      const { pool: toolPool, fallbackCookie: toolFallbackCookie } = await resolveDoubaoPool();
      exec.signal?.throwIfAborted?.();
      const size = args.size || cfg().image.defaultSize;
      // 图生图画幅请求值：缺省 auto（lib 会原样回显 requestedRatio）。`ratio`
      // 已被视频参数占用，图生图走独立的 `edit_ratio`，两者互不干扰。
      const editRatio = typeof args.edit_ratio === "string" && args.edit_ratio.trim() !== "" ? args.edit_ratio.trim() : "auto";

      if (wantEdit) {
        if (referenceImages.length === 0) throw new Error("mode=edit 需要给出 reference_images（本地图片路径）");
        const images = [];
        for (const file of referenceImages) {
          // 与视频分支同一道关：边界 / 大小 / 字节嗅探，理由见 readReferenceImage。
          const ref = await readReferenceImage(file, exec);
          images.push({ data: ref.data, mediaType: ref.mediaType });
        }
        const callEdit = (cookieHeader, identity = {}, options = {}) => doubaoEditImage({
          cookieHeader,
          ...identity,
          prompt,
          size,
          ratio: editRatio,
          model: typeof args.model === "string" && args.model !== "" ? args.model : cfg().image.model,
          images,
          timeoutMs: cfg().image.timeoutMs,
          allowBrowserFallback: !options.hasMoreAccounts,
        });
        const { result, account, attempts } = toolPool
          ? await withDoubaoAccount(toolPool, (a, options) => callEdit(a.cookieHeader, doubaoIdentityOf(a), options))
          : { result: await callEdit(toolFallbackCookie), account: null, attempts: [] };
        const saved = await attachAllImages(
          result,
          (index, mediaType) => `doubao-edit-${index + 1}${extOfMime(mediaType)}`,
        );
        const extra = saved.slice(1).map((item) => item.attachment);
        const { paths, saveError } = await saveAllToWorkspace(saved, exec);
        return {
          kind: "image",
          mediaType: saved[0].mediaType,
          ratio: result.ratio,
          itemRatios: saved.map((item, index) => item.actualRatio ?? (index === 0 && !Array.isArray(result.items) ? result.ratio : "")),
          ...(typeof result.requestModel === "string" ? { requestModel: result.requestModel } : {}),
          ...(typeof result.actualModel === "string" && result.actualModel !== "" ? { actualModel: result.actualModel } : {}),
          ...(typeof result.requestedRatio === "string" ? { requestedRatio: result.requestedRatio } : {}),
          watermarkFree: saved[0].watermarkFree,
          references: result.references,
          count: saved.length,
          attachment: saved[0].attachment,
          ...(extra.length === 0 ? {} : { extraAttachments: extra }),
          // undefined 的字段必须条件展开：宿主会对返回值做 JSON 往返，
          // 值为 undefined 的键会直接消失，schema 校验与投影形状会对不上。
          ...(paths[0] === undefined ? {} : { savedTo: paths[0] }),
          ...(paths.length > 1 ? { savedToAll: paths.filter((p) => typeof p === "string") } : {}),
          ...(saveError === undefined ? {} : { saveError }),
          ...(account ? { accountId: account.id, accountLabel: account.label || `账号 ${toolPool.accounts.findIndex((a) => a.id === account.id) + 1}`, switchCount: attempts.length } : {}),
          summary: [
            `豆包图生图完成（参考图 ${result.references} 张，请求比例 ${result.requestedRatio ?? "auto"}，实际比例 ${result.ratio || "未知（服务端未回显）"}，模型 ${describeModel(result)}，共 ${saved.length} 张${saved[0].watermarkFree ? "，无水印" : ""}${accountNote(account, toolPool, attempts)}）。注意豆包会重绘整张画面，背景与视角可能与原图不同。`,
            imagePathHint(paths.length === 1 ? paths[0] : paths.length > 1 ? paths.join("、") : undefined, saveError),
          ].join(""),
        };
      }

      const generated = await runGeneration({
        provider: "doubao",
        prompt,
        size,
        model: typeof args.model === "string" && args.model !== "" ? args.model : undefined,
        exec,
      });
      return {
        kind: "image",
        mediaType: generated.mediaType,
        ratio: generated.ratio,
        watermarkFree: generated.watermarkFree,
        model: generated.model,
        ...(generated.requestModel ? { requestModel: generated.requestModel } : {}),
        ...(generated.actualModel ? { actualModel: generated.actualModel } : {}),
        count: generated.count,
        attachment: generated.attachment,
        ...(generated.extraAttachments ? { extraAttachments: generated.extraAttachments } : {}),
        ...(generated.savedTo ? { savedTo: generated.savedTo } : {}),
        ...(generated.savedToAll?.length ? { savedToAll: generated.savedToAll } : {}),
        ...(generated.saveError ? { saveError: generated.saveError } : {}),
        ...(generated.accountId ? { accountId: generated.accountId, accountLabel: generated.accountLabel ?? "", switchCount: generated.switchCount ?? 0 } : {}),
        // schema 已声明该字段（见下方 output.schema），漏传会让清理失败静默。
        ...(generated.conversationCleanup ? { conversationCleanup: generated.conversationCleanup } : {}),
        summary: generated.summary,
      };
    },
  });

  /* ------------------------------------------------------------ 工具：GPT */

  ctx.tools.register({
    name: "gpt_image",
    description:
      "用网页版 ChatGPT 免费账户生成图片。只接受提示词，不支持参考图与尺寸参数（免费账户走 picture_v2，风格由模型自定）。"
      + "需要先在插件设置页完成 GPT 登录。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "图片描述；英文或中文都可以" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "mediaType", "summary", "attachment"],
        properties: {
          kind: { type: "string" },
          mediaType: { type: "string" },
          model: { type: "string" },
          conversationId: { type: "string" },
          revisedPrompt: { type: "string" },
          summary: { type: "string" },
          /** 图片另存到工作区后的绝对路径。 */
          savedTo: { type: "string" },
          /** 另存到工作区失败时的原因；失败不影响出图。 */
          saveError: { type: "string" },
          /**
           * 本次生成的图片张数。
           *
           * 每个返回值字段都必须在 schema 里声明：宿主 `createSuccessResult`
           * 用 `additionalProperties: false` 校验**整个返回值**，多一个未声明
           * 字段就让整次调用失败（报 `"value.count" is not a declared
           * property`）。GPT 通道一次只出一张，恒为 1，但 `execute` 里确实
           * 返回了它——2026-10-18 加 `count: 1` 时漏了这里，工具实际不可用。
           */
          count: { type: "integer" },
          /**
           * 会话清理失败时才出现。
           *
           * 2026-10-25 起 GPT 免费通道也「生完就删会话」（用户要求）。
           * 删不掉不影响出图，但必须让用户知道——否则他以为没留痕。
           * `additionalProperties: false` 下未声明的字段会让整次调用失败，
           * 所以必须在这里声明（同豆包工具的同一处雷）。
           */
          conversationCleanup: {
            type: "object",
            additionalProperties: false,
            required: ["conversationId", "ok", "reason"],
            properties: {
              conversationId: { type: "string" },
              ok: { type: "boolean" },
              reason: { type: "string" },
            },
          },
          attachment: IMAGE_REF_SCHEMA,
        },
      },
      /**
       * 只返回文本 —— 与豆包工具同样的理由：内置渲染器会渲染 image 块，
       * 同一张图会被画两次（见 doubao_image 处 render 的注释）。
       */
      render: (_args, value) => [{ type: "text", text: value.summary }],
      /** 同豆包工具：客户端自定义卡片靠这份 meta 显示提示词与模型。 */
      presentationMeta: (args, value) => {
        const attachment = parseImageAttachmentRef(value?.attachment);
        return {
          plugin: "dsh-doubao-image",
          prompt: typeof args?.prompt === "string" ? args.prompt : "",
          provider: "gpt",
          kind: "image",
          model: typeof value?.model === "string" ? value.model : "",
          conversationId: typeof value?.conversationId === "string" ? value.conversationId : "",
          ...(typeof value?.savedTo === "string" && value.savedTo !== "" ? { savedTo: value.savedTo } : {}),
          ...(attachment === undefined ? {} : { attachment }),
        };
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("`prompt` 不能为空");

      exec.signal?.throwIfAborted?.();
      const credential = await resolveGptCredential();
      if (!credential.accessToken) {
        throw new Error("请先在设置页完成 GPT 登录（点击「拉起浏览器登录」或手工粘贴 accessToken）");
      }
      const result = await gptGenerateImage({
        accessToken: credential.accessToken,
        cookieHeader: credential.cookieHeader,
        oaiDeviceId: credential.oaiDeviceId,
        prompt,
        proxyUrl: credential.proxyUrl,
        timeoutMs: credential.timeoutMs,
      });

      const attachment = await attachImage(result.data, result.mediaType, "gpt-image");
      const raw = result.raw ?? {};
      /**
       * 生完就删会话（用户 2026-10-25 要求）。删除失败不抛、不回滚出图，
       * 只把原因带回返回值；`cleanupGptConversation` 的注释写了为什么。
       */
      const cleanup = await cleanupGptConversation({
        credential,
        conversationId: raw.conversationId,
      });
      const { paths, saveError } = await saveAllToWorkspace(
        [{ attachment, mediaType: result.mediaType, watermarkFree: false, data: result.data }],
        exec,
      );
      return {
        kind: "image",
        mediaType: result.mediaType,
        model: String(raw.model ?? ""),
        conversationId: String(raw.conversationId ?? ""),
        revisedPrompt: String(raw.revisedPrompt ?? ""),
        count: 1,
        ...(paths[0] === undefined ? {} : { savedTo: paths[0] }),
        ...(saveError === undefined ? {} : { saveError }),
        ...(cleanup === null ? {} : { conversationCleanup: cleanup }),
        summary: [
          `ChatGPT 免费账户出图完成（model=${raw.model ?? "?"}${raw.revisedPrompt ? `，改写后的提示词：${raw.revisedPrompt}` : ""}）。`,
          imagePathHint(paths[0], saveError),
        ].join(""),
        attachment,
      };
    },
  });

  /* -------------------------------------------------------------- 路由 */

  /**
   * 注册一条同源路由。
   *
   * 必须自己兜住异常：宿主 webServer 的顶层 catch 只回一个**空的 400**，
   * 客户端的 r.json() 会解析失败并被 catch 吞掉 —— 表现就是「界面没有任何反馈」。
   * 这里统一转成 200 + {ok:false,message}，让失败原因能显示到设置页。
   *
   * ## 同源校验放在这里，不放在各 handler 里
   *
   * 插件路由在 `/plugins/...` 下，**不经过**宿主 `/api` 的 browser-trust fence
   * （见 `sameOrigin` 的说明），所以这道校验就是全部 16 条路由的唯一防线。
   * 写进包装器有两个好处：新增路由自动获得保护，不会有「忘了写」的遗漏；
   * 校验与路由注册在同一个地方，审查时一眼能看出覆盖范围。
   *
   * 判据按请求是否改变状态分流：
   *   - GET/HEAD/OPTIONS：`sameOrigin`
   *   - 其余（POST/DELETE/PUT/PATCH）：`allowsStateChange`（更严，额外查 sec-fetch-site）
   * 分流判据用「不是只读方法」而不是「是 POST 或 DELETE」：将来加 PUT 也自动走严的那条。
   */
  const route = (path, handler, label) => {
    const wrapped = async (req, res) => {
      const readOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
      const allowed = readOnly ? sameOrigin(req, ctx) : allowsStateChange(req, ctx);
      if (!allowed) { {
        // 2026-10-28 画廊 403 诊断：ctx.logger 在 GUI 进程无落点，改直接追加文件。
        const DBI_DIAG_LOG = join(homedir(), ".dsh", "logs", "dsh-doubao-image-api.log");
        try {
          mkdirSync(join(homedir(), ".dsh", "logs"), { recursive: true });
          appendFileSync(DBI_DIAG_LOG, `[${new Date().toISOString()}] origin-rejected: ${req.method} ${req.url} host=${req.headers.host} origin=${JSON.stringify(req.headers.origin)} site=${JSON.stringify(req.headers["sec-fetch-site"])} UA=${JSON.stringify(req.headers["user-agent"])}\n`);
        } catch {}
      } return sendJson(res, 403, { ok: false, reason: "origin-rejected" }); }

      try {
        await handler(req, res);
      } catch (error) {
        const text = errText(error);
        // 日志也要兜住：ctx.logger 同样是代理属性，未注入时访问即抛，
        // 在 catch 里再抛一次就会绕过下面的响应、让宿主回空 400。
        try {
          ctx.get?.("logger")?.warn?.(`dsh-doubao-image: ${label} 处理失败: ${text}`);
        } catch {
          // 拿不到 logger 就算了，绝不能因此丢掉给客户端的响应。
        }
        if (res.headersSent) {
          res.destroy();
          return;
        }
        sendJson(res, 200, { ok: false, reason: "handler-error", message: text });
      }
    };
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler: wrapped }), `dsh-doubao-image: ${label}`);
  };

  /** GET /api/status —— 设置页首屏。 */
  route(ROUTE_STATUS, async (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    const [doubao, gpt] = await Promise.all([sessions.readDoubao(), sessions.readGpt()]);
    const c = cfg();
    return sendJson(res, 200, {
      ok: true,
      credentialsAvailable: sessions.available(),
      doubao: {
        loggedIn: Boolean((doubao?.accounts?.length ? "y" : c.doubao.cookieHeader || "").trim()),
        updatedAt: doubao?.updatedAt ?? null,
        /*
         * 账号池只暴露「有几个、当前是哪个、怎么认」——**绝不回传 cookie 全文**。
         * 设置页要显示列表就得知道这些，但它不需要拿到凭据本体。
         */
        accounts: (doubao?.accounts ?? []).map((account, index) => ({
          id: account.id,
          label: account.label || `账号 ${index + 1}`,
          active: account.id === doubao.activeId,
          /*
           * **必须用 `normalizeDevice` 判，不能写 `Boolean(account.device)`。**
           *
           * `Boolean({})` 是 true，而 `normalizeDevice({})` 返回 null —— 一个空的
           * 或 fps 不合法的 device 对象会让设置页显示「有设备身份」，实际生图时
           * `securityParams` 却抛「尚未导入设备身份」。两处判据不一致会把排查引向
           * 错误方向（2026-10-22 实测踩过：status 说两个号都有身份，生图两个都报缺）。
           *
           * 这里复刻的是生图路径真正使用的判据，所以两边永远一致。
           */
          hasDevice: normalizeDevice(account.device) !== null,
          hasMsToken: Boolean(account.msToken),
          cookieTail: account.cookieHeader.slice(-4),
          createdAt: account.createdAt ?? "",
          lastUsedAt: account.lastUsedAt ?? "",
        })),
        activeId: doubao?.activeId ?? "",
      },
      gpt: {
        loggedIn: Boolean((gpt?.accessToken || c.gpt.accessToken || "").trim()),
        updatedAt: gpt?.updatedAt ?? null,
      },
      config: {
        videoEnabled: c.video.enabled,
        galleryEnabled: c.gallery.enabled,
        defaultSize: c.image.defaultSize,
        timeoutMs: c.image.timeoutMs,
        proxyUrl: c.gpt.proxyUrl,
        videoModel: c.video.model,
        /*
         * 视频模型清单与标签也一起送出去：工作台的下拉要显示「Seedance 2.0」
         * 这种网页端叫法，而客户端 bundle 拿不到 Host 的常量。放在 status 里
         * 是唯一不重复维护两份清单的做法。
         */
        videoModels: DOUBAO_VIDEO_MODELS.map((key) => ({ key, label: DOUBAO_VIDEO_MODEL_LABELS[key] ?? key })),
        videoRemoveWatermark: c.video.removeWatermark !== false,
      },
    });
  }, "status route");

  /**
   * POST /api/doubao/browser-login —— 拉起独立浏览器登录，取回 cookie + 设备身份。
   *
   * 这是豆包唯一的登录入口：插件用用户自己那台浏览器的 cookie 与 `fp`
   * 发请求，不再有共享的硬编码身份。
   *
   * 为什么不做扫码登录：扫码只能拿到 cookie，拿不到 `fp`，也拿不到
   * `msToken`——那两样都来自页面 JS 运行时。只存 cookie 的账号会在真正
   * 生图时才失败，属于「看起来登录了、其实用不了」。所以只保留这一条。
   *
   * 阻塞到登录完成才返回（最长 300 秒），因为客户端只需要一个明确的成败。
   */
  route(ROUTE_DOUBAO_BROWSER_LOGIN, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    /*
     * 卡住的登录会话要能被新请求顶掉（2026-10-18 用户实测）。
     *
     * 旧实现只看 `running` 就拒绝，于是用户手动关掉浏览器窗口后，
     * 服务端还在轮询等待（最长 300 秒），这期间再点登录一律被拒，
     * 提示「请先完成或关闭那个窗口」——但他明明已经关掉了。
     *
     * 现在多一道判据：会话登记的浏览器进程已退出、并且调试端口也连不上
     * ⇒ 这个会话已经不可能成功了，直接取消并让新请求接手。
     */
    if (browserLogin?.running) {
      const stale = await browserLogin.isStale();
      if (!stale) {
        return sendJson(res, 200, { ok: false, reason: "already-running", message: "浏览器登录已在进行中，请先完成或关闭那个窗口" });
      }
      void browserLogin.cancel().catch(() => {});
      browserLogin = null;
    }

    try {
      browserLogin = new BrowserLoginSession({ timeoutMs: BROWSER_LOGIN_TIMEOUT_MS });
      const result = await browserLogin.run();
      if (!result.ok) {
        return sendJson(res, 200, { ok: false, reason: "browser-login-failed", message: result.message });
      }

      /*
       * 存成一个**账号**，而不是覆盖掉原来那个。
       *
       * 同一个账号（认 `sessionid`）重复登录只会更新那一条，不会长出重复项；
       * 换一个账号登录才是「再加一个号」。这是多账号的入口：重复点几次登录、
       * 每次换一个豆包号，账号池就攒起来了。
       *
       * 抓不到真 msToken 就存空串：空 = 不发（实测也能出图）。
       * 绝不填一个假值——自造的 msToken 会被服务端判异常请求。
       */
      const saved = await sessions.upsertDoubaoAccount({
        cookieHeader: result.cookieHeader,
        device: result.device,
        msToken: result.msToken || "",
      });
      if (!saved.ok) {
        return sendJson(res, 200, { ok: false, reason: saved.reason, message: "已读取登录信息，但保存失败（credentials 服务不可用）" });
      }
      /*
       * 不再 `setDeviceIdentity(...)` 写进程单例（H3）：设备身份已经存进账号
       * 对象，生成时由 `doubaoIdentityOf(account)` 显式带上。这里原本的
       * 「立刻生效，用户不必重启插件」在参数化之后是**自动成立**的——
       * 下一次生成会从账号池里读到刚写进去的 device。
       */
      const total = (await sessions.readDoubao())?.accounts?.length ?? 1;
      return sendJson(res, 200, {
        ok: true,
        created: saved.created === true,
        totalAccounts: total,
        message: saved.created === true
          ? `豆包登录成功（已加入账号池，当前共 ${total} 个账号${result.msToken ? "，已取到 msToken" : ""}）`
          : `豆包账号已更新（同一账号不会重复计入，当前共 ${total} 个${result.msToken ? "，已取到 msToken" : ""}）`,
        device: { fps: result.device.fps, webId: result.device.webId, pcVersion: result.device.pcVersion },
        hasMsToken: Boolean(result.msToken),
      });
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "browser-login-failed", message: errText(error) });
    } finally {
      browserLogin = null;
    }
  }, "doubao browser-login route");

  /**
   * POST /api/doubao/reset-profile —— 删掉豆包登录 profile（L2，2026-10-18）。
   *
   * 这是设备身份被风控锁死时的自救入口：profile 目录里存着 `s_v_web_id` 与
   * device_id，换一份就等于换一台设备。删掉之后用户重新点「登录豆包」即可。
   *
   * ## 两道安全约束
   *
   * 1. **浏览器开着时不许删**。文件被占用时 `rm` 会删一半，留下一个半残的
   *    profile —— 下次登录可能带着残缺状态起来，比不删更糟。所以先探
   *    `DOUBAO_DEBUG_PORT`，端口活着就拒绝，并告诉用户先关浏览器。
   * 2. **只删固定的那个目录**。不接受任何参数（不做 `body.dir`），否则就是
   *    一个「删任意目录」的接口。
   *
   * 删之前先把路径回给客户端，让「删了什么」可见——这个操作不可撤销。
   */
  route(ROUTE_DOUBAO_RESET_PROFILE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    const dir = DOUBAO_PROFILE_DIR;

    // 端口活着说明浏览器还开着，此时删目录会删一半
    let alive = false;
    try {
      const probe = await fetch(`http://127.0.0.1:${DOUBAO_DEBUG_PORT}/json/version`, {
        signal: AbortSignal.timeout(1_500),
      });
      alive = probe.ok;
    } catch {
      alive = false;
    }
    if (alive) {
      return sendJson(res, 200, {
        ok: false,
        reason: "browser-running",
        message: "豆包登录浏览器还开着，请先关闭它再重置（浏览器运行时删除 profile 会删不干净）",
      });
    }

    try {
      await resetProfile(dir);
      return sendJson(res, 200, {
        ok: true,
        removed: dir,
        message: "已重置豆包登录 profile，请重新点「登录豆包」以换一份设备身份",
      });
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "reset-failed", message: errText(error) });
    }
  }, "doubao reset-profile route");

  /**
   * POST /api/doubao/device —— 从已登录豆包的浏览器导入设备身份。
   *
   * 这条路由是「出图被风控拦」的修复入口：插件原先用一套写死的旧设备身份，
   * 配真实 cookie 会被判成异常请求（0.4 秒回 710022004 verify，不出图）。
   * 用户在浏览器里正常登录后用一次这里，把真实身份存进凭据，之后纯 HTTP 即可。
   *
   * 端口固定 19222（豆包桌面端），没有豆包桌面端时回一句可操作的提示，
   * 而不是抛一个 ECONNREFUSED 让人猜。
   *
   * ## 为什么不接受 `body.port`（H4，2026-10-18）
   *
   * 旧实现允许请求体指定端口，然后 `readDeviceIdentityFromBrowser(port)` 直接
   * 去连 `127.0.0.1:<port>` 的 CDP 端点。这等于给**任何能发 POST 的页面**
   * 一个本机端口探测器：
   *
   *   - 打 9222/9333 这类调试端口，可以读别的浏览器的 cookie（含登录态）
   *   - 打任意端口，从「连接成功/失败/超时」的差异反推本机开了哪些服务
   *
   * 虽然同源校验已经挡住了跨站请求，但端口仍应是**写死的常量**，不该由
   * 请求体决定——同源校验将来放宽一处，这里就会变成完整的内网探测面。
   */
  route(ROUTE_DOUBAO_DEVICE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    /*
     * 端口写死。请求体一律不读——留着读 body 的代码只会诱导后来的人
     * 再把它接回端口参数上。
     */
    const port = DOUBAO_DEVICE_CDP_PORT;

    try {
      const device = await readDeviceIdentityFromBrowser(port);
      // 至少要拿到 fp 才有意义：没有它就等于没导入，继续用旧身份更安全。
      if (!device.fps) throw new Error("浏览器里没读到 s_v_web_id，请确认已登录豆包");
      /*
       * 设备身份属于某个账号，所以必须落到「当前账号」那一条上。
       *
       * 没有账号时无事可做：设备身份单独存在没有意义（它必须配 cookie 才生效），
       * 回一句可操作的话，而不是静默成功让用户以为配好了。
       */
      const stored = await sessions.readDoubao();
      const current = stored?.activeId ? stored.accounts.find((a) => a.id === stored.activeId) : undefined;
      if (!current) {
        return sendJson(res, 200, { ok: false, reason: "no-account", message: "还没有豆包账号：请先用「拉起浏览器登录」登录一个账号，再导入设备身份" });
      }
      const saved = await sessions.upsertDoubaoAccount({ cookieHeader: current.cookieHeader, device });
      if (!saved.ok) return sendJson(res, 200, { ok: false, reason: saved.reason, message: "设备身份读到了，但保存失败（credentials 服务不可用）" });
      // 同上：设备身份已写进账号对象，生成时随请求带上，无需写进程单例。
      return sendJson(res, 200, { ok: true, device: { fps: device.fps, deviceId: device.deviceId ?? "", webId: device.webId ?? "", pcVersion: device.pcVersion ?? "" } });
    } catch (error) {
      const text = errText(error);
      const message = /ECONNREFUSED|connect timeout|CDP/i.test(text)
        ? `连不上浏览器调试端口 ${port}。请先打开「豆包」桌面客户端并保持登录，或在设置里填它的调试端口。`
        : text;
      return sendJson(res, 200, { ok: false, reason: "device-import-failed", message });
    }
  }, "doubao device route");

  /**
   * DELETE /api/doubao/session —— 退出豆包登录。
   *
   * 带 `?id=<账号 id>` 时只退这一个账号（账号池里的「删除这个号」）；
   * 不带 id 时清空整个账号池（语义与改动前一致：退出登录）。
   */
  route(ROUTE_DOUBAO_SESSION, async (req, res) => {
    if (req.method !== "DELETE") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const id = String(new URL(req.url ?? "/", "http://localhost").searchParams.get("id") ?? "").trim();
    if (id !== "") {
      const removed = await sessions.removeDoubaoAccount(id);
      const left = (await sessions.readDoubao())?.accounts?.length ?? 0;
      return sendJson(res, 200, removed.ok ? { ok: true, remaining: left } : { ok: false, reason: removed.reason });
    }
    const result = await sessions.clearDoubao();
    return sendJson(res, 200, result.ok ? { ok: true, remaining: 0 } : { ok: false, reason: result.reason });
  }, "doubao session route");

  /**
   * POST /api/doubao/accounts —— 账号池操作。
   *
   * body: `{action: "activate" | "rename", id, label?}`
   *
   * 只做这两件「切换用哪个号」的事；增删账号走 `/browser-login` 与
   * `/session?id=`，分开是为了让每个入口的语义单一。
   */
  route(ROUTE_DOUBAO_ACCOUNTS, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const parsed = await jsonBody(req);
    if (parsed.error) return sendJson(res, 400, { ok: false, reason: parsed.error });
    const action = String(parsed.body.action ?? "");
    const id = String(parsed.body.id ?? "");
    if (action === "activate") {
      const result = await sessions.setActiveDoubaoAccount(id);
      return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, reason: result.reason });
    }
    if (action === "rename") {
      const result = await sessions.renameDoubaoAccount(id, parsed.body.label);
      return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, reason: result.reason });
    }
    return sendJson(res, 400, { ok: false, reason: "invalid-action" });
  }, "doubao accounts route");

  /**
   * POST /api/doubao/cookie —— 手工粘贴 Cookie。
   *
   * 手工粘贴只能拿到 cookie，拿不到 `fp` 与 `msToken`，所以这份凭据大概率
   * 发不出图；保留它是因为它能救「cookie 我手上就有、浏览器那边打不开」的场景。
   * 存的是**一条账号**，能取到 sessionid 时按账号去重。
   */
  route(ROUTE_DOUBAO_COOKIE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const parsed = await jsonBody(req);
    if (parsed.error) return sendJson(res, 400, { ok: false, reason: parsed.error });
    const cookieHeader = String(parsed.body.cookieHeader ?? "").trim();
    if (!cookieHeader) return sendJson(res, 400, { ok: false, reason: "cookie-required" });
    const result = await sessions.upsertDoubaoAccount({ cookieHeader });
    if (!result.ok) return sendJson(res, 200, { ok: false, reason: result.reason });
    const total = (await sessions.readDoubao())?.accounts?.length ?? 1;
    return sendJson(res, 200, { ok: true, created: result.created === true, totalAccounts: total });
  }, "doubao cookie route");

  /**
   * POST /api/doubao/new-conversation —— 换一个新的生图会话（界面上的「+」）。
   *
   * 打开「固定会话」开关后所有生图进同一个会话。用户想换风格时点「+」，
   * 清掉当前账号记住的会话 id，下一次生图就新建一个并记住它。
   *
   * 清空而不是「换成一个指定的 id」：会话 id 由服务端生成，客户端无从知道。
   */
  route(ROUTE_DOUBAO_NEW_CONVERSATION, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const stored = await sessions.readDoubao().catch(() => null);
    const account = stored?.accounts?.find((a) => a.id === stored.activeId) ?? stored?.accounts?.[0];
    if (!account) return sendJson(res, 200, { ok: false, reason: "no-account" });
    const result = await sessions.setDoubaoConversationId(account.id, "");
    if (!result?.ok) return sendJson(res, 200, { ok: false, reason: result?.reason ?? "write-failed" });
    return sendJson(res, 200, {
      ok: true,
      accountId: account.id,
      // 下一次生图会新建会话；这里只是告诉客户端「已经清掉了」。
      previous: typeof account.conversationId === "string" ? account.conversationId : "",
    });
  }, "doubao new conversation route");

  /** POST/GET /api/gpt/edge-login —— 拉起 Edge 登录 / 轮询抓取结果。 */
  route(ROUTE_GPT_EDGE_LOGIN, async (req, res) => {
    if (req.method === "POST") {
      try {
        const result = await edgeSession.start();
        if (!result.ok) return sendJson(res, 200, result);
        return sendJson(res, 200, { ok: true, status: "waiting", message: result.message });
      } catch (error) {
        return sendJson(res, 200, { ok: false, status: "error", message: errText(error) });
      }
    }
    if (req.method === "GET") {
      const state = await edgeSession.status();
      if (state.status !== "done") return sendJson(res, 200, state);
      const taken = edgeSession.take();
      // take() 会清空内存副本；并发或重复轮询可能取到空值，此时不能再写，
      // 否则会把已保存的凭据覆盖成空。
      if (!taken.accessToken) {
        return sendJson(res, 200, { ok: true, status: "done", message: "GPT 登录成功" });
      }
      const saved = await sessions.writeGpt(taken);
      return sendJson(res, 200, {
        ok: true,
        status: "done",
        message: saved.ok ? "GPT 登录成功" : "已读取凭据，但保存失败（credentials 服务不可用）",
        saved: saved.ok,
      });
    }
    return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
  }, "gpt edge-login routes");

  /** POST /api/gpt/token —— 手工粘贴 accessToken（可带 cookieHeader）。 */
  route(ROUTE_GPT_TOKEN, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const parsed = await jsonBody(req);
    if (parsed.error) return sendJson(res, 400, { ok: false, reason: parsed.error });
    const accessToken = String(parsed.body.accessToken ?? "").trim();
    if (!accessToken) return sendJson(res, 400, { ok: false, reason: "token-required" });
    const result = await sessions.writeGpt({
      accessToken,
      cookieHeader: String(parsed.body.cookieHeader ?? ""),
      oaiDeviceId: String(parsed.body.oaiDeviceId ?? ""),
    });
    return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, reason: result.reason });
  }, "gpt token route");

  /** DELETE /api/gpt/session —— 退出 GPT 登录。 */
  route(ROUTE_GPT_SESSION, async (req, res) => {
    if (req.method !== "DELETE") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    const result = await sessions.clearGpt();
    return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, reason: result.reason });
  }, "gpt session route");

  /**
   * POST /api/image —— 按 attachment ref 取回图片字节。
   *
   * 画廊要显示历史图片，但 IndexedDB 里存的是 ref 而不是字节（字节由
   * attachments 服务统一管理），所以需要这一条把 ref 换回二进制。响应不是
   * JSON 而是裸图片，前端拿到后转 blob URL。
   *
   * 用 POST 而不是 GET 是因为 ref 是结构化对象，塞进 query 既啰嗦又容易
   * 被日志记录下来。
   */
  route(ROUTE_IMAGE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { ok: false, reason: "json-required" });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, reason: "invalid-request" });
    }

    const ref = parseImageAttachmentRef(isRecord(body) ? body.attachment : undefined);
    if (ref === undefined) return sendJson(res, 400, { ok: false, reason: "invalid-attachment" });

    try {
      const stored = await ctx.attachments.readImage(ref);
      res.writeHead(200, {
        "content-type": stored.ref.mediaType,
        "content-length": String(stored.data.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(stored.data);
    } catch {
      // 读不到就 404：ref 可能指向已被清理的附件，这不是服务端错误。
      sendJson(res, 404, { ok: false, reason: "image-unavailable" });
    }
  }, "image route");

  /**
   * POST /api/video —— 按文件引用取视频字节，画廊「视频」栏用。
   *
   * 走 `readFileStream` 而不是一次读全：视频动辄几十上百 MB，
   * 一次性 `Buffer.concat` 会把整段内容压在内存里。这里逐块 `write`，
   * 边读边发；客户端拿到的是 `blob:` URL，`<video>` 可以直接播。
   *
   * `content-type` 固定 `video/mp4`：`saveFile` 不保存 mediaType，
   * 而豆包视频接口产出的就是 MP4（`doubao-video.mjs` 里落的文件名
   * 也是 `.mp4`）。写死比猜更诚实——猜错了浏览器会静默不播。
   */
  route(ROUTE_VIDEO, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { ok: false, reason: "json-required" });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, reason: "invalid-request" });
    }

    const ref = parseVideoAttachmentRef(isRecord(body) ? body.attachment : undefined);
    if (ref === undefined) return sendJson(res, 400, { ok: false, reason: "invalid-attachment" });

    let stream;
    try {
      // 先拿到迭代器：这一步才会真正校验 ref 指向的对象存在。
      // 把它放在 writeHead 之前，才能把「文件不存在」报成 404 而不是
      // 「已经发了 200 头、然后连接被掐断」。
      stream = ctx.attachments.readFileStream(ref);
      // eslint-disable-next-line no-unused-vars
      var iterator = stream[Symbol.asyncIterator]();
      var first = await iterator.next();
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": String(ref.bytes),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      while (first.done !== true) {
        res.write(Buffer.from(first.value));
        first = await iterator.next();
      }
      res.end();
    } catch {
      // 读不到就 404：ref 可能指向已被清理的附件，这不是服务端错误。
      // 已经发过头就不能再发 JSON 了，只能断开——所以上面的首块读取
      // 必须在 writeHead 之前完成。
      if (!res.headersSent) sendJson(res, 404, { ok: false, reason: "video-unavailable" });
      else res.end();
    }
  }, "video route");

  /**
   * GET /api/image/raw —— 按 attachment 引用取图，专门给 `<img src>` 用。
   *
   * **为什么必须另开一条**：上面的 `POST /api/image` 返回裸字节没错，但
   * tldraw 的 asset `src` 会走浏览器原生 `<img>`，只认 GET；而且它的校验器
   * 把协议白名单钉死在 `http: / https: / data: / asset:`
   * （`@tldraw/validate` 打包在官方 `dsh-image-gen/lib/client.js:13986-13991`），
   * **`blob:` 会被判为非法协议并抛 ValidationError** —— 实测症状是往画布
   * 放图时整个 tldraw 事务回滚、画布崩成「Something went wrong」。
   * 所以画布里的资产只能引用 http URL，这一条就是它的来源。
   *
   * 用 query 而不是路径段：宿主 `webServer.register` 只认 `kind: "exact"`
   * （全部已装插件无一例外），没有前缀/参数路由可用。
   */
  route(ROUTE_IMAGE_RAW, async (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    const params = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const ref = parseImageAttachmentRef({
      attachmentId: params.get("attachmentId") ?? "",
      mediaType: params.get("mediaType") ?? "",
      bytes: Number(params.get("bytes") ?? 0),
      width: Number(params.get("width") ?? 0),
      height: Number(params.get("height") ?? 0),
    });
    if (ref === undefined) return sendJson(res, 400, { ok: false, reason: "invalid-attachment" });

    try {
      const stored = await ctx.attachments.readImage(ref);
      res.writeHead(200, {
        "content-type": stored.ref.mediaType,
        "content-length": String(stored.data.byteLength),
        // 附件字节按 attachmentId 寻址、内容不变，可以放心让浏览器缓存：
        // 画布刷新时同一张图会被 <img> 反复请求，不缓存会重复打穿存储层。
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(stored.data);
    } catch {
      // 读不到就 404：ref 可能指向已被清理的附件，这不是服务端错误。
      sendJson(res, 404, { ok: false, reason: "image-unavailable" });
    }
  }, "raw image route");

  /**
   * POST /api/import —— 把用户选的本地图片存成 attachment。
   *
   * 为什么由 Host 存而不是前端自己塞 IndexedDB：画廊里的图必须能被
   * `/api/image` 取回，而那条路由读的是 attachments 服务。前端存一份字节
   * 只会得到两个真相源。
   *
   * 走 `saveImage` 而不是 `saveFile`：画廊只认图片附件，`saveFile` 返回的
   * 引用没有 mediaType/width/height，会被 `parseImageAttachmentRef` 拒掉。
   */
  route(ROUTE_IMPORT, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { ok: false, reason: "json-required" });
    }

    let body;
    try {
      body = JSON.parse(await readBodyLimited(req, MAX_IMPORT_BODY_BYTES));
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: "invalid-request", message: errText(error) });
    }

    const parsed = parseImageDataUrl(isRecord(body) ? body.dataUrl : undefined);
    if (parsed === undefined) return sendJson(res, 400, { ok: false, reason: "invalid-image-data" });

    const rawName = isRecord(body) && typeof body.name === "string" ? body.name : "";
    // 只取基名：前端可能传 `../../x.png`，落盘名不能带路径。
    const name = basename(rawName).slice(0, 200) || "imported-image";

    try {
      const attachment = await attachImage(parsed.buf, parsed.mediaType, name);
      const ref = parseImageAttachmentRef(attachment);
      if (ref === undefined) return sendJson(res, 200, { ok: false, reason: "attachment-rejected" });
      return sendJson(res, 200, { ok: true, attachment: ref });
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "save-failed", message: errText(error) });
    }
  }, "import route");

  /**
   * POST /api/regenerate —— 用（可能改过的）提示词重新生成一张图。
   *
   * 这是 `client.gallery.js`（B8 单图重新生成）与对话内 E4 共用的契约，
   * 请求体 `{prompt, provider?, ratio?, mode?, model?, references?: ImageAttachmentRef[]}`，返回
   * `{ok:true, attachment, prompt, provider, model, requestModel?, actualModel?, ratio, createdAt}`。
   * 模型只在豆包通道有效（GPT 免费通道由服务端固定）：`requestModel` 是请求值，
   * `actualModel` 是服务端回显值，为空表示未回显而不是没生效。
   * 编辑 `ratio` 仅取服务端回显的首图实际值，不能回退为请求画幅；
    * `itemRatios` 按 `[attachment, ...extraAttachments]` 顺序回传逐图实际比例，
    * 空串代表对应图片比例未知。编辑模式的 `ratio` 作为画幅请求值原值透传给
    * lib（缺省吸附 auto），实际请求值以 `requestedRatio` 回传。
   *
   * 生成逻辑与 `doubao_image` 工具共用 `runGeneration`：路由不重复实现通道细节。
   * 只回**第一张**（调用方是「替换这一张」的语义）—— 多张时把全部张数如实
   * 放在 `count` 里，别让前端以为只出了一张。
   */
  route(ROUTE_REGENERATE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { ok: false, reason: "json-required" });
    }

    let body;
    try {
      body = JSON.parse(await readBodyLimited(req, MAX_IMPORT_BODY_BYTES));
    } catch (error) {
      return sendJson(res, 400, { ok: false, reason: "invalid-request", message: errText(error) });
    }

    const prompt = isRecord(body) && typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt === "") return sendJson(res, 400, { ok: false, reason: "empty-prompt" });

    // 只认本插件有的两条通道；缺省按豆包（免登录配置最少的默认通道）。
    const rawProvider = isRecord(body) && typeof body.provider === "string" ? body.provider : "";
    if (body.provider !== undefined && (typeof body.provider !== "string" || (rawProvider !== "" && rawProvider !== "doubao" && rawProvider !== "gpt"))) {
      return sendJson(res, 400, { ok: false, reason: "invalid-provider" });
    }
    const provider = rawProvider === "gpt" ? "gpt" : "doubao";
    // `ratio` 只是画幅线索：豆包只认 1:1 / 4:3 / 16:9 / 9:16，由 lib 吸附。
    const size = isRecord(body) && typeof body.ratio === "string" ? ratioToSize(body.ratio) : undefined;

    const mode = body.mode === undefined ? "generate" : body.mode;
    if (mode !== "generate" && mode !== "edit" && mode !== "i2v" && mode !== "video") return sendJson(res, 400, { ok: false, reason: "invalid-mode" });
    /*
     * 视频有两条进来的路，语义上都是「跑视频通道」：
     *   - `video`：工作台「生视频」按钮用的**统一入口**，带不带参考图都走它
     *     （有参考图 → 图生视频；没有 → 文生视频）。2026-10-25 起客户端只用这个。
     *   - `i2v`：**必须有参考图**的旧别名，保留给已有调用与测试，
     *     行为与 `video` + 参考图完全一致。
     * 之所以不把 `video` 做成「i2v 的子集」再让客户端自己判断：模式判断散在两端
     * 迟早在「有图却没走图生视频」上出分歧，入口就一个才不会有二义。
     */
    const isVideoMode = mode === "video" || mode === "i2v";
    /*
     * GPT 图生图已支持（2026-10-22）：参考图上传到 `/backend-api/files` 拿
     * fileId，对话 body 用 `multimodal_text` + `image_asset_pointer` 引用。
     * 这里原先有一条 `gpt-edit-unsupported` 的硬拒——那是实现缺失时的占位，
     * 不是 GPT 的能力边界，已移除。
     */
    /*
     * 视频只有豆包这一条通道（GPT 免费账户不出视频）。在这里就拒掉，
     * 而不是等 `runVideoGeneration` 里跑一遍豆包才失败 —— 前者一秒出结果，
     * 后者要等十几秒才告诉用户「选错通道了」。
     */
    if (isVideoMode && provider !== "doubao") return sendJson(res, 400, { ok: false, reason: "provider-does-not-support-image-to-video" });
    if (isVideoMode && !cfg().video.enabled) return sendJson(res, 400, { ok: false, reason: "video-disabled" });
    const refs = body.references;
    /*
     * `i2v` 的历史契约是「必须有参考图」，保持不变；`video` 两可，
     * 参考图只是可选的构图输入。`edit` 仍然必须给图（没有图就不是编辑）。
     */
    if ((mode === "edit" || mode === "i2v") && (!Array.isArray(refs) || refs.length === 0)) return sendJson(res, 400, { ok: false, reason: "reference-required" });
    if (mode === "video" && refs !== undefined && !Array.isArray(refs)) return sendJson(res, 400, { ok: false, reason: "invalid-references" });
    if (mode === "generate" && refs !== undefined && (!Array.isArray(refs) || refs.length > 0)) return sendJson(res, 400, { ok: false, reason: "references-require-edit" });
    // 编辑模式：`ratio` 作为画幅请求值**原值透传**给 lib（lib 自行吸附合法值，
    // 缺省 auto），不再折算成 size；generate 模式维持 ratioToSize 链路不变。
    const editRatio = (mode === "edit" || isVideoMode) && isRecord(body) && typeof body.ratio === "string" ? body.ratio : undefined;
    /*
     * 模型只在豆包通道有效；非法值不在这里拦，交给 lib 吸附默认
     * （路由层重复维护一份白名单迟早与 lib 漂移）。
     */
    const requestedModel = provider === "doubao" && isRecord(body) && typeof body.model === "string" && body.model !== ""
      ? body.model
      : undefined;

    try {
      let images;
      if (mode === "edit") {
        const limits = ctx.attachments.imageLimits;
        if (refs.length > limits.maxImagesPerMessage) throw new Error("参考图数量超过附件限制");
        images = [];
        let total = 0;
        for (const raw of refs) {
          const ref = parseImageAttachmentRef(raw);
          if (!ref) throw new Error("无效的参考图附件");
          const stored = await ctx.attachments.readImage(ref);
          // lib 当前自行生成安全的 reference-N 名，Host 不传未承诺会保留的 refs.name。
          const image = { data: stored.data, mediaType: stored.ref.mediaType };
          await ctx.attachments.validateImage(image);
          total += image.data.length;
          if (total > limits.maxMessageImageBytes) throw new Error("参考图总大小超过附件限制");
          images.push(image);
        }
      }
      /*
       * 视频（文生 + 图生共用一条通道）：与「图生图」共用同一条附件读取链路
       * （客户端先把字节经 `/api/import` 存成本地 attachment），区别只在
       * 拿字节去跑视频通道。参考图数量上限同样复用附件限制，不另立一套数字。
       *
       * 参考图**可以为空**——那就是文生视频。空数组与 undefined 等价，
       * `runVideoGeneration` 只管上传非空的那些。
       */
      if (isVideoMode) {
        const limits = ctx.attachments.imageLimits;
        const rawRefs = Array.isArray(refs) ? refs : [];
        if (rawRefs.length > limits.maxImagesPerMessage) throw new Error("参考图数量超过附件限制");
        images = [];
        let total = 0;
        for (const raw of rawRefs) {
          const ref = parseImageAttachmentRef(raw);
          if (!ref) throw new Error("无效的参考图附件");
          const stored = await ctx.attachments.readImage(ref);
          const image = {
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ext: extOfMime(stored.ref.mediaType),
          };
          await ctx.attachments.validateImage(image);
          total += image.data.length;
          if (total > limits.maxMessageImageBytes) throw new Error("参考图总大小超过附件限制");
          images.push(image);
        }
        /*
         * `duration` 只在这里读一次：缺省交给 `runVideoGeneration` 取设置值，
         * 非法值（负数 / NaN / 超范围）一律当没给——让服务端用默认时长，
         * 比传一个 0 秒或 999 秒的请求体更可预期。
         */
        const rawDuration = isRecord(body) && typeof body.duration === "number" ? body.duration : undefined;
        const duration = typeof rawDuration === "number" && isFinite(rawDuration) && rawDuration >= 1 && rawDuration <= 10
          ? Math.round(rawDuration)
          : undefined;
        const video = await runVideoGeneration({
          prompt,
          ratio: editRatio,
          duration,
          model: requestedModel,
          references: images,
          exec: undefined,
        });
        return sendJson(res, 200, {
          ok: true,
          attachment: video.attachment,
          prompt,
          provider: "doubao",
          kind: "video",
          model: video.model,
          ratio: video.ratio,
          duration: video.duration,
          width: video.width,
          height: video.height,
          fromImage: video.fromImage,
          path: video.path,
          watermarkFree: video.watermarkFree,
          summary: video.summary,
          ...(video.conversationCleanup ? { conversationCleanup: video.conversationCleanup } : {}),
          createdAt: Date.now(),
        });
      }
      const generated = await runGeneration({ provider, prompt, size, ratio: editRatio, model: requestedModel, images });
      if (mode === "edit" && [generated.attachment, ...(generated.extraAttachments || [])].some((image) => refs.some((ref) => ref.attachmentId === image.attachmentId))) {
        throw new Error("通道返回了参考图原件，未产生新图片");
      }
      return sendJson(res, 200, {
        ok: true,
        attachment: generated.attachment,
        ...(generated.extraAttachments ? { extraAttachments: generated.extraAttachments } : {}),
        prompt,
        provider: generated.provider,
        model: generated.model,
        // 模型来源不再随模式而变：文生图与图生图都走同一端点、都带模型。
        ...(typeof generated.requestModel === "string" && generated.requestModel !== "" ? { requestModel: generated.requestModel } : {}),
        ...(typeof generated.actualModel === "string" && generated.actualModel !== "" ? { actualModel: generated.actualModel } : {}),
        ratio: mode === "edit" ? generated.ratio : generated.ratio || (isRecord(body) && typeof body.ratio === "string" ? body.ratio : ""),
        ...(mode === "edit" && Array.isArray(generated.itemRatios) ? { itemRatios: generated.itemRatios } : {}),
        ...(mode === "edit" && typeof generated.requestedRatio === "string" ? { requestedRatio: generated.requestedRatio } : {}),
        count: generated.count,
        /*
         * 用了哪个账号出的图。
         *
         * 挂了多个号之后，用户最常问的就是「这张是谁的额度」；换过号时还要能
         * 说明换的原因，否则「为什么突然换号了」无从判断。
         */
        ...(generated.accountId ? { accountId: generated.accountId, accountLabel: generated.accountLabel ?? "" } : {}),
        ...(generated.switchedFrom ? { switchedFrom: generated.switchedFrom } : {}),
        // 会话没删掉时告诉前端。成功不占字段（清理是附带动作）。
        ...(generated.conversationCleanup ? { conversationCleanup: generated.conversationCleanup } : {}),
        createdAt: Date.now(),
      });
    } catch (error) {
      // 生成失败是**业务失败**，用 200 + ok:false 回，让前端能显示原因；
      // 回 500 会被 webServer 顶层 catch 换成空 400，前端什么都看不到。
      return sendJson(res, 200, { ok: false, reason: "generate-failed", message: errText(error) });
    }
  }, "regenerate route");

  /** GET /api/inspiration —— 灵感库元数据（内置数据集快照）。 */
  route(ROUTE_INSPIRATION, async (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    try {
      const catalog = await loadCatalog();
      return sendJson(res, 200, { ok: true, ...publicCatalog(catalog) });
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "catalog-unavailable", message: errText(error) });
    }
  }, "inspiration route");

  /**
   * POST /api/inspiration/image —— 代理远程灵感图。
   *
   * 为什么不让浏览器直连：CSP 与隐私都不允许页面把用户的 IP 交给第三方 CDN；
   * 而且本机实测 jsdelivr / raw.githubusercontent 都 ECONNRESET，只有 canghe
   * 镜像可达（见 lib/inspiration.mjs 的 imageUrls）。
   *
   * body 用 `{sourceId, image}` 而不是把路径塞进 URL：路径来自数据集，校验
   * 失败时必须能返回结构化错误而不是 404。
   */
  route(ROUTE_INSPIRATION_IMAGE, async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { ok: false, reason: "json-required" });
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { ok: false, reason: "invalid-request" });
    }

    const sourceId = isRecord(body) && typeof body.sourceId === "string" ? body.sourceId : "";
    // 路径必须过白名单：客户端发回来的是数据集里的值，但它可被伪造。
    const imagePath = safeImagePath(isRecord(body) ? body.image : undefined);
    if (imagePath === undefined) return sendJson(res, 400, { ok: false, reason: "invalid-image-path" });

    let source;
    try {
      source = await findSource(sourceId);
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "catalog-unavailable", message: errText(error) });
    }
    if (source === undefined) return sendJson(res, 404, { ok: false, reason: "source-not-found" });

    try {
      const image = await fetchInspirationImageCached(source, imagePath);
      res.writeHead(200, {
        "content-type": image.mediaType,
        "content-length": String(image.data.byteLength),
        // 数据集带 commit 版本，内容不可变，可以长缓存。
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
      });
      res.end(image.data);
    } catch (error) {
      sendJson(res, 200, { ok: false, reason: "source-image-unavailable", message: errText(error) });
    }
  }, "inspiration image route");

  /**
   * GET /api/diag/conversation?id=<conversationId> —— 只读诊断。
   *
   * 存在理由：图生图请求确已送达豆包、豆包返回「出了点问题，请稍后重试。」，
   * 而插件只看到「未返回改图结果」。`extractImagesV2` 只读 2074 创造块的
   * `image.tips` / `image.fail_code` / `creation.fail_code`，漏掉了
   * `creation.fail_msg` 与文字回复块（block_type 10000）——服务端的真实原因就在那两处。
   *
   * 只调 `chain_by_block` 拉历史，不发起生成、不消耗额度。
   * 响应绝不含 cookie；任何超长字符串只报 `<N chars>`。
   */
  route(ROUTE_DIAG_CONVERSATION, async (req, res) => {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });

    const id = String(new URL(req.url ?? "/", "http://localhost").searchParams.get("id") ?? "").trim();
    // 豆包会话 id 是长数字串；只接受这一形状，避免把诊断路由变成任意路径探测器。
    if (!/^\d{6,}$/.test(id)) return sendJson(res, 400, { ok: false, reason: "invalid-id" });

    const storedDoubao = await sessions.readDoubao();
    const diagnosticAccount = doubaoAccountCandidates(storedDoubao)[0];
    const cookieHeader = diagnosticAccount?.cookieHeader ?? (cfg().doubao.cookieHeader ?? "").trim();
    if (!cookieHeader) return sendJson(res, 200, { ok: false, reason: "cookie-required" });

    /*
     * `types` 可选：逗号分隔的块类型数字，`none` 表示不筛。
     *
     * 默认只查 2074（创造输出块），但实测发现「豆包在出图前就失败」的会话
     * 用该 filter 会返回空 messages——失败信息不在创造块里。排查这类问题
     * 必须能换块类型，否则诊断路由对目标场景无效。
     */
    const rawTypes = String(new URL(req.url ?? "/", "http://localhost").searchParams.get("types") ?? "").trim();
    let blockTypes;
    if (rawTypes === "none") {
      blockTypes = [];
    } else if (rawTypes !== "") {
      const parts = rawTypes.split(",").map((part) => part.trim());
      if (parts.some((part) => !/^\d+$/.test(part))) {
        return sendJson(res, 400, { ok: false, reason: "invalid-types" });
      }
      blockTypes = parts.map((part) => Number(part));
    }

    // `shape=1`：连带返回**结构骨架**（键名 + 值的类型/长度），用于定位
    // 「消息拿到了但抽不出块」的情形。骨架不含任何值，无泄漏风险。
    const rawShape = String(new URL(req.url ?? "/", "http://localhost").searchParams.get("shape") ?? "").trim();

    /*
     * `text=full`：显式要求回传文字块原文（默认脱敏成 `<N chars>`）。
     *
     * 默认关闭的理由：那段文字是用户的提示词或豆包回复，属于会话内容。
     * 诊断路由的默认路径不该出现用户内容，只有用户**主动**排障时才打开。
     */
    const rawText = String(new URL(req.url ?? "/", "http://localhost").searchParams.get("text") ?? "").trim();

    try {
      const diag = await fetchConversationDiagnosis(cookieHeader, id, {
        blockTypes,
        includeShape: rawShape === "1",
        includeText: rawText === "full",
        ...doubaoIdentityOf(diagnosticAccount),
      });
      return sendJson(res, 200, { ok: true, conversationId: id, ...diag });
    } catch (error) {
      return sendJson(res, 200, { ok: false, reason: "fetch-failed", message: errText(error) });
    }
  }, "diag conversation route");

  /*
   * 画廊持久化。
   *
   * ## 为什么是服务端
   *
   * 客户端的 IndexedDB 按 origin 隔离，而 origin 含端口。DSH web 每次启动
   * 端口可能不同（3080 / 49422 / 49787 …），换一次端口就是一个全新的空库。
   * 用户的工作区没变、图也没删，画廊却空了 —— 这不是用户操作失误，是
   * 「把服务端概念（工作区）存在客户端」的必然代价。
   *
   * 所以权威副本落 `$DSH_HOME/storages/dsh-doubao-image/gallery.json`，
   * 客户端 IndexedDB 降级为本地缓存。
   *
   * ## 为什么按工作区隔离却不在服务端过滤
   *
   * 记录里带 `workspaceId` / `workspacePath` / `sessionId`，但**归属判定
   * 留在客户端**：只有它知道当前工作区的完整判据集合（id + 路径 +
   * 会话 id 列表，见 `client.js` 的 `isItemInWorkspace`）。服务端做原样
   * 存取，不在服务端复制一份归属逻辑 —— 两处判据迟早会漂移。
   *
   * ## 为什么只有一条路由
   *
   * 宿主 `webServer.register` 对同一路径的第二次注册**直接抛错**
   * （`webserver: duplicate exact route`），插件会整个起不来。
   * 所以读写删改全部走这一条，按 method 分流。
   */
  route(ROUTE_GALLERY, async (req, res) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;

    // ── GET：拉全量 ──
    if (req.method === "GET") {
      const result = await galleryStore.read();
      if (!result.ok) {
        // 损坏要让用户看见，否则他会以为图丢了却收不到任何提示。
        return sendJson(res, 200, { ok: false, reason: result.reason, message: result.message, file: galleryStore.file });
      }
      return sendJson(res, 200, { ok: true, items: result.items, tombstones: result.tombstones, file: galleryStore.file });
    }

    // ── POST：写入 / 批量写入 ──
    if (req.method === "POST") {
      const parsed = await jsonBody(req);
      if (parsed.error) return sendJson(res, 400, { ok: false, reason: parsed.error });
      const body = parsed.body;

      // 批量写：导入本地图时一次性提交，避免 N 次重写整个文件。
      if (Array.isArray(body.items)) {
        const result = await galleryStore.upsertMany(body.items);
        return sendJson(res, 200, result.ok ? { ok: true, written: result.written } : result);
      }

      const result = await galleryStore.upsert(body.item ?? body);
      return sendJson(res, 200, result);
    }

    // ── DELETE：删单条 / 批量 ──
    if (req.method === "DELETE") {
      const ids = String(params.get("ids") ?? "").trim();
      if (ids !== "") {
        const list = ids.split(",").map((id) => id.trim()).filter((id) => id !== "");
        const result = await galleryStore.removeMany(list);
        return sendJson(res, 200, result);
      }

      const id = String(params.get("id") ?? "").trim();
      if (id === "") return sendJson(res, 400, { ok: false, reason: "id-required" });
      const result = await galleryStore.remove(id);
      return sendJson(res, 200, result);
    }

    // ── PATCH：收藏切换 / 清空 ──
    if (req.method === "PATCH") {
      const parsed = await jsonBody(req);
      if (parsed.error) return sendJson(res, 400, { ok: false, reason: parsed.error });
      const body = parsed.body;

      if (body.action === "clear") {
        const result = await galleryStore.clear();
        return sendJson(res, 200, result);
      }

      if (body.action !== "favorite") return sendJson(res, 400, { ok: false, reason: "unknown-action" });

      const isFavorite = body.isFavorite === true;
      if (Array.isArray(body.ids)) {
        const result = await galleryStore.setFavoriteMany(body.ids, isFavorite);
        return sendJson(res, 200, result);
      }

      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (id === "") return sendJson(res, 400, { ok: false, reason: "id-required" });
      const result = await galleryStore.setFavorite(id, isFavorite);
      return sendJson(res, 200, result);
    }

    return sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
  }, "gallery route");
}

export const __internals = { BASE, sameOrigin, allowsStateChange, isLoopbackHost, originMatchesHost, sniffPngOrJpeg, sniffImageMediaType, mediaTypeOfFile, referenceImageRoot, readReferenceImage, MAX_REFERENCE_IMAGE_BYTES, findEdgeExecutable, describeVideoWatermark, pluginDir: fileURLToPath(new URL(".", import.meta.url)) };
