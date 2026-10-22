/**
 * 浏览器出图兜底：当 Node 直连被风控拦（710022004）时，改在真实浏览器页面里发请求。
 *
 * ## 为什么需要它（2026-10-18 实证）
 *
 * 同一账号、同一请求体、同一时间窗：
 *   - **页面里发** → 20 多秒跑完整个生成流程，返回 3 张 2304×1728 的图（下载验证过）；
 *   - **Node 直连** → 330~407ms 秒回 1053 字节的 `710022004`，连生成都没开始。
 *
 * 已逐一排除的因素：`a_bogus`（页面不带它也出图）、请求头（照抄页面头仍被拒）、
 * 出口 IP（doubao 走代理也是 DIRECT，与直连同 IP）、HTTP 协议。
 * 也就是说，风控看的是「请求是不是真的从浏览器里发出来的」，这一层无法在 Node 里伪造。
 *
 * ## 设计约束
 *
 * - **用临时 profile**，每次用完即删。绝不碰 `DOUBAO_PROFILE_DIR`（那是登录用的持久
 *   配置，删了等于换设备）。
 * - **纯自动，不需要人**。与 `BrowserLoginSession` 的定位完全不同：那个是等用户扫码/登录，
 *   这个是从头到尾自己跑完，绝不等待用户交互。
 * - **失败要快**。浏览器起不来、页面没响应、超时，都返回结构化错误，由上层决定换号还是报错。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { CdpConnection, cdpTargets, waitForCdp } from "./cdp.mjs";
import { findBrowser } from "./browser-login.mjs";

/** 每次会话换一个端口，避免与登录态浏览器（9335）、GPT（9333）、抓包（9341）撞车。 */
const BASE_PORT = 9350;

/**
 * 页面就绪的等待上限。
 *
 * ## 为什么不再盲等（2026-10-19 实测）
 *
 * 旧实现是 `await new Promise(r => setTimeout(r, PAGE_READY_MS))` —— **无条件等 20 秒**。
 * 实测页面其实 1.5~3 秒就到 `readyState=complete`，剩下的 17 秒纯粹是浪费：
 * 整个兜底路径 44 秒里，这一段占了将近一半。
 *
 * 更关键的是「等够了没」不该靠猜。实测：
 * 页面 `complete` 之后**立刻**发请求就能拿到结构化业务码（`710012001 登录已过期`，
 * 因为那次没注入 cookie），而不是网络层失败；随后每秒再发 4 次，返回码完全一致。
 * ⇒ `complete` 就是可用的信号，不需要额外缓冲。
 *
 * 所以改成**轮询**，命中就走。这个上限只是兜底，正常路径 3 秒内就结束。
 */
const PAGE_READY_TIMEOUT_MS = 20_000;

/** 轮询间隔。250ms 足够细，又不至于把 CDP 打满。 */
const PAGE_READY_POLL_MS = 250;

/**
 * 等页面真的可用：**同时**满足 `location.host` 正确与 `readyState === "complete"`。
 *
 * 只看 `readyState` 会误判：刚拉起的浏览器在 ~600ms 时 target 列表里已经有目标 URL，
 * 但执行上下文还停在 `about:blank` —— 空文档天然就是 `complete`。
 * 所以必须连 host 一起校验，否则会在空文档上「立刻成功」，然后在真页面上发请求时
 * 撞上一堆未初始化的状态。
 *
 * @param {import("./cdp.mjs").CdpConnection} conn
 * @param {string} wantHost 期望的 location.host（如 `www.doubao.com`）
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} 是否在超时前就绪
 */
async function waitForPageReady(conn, wantHost, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await conn.send(
        "Runtime.evaluate",
        {
          expression: `JSON.stringify({ state: document.readyState, host: location.host })`,
          returnByValue: true,
        },
        { timeoutMs: 2_000 },
      );
      const raw = r?.result?.value;
      if (typeof raw === "string") {
        const info = JSON.parse(raw);
        if (info.host === wantHost && info.state === "complete") return true;
      }
    } catch {
      /* 导航过程中执行上下文会被销毁重建，报错是正常的，下一轮重试 */
    }
    await new Promise((r) => setTimeout(r, PAGE_READY_POLL_MS));
  }
  return false;
}

/**
 * 兜底通道的**可替换实现**（测试注入点）。
 *
 * ## 为什么需要这个间接层（2026-10-19 实测）
 *
 * `doubao-image.mjs` 的 `tryBrowserFallback` 用 `await import("./browser-image.mjs")`
 * 拿本模块，而 ESM 的命名导出是**不可重定义**的只读绑定 —— 测试里
 * `Object.defineProperty(mod, "fetchViaBrowser", …)` 直接抛
 * `TypeError: Cannot redefine property`。于是此前只能让测试**真起一次浏览器**：
 * 实测整个 edit-v2 套件 31 秒，其中约 25 秒花在「spawn Edge → CDP 连不上 → 返回 null」，
 * 而且会在用户桌面闪窗口、往 %TEMP% 留 `dbi-img-*` 目录。
 *
 * 更关键的是兜底路径**零覆盖**：它只在真被风控时才走，平时测不到，
 * 于是「兜底成功了会不会误改语义」「没拿到图时会不会把原错误吞掉」全靠读代码。
 *
 * 与 `credential-renew.mjs` 的 `renew` 注入点是同一套做法：留一个模块级
 * 可替换引用，生产默认就是本函数，测试换成桩。这样既不改变生产行为，
 * 又能把每条分支都断言到。
 */
let impl = realFetchViaBrowser;

/**
 * 替换兜底实现，仅供测试。传 `null` 恢复默认。
 *
 * 返回**设置前的**实现，让调用方能验证「确实换掉了」。这一点不是装饰：
 * 没有它，测试只能靠「真的调一次」来确认恢复生效，而那会 spawn 浏览器——
 * 一个本该零副作用的测试钩子反而制造了最大的副作用（实测把套件从 0.2 秒
 * 拖回 31 秒）。
 *
 * @param {typeof realFetchViaBrowser | null} next
 * @returns {typeof realFetchViaBrowser} 设置前的实现
 */
export function __setBrowserImpl(next) {
  const previous = impl;
  impl = next ?? realFetchViaBrowser;
  return previous;
}

/**
 * 对外入口：转发到当前 `impl`。
 *
 * 生产环境 `impl` 永远是 `realFetchViaBrowser`，行为与拆分前逐字一致；
 * 测试用 `__setBrowserImpl` 换掉它，从而不 spawn 浏览器也能覆盖每条分支。
 */
export async function fetchViaBrowser(options) {
  return await impl(options);
}

/**
 * 在真实浏览器页面里发一次生图请求。
 *
 * 这是**真正的实现**；对外导出的是下面那个转发到 `impl` 的包装函数。
 * 拆成两个名字是为了让 `__setBrowserImpl` 有东西可指（默认值必须是真实实现，
 * 而不是包装函数自己 —— 否则会自我递归）。
 *
 * @param {object} opts
 * @param {string} opts.cookieHeader 该账号的完整 cookie 串
 * @param {string} opts.body 已构造好的请求体 JSON 字符串（与 Node 直连用的是同一份）
 * @param {string} opts.query 已构造好的查询串（同 editSecurityParams 的产物）
 * @param {number} [opts.timeoutMs] 整次请求的超时，默认 120 秒
 * @param {number} [opts.port] 调试端口
 * @returns {Promise<{ok:boolean, text?:string, status?:number, ms?:number, message?:string}>}
 *          `text` 是服务端返回的**原始 SSE 全文**，交给调用方用现成的解析器处理 ——
 *          不在这里解析，避免两套解析逻辑漂移。
 */
async function realFetchViaBrowser({ cookieHeader, body, query, timeoutMs = 120_000, port = BASE_PORT }) {
  const started = Date.now();
  let browser;
  try {
    browser = findBrowser();
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const dir = await mkdtemp(join(tmpdir(), "dbi-img-"));
  let child = null;
  let conn = null;
  try {
    child = spawn(browser, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // 兜底路径本来就要跑十几二十秒，隐藏窗口能省掉用户被弹窗打断的成本。
      // 注意：不用 --headless，部分站点的风控会识别无头特征。
      "--window-position=0,0",
      "about:blank",
    ], { stdio: "ignore", detached: true });
    child.on("error", () => { /* waitForCdp 会给出更具体的失败 */ });
    child.unref();

    try {
      await waitForCdp(port, { timeoutMs: 30_000, intervalMs: 500 });
    } catch {
      return { ok: false, message: `浏览器没有打开调试端口 ${port}` };
    }

    const targets = await cdpTargets(port);
    const page = targets.find((t) => t.type === "page");
    if (!page) return { ok: false, message: "浏览器里没有可用页面" };
    conn = await CdpConnection.connect(page.webSocketDebuggerUrl);
    await conn.send("Network.enable");

    // 注入该账号的 cookie。跳过 s_v_web_id —— 那是设备身份，临时 profile 会自己生成一个，
    // 拿别处的值覆盖反而会造成 cookie 与浏览器本地状态不自洽。
    let injected = 0;
    for (const part of cookieHeader.split(";")) {
      const s = part.trim();
      if (!s) continue;
      const eq = s.indexOf("=");
      if (eq <= 0) continue;
      const name = s.slice(0, eq);
      if (name === "s_v_web_id") continue;
      await conn.send("Network.setCookie", { name, value: s.slice(eq + 1), domain: ".doubao.com", path: "/" });
      injected++;
    }
    if (injected === 0) return { ok: false, message: "cookie 解析失败，没有可注入的条目" };

    // 先加载豆包首页，让页面把自身的运行时（含签名逻辑）初始化好。
    await conn.send("Page.enable");
    await conn.send("Page.navigate", { url: "https://www.doubao.com/chat/" });
    /*
     * 轮询到真的可用就继续，不再盲等 20 秒（见 waitForPageReady 的注释）。
     * 超时也不直接失败：有些网络条件下 complete 会晚到，但请求本身可能仍然能成，
     * 所以这里只记一笔，让后面的真实请求去判定成败 —— 少一次「等太久就报错」的误杀。
     */
    const ready = await waitForPageReady(conn, "www.doubao.com", PAGE_READY_TIMEOUT_MS);
    if (process.env.DBI_DEBUG_FALLBACK) {
      console.log(`[fallback] 页面就绪=${ready} 用时=${Date.now() - started}ms`);
    }

    // 在页面上下文里发请求。请求体与参数由调用方传入，与直连那条路完全相同。
    const expr = `(async () => {
      const t0 = performance.now();
      const res = await fetch("/chat/completion?" + ${JSON.stringify(query)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ${JSON.stringify(body)},
      });
      const text = await res.text();
      return JSON.stringify({ ms: Math.round(performance.now() - t0), status: res.status, text });
    })()`;

    // 注意：超时是 `send()` 的**第三个参数**（`{timeoutMs}`），写进 params 里不会生效，
    // 会静默退回默认的 30 秒 —— 实测页面生成一次要 15~25 秒，加上排队很容易超。
    const out = await conn.send(
      "Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true },
      { timeoutMs },
    ).then((r) => r.result?.value ?? null).catch((e) => { throw new Error(e.message); });

    if (!out) return { ok: false, message: "页面没有返回结果" };
    const parsed = JSON.parse(out);
    return { ok: true, text: parsed.text, status: parsed.status, ms: parsed.ms };
  } catch (error) {
    return { ok: false, message: error && error.message ? error.message : String(error) };
  } finally {
    if (conn) {
      try { conn.close(); } catch { /* 已断开 */ }
    }
    if (child) {
      try { child.kill(); } catch { /* 已退出 */ }
      // 给进程收尾时间，否则临时目录会因占用删不干净。
      await new Promise((r) => setTimeout(r, 500));
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
