/**
 * 凭据存取 —— 把豆包 / GPT 两份登录凭据存进 DSH `credentials` 服务的 record 半。
 *
 * 关键约束（都已实测，改动会直接抛 TypeError）：
 *   - credentialKey(scope, id) 的两段都必须匹配 /^[a-z][a-z0-9-]*$/，
 *     用 "dsh-doubao-image" + "doubao-session" / "gpt-session"。
 *   - payload 必须能无损 JSON 往返：时间戳一律存 ISO 字符串，不存 Date。
 *   - credentials 是可选服务。缺失或半残时本模块**不抛**，只返回可读的降级
 *     状态（读 → undefined，写/删 → {ok:false, reason}），由上层提示用户。
 */

import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

/** key 的两段（scope / id）都必须是小写 kebab。 */
const SCOPE = "dsh-doubao-image";
const KEY_DOUBAO = "doubao-session";
const KEY_GPT = "gpt-session";

/**
 * payload 版本号。凭据结构后续若要改字段，递增它即可让旧记录被识别为
 * 「需要重新登录」而不是当成损坏数据。
 *
 * 1 → 2（2026-10-17）：豆包凭据从「单条」改成「账号数组」。
 * 升级时把 v1 的单账号自动迁移成数组的第 0 项，用户无需重新登录。
 */
const VERSION = 2;

/** v1 豆包凭据的形状，升级时用来判读旧记录。 */
const VERSION_LEGACY = 1;

const REASON_UNAVAILABLE = "credentials-unavailable";

const require_ = createRequire(import.meta.url);

/** DSH 各服务对外都包了一层包装对象，真正的实现挂在 `[Symbol.for("cordis.shadow")]` 上。 */
const SHADOW = Symbol.for("cordis.shadow");

/**
 * 拿到 credentials 的实现对象。
 *
 * 必须用 ctx.get() 而不是 ctx.credentials：
 * cordis 的上下文是 Proxy，服务未注入时属性访问会**直接抛错**
 * （`cannot get property "credentials" without inject`），可选链 `?.` 保护不了它。
 * 这个异常会一路打穿路由 handler，被宿主 webServer 的顶层 catch 变成**空的 400**，
 * 客户端 r.json() 解析失败又被吞掉 —— 表现就是设置页「没有任何反馈」。
 * ctx.get() 才是安全取法：服务未提供时返回 undefined。
 *
 * 拿到包装对象后还要看影子实现：包装对象只暴露少量属性，`readRecord`
 * 这类方法只在 `[Symbol.for("cordis.shadow")]` 上；而影子是 symbol，
 * 浅合并拿不到。两处都没找到就返回 null，让调用方降级。
 */
export function resolveCredentialsService(ctx) {
  let service = null;
  try {
    service = typeof ctx?.get === "function" ? ctx.get("credentials") : ctx?.credentials;
  } catch {
    // 属性访问抛错（未注入 / 上下文未激活）——语义上等同于「没有该服务」。
    return null;
  }
  if (!service) return null;
  /** 包装对象与影子实现都是代理，任何属性访问都可能抛错，一律兜住。 */
  const read = (target) => {
    if (!target) return null;
    try {
      return typeof target.readRecord === "function" &&
        typeof target.modifyRecord === "function" &&
        typeof target.deleteRecord === "function"
        ? target
        : null;
    } catch {
      return null;
    }
  };

  if (read(service)) return service;
  try {
    return read(service[SHADOW]);
  } catch {
    return null;
  }
}

/**
 * 构造凭据 key；本机 DSH 没导出 credentialKey 时退回等价的字面量。
 *
 * 分隔符必须是 `/` —— 宿主实现原文是 `brandString(`${scope}/${id}`)`
 * （`@deepseek-ai/dsh-credentials/lib/index.js` 的 credentialKey）。
 * 曾经这里写成 `:`，结果在 profile 里解析不到 `@deepseek-ai/dsh-credentials`
 * （该包不在 profile 的 node_modules 中）时 fallback 生效，写出畸形 key，
 * **直接导致 credentials 服务启动失败、DSH 崩溃**。见
 * 改动这一行必须同时跑 key 格式断言。
 */
function credentialKey(scope, id) {
  if (!/^[a-z][a-z0-9-]*$/.test(scope) || !/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new TypeError(`credentialKey: 非法段 "${scope}"/"${id}"（只允许小写 kebab）`);
  }
  try {
    const mod = require_("@deepseek-ai/dsh-credentials");
    if (typeof mod?.credentialKey === "function") return mod.credentialKey(scope, id);
  } catch {
    // 未导出该模块时用下面的字面量，格式与宿主一致。
  }
  return `${scope}/${id}`;
}

const KEY_DOUBAO_FULL = credentialKey(SCOPE, KEY_DOUBAO);
const KEY_GPT_FULL = credentialKey(SCOPE, KEY_GPT);

/** 从 record 里取出 payload；结构不对一律当成「没登录」。 */
function payloadOf(recordFromVault) {
  const record = recordFromVault?.value !== undefined ? recordFromVault.value : recordFromVault;
  if (!record || typeof record !== "object") return null;
  if (record.kind !== "grant") return null;
  return record.payload && typeof record.payload === "object" ? record.payload : null;
}

const grant = (payload) => ({ kind: "grant", payload });

const nowIso = () => new Date().toISOString();

/**
 * 从 cookie 里取 `sessionid` —— 它是豆包账号的唯一标识，也是账号去重键。
 *
 * 取不到就返回空串，调用方据此退回随机 id（而不是拼一个假的 sessionid）。
 */
export function sessionIdOf(cookieHeader) {
  const text = String(cookieHeader ?? "");
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== "sessionid") continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

/** 账号 id 不能带凭据内容，用随机串即可（去重靠 sessionIdOf）。 */
function newAccountId() {
  return `acc_${randomBytes(8).toString("hex")}`;
}

/**
 * 把一条账号记录规整成固定形状；缺 cookie 或形状不对返回 null。
 *
 * 只保留已知字段：多余字段（比如未来版本的字段）不进新结构，
 * 避免脏数据在 record 里越滚越大。
 */
function normalizeAccount(input) {
  if (!input || typeof input !== "object") return null;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const cookieHeader = typeof input.cookieHeader === "string" ? input.cookieHeader.trim() : "";
  if (id === "" || cookieHeader === "") return null;
  return {
    id,
    label: typeof input.label === "string" ? input.label : "",
    cookieHeader,
    ...(input.device && typeof input.device === "object" ? { device: input.device } : {}),
    ...(typeof input.msToken === "string" ? { msToken: input.msToken } : {}),
    /*
     * 固定生图会话。只保留纯数字串（豆包会话 id 的真实形状），
     * 其它值一律丢弃 —— 宁可不复用，也不能把可疑串发进请求体。
     */
    ...(typeof input.conversationId === "string" && /^\d{6,}$/.test(input.conversationId.trim())
      ? { conversationId: input.conversationId.trim() }
      : {}),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : nowIso(),
    lastUsedAt: typeof input.lastUsedAt === "string" ? input.lastUsedAt : "",
  };
}

/** 对外暴露账号时**绝不带 cookie 全文**，只给末 4 位让人认出是哪个号。 */
function plainAccount(id, accounts) {
  const account = accounts.find((a) => a.id === id);
  if (!account) return undefined;
  return {
    id: account.id,
    label: account.label,
    createdAt: account.createdAt,
    lastUsedAt: account.lastUsedAt,
    hasDevice: Boolean(account.device),
    hasMsToken: Boolean(account.msToken),
    cookieTail: account.cookieHeader.slice(-4),
  };
}

/** 把任意版本的已存 payload 在内存里转成 v2 形状（不做落盘）。 */
function migrateInMemory(payload) {
  if (!payload) return { version: VERSION, accounts: [], activeId: "" };
  if (payload.version === VERSION && Array.isArray(payload.accounts)) {
    return {
      version: VERSION,
      accounts: payload.accounts.map(normalizeAccount).filter(Boolean),
      activeId: typeof payload.activeId === "string" ? payload.activeId : "",
    };
  }
  if (payload.version === VERSION_LEGACY) {
    const account = normalizeAccount({
      id: newAccountId(),
      cookieHeader: payload.cookieHeader,
      ...(payload.device && typeof payload.device === "object" ? { device: payload.device } : {}),
      ...(typeof payload.msToken === "string" ? { msToken: payload.msToken } : {}),
      createdAt: typeof payload.updatedAt === "string" ? payload.updatedAt : nowIso(),
    });
    return account
      ? { version: VERSION, accounts: [account], activeId: account.id }
      : { version: VERSION, accounts: [], activeId: "" };
  }
  return { version: VERSION, accounts: [], activeId: "" };
}

/** 把账号池复原成 v1 形状（兼容改回旧版的场景），没有账号时返回 undefined。 */
function toLegacySingle(accounts, activeId) {
  const account = accounts.find((a) => a.id === activeId) ?? accounts[0];
  if (!account) return undefined;
  return { version: VERSION_LEGACY, cookieHeader: account.cookieHeader, ...(account.device ? { device: account.device } : {}), ...(typeof account.msToken === "string" ? { msToken: account.msToken } : {}), updatedAt: nowIso() };
}

/**
 * 建一个会话存取器。
 *
 * @param {{credentials?: object}} ctx 插件上下文（只用到 credentials）
 * @returns {{
 *   available: () => boolean,
 *   readDoubao: () => Promise<object|undefined>,
 *   writeDoubao: (patch: object) => Promise<{ok:boolean, reason?:string}>,
 *   clearDoubao: () => Promise<{ok:boolean, reason?:string}>,
 *   readGpt: () => Promise<object|undefined>,
 *   writeGpt: (patch: object) => Promise<{ok:boolean, reason?:string}>,
 *   clearGpt: () => Promise<{ok:boolean, reason?:string}>
 * }}
 */
export function createSessionStore(ctx) {
  const unavailable = () => ({ ok: false, reason: REASON_UNAVAILABLE });

  const read = async (key) => {
    const credentials = resolveCredentialsService(ctx);
    if (!credentials) return undefined;
    let record;
    try {
      record = await credentials.readRecord(key);
    } catch {
      // 宿主可能因凭据不可解密而抛错；语义上等同于「没有可用凭据」。
      return undefined;
    }
    const payload = payloadOf(record);
    if (!payload || payload.version !== VERSION) return undefined;
    return payload;
  };

  /**
   * 读豆包记录，并把 v1 的单账号就地升级成 v2 的账号数组。
   *
   * 迁移只在**读到旧记录**时发生一次，之后写回的就是 v2。
   * 迁移放在读路径而不是写路径：用户升级插件后第一次打开设置页就该看到
   * 自己那个账号还在，而不是先看到「未登录」再被迫重登。
   */
  const readDoubaoMigrated = async () => {
    const credentials = resolveCredentialsService(ctx);
    if (!credentials) return undefined;
    let record;
    try {
      record = await credentials.readRecord(KEY_DOUBAO_FULL);
    } catch {
      return undefined;
    }
    const payload = payloadOf(record);
    if (!payload) return undefined;

    if (payload.version === VERSION && Array.isArray(payload.accounts)) {
      const accounts = payload.accounts.map(normalizeAccount).filter(Boolean);
      // 一个账号都不剩 = 没登录；返回空壳会让上层「已登录但用不了」。
      if (accounts.length === 0) return undefined;
      return { ...payload, accounts };
    }
    if (payload.version !== VERSION_LEGACY) return undefined;

    const migrated = migrateInMemory(payload);
    // 旧记录里没 cookie 时没有可迁移的东西，按「未登录」处理。
    if (migrated.accounts.length === 0) return undefined;
    try {
      const next = { ...migrated, updatedAt: nowIso() };
      await credentials.modifyRecord(KEY_DOUBAO_FULL, () => grant(next));
      return next;
    } catch {
      // 写不回去也不能让用户「凭空丢号」：内存里照常返回迁移结果。
      return migrated;
    }
  };

  /**
   * 对豆包记录做读-改-写，决策全程在锁内。
   *
   * `mutator(accounts, activeId)` 返回 `{accounts, activeId}`（新数组，别就地改）。
   * 锁外读锁内写会有并发覆盖：两个标签页同时保存账号时，后写的会吞掉先写的。
   */
  const mutateDoubao = async (mutator) => {
    const credentials = resolveCredentialsService(ctx);
    if (!credentials) return unavailable();
    let outcome = { ok: true };
    try {
      await credentials.modifyRecord(KEY_DOUBAO_FULL, (current) => {
        const base = migrateInMemory(payloadOf(current));
        const result = mutator(base.accounts, base.activeId);
        const accounts = Array.isArray(result?.accounts) ? result.accounts : base.accounts;
        let activeId = typeof result?.activeId === "string" ? result.activeId : base.activeId;
        // 指到不存在的账号等于「没有当前账号」，会被当作未登录，所以兜一层。
        if (activeId && !accounts.some((a) => a.id === activeId)) activeId = accounts[0]?.id ?? "";
        if (!activeId && accounts.length > 0) activeId = accounts[0].id;
        outcome = result?.outcome && typeof result.outcome === "object" ? result.outcome : outcome;
        return grant({ version: VERSION, accounts, activeId, updatedAt: nowIso() });
      });
      return outcome;
    } catch (error) {
      return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  /** 读-改-写：决策放在锁内，避免扫码保存与手工粘贴互相覆盖。 */
  const write = async (key, patch) => {
    const credentials = resolveCredentialsService(ctx);
    if (!credentials) return unavailable();
    try {
      await credentials.modifyRecord(key, (current) => {
        const base = payloadOf(current) ?? {};
        const next = { ...base, ...patch, version: VERSION, updatedAt: nowIso() };
        return grant(next);
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "write-failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const clear = async (key) => {
    const credentials = resolveCredentialsService(ctx);
    if (!credentials) return unavailable();
    try {
      await credentials.deleteRecord(key);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "delete-failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    available: () => resolveCredentialsService(ctx) !== null,

    /*
     * 豆包账号池。
     *
     * 返回 `{version, accounts, activeId}`；accounts 是数组，每项
     * `{id, label, cookieHeader, device?, msToken?, createdAt, lastUsedAt}`。
     * 没登录时返回 undefined（与改动前语义一致）。
     */
    readDoubao: () => readDoubaoMigrated(),

    /**
     * 新增或按账号更新一条豆包凭据。
     *
     * 认的是 `sessionid`：同一个账号重复登录只会更新那一条，不会长出重复项——
     * 用户点两次「登录」不该变成两个账号轮流消耗同一份额度。
     *
     * @param {{cookieHeader: string, device?: object, msToken?: string, label?: string}} input
     * @returns {Promise<{ok: boolean, account?: object, created?: boolean, reason?: string}>}
     */
    upsertDoubaoAccount: ({ cookieHeader, device, msToken, label }) => mutateDoubao((accounts, activeId) => {
      const cookie = String(cookieHeader ?? "").trim();
      const sessionId = sessionIdOf(cookie);
      const existing = sessionId === "" ? undefined : accounts.find((a) => a.id === sessionId);
      const patch = {
        ...(typeof label === "string" && label.trim() !== "" ? { label: label.trim() } : {}),
        ...(cookie !== "" ? { cookieHeader: cookie } : {}),
        /*
         * `device` / `msToken` 都是可选的。
         *
         * `device`：记录「这份 cookie 对应哪个浏览器设备」（fp 等）。
         * `msToken`：登录时从页面实时抓到的签名参数。实测它在多次请求间逐字相同
         * （a_bogus 则每次都变），所以可以存下来复用；抓不到就存空串，表示不发——
         * 空是安全的，自造一个假的反而会被服务端判成异常请求。
         */
        ...(device && typeof device === "object" ? { device } : {}),
        ...(typeof msToken === "string" ? { msToken } : {}),
      };
      if (existing) {
        const next = accounts.map((a) => (a.id === existing.id ? normalizeAccount({ ...a, ...patch }) : a));
        return { accounts: next, activeId: activeId || existing.id, outcome: { ok: true, created: false, account: plainAccount(existing.id, next) } };
      }
      const account = normalizeAccount({
        id: sessionId || newAccountId(),
        ...patch,
        createdAt: nowIso(),
        lastUsedAt: "",
      });
      if (!account) return { accounts, activeId };
      const next = [...accounts, account];
      // 新加的账号立刻设为当前账号：用户刚登录完，下一步多半就是想用它。
      return { accounts: next, activeId: account.id, outcome: { ok: true, created: true, account: plainAccount(account.id, next) } };
    }),

    /** 切换当前账号。id 不存在时不动，返回 ok:false。 */
    setActiveDoubaoAccount: (id) => mutateDoubao((accounts) => {
      const target = String(id ?? "");
      if (!accounts.some((a) => a.id === target)) {
        return { accounts, outcome: { ok: false, reason: "account-not-found" } };
      }
      return { accounts, activeId: target };
    }),

    removeDoubaoAccount: (id) => mutateDoubao((accounts, activeId) => {
      const target = String(id ?? "");
      const next = accounts.filter((a) => a.id !== target);
      if (next.length === accounts.length) return { accounts, outcome: { ok: false, reason: "account-not-found" } };
      return { accounts: next, activeId: activeId === target ? (next[0]?.id ?? "") : activeId };
    }),

    /** 重命名账号（仅用于区分「自己的号 / 小号」）。空 label 表示清除备注。 */
    renameDoubaoAccount: (id, label) => mutateDoubao((accounts) => {
      const target = String(id ?? "");
      const text = String(label ?? "").trim();
      const next = accounts.map((a) => (a.id === target ? { ...a, label: text } : a));
      if (!accounts.some((a) => a.id === target)) return { accounts, outcome: { ok: false, reason: "account-not-found" } };
      return { accounts: next, activeId: undefined };
    }),

    /** 记录某账号刚刚被用过（轮换时写回，供设置页显示顺序依据）。 */
    touchDoubaoAccount: (id) => mutateDoubao((accounts) => {
      const target = String(id ?? "");
      const next = accounts.map((a) => (a.id === target ? { ...a, lastUsedAt: nowIso() } : a));
      return { accounts: next, activeId: undefined };
    }),

    /**
     * 记住某账号的「固定生图会话」。
     *
     * 生图默认每次新建会话，用久了账号里会堆一堆测试会话。把服务端分配的会话 id
     * 记下来、下次复用，账号里就只留 1 个生图会话 —— 不必删任何东西
     * （删除本身还会在服务端留下操作记录）。
     *
     * **值没变时返回 `changed: false`**：`mutateDoubao` 是读-改-写，
     * 底层总会走一次 `modifyRecord`，所以「不碰存储」在这里做不到；
     * 调用方（index.js 的 `rememberDoubaoConversation`）会先读一次比对，
     * 值没变就根本不调本方法，那才是真正省掉写盘的地方。
     *
     * @param {string} id 账号 id
     * @param {string} conversationId 服务端会话 id；空串表示清除记录
     * @returns {Promise<{ok: boolean, changed?: boolean, reason?: string}>}
     */
    setDoubaoConversationId: (id, conversationId) => mutateDoubao((accounts) => {
      const target = String(id ?? "");
      const next = String(conversationId ?? "").trim();
      const found = accounts.find((a) => a.id === target);
      if (!found) return { accounts, outcome: { ok: false, reason: "account-not-found" } };
      if ((found.conversationId ?? "") === next) {
        return { accounts, activeId: undefined, outcome: { ok: true, changed: false } };
      }
      const updated = accounts.map((a) => (a.id === target
        ? normalizeAccount({ ...a, conversationId: next })
        : a));
      return { accounts: updated, activeId: undefined, outcome: { ok: true, changed: true } };
    }),

    clearDoubao: () => clear(KEY_DOUBAO_FULL),

    readGpt: () => read(KEY_GPT_FULL),
    writeGpt: ({ accessToken, cookieHeader, oaiDeviceId }) => write(KEY_GPT_FULL, {
      accessToken: String(accessToken ?? ""),
      cookieHeader: String(cookieHeader ?? ""),
      oaiDeviceId: String(oaiDeviceId ?? ""),
    }),
    clearGpt: () => clear(KEY_GPT_FULL),
  };
}

export const __internals = { credentialKey, KEY_DOUBAO_FULL, KEY_GPT_FULL, VERSION, VERSION_LEGACY, sessionIdOf, normalizeAccount, migrateInMemory, toLegacySingle };
