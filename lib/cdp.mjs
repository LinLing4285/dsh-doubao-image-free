/**
 * Minimal Chrome DevTools Protocol client over node's built-in WebSocket.
 * No puppeteer-core, no ws — Node 24 ships a global WebSocket.
 *
 * Used by the GPT free-account login flow: launch Edge with a debug port,
 * let the user sign in by hand, then read the ChatGPT session cookie and
 * access token out of the live page.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CdpError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = "CdpError";
    this.method = method;
    this.code = code;
  }
}

/** Query the HTTP endpoint of a running debug target. */
export async function cdpVersion(port, { timeoutMs = 5000 } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new CdpError(`devtools /json/version -> HTTP ${r.status}`);
  return r.json();
}

export async function cdpTargets(port, { timeoutMs = 5000 } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new CdpError(`devtools /json/list -> HTTP ${r.status}`);
  return r.json();
}

/** Poll until the debug port answers, or give up. */
export async function waitForCdp(port, { timeoutMs = 20_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      return await cdpVersion(port);
    } catch (e) {
      last = e;
      await sleep(intervalMs);
    }
  }
  throw new CdpError(`debug port ${port} not ready in ${timeoutMs}ms: ${last?.message}`);
}

/** One CDP connection to a single target (page) or the browser endpoint. */
export class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(ws, url) {
    this.url = url;
    this.#ws = ws;
    ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  static async connect(wsUrl, { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError(`ws connect timeout: ${wsUrl}`)), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new CdpError(`ws connect failed: ${wsUrl} (${e?.message ?? "error"})`));
      }, { once: true });
    });
    return new CdpConnection(ws, wsUrl);
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        p.reject(new CdpError(msg.error.message || "cdp error", { method: p.method, code: msg.error.code }));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    const subs = this.#listeners.get(msg.method);
    if (subs) for (const fn of subs) { try { fn(msg.params); } catch { /* listener fault */ } }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new CdpError("connection closed", { method: p.method }));
    this.#pending.clear();
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) return Promise.reject(new CdpError("connection closed", { method }));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`cdp timeout: ${method}`, { method }));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve on the first matching event. */
  once(method, { timeoutMs = 30_000, filter } = {}) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new CdpError(`cdp event timeout: ${method}`, { method })); }, timeoutMs);
      const off = this.on(method, (params) => {
        if (filter && !filter(params)) return;
        clearTimeout(t);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch { /* already closing */ }
  }
}

/** Attach to the first page target, creating one when the browser has none. */
export async function attachFirstPage(port, { url = "about:blank" } = {}) {
  const list = await cdpTargets(port);
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (page) {
    const conn = await CdpConnection.connect(page.webSocketDebuggerUrl);
    return { conn, targetId: page.id, created: false };
  }
  const ver = await cdpVersion(port);
  const browser = await CdpConnection.connect(ver.webSocketDebuggerUrl);
  try {
    const { targetId } = await browser.send("Target.createTarget", { url });
    return { conn: browser, targetId, created: true, browserLevel: true };
  } finally {
    // Caller keeps the browser-level connection when it created the target.
  }
}

/** Evaluate an expression in a page and return its JSON value. */
export async function evaluate(conn, expression, { awaitPromise = true } = {}) {
  const res = await conn.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new CdpError(
      res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluate threw",
    );
  }
  return res.result?.value;
}

/** Read cookies for a url pattern via Network.getCookies. */
export async function getCookies(conn, urls = ["https://chatgpt.com/"]) {
  const { cookies } = await conn.send("Network.getCookies", { urls });
  return cookies ?? [];
}

/**
 * Extract the ChatGPT access token by asking the page itself, which keeps the
 * request same-origin and cookie-authenticated.
 */
export async function fetchChatGptSession(conn) {
  return evaluate(
    conn,
    `fetch("/api/auth/session", { credentials: "include" })
       .then(r => r.ok ? r.json() : { __status: r.status })
       .catch(e => ({ __error: String(e) }))`,
  );
}
