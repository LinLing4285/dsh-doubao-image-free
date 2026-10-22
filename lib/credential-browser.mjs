/**
 * 凭据续期执行器：**不打扰用户地**把过期前的凭证重新读一遍。
 *
 * ## 与登录流程的区别（关键）
 * `BrowserLoginSession.run()` 会先 `_clearBrowserCookies` —— 那是「换号登录」要的，
 * 但续期时清 cookie 等于把用户踢下线。续期必须走**只读路径**：
 * 起浏览器 → 连上持久 profile → 读 cookie 与设备身份 → 关掉。
 *
 * ## 为什么复用同一个 user-data-dir
 * 登录态就存在那个 profile 里（豆包的 `s_v_web_id` 设备身份也在里面）。
 * 换一个临时 profile 读到的只会是未登录状态。
 *
 * ## 并发
 * 两个生图请求同时发现要过期，不应该起两个浏览器。
 * 这里用 `createSingleFlight` 串行化，后到的复用前一次结果。
 *
 * ## 失败语义
 * 续期失败**不抛给业务层**：原凭证通常还能撑一段时间，让业务照常用；
 * 真的不能用了，业务层自己的错误处理会给出「请重新登录」。
 * 只有续期失败且原凭证已过期时，才把失败原因带出去。
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { CdpConnection, cdpTargets, waitForCdp } from "./cdp.mjs";
import { findBrowser, deviceFromBrowser, DOUBAO_PROFILE_DIR, DOUBAO_DEBUG_PORT } from "./browser-login.mjs";
import { createSingleFlight, withTimeout, REFRESH_TIMEOUT_MS } from "./credential-renew.mjs";

/** GPT 登录用的 profile 与端口，与 index.js 的 EDGE_USER_DATA_DIR / EDGE_DEBUG_PORT 保持一致。 */
const GPT_DEBUG_PORT = 9333;
const GPT_LOGIN_URL = "https://chatgpt.com/";

/** 浏览器起来到 CDP 就绪的等待上限。 */
const LAUNCH_TIMEOUT_MS = 30_000;

/** 页面上取完数据后，等多久再关浏览器（给 cookie 落盘留时间）。 */
const SETTLE_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 挑出命令行里带 `--user-data-dir=<userDataDir>` 的进程。
 *
 * 从 `wmic ... /format:csv` 的输出里逐行匹配。**只做匹配，不杀进程** ——
 * 这样「判断残留」与「杀残留」可以分开测，也让调用方能先确认再动手。
 *
 * CSV 末列是 ProcessId。任何解析不出来的行都跳过，绝不猜一个 PID 出来。
 *
 * @param {string} listing wmic 的 stdout
 * @param {string} userDataDir
 * @param {number} [selfPid] 要排除的 PID（本进程）
 * @returns {number[]}
 */
export function matchProfilePids(listing, userDataDir, selfPid = process.pid) {
  const needle = String(userDataDir ?? "").toLowerCase();
  if (needle === "" || typeof listing !== "string") return [];
  const pids = [];
  for (const line of listing.split(/\r?\n/)) {
    if (!line.toLowerCase().includes(needle)) continue;
    const pid = Number(line.slice(line.lastIndexOf(",") + 1).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === selfPid) continue;
    if (pids.includes(pid)) continue;
    pids.push(pid);
  }
  return pids;
}

/**
 * 找出命令行里带本 profile 的残留浏览器 PID（只查，不杀）。
 *
 * 非 Windows 直接返回空数组（没有 wmic）。
 *
 * @param {string} userDataDir
 * @returns {Promise<number[]>}
 */
async function findStaleBrowserPids(userDataDir) {
  if (process.platform !== "win32") return [];
  try {
    const listing = await runCapture("wmic", ["process", "get", "ProcessId,CommandLine", "/format:csv"], 15_000);
    if (!listing) return [];
    return matchProfilePids(listing, userDataDir);
  } catch {
    return [];
  }
}

/**
 * 按 `--user-data-dir=<dir>` 匹配并强杀残留浏览器进程（Windows）。
 *
 * 用 `taskkill /F /FI` 无法按命令行过滤，所以走 `wmic process where`。
 * 匹配失败一律**放弃**（返回 false），不升级到「按端口杀」——端口可能是
 * 用户自己浏览器的。
 *
 * 为什么按 user-data-dir 而不是按端口：端口只是个数字，用户自己开的
 * Edge 也可能占着同一个端口；而 user-data-dir 是插件专用的临时目录，
 * 匹配到它基本就一定是自己上次留下的。
 *
 * @param {string} userDataDir
 * @returns {Promise<boolean>} 是否至少杀了一个
 */
async function killByUserDataDir(userDataDir) {
  if (process.platform !== "win32") return false;
  try {
    const listing = await runCapture("wmic", ["process", "get", "ProcessId,CommandLine", "/format:csv"], 15_000);
    if (!listing) return false;
    const pids = matchProfilePids(listing, userDataDir);
    if (pids.length === 0) return false;
    let killedAny = false;
    for (const pid of pids) {
      const r = await runCapture("taskkill", ["/F", "/PID", String(pid)], 10_000);
      if (r !== null) killedAny = true;
    }
    if (killedAny) {
      console.info(`dsh-doubao-image: 已强制关闭 ${pids.length} 个残留浏览器进程（profile ${userDataDir}）`);
    }
    return killedAny;
  } catch {
    return false;
  }
}

/**
 * 起一个带调试端口的浏览器，执行 `fn(port)`，然后关掉。
 *
 * - 端口已被占用（说明浏览器已经开着）时**不重复拉起**，直接用；
 *   这种情况下也不负责关它 —— 是别人的浏览器。
 * - 自己拉起的才自己关，且必须关干净，否则 user-data-dir 被占用，
 *   下次续期会失败。
 *
 * ## 已知边界（M2，2026-10-18 核实）
 *
 * **一、被 `withTimeout` 包裹后，超时不会中断本函数。**
 * `:222` 与 `:258` 都是 `withTimeout(withBrowser(...))`。超时抛错给调用方后，
 * 本函数内部的 `fn` **仍在跑**，`finally` 要等 `fn` 自己结束才执行。
 * ⇒ 不是泄漏，是**晚关**（可能拖到 `REFRESH_TIMEOUT_MS` 之后才关）。
 * 这是可接受的取舍：强行中断 `fn` 会让 CDP 连接停在半路，反而更容易留下
 * 孤儿浏览器。要知道的是「超时之后可能还有一个浏览器在关」。
 *
 * **二、端口已被占用时的处理**见下面的分支说明。
 *
 * **三、`closeGracefully` 的强杀兜底依赖 `child` 句柄。** Edge 常见行为是
 * 主进程派生子进程后自身退出，`child` 句柄就指向一个已死的 PID。见
 * `closeGracefully` 里的按 user-data-dir 兜底。
 *
 * @template T
 * @param {{userDataDir: string, port: number, url: string}} opts
 * @param {(port: number) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withBrowser(opts, fn) {
  const { userDataDir, port, url } = opts;
  const exe = findBrowser();

  let ours = false;
  let child = null;

  if (!(await portAlive(port))) {
    await mkdir(userDataDir, { recursive: true });
    child = spawn(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ], { stdio: "ignore", detached: true, windowsHide: false });
    child.on("error", () => { /* waitForCdp 会失败并给出提示 */ });
    child.unref();
    ours = true;
    try {
      await waitForCdp(port, { timeoutMs: LAUNCH_TIMEOUT_MS, intervalMs: 500 });
    } catch (error) {
      if (ours) await closeGracefully(port, child, userDataDir);
      throw new Error(`浏览器没有打开调试端口 ${port}：${error.message}`);
    }
  } else {
    /*
     * 端口已占用。分两步：**先确认它是不是自己上次留下的**，再决定接管还是回收。
     *
     * 这里以前是「直接用，永不关闭」——于是上一次异常退出留下的浏览器会
     * 一直留着，泄漏不会自愈（AUDIT M2 的「边界缺口二」）。现在：
     *
     *   - 端口上的进程**命令行带本 profile 的 --user-data-dir** ⇒ 一定是自己
     *     上次留下的。**回收掉**（强杀），然后自己重新起一个。这样残留不会
     *     累积，也不需要用户手动关。
     *   - 端口上连不上 CDP，且**匹配不到本 profile 的进程** ⇒ 是别的东西
     *     占着这个端口。**不碰它**，报错让用户处理。
     *   - 端口上是别人的浏览器（匹配不到本 profile，但 CDP 可用）⇒ 直接用，
     *     不关（那是用户的）。
     *
     * 为什么按 user-data-dir 而不是按端口判断：端口只是个数字，用户自己开的
     * Edge 也可能占着同一个端口；而 user-data-dir 是插件专用的临时目录，
     * 匹配到它基本就一定是自己上次留下的。
     */
    const stale = await findStaleBrowserPids(userDataDir);
    if (stale.length > 0) {
      console.info(
        `dsh-doubao-image: 端口 ${port} 上是上次残留的浏览器（PID ${stale.join(",")}），`
        + `回收后重新启动。`,
      );
      await killByUserDataDir(userDataDir);
      // 等端口真的释放，最多 10 秒
      for (let i = 0; i < 20; i += 1) {
        if (!(await portAlive(port))) break;
        await sleep(500);
      }
      if (await portAlive(port)) {
        throw new Error(
          `调试端口 ${port} 上残留的浏览器回收失败（PID ${stale.join(",")} 仍在）。`
          + `请手动关闭它或重启电脑后重试。`,
        );
      }
      // 端口已空，走正常的启动流程
      return withBrowser(opts, fn);
    }

    try {
      await waitForCdp(port, { timeoutMs: 5_000, intervalMs: 300 });
      /*
       * 端口上有个**不是本次起的**、也不是自己残留的浏览器（用户的）。
       *
       * 不关它，但要说出来：反复出现这条日志意味着有别的程序占着端口。
       */
      console.info(
        `dsh-doubao-image: 调试端口 ${port} 上已有别的浏览器（不是本插件启动的），`
        + `将直接使用；若它不是你的，请检查是否有其他程序占用该端口。`,
      );
    } catch (error) {
      throw new Error(
        `调试端口 ${port} 已被占用但连不上 CDP，且匹配不到本插件的浏览器进程。`
        + `请手动关闭占用该端口的程序后重试。原始错误：${error.message}`,
      );
    }
  }

  try {
    return await fn(port);
  } finally {
    if (ours) await closeGracefully(port, child, userDataDir);
  }
}

/**
 * 优雅关闭浏览器：先 CDP `Browser.close`，它不退才强杀。
 *
 * 直接 kill 会让 cookie 不落盘（见 `lib/browser-login.mjs` 的 `_teardown` 注释，
 * 实测 kill→0 条 / Browser.close→30 条）。续期场景尤其不能犯 ——
 * 续期本身就在读写 profile 里的登录态。
 *
 * ## 强杀兜底为什么不能只靠 `child`（M2 缺口三）
 *
 * Edge 的常见行为是**主进程派生子进程后自身退出**：`spawn` 拿到的 `child`
 * 指向那个已经退出的主进程，`child.kill()` 打在一个已失效的 PID 上——而真正
 * 占着 `user-data-dir` 的子进程还活着。表现就是「关过了但下次起不来」。
 *
 * 所以强杀分两级：
 *   1. `child.kill()` —— 主进程还活着时这一步就够
 *   2. 按端口再探一次 CDP；还活着说明进程换了 PID，此时**按 user-data-dir
 *      匹配进程**再杀（不用端口杀：端口可能被用户自己的浏览器占用）
 *
 * 第 2 步在 Windows 上用 `wmic`/`taskkill` 按命令行匹配。找不到就放弃——
 * 杀错进程的代价远大于留一个孤儿浏览器。
 *
 * @param {number} port
 * @param {import("node:child_process").ChildProcess} child
 * @param {string} [userDataDir] 用于按命令行匹配残留进程
 */
async function closeGracefully(port, child, userDataDir) {
  await sleep(SETTLE_MS);
  let conn = null;
  try {
    const targets = await cdpTargets(port, { timeoutMs: 3_000 }).catch(() => []);
    const page = targets.find((t) => t.webSocketDebuggerUrl);
    if (page) {
      conn = await CdpConnection.connect(page.webSocketDebuggerUrl, { timeoutMs: 5_000 });
      await conn.send("Browser.close", {}, { timeoutMs: 5_000 }).catch(() => {});
    }
  } catch {
    /* 连不上就降级 */
  } finally {
    if (conn) conn.close();
  }

  for (let i = 0; i < 16; i += 1) {
    if (child.exitCode !== null) return;
    await sleep(500);
  }
  try { child.kill(); } catch { /* 已经退了 */ }
  await sleep(500);
  try { child.kill("SIGKILL"); } catch { /* 已经退了 */ }

  /*
   * 第三级：按 user-data-dir 兜底。
   *
   * 走到这里说明 `child` 已经杀过但浏览器可能还活着（PID 变了）。
   * 只在**给了 userDataDir 且端口仍然活着**时才做，避免无谓地起一个
   * taskkill 进程。
   */
  if (typeof userDataDir === "string" && userDataDir !== "" && await portAlive(port)) {
    await killByUserDataDir(userDataDir);
  }
}

/**
 * 跑一条命令并拿 stdout；失败返回 null（不抛）。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      done(null);
    }, timeoutMs);
    proc.stdout?.on("data", (chunk) => { out += chunk.toString("utf8"); });
    proc.on("error", () => { clearTimeout(timer); done(null); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? out : null);
    });
  });
}

async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 连到指定域名的页面并执行一次读取。
 *
 * 每次调用都**重新查 target**：浏览器刚起来时页面可能还在加载，
 * 固定用第一次拿到的 target 会连到已失效的 ws。
 *
 * **查不到 target 只是必要条件，不是充分条件**（实测 675ms 就能在 target 列表里
 * 看到 doubao 页面，但那时页面还没拿到响应）。所以这里在连上之后再等一次
 * `document.readyState === "complete"` —— cookie 是服务端在导航响应里下发的，
 * 页面没加载完就等于没登录态，会得到一个假的「已失效」结论。
 *
 * @param {number} port
 * @param {RegExp} hostPattern
 * @param {(conn: CdpConnection) => Promise<T>} fn
 * @param {{waitPageMs?: number, waitLoadMs?: number}} [opts]
 * @template T
 */
async function withPage(port, hostPattern, fn, opts = {}) {
  const { waitPageMs = 15_000, waitLoadMs = 30_000 } = opts;
  const deadline = Date.now() + waitPageMs;
  let page = null;
  while (Date.now() < deadline) {
    const targets = await cdpTargets(port, { timeoutMs: 5_000 }).catch(() => []);
    page = targets.find((t) => t.type === "page" && hostPattern.test(t.url ?? "") && t.webSocketDebuggerUrl);
    if (page) break;
    await sleep(500);
  }
  if (!page) throw new Error(`浏览器里没有匹配 ${hostPattern} 的页面`);

  const conn = await CdpConnection.connect(page.webSocketDebuggerUrl, { timeoutMs: 10_000 });
  try {
    await waitForLoad(conn, hostPattern, waitLoadMs);
    return await fn(conn);
  } finally {
    conn.close();
  }
}

/**
 * 等页面**真正加载到目标站点**。
 *
 * 实测（2026-10-18）：
 *   599ms  readyState=complete  但 location.host=""
 *   2257ms readyState=interactive  host=www.doubao.com  cookies=5
 *   3776ms readyState=complete     host=www.doubao.com  cookies=10
 *
 * 刚拉起的浏览器里，target 列表在 588ms 就能看到 `https://www.doubao.com/chat/`，
 * 但那一刻执行上下文还是 **about:blank** —— `document.readyState` 为 "complete"
 * 是因为空文档本来就已经加载完了。
 *
 * ⇒ **只判断 readyState 会被空页面骗过去**（本模块第一版就这么错，导致续期
 *    永远报「登录已失效」）。判据必须是 `location.host` 匹配目标域名。
 *
 * 超时不报错：页面可能一直转圈，读到的空就是空，由调用方按业务语义处理。
 */
async function waitForLoad(conn, hostPattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await conn.send("Runtime.evaluate", {
        expression: "JSON.stringify({s: document.readyState, h: location.host})",
        returnByValue: true,
      }, { timeoutMs: 5_000 });
      const v = JSON.parse(r.result?.value ?? "{}");
      if (v.s === "complete" && hostPattern.test(String(v.h ?? ""))) return true;
    } catch {
      /* 页面正在导航，执行上下文可能被销毁，重试即可 */
    }
    await sleep(300);
  }
  return false;
}

/**
 * 从浏览器重新读 GPT 凭据（accessToken + cookie）。
 *
 * 读的是 `/api/auth/session`（同源 fetch，带 cookie），
 * 页面自己也是这么拿会话的 —— 不额外造一套。
 *
 * @param {{userDataDir: string, port?: number, timeoutMs?: number}} opts
 * @returns {Promise<{accessToken: string, cookieHeader: string}>}
 */
export function renewGptFromBrowser(opts) {
  const userDataDir = String(opts?.userDataDir ?? "").trim();
  if (!userDataDir) return Promise.reject(new Error("renewGptFromBrowser 需要 userDataDir"));
  const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : GPT_DEBUG_PORT;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REFRESH_TIMEOUT_MS;

  return withTimeout(withBrowser({ userDataDir, port, url: GPT_LOGIN_URL }, async (p) => {
    return await withPage(p, /chatgpt\.com/, async (conn) => {
      const result = await conn.send("Runtime.evaluate", {
        expression: `fetch("/api/auth/session", { credentials: "include" })
          .then(r => r.ok ? r.json() : { __status: r.status })
          .catch(e => ({ __error: String(e) }))`,
        awaitPromise: true,
        returnByValue: true,
      }, { timeoutMs: 30_000 });
      const session = result.result?.value;
      if (!session || session.__status || session.__error) {
        throw new Error(`读取 ChatGPT 会话失败：${JSON.stringify(session).slice(0, 200)}`);
      }
      const accessToken = String(session.accessToken ?? "").trim();
      if (!accessToken) throw new Error("ChatGPT 会话里没有 accessToken（可能已退出登录）");

      const { cookies } = await conn.send("Network.getCookies", { urls: ["https://chatgpt.com/"] }, { timeoutMs: 15_000 });
      const cookieHeader = (cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");
      return { accessToken, cookieHeader };
    });
  }), timeoutMs, "GPT 凭据续期");
}

/**
 * 从浏览器重新读豆包凭据（cookie + 设备身份）。
 *
 * **只读**：不像 `BrowserLoginSession.run()` 那样先清 cookie —— 那会把用户踢下线。
 *
 * @param {{userDataDir?: string, port?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{cookieHeader: string, device: object}>}
 */
export function renewDoubaoFromBrowser(opts = {}) {
  const userDataDir = String(opts.userDataDir ?? DOUBAO_PROFILE_DIR);
  const port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DOUBAO_DEBUG_PORT;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REFRESH_TIMEOUT_MS;

  return withTimeout(withBrowser({ userDataDir, port, url: "https://www.doubao.com/chat/" }, async (p) => {
    return await withPage(p, /doubao\.com/, async (conn) => {
      const { cookies } = await conn.send("Network.getCookies", { urls: ["https://www.doubao.com/"] }, { timeoutMs: 15_000 });
      const list = Array.isArray(cookies) ? cookies : [];
      if (!list.some((c) => c.name === "sessionid" && c.value)) {
        throw new Error("豆包浏览器里没有有效的 sessionid（登录已失效，需要重新登录）");
      }
      const device = await deviceFromBrowser(conn, list);
      if (!device?.fps) throw new Error("豆包设备身份读取失败（s_v_web_id 缺失）");
      return {
        cookieHeader: list.map((c) => `${c.name}=${c.value}`).join("; "),
        device,
      };
    });
  }), timeoutMs, "豆包凭据续期");
}

/** 每个账号一个串行锁：并发请求同时发现要过期时只起一个浏览器。 */
const gptSingleFlight = new Map();
const doubaoSingleFlight = new Map();

/**
 * 带单飞（single-flight）包装的 GPT 续期。
 * @param {{key: string, userDataDir: string, port?: number}} opts
 */
export function renewGptOnce({ key, userDataDir, port }) {
  const id = String(key ?? userDataDir ?? "default");
  if (!gptSingleFlight.has(id)) {
    gptSingleFlight.set(id, createSingleFlight(() => renewGptFromBrowser({ userDataDir, port })));
  }
  return gptSingleFlight.get(id)();
}

/**
 * 带单飞包装的豆包续期。
 * @param {{key: string, userDataDir?: string, port?: number}} opts
 */
export function renewDoubaoOnce({ key, userDataDir, port }) {
  const id = String(key ?? userDataDir ?? "default");
  if (!doubaoSingleFlight.has(id)) {
    doubaoSingleFlight.set(id, createSingleFlight(() => renewDoubaoFromBrowser({ userDataDir, port })));
  }
  return doubaoSingleFlight.get(id)();
}
