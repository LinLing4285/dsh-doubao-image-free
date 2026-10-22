/**
 * 拉起一个独立配置的浏览器，让用户登录豆包，然后**一次性**取回
 * 这台浏览器自己的 cookie、设备身份。
 *
 * ## 为什么必须这么做
 *
 * 豆包把 `fp` / `device_id` / `web_id` 与 cookie 交叉校验。插件早期写死了一套
 * 2026-10 的设备身份（来自开发机），任何别人装上、配上自己的 cookie，发出去
 * 的都是「别人的设备 + 自己的账号」——这正是风控最典型的异常特征：服务端
 * 0.4 秒回 710022004 进人机校验队列，永远不出图。
 *
 * 所以没有任何可以共享的默认身份。每个用户必须用自己的浏览器，因为：
 *   - 纯 HTTP 扫码能拿到 cookie，但**拿不到设备身份**（`fp` 不是 Set-Cookie
 *     下发的，`device_id` / `web_id` 在页面 localStorage 里）；
 *   - 只有真的把浏览器跑起来，才能读到这两样。
 *
 * ## 为什么 user-data-dir 必须持久
 *
 * 浏览器的 `s_v_web_id` cookie 与 localStorage 里的 device_id 都活在这个目录
 * 里。目录一删，下次打开就是一台「全新设备」，豆包会认为换了机器，之前的
 * 登录与设备绑定关系全部作废。
 *
 * 所以这里用固定目录（与 GPT 的 Edge 登录同一个思路），代价是「换账号」时要
 * 显式清理，见 `resetProfile()`。
 *
 * ## 关于 msToken
 *
 * msToken 是请求级签名参数，**无法预先导出**：它由页面 JS 在发请求时生成并
 * 挂在 URL 上，不在 cookie 里，且服务端校验其真实性（自造串比不传更糟，
 * 见 lib/doubao.mjs 的 currentMsToken 说明）。这里只负责把同一台浏览器的
 * 身份取全；msToken 的取用见 `lib/doubao-device.mjs` 的 readMsTokenFromBrowser()。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpConnection, cdpTargets, evaluate, waitForCdp } from "./cdp.mjs";

const LOGIN_URL = "https://www.doubao.com/chat/";
const POLL_INTERVAL_MS = 2000;
const LAUNCH_TIMEOUT_MS = 30_000;

/** 登录成功的判据：拿到 sessionid（豆包登录态的核心 cookie）。 */
const SESSION_COOKIE = "sessionid";

/** 抓签名参数时监听的目标端点。 */
const COMPLETION_RE = /\/chat\/completion/;

/**
 * 独立浏览器配置目录。
 *
 * 固定路径而非临时目录：见文件头的「为什么 user-data-dir 必须持久」。
 * 与 GPT 的 `dsh-doubao-image-edge` 分开，避免两套登录互相干扰。
 */
export const DOUBAO_PROFILE_DIR = join(tmpdir(), "dsh-doubao-image-doubao");

/** 默认调试端口。挑一个不与 GPT 的 9333、抓包脚本的 9341 冲突的号。 */
export const DOUBAO_DEBUG_PORT = 9335;

/**
 * 找本机可用的 Chromium 系浏览器。
 *
 * 按 Edge → Chrome 的顺序找，都找不到就抛错并说明该怎么办。
 * 只返回确定存在 exe 的路径，不猜版本号。
 */
export function findBrowser() {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error("没找到 Edge 或 Chrome，请先安装其中一个浏览器");
}

/**
 * 删掉浏览器配置目录，用于「换账号登录」。
 *
 * 必须在浏览器关闭时调用，否则文件被占用、删不干净。
 */
export async function resetProfile(dir = DOUBAO_PROFILE_DIR) {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * 从 cookie 数组与页面存储里取出能确认的身份字段。
 *
 * ## 2026-10-17 实测修正（重要）
 *
 * 早期实现去找 localStorage 里的 `device_id` / `web_id` / `tea_uuid` 三个键，
 * 结果**永远拿不到**，登录流程卡在「等身份」上直到超时。实际排查结论：
 *
 *   - 页面 localStorage / cookie 里**没有** `device_id` 与 `tea_uuid`
 *     （扫遍全部键与全部 30 个 cookie 确认）；
 *   - `web_id` 在 `samantha_web_web_id` 这个 JSON 的 `web_id` 字段里；
 *   - 更重要的是：页面自己 fetch `/chat/completion` 时，URL 上**只带
 *     `msToken` 与 `a_bogus`**，根本没有任何设备参数。
 *
 * 所以「必须凑齐五个字段」的前提本身是错的。现在只要求能确认的部分，
 * 拿不到就留空——调用方不再因缺字段而判定失败。
 *
 * @param {object} conn CDP 连接
 * @param {Array<{name:string,value:string}>} cookies
 * @returns {Promise<{fps:string,deviceId:string,teaUuid:string,webId:string,pcVersion:string}>}
 */
export async function deviceFromBrowser(conn, cookies) {
  const sVWebId = (cookies.find((c) => c.name === "s_v_web_id")?.value ?? "").trim();
  const parts = sVWebId.split("_");
  const fps = parts.length >= 3 && parts[0] === "verify" ? parts.slice(0, 3).join("_") : "";

  let page = {};
  try {
    const raw = await evaluate(conn, `(() => {
      const read = (k) => { try { return String(window.localStorage.getItem(k) ?? ""); } catch { return ""; } };
      const num = (v) => (/^\\d{6,}$/.test(v) ? v : "");
      // web_id 藏在 samantha_web_web_id 这个 JSON 里，不是独立键。
      let webId = "";
      try { webId = num(JSON.parse(read("samantha_web_web_id"))?.web_id ?? ""); } catch { /* 不是 JSON */ }
      return JSON.stringify({ webId });
    })()`);
    page = JSON.parse(raw ?? "{}") ?? {};
  } catch { /* 读不到就留空 */ }

  return {
    fps,
    // 页面不存这两个字段；留空，由调用方按「可用字段」处理。
    deviceId: "",
    teaUuid: "",
    webId: page.webId || "",
    // 网页端 pc_version 是固定值（抓包实测 3.41.4），不需要从页面读。
    pcVersion: "3.41.4",
  };
}

/**
 * 一个可取消的浏览器登录会话。
 *
 * 与 DoubaoQrSession 的区别：那个是纯 HTTP 轮询扫码，只能拿到 cookie；
 * 这个真的把浏览器跑起来，能拿到 cookie 之外的全部身份字段。
 */
export class BrowserLoginSession {
  constructor(opts = {}) {
    const timeoutMs = Number(opts.timeoutMs);
    /** 整个流程的总超时，默认 300 秒（与 GPT 登录一致）。 */
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000;
    this.port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DOUBAO_DEBUG_PORT;
    this.userDataDir = typeof opts.userDataDir === "string" && opts.userDataDir
      ? opts.userDataDir
      : DOUBAO_PROFILE_DIR;

    this._child = null;
    this._cancelled = false;
    this._done = false;
  }

  get running() {
    return Boolean(this._child) && !this._done;
  }

  /** 取消登录并关掉浏览器。可重复调用。注意**不删**配置目录（见文件头）。 */
  async cancel() {
    this._cancelled = true;
    await this._teardown();
  }

  /**
   * 关掉浏览器。
   *
   * ## 必须优雅退出（2026-10-18 实测）
   *
   * Chromium 的 cookie 平时在**内存**里，定期批量落盘；进程被 kill 就不落盘。
   * 同一份 cookie、同一个 profile，只改关闭方式：
   *
   * | 关闭方式              | 落盘 cookie | sessionid |
   * |-----------------------|-------------|-----------|
   * | `child.kill()`        | 0 条        | 不在      |
   * | CDP `Browser.close`   | 30 条       | 在        |
   *
   * 直接 kill 的后果不只是「这次没存住」：`user-data-dir` 里的登录态
   * 永远停在游客状态，用户每次点「登录豆包」都得重新扫码，而且
   * `lib/credential-browser.mjs` 的续期读不到任何东西。
   *
   * 所以这里先发 `Browser.close` 让浏览器自己收尾，只在它赖着不退时才降级强杀。
   */
  async _teardown() {
    this._done = true;
    const child = this._child;
    this._child = null;
    if (!child || child.exitCode !== null) return;

    // 1) 优雅关闭：连 CDP 发 Browser.close，浏览器会先 flush cookie 再退出。
    await this._closeGracefully();

    // 2) 等它自己退；最多 8 秒（flush 大 profile 需要时间）。
    for (let i = 0; i < 16; i += 1) {
      if (child.exitCode !== null) return;
      await new Promise((r) => setTimeout(r, 500));
    }

    // 3) 还不退才强杀，否则 user-data-dir 会留在占用状态，下次起不来。
    try { child.kill(); } catch { /* 已经退了 */ }
    await new Promise((r) => setTimeout(r, 500));
    try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }
  }

  /** 通过 CDP 让浏览器自己退出；连不上就算了，由调用方降级处理。 */
  async _closeGracefully() {
    let conn = null;
    try {
      const targets = await cdpTargets(this.port, { timeoutMs: 3000 });
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
      if (!page) return false;
      conn = await CdpConnection.connect(page.webSocketDebuggerUrl, { timeoutMs: 5000 });
      await conn.send("Browser.close", {}, { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    } finally {
      if (conn) conn.close();
    }
  }

  /**
   * 启动浏览器并阻塞到用户完成登录。
   *
   * @returns {Promise<{ok:boolean, cookieHeader?:string, device?:object, message?:string}>}
   */
  async run() {
    this._cancelled = false;
    this._done = false;

    let browser;
    try {
      browser = findBrowser();
    } catch (error) {
      return { ok: false, message: error.message };
    }

    try {
      await mkdir(this.userDataDir, { recursive: true });

      // 端口已被上一轮遗留的浏览器占着，说明窗口还开着，那就不重复拉起。
      if (await this._portAlive()) {
        await this._clearCookies();
        return await this._waitForLogin();
      }

      const args = [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${this.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        LOGIN_URL,
      ];
      this._child = spawn(browser, args, {
        // 沙箱下 piped stdio 可能被拒；我们也不需要它的输出。
        stdio: "ignore",
        detached: true,
        windowsHide: false,
      });
      this._child.on("error", () => { /* 下面 waitForCdp 会失败并给出提示 */ });
      this._child.unref();

      try {
        await waitForCdp(this.port, { timeoutMs: LAUNCH_TIMEOUT_MS, intervalMs: 500 });
      } catch {
        return { ok: false, message: `浏览器没有打开调试端口 ${this.port}，可能被其他实例占用，请关掉它再试` };
      }
      // 配置目录是持久的，里面还留着上一个账号的登录态；不清掉就没有登录页可看。
      await this._clearCookies();
      return await this._waitForLogin();
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : String(error) };
    } finally {
      await this._teardown();
    }
  }

  /**
   * 轮询到登录完成、超时，或**浏览器被用户关掉**。
   *
   * ## 为什么必须感知「浏览器没了」（2026-10-18 用户实测）
   *
   * 用户点登录 → 拉起浏览器 → 扫码前手动把窗口关了。
   * 旧实现只轮询 cookie，浏览器没了以后 `_readIdentityOnce` 一直返回 null，
   * 于是白等满 300 秒；而这不只是浪费——**这段时间里 `browserLogin.running`
   * 一直是 true**，用户再点一次登录会被拒：
   * 「浏览器登录已在进行中，请先完成或关闭那个窗口」，
   * 可他明明已经关掉了。
   *
   * 所以这里每一轮都额外确认两件事：进程还在、调试端口还活着。
   * 任一不成立就当作「用户放弃了这次登录」立刻返回。
   */
  async _waitForLogin() {
    const deadline = Date.now() + this.timeoutMs;
    let diedCount = 0;
    while (Date.now() < deadline) {
      if (this._cancelled) return { ok: false, message: "已取消" };

      const identity = await this._readIdentityOnce();
      if (identity) return { ok: true, ...identity };

      // 进程已退出 或 调试端口连不上 ⇒ 用户关了窗口。
      // 连续两次确认，避免启动瞬间的抖动误判成「用户关了」。
      const childGone = this._child && this._child.exitCode !== null;
      const portGone = !(await this._portAlive());
      if (childGone || portGone) {
        diedCount += 1;
        if (diedCount >= 2) {
          return { ok: false, message: "浏览器窗口已关闭，登录未完成", browserClosed: true };
        }
      } else {
        diedCount = 0;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { ok: false, message: "等待登录超时，请重试" };
  }

  async _portAlive() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * 这个会话是不是已经废了（浏览器进程没了、端口也连不上）。
   *
   * 供路由判断「要不要让新请求顶掉它」：用户手动关了窗口之后，
   * 会话不该继续占着位置把后续登录请求全挡掉。
   */
  async isStale() {
    if (!this.running) return true;
    if (this._child && this._child.exitCode !== null) return true;
    return !(await this._portAlive());
  }

  /**
   * 清掉浏览器里的 cookie，等价于「点了一下退出登录」。
   *
   * ## 为什么必须清
   *
   * `userDataDir` 是持久的（见文件头），上一个账号的登录态一直留在里面。
   * 不清的话，第二次点「拉起浏览器登录」时浏览器直接带着旧账号就进去了，
   * 用户根本没有换账号的入口——2026-10-17 用户实测报的就是这个现象：
   * 「我点拉起之后浏览器自动登录了，没有切换账号的机会」。
   *
   * ## 为什么只清 cookie、不删目录
   *
   * `s_v_web_id` 也在这个目录里，它是设备身份的来源。整个删掉等于换了一台
   * 设备，豆包会重新判风控（见文件头「为什么 user-data-dir 必须持久」）。
   * 只清 cookie 则设备不变、账号退出，正是我们想要的。
   */
  async _clearCookies() {
    let conn = null;
    try {
      const targets = await cdpTargets(this.port, { timeoutMs: 5000 });
      const page = targets.find((t) => t.type === "page");
      if (!page || !page.webSocketDebuggerUrl) return;
      conn = await CdpConnection.connect(page.webSocketDebuggerUrl, { timeoutMs: 5000 });
      await conn.send("Network.clearBrowserCookies");
      // 清完再让页面回到登录入口，免得停在已登录的旧页面上。
      await conn.send("Page.navigate", { url: LOGIN_URL });
    } catch { /* 清不掉就让下面的轮询去发现（会等待登录超时） */ } finally {
      if (conn) conn.close();
    }
  }

  /**
   * 连上去读一次身份；没登录就返回 null。
   *
   * 每次轮询都新开连接：登录状态变化时页面会跳转，旧 target 可能已失效。
   */
  async _readIdentityOnce() {
    let conn = null;
    try {
      const targets = await cdpTargets(this.port, { timeoutMs: 5000 });
      const page = targets.find((t) => t.type === "page" && /doubao\.com/.test(t.url ?? ""));
      if (!page || !page.webSocketDebuggerUrl) return null;

      conn = await CdpConnection.connect(page.webSocketDebuggerUrl, { timeoutMs: 5000 });
      const { cookies } = await conn.send("Network.getCookies", { urls: ["https://www.doubao.com/"] });
      const list = Array.isArray(cookies) ? cookies : [];
      if (!list.some((c) => c.name === SESSION_COOKIE && c.value)) return null;

      const device = await deviceFromBrowser(conn, list);
      /*
       * 只要求 fp。`fp` 来自 cookie 的 s_v_web_id，登录后就一定有；
       * deviceId / teaUuid 页面根本不存（见 deviceFromBrowser 的说明），
       * 拿它们当判据会让流程永远卡在等待上——这正是 2026-10-17 的故障。
       */
      if (!device.fps) return null;

      const msToken = await this._captureMsToken(conn);

      return {
        cookieHeader: list.map((c) => `${c.name}=${c.value}`).join("; "),
        device,
        msToken,
      };
    } catch {
      return null;
    } finally {
      if (conn) conn.close();
    }
  }

  /**
   * 在页面里发一次 `/chat/completion`，从 CDP 事件里抓 URL 上的 `msToken`。
   *
   * 为什么这么做（2026-10-17 实测）：
   *   - 页面自己的 fetch 不带任何设备参数，只带 `msToken` + `a_bogus`；
   *   - `msToken` 在连续三次请求里**逐字相同**，所以可以存下来复用；
   *   - `a_bogus` 每次都变且与请求体绑定，存了也没用，因此不抓。
   *
   * 抓不到就返回空串（调用方按「不发 msToken」处理，实测那样也能出图），
   * 绝不编造——自造的 msToken 会被服务端判异常，比不带更糟。
   */
  async _captureMsToken(conn) {
    let found = "";
    const off = conn.on("Network.requestWillBeSent", (p) => {
      const href = p.request?.url ?? "";
      if (!COMPLETION_RE.test(href)) return;
      try {
        const value = new URL(href).searchParams.get("msToken") ?? "";
        if (value) found = value;
      } catch { /* URL 解析失败就当没抓到 */ }
    });
    try {
      await conn.send("Network.enable");
      // body 留空：这次请求只为触发页面 JS 生成签名参数，不期望它出图。
      await conn.send("Runtime.evaluate", {
        expression: `fetch("/chat/completion", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then(r => r.status).catch(() => 0)`,
        awaitPromise: true,
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 800));
    } catch { /* 抓不到就算了 */ } finally {
      off();
    }
    return found;
  }
}
