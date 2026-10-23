/**
 * dsh-doubao-image —— 浏览器半（免构建 ModuleLoader bundle）。
 *
 * 只做两件事：
 *   1. `plugins.bundle.config` 里的设置页：豆包扫码登录、GPT 免费账户登录、
 *      通用配置、以及自建 IndexedDB 画廊。
 *   2. 把画廊持久层（client/gallery.js）接到页面上。
 *
 * 不写聊天渲染器：聊天里的图由内置 `dsh-client-ui-attachment` 的
 * `tool.call.images` slot 负责，Host 侧 render() 返回 {type:"image",attachment}
 * 就会自动显示。
 *
 * 免构建约束：不用 JSX，不 import 任何第三方包，只用 require("react")。
 */
window.__ModuleLoader__.load({
  id: "dsh-doubao-image-free",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    /* ── 画廊持久层（内联，勿拆成独立文件） ────────────────────────────
     * 必须是单文件：DSH 只加载 exports["./client"] 指向的那一个文件，本机
     * 21 个已装插件的 client 半全部是单文件。若把画廊放进 client/gallery.js
     * 等浏览器自己去加载，它永远不会被加载，本模块只能拿到一个空全局。
     */
    var gallery = (function () {
    "use strict";

    /** 独立 DB 名，绝不能与 dsh-image-gen 的 dsh_image_gen_db 相同。 */
    var DB_NAME = "dsh_doubao_image_db";
    /*
     * v2 新增 `favorite_prompts`（收藏提示词）。
     *
     * `onupgradeneeded` 里每个 store 都先 `contains` 再建，所以升版本**不会**
     * 重建 `gallery_history` / `gallery_tombstones`——IndexedDB 的升级只跑
     * 这里写明的迁移分支，既有的图库数据原样保留。
     */
    var DB_VERSION = 2;
    var STORE_ITEMS = "gallery_history";
    var STORE_TOMBSTONES = "gallery_tombstones";
    var STORE_PROMPTS = "favorite_prompts";

    /** 宿主图片字节路由。默认空 = 宿主未提供，画廊据此提示而不是发瞎请求。 */
    var HOST_IMAGE_ROUTE = "";

    /**
     * 画廊持久化路由（服务端）。
     *
     * 存在的理由：IndexedDB 按 origin 隔离，而 origin 含端口。DSH web 每次
     * 启动端口可能不同，换一次端口就是一个全新的空库 —— 工作区没变、图也
     * 没删，画廊却空了。所以权威副本放服务端，本地 IndexedDB 降级成缓存。
     */
    var GALLERY_ROUTE = "/plugins/dsh-doubao-image-free/api/gallery";

    var dbPromise = null;

    /** 变化订阅者。只在写成功后通知。 */
    var listeners = new Set();

    function notify() {
      listeners.forEach(function (fn) {
        try {
          fn();
        } catch {
          // 单个订阅者出错不能影响其它订阅者与写入结果。
        }
      });
    }

    function subscribe(listener) {
      if (typeof listener !== "function") return function () {};
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    /** 取宿主图片路由；宿主补上取图路由后由 client.js 注入。 */
    function galleryImageRoute() {
      return HOST_IMAGE_ROUTE;
    }

    /** 由 client.js 在 apply 时注入（值来自宿主契约，不在这里臆造）。 */
    function setGalleryImageRoute(route) {
      HOST_IMAGE_ROUTE = typeof route === "string" ? route : "";
    }

    /** 有没有 IndexedDB 可用；不可用时所有 API 静默降级。 */
    function available() {
      return typeof indexedDB !== "undefined" && indexedDB !== null;
    }

    // ── 服务端同步层 ──────────────────────────────────────────────
    //
    // 这一层**不改动** IndexedDB 的任何内部逻辑，只在外面包一层。那部分有
    // 一百多条测试覆盖，重写风险远大于收益。
    //
    // 策略：
    //   - 读：服务端优先，本地缓存兜底（离线仍能看图）。
    //   - 写：先写服务端；服务端失败时本地照写，不让用户的操作当场丢掉。
    //   - 服务端可用时顺手把数据刷进本地缓存，换端口打开也能立刻有图。

    /** 服务端不可用的统一返回值。与「服务端说没有数据」是两回事。 */
    var SERVER_DOWN = { ok: false, reason: "server-unavailable" };

    /** 最近一次服务端调用是否成功。供设置页显示同步状态。 */
    var serverHealthy = null;

    /**
     * 调服务端。
     *
     * 任何异常（网络断、路由 404、JSON 解析失败）都归一成 SERVER_DOWN，
     * 调用方据此降级——绝不让画廊因为服务端不可用而整块消失。
     */
    async function callServer(method, query, body) {
      try {
        var url = GALLERY_ROUTE + (query ? "?" + query : "");
        var init = { method: method, credentials: "same-origin" };
        if (body !== undefined) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        var response = await fetch(url, init);
        if (!response.ok) {
          serverHealthy = false;
          return SERVER_DOWN;
        }
        var parsed = await response.json();
        if (!parsed || typeof parsed !== "object") {
          serverHealthy = false;
          return SERVER_DOWN;
        }
        serverHealthy = true;
        return parsed;
      } catch {
        serverHealthy = false;
        return SERVER_DOWN;
      }
    }

    /** 把一批记录写进本地缓存。失败不影响调用方返回值——缓存只是加速。 */
    async function seedLocalCache(items) {
      if (!Array.isArray(items) || items.length === 0) return;
      if (!available()) return;
      try {
        var db = await openDb();
        if (db === null) return;
        await runTransaction(db, [STORE_ITEMS], "readwrite", function (tx) {
          var store = tx.objectStore(STORE_ITEMS);
          items.forEach(function (item) {
            if (item && typeof item.id === "string" && item.id !== "") store.put(item);
          });
        });
      } catch {
        // 缓存写不进去不算失败。
      }
    }

    // ── attachment ref 校验（与 dsh-image-gen 的 parseImageAttachmentRef 同构） ──

    var IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

    /**
     * 视频条目的类型标记。
     *
     * **为什么必须显式标，不能靠 `mediaType` 前缀猜**：Host 的 `saveFile`
     * 契约（`index.js` 的 `FILE_REF_SCHEMA`）只回 `attachmentId` / `name` /
     * `bytes` —— 视频引用里**根本没有 `mediaType` 字段**。拿不到 mediaType
     * 就只能靠写入方在记录上打这个标记，读取端才分得清图片和视频。
     */
    var VIDEO_KIND = "video";

    function isNonEmptyString(v) {
      return typeof v === "string" && v.length > 0;
    }

    function isNonNegativeInteger(v) {
      return typeof v === "number" && Number.isInteger(v) && v >= 0;
    }

    function isPositiveInteger(v) {
      return typeof v === "number" && Number.isInteger(v) && v > 0;
    }

    /**
     * 校验并归一化一个 attachment 引用。
     *
     * 返回归一化对象或 null。守卫的存在意义：坏 ref 直接入库会让画廊在渲染时
     * 才炸，且会污染 attachmentId 主键（同一张图两个 key）。宁可在这里丢。
     *
     * 支持两种形态，靠 `kind` 显式区分（不猜 `mediaType` 前缀——视频引用里
     * 没有那个字段，见 `VIDEO_KIND` 的注释）：
     *
     * - 图片：`attachmentId` / `mediaType` / `bytes` / `width` / `height`
     *   （Host `ImageAttachmentRef`）
     * - 视频：`attachmentId` / `name` / `bytes`（Host `FileAttachmentRef`）
     *
     * 视频**不做像素尺寸校验**：视频的宽高要 ffprobe 才知道，Host 不提供，
     * 插件也不该为了存一条画廊记录去解析容器。
     */
    function parseAttachmentRef(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      if (!isNonEmptyString(value.attachmentId)) return null;
      if (value.kind === VIDEO_KIND) {
        // 文件引用。`name` 是 Host 的必填字段（存的就是这个叶子名），
        // 缺了说明这不是一个合法的 FileAttachmentRef。
        if (!isNonEmptyString(value.name)) return null;
        if (!isNonNegativeInteger(value.bytes)) return null;
        return {
          attachmentId: value.attachmentId,
          name: value.name,
          bytes: value.bytes,
          kind: VIDEO_KIND,
        };
      }
      if (IMAGE_MEDIA_TYPES.indexOf(value.mediaType) === -1) return null;
      if (!isNonNegativeInteger(value.bytes)) return null;
      if (!isPositiveInteger(value.width) || !isPositiveInteger(value.height)) return null;
      if (value.name !== undefined && typeof value.name !== "string") return null;
      var out = {
        attachmentId: value.attachmentId,
        mediaType: value.mediaType,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
      };
      if (typeof value.name === "string") out.name = value.name;
      return out;
    }

    /**
     * 从「当前会话/工作区」推导出要随画廊记录一起存的工作区字段。
     *
     * **为什么必须有这个函数**：`isItemInWorkspace` 早就写好了四条判据，但
     * 历史版本的**所有五个写入点都没写工作区字段**（工具结果卡、导入、
     * 工作台文生图/图生图、工作台内部存图），于是 `collectWorkspaces` 永远
     * 收不到任何 `workspacePath`，画廊的「工作区」下拉里只剩「全部工作区」。
     *
     * `cwd` 的权威来源是宿主 slot 的 owner props：`ToolCallCommonProps.cwd`
     * 与 `ChatNodeOwnerProps.cwd` 的注释都是「Session workspace root」。它可能
     * 缺席（老宿主 / 非工作区会话），所以两个字段都按「空即不写」处理——
     * **绝不写空串**：空串会被 `collectWorkspaces` 过滤掉，看起来和没写一样，
     * 但会误导后续排查（以为写入端已经接了工作区）。
     *
     * @returns {{workspacePath?: string, sessionId?: string}} 可直接 Object.assign 进记录
     */
    function workspaceFieldsFrom(cwd, sessionId) {
      var out = {};
      if (isNonEmptyString(cwd)) out.workspacePath = cwd;
      if (isNonEmptyString(sessionId)) out.sessionId = sessionId;
      return out;
    }

    /**
     * 这条画廊记录是不是视频。
     *
     * 两处都看，是因为历史与未来的写入路径可能只给其中一处：
     * `record.kind` 由 `saveGalleryItem` 写；`attachment.kind` 由
     * `parseAttachmentRef` 归一化后写进引用里。任何一处命中都算视频，
     * 免得「存的时候标了、读的时候没标」这种半截状态让视频混进图库。
     */
    function isVideoItem(item) {
      if (item === null || typeof item !== "object") return false;
      if (item.kind === VIDEO_KIND) return true;
      var att = item.attachment;
      return att !== null && typeof att === "object" && att.kind === VIDEO_KIND;
    }

    /**
     * 从 `SessionSnapshot` 形状的列表里取出某个会话的 `cwd`。
     *
     * **纯函数，不是 hook** —— 这是刻意的：`tool.call.toolview` 与
     * `conversation.chat.node` 的 ownerProps 已经直接带 `cwd`
     * （`ToolCallCommonProps.cwd` / `ChatNodeOwnerProps.cwd`，注释都是
     * 「Session workspace root」），只有 `conversation.view`（画廊所在槽）
     * 的 ownerProps 没有 `cwd`，需要自己从 `useSessions` 里查
     * （官方写法见 `dsh-client-ui-tool/lib/client.js:2434`）。
     *
     * 把「查表」做成纯函数，是为了让 hook 调用点收敛到**唯一一处**
     * （画廊容器的顶层）。在结果卡里按需调 hook 会导致 hook 次数随
     * props 形状变化 —— 那是 React 会直接抛错的违规。
     */
    function pickSessionCwd(list, sessionId) {
      if (!isNonEmptyString(sessionId)) return "";
      if (list === null || typeof list !== "object") return "";
      var byId = list.byId;
      if (byId === null || typeof byId !== "object") return "";
      var entry = byId[sessionId];
      if (entry === null || typeof entry !== "object") return "";
      return isNonEmptyString(entry.cwd) ? entry.cwd : "";
    }

    /** 工作区路径归一化：统一小写、正斜杠、去尾斜杠，便于跨平台比较。 */
    function normalizeWorkspacePath(rawPath) {
      if (typeof rawPath !== "string") return "";
      var p = rawPath.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
      if (p.length > 1) p = p.replace(/\/+$/, "");
      return p.toLowerCase();
    }

    /**
     * 这条记录属不属于给定工作区。
     *
     * 命中任一即算：workspaceId 相同、sessionId 在集合里、workspacePath 归一化后
     * 相同、或已落盘文件在该工作区路径前缀下。
     *
     * 工作区没有任何判据时**不需要**额外的短路分支：四个比较项各自都要求判据
     * 非空（isNonEmptyString / `!== ""` / length），空工作区自然一条都命中不了。
     * 曾写过 `if (!hasCriterion) return false`，变异测试证明它与去掉后行为完全
     * 一致——是死代码，故删除。
     */
    function isItemInWorkspace(item, workspace) {
      if (!item || typeof item !== "object") return false;
      if (!workspace || typeof workspace !== "object") return false;
      var wsId = workspace.workspaceId;
      var wsPath = normalizeWorkspacePath(workspace.path);
      var sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];

      if (isNonEmptyString(wsId) && item.workspaceId === wsId) return true;
      if (isNonEmptyString(item.sessionId) && sessionIds.indexOf(item.sessionId) !== -1) return true;
      if (wsPath !== "" && normalizeWorkspacePath(item.workspacePath) === wsPath) return true;
      if (wsPath !== "" && typeof item.savedTo === "string" && item.savedTo !== "") {
        var saved = normalizeWorkspacePath(item.savedTo);
        if (saved.indexOf(wsPath + "/") === 0) return true;
      }
      return false;
    }

    /** 打开数据库（含升级建表）。失败一律 resolve(null)，调用方降级。 */
    function openDb() {
      if (!available()) return Promise.resolve(null);
      if (dbPromise !== null) return dbPromise;

      dbPromise = new Promise(function (resolve) {
        var request;
        try {
          request = indexedDB.open(DB_NAME, DB_VERSION);
        } catch {
          resolve(null);
          return;
        }
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORE_ITEMS)) {
            var items = db.createObjectStore(STORE_ITEMS, { keyPath: "id" });
            items.createIndex("createdAt", "createdAt", { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_TOMBSTONES)) {
            db.createObjectStore(STORE_TOMBSTONES, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(STORE_PROMPTS)) {
            var prompts = db.createObjectStore(STORE_PROMPTS, { keyPath: "id" });
            prompts.createIndex("createdAt", "createdAt", { unique: false });
          }
        };
        request.onsuccess = function () {
          var db = request.result;
          // 别的标签页要升级时必须让它拿到锁，否则它会一直 blocked。
          db.onversionchange = function () {
            try {
              db.close();
            } catch {
              // 已关闭。
            }
            dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = function () {
          dbPromise = null;
          resolve(null);
        };
        request.onblocked = function () {
          resolve(null);
        };
      });
      return dbPromise;
    }

    /** 跑一个事务；Promise 在 transaction.oncomplete 时兑现。 */
    function runTransaction(db, stores, mode, work) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(stores, mode);
        } catch (error) {
          reject(error);
          return;
        }
        var result;
        tx.oncomplete = function () {
          resolve(result);
        };
        tx.onerror = function () {
          reject(tx.error ?? new Error("indexeddb-transaction-failed"));
        };
        tx.onabort = function () {
          reject(tx.error ?? new Error("indexeddb-transaction-aborted"));
        };
        try {
          work(tx, function (value) {
            result = value;
          });
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // 已中止。
          }
          reject(error);
        }
      });
    }

    /** 单次请求包成 Promise。 */
    function requestAsPromise(request) {
      return new Promise(function (resolve, reject) {
        request.onsuccess = function () {
          resolve(request.result);
        };
        request.onerror = function () {
          reject(request.error ?? new Error("indexeddb-request-failed"));
        };
      });
    }

    /**
     * 保存或更新一条画廊记录（按 attachmentId 去重）。
     *
     * @returns {Promise<boolean>} 是否真的落库。false = 被墓碑挡掉、ref 非法、
     *   或 IndexedDB 不可用——调用方据此决定要不要提示用户。
     */
    async function saveGalleryItem(item) {
      try {
        if (!item || typeof item !== "object") return false;
        /*
         * 视频条目：调用方传的是 Host `saveFile` 的原始返回
         * （`attachmentId` / `name` / `bytes`，没有 `kind`），类型信息在
         * `item.kind` 上。这里把 kind 合并进去再交给解析器，而不是要求
         * 每个调用点自己记得给 attachment 打标——写入点有五个，漏一个
         * 就是一条永远显示不出来的记录。
         */
        var kind = item.kind === VIDEO_KIND ? VIDEO_KIND : "";
        var rawRef = kind === VIDEO_KIND
          ? Object.assign({}, item.attachment, { kind: VIDEO_KIND })
          : item.attachment;
        var ref = parseAttachmentRef(rawRef);
        if (ref === null) return false;
        var id = ref.attachmentId;

        var db = await openDb();
        if (db === null) return false;

        var createdAt = typeof item.createdAt === "number" && isFinite(item.createdAt) ? item.createdAt : Date.now();

        var record = {
          id: id,
          attachment: ref,
          prompt: typeof item.prompt === "string" ? item.prompt : "",
          provider: typeof item.provider === "string" ? item.provider : "",
          model: typeof item.model === "string" ? item.model : "",
          createdAt: createdAt,
        };
        // 记录级类型标记：画廊按它分「图库 / 视频」两栏。图片不写（历史记录
        // 都没有这个字段，缺省即图片），只有视频才写，保持老数据零迁移。
        if (kind === VIDEO_KIND) record.kind = VIDEO_KIND;
        // 保留原有收藏/标签/原始时间：重扫同一张图不能把用户的状态冲掉。
        var optional = ["aspectRatio", "imageSize", "output", "savedTo", "workspacePath", "workspaceId", "sessionId"];
        optional.forEach(function (key) {
          if (typeof item[key] === "string" && item[key] !== "") record[key] = item[key];
        });
        if (typeof item.seed === "number") record.seed = item.seed;
        if (Array.isArray(item.tags)) record.tags = item.tags.slice();
        if (Array.isArray(item.sourceAttachmentIds)) record.sourceAttachmentIds = item.sourceAttachmentIds.slice();

        var persisted = await runTransaction(db, [STORE_ITEMS, STORE_TOMBSTONES], "readwrite", function (tx, setResult) {
          var tombstones = tx.objectStore(STORE_TOMBSTONES);
          var items = tx.objectStore(STORE_ITEMS);

          var tombstoneRequest = tombstones.get(id);
          tombstoneRequest.onsuccess = function () {
            // 墓碑命中 → 用户删过它，这次「复活」被静默丢弃。
            //
            // 返回 true 而不是 false：调用方（重新扫描旧聊天时的回填）把 false 当
            // 「写入失败，请重试」来提示用户，可这里根本不是失败——是用户要的结果
            // 已经生效了。返回 false 会让他反复看到一条无法消除的报错。
            if (tombstoneRequest.result !== undefined) {
              setResult(true);
              return;
            }
            var existingRequest = items.get(id);
            existingRequest.onsuccess = function () {
              var existing = existingRequest.result;
              if (existing !== undefined && existing !== null) {
                record.createdAt = typeof existing.createdAt === "number" ? existing.createdAt : createdAt;
                if (existing.isFavorite !== undefined) record.isFavorite = existing.isFavorite;
                if (Array.isArray(existing.tags)) record.tags = existing.tags;
              }
              items.put(record);
              setResult(true);
            };
          };
        });

        if (persisted) notify();
        // 服务端同步：整条记录提交，服务端自己按 id 去重并保留收藏状态。
        if (persisted) {
          callServer("POST", "", { item: record }).catch(function () {});
        }
        return persisted === true;
      } catch {
        return false;
      }
    }

    /**
     * 读全部记录（服务端优先，本地缓存兜底）。
     *
     * 服务端可用时**以服务端为准**，并顺手把数据刷进本地缓存 —— 这样换
     * 端口打开时，本地空库会被服务端数据填满，用户不会看到「画廊空了」。
     *
     * 服务端不可用时回落到 IndexedDB：离线、插件旧版、路由未注册都走这条。
     */
    async function getGalleryItems() {
      var remote = await callServer("GET");
      if (remote.ok === true && Array.isArray(remote.items)) {
        await seedLocalCache(remote.items);
        return remote.items.slice().sort(function (a, b) {
          return (b.createdAt ?? 0) - (a.createdAt ?? 0);
        });
      }

      try {
        var db = await openDb();
        if (db === null) return [];

        return await runTransaction(db, [STORE_ITEMS], "readonly", function (tx, setResult) {
          var out = [];
          var index = tx.objectStore(STORE_ITEMS).index("createdAt");
          var cursorRequest = index.openCursor(null, "prev");
          cursorRequest.onsuccess = function () {
            var cursor = cursorRequest.result;
            if (cursor === null || cursor === undefined) {
              setResult(out);
              return;
            }
            out.push(cursor.value);
            cursor.continue();
          };
          // 让 setResult 先于 oncomplete 拿到数组。
          setResult(out);
        });
      } catch {
        return [];
      }
    }

    /** 切换收藏状态，返回新状态。记录不存在时返回 false。 */
    async function toggleFavoriteGalleryItem(id) {
      try {
        if (!isNonEmptyString(id)) return false;
        var db = await openDb();
        if (db === null) return false;

        var next = await runTransaction(db, [STORE_ITEMS], "readwrite", function (tx, setResult) {
          var items = tx.objectStore(STORE_ITEMS);
          var getRequest = items.get(id);
          getRequest.onsuccess = function () {
            var record = getRequest.result;
            if (record === undefined || record === null) {
              setResult(false);
              return;
            }
            record.isFavorite = record.isFavorite !== true;
            items.put(record);
            setResult(record.isFavorite);
          };
        });

        if (next === true || next === false) notify();
        // 服务端同步：失败不影响本地结果，用户的操作已经生效。
        if (next === true || next === false) {
          callServer("PATCH", "", { action: "favorite", id: id, isFavorite: next }).catch(function () {});
        }
        return next === true;
      } catch {
        return false;
      }
    }

    /**
     * 提示词收藏。与图片收藏分开存：提示词是纯文本、没有 attachment，
     * 混进 `gallery_history` 会让后者所有「必须有 attachment」的判据失效。
     *
     * id 用归一化后的提示词文本——同一段提示词反复收藏不会产生多条记录。
     */
    /**
     * 提示词 id 的归一化。
     *
     * 必须先判类型再 String()：`String(null)` 是 "null"、`String(undefined)`
     * 是 "undefined"，直接 trim 会把它们当成合法提示词存进库（实测踩过）。
     */
    function promptKey(text) {
      if (typeof text !== "string") return "";
      return text.trim();
    }

    /** 收藏一条提示词。已收藏则原样返回 true（幂等，不刷新 createdAt）。 */
    async function addFavoritePrompt(text) {
      try {
        var id = promptKey(text);
        if (id === "") return false;
        var db = await openDb();
        if (db === null) return false;

        var created = await runTransaction(db, [STORE_PROMPTS], "readwrite", function (tx, setResult) {
          var store = tx.objectStore(STORE_PROMPTS);
          var getRequest = store.get(id);
          getRequest.onsuccess = function () {
            var existing = getRequest.result;
            if (existing !== undefined && existing !== null) {
              setResult(false);
              return;
            }
            store.put({ id: id, text: id, createdAt: Date.now() });
            setResult(true);
          };
        });

        if (created === true) notify();
        return true;
      } catch {
        return false;
      }
    }

    /** 取消收藏一条提示词。未收藏时返回 false。 */
    async function removeFavoritePrompt(text) {
      try {
        var id = promptKey(text);
        if (id === "") return false;
        var db = await openDb();
        if (db === null) return false;

        var existed = await runTransaction(db, [STORE_PROMPTS], "readwrite", function (tx, setResult) {
          var store = tx.objectStore(STORE_PROMPTS);
          var getRequest = store.get(id);
          getRequest.onsuccess = function () {
            if (getRequest.result === undefined || getRequest.result === null) {
              setResult(false);
              return;
            }
            store.delete(id);
            setResult(true);
          };
        });

        if (existed === true) notify();
        return existed === true;
      } catch {
        return false;
      }
    }

    /**
     * 切换收藏状态。
     *
     * @returns {Promise<boolean>} **切换后的状态**——新收藏 true、取消 false。
     *   注意这与 `addFavoritePrompt` / `removeFavoritePrompt` 的返回值语义不同：
     *   那两个返回「本次操作是否生效」，这里返回「操作完的状态」。直接把
     *   `removeFavoritePrompt` 的结果透出去会得到 true，与契约相反。
     */
    async function toggleFavoritePrompt(text) {
      var id = promptKey(text);
      if (id === "") return false;
      var items = await getFavoritePrompts();
      var on = items.some(function (item) { return item.id === id; });
      if (on) {
        await removeFavoritePrompt(id);
        return false;
      }
      await addFavoritePrompt(id);
      return true;
    }

    /** 列出收藏的提示词，最新的在前。与 `getGalleryItems` 同法：索引游标倒序。 */
    async function getFavoritePrompts() {
      try {
        var db = await openDb();
        if (db === null) return [];

        return await runTransaction(db, [STORE_PROMPTS], "readonly", function (tx, setResult) {
          var out = [];
          var index = tx.objectStore(STORE_PROMPTS).index("createdAt");
          var cursorRequest = index.openCursor(null, "prev");
          cursorRequest.onsuccess = function () {
            var cursor = cursorRequest.result;
            if (cursor === null || cursor === undefined) {
              setResult(out);
              return;
            }
            out.push(cursor.value);
            cursor.continue();
          };
          setResult(out);
        });
      } catch {
        return [];
      }
    }

    /**
     * 单删：同一事务里 delete + put 墓碑。
     *
     * 两件事必须原子——先删后写墓碑之间若失败，下次扫描就会把这张图复活。
     */
    async function deleteGalleryItem(id) {
      try {
        if (!isNonEmptyString(id)) return false;
        var db = await openDb();
        if (db === null) return false;

        await runTransaction(db, [STORE_ITEMS, STORE_TOMBSTONES], "readwrite", function (tx) {
          tx.objectStore(STORE_ITEMS).delete(id);
          tx.objectStore(STORE_TOMBSTONES).put({ id: id, deletedAt: Date.now() });
        });
        notify();
        // 服务端同步：失败不回滚本地删除——用户看到的效果已经生效，
        // 下次读服务端时以服务端为准，不会「复活」。
        callServer("DELETE", "id=" + encodeURIComponent(id)).catch(function () {});
        return true;
      } catch {
        return false;
      }
    }

    /** 批量删除；空数组是合法的无操作。 */
    async function bulkDeleteGalleryItems(ids) {
      try {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        var valid = ids.filter(isNonEmptyString);
        if (valid.length === 0) return false;

        var db = await openDb();
        if (db === null) return false;

        var now = Date.now();
        await runTransaction(db, [STORE_ITEMS, STORE_TOMBSTONES], "readwrite", function (tx) {
          var items = tx.objectStore(STORE_ITEMS);
          var tombstones = tx.objectStore(STORE_TOMBSTONES);
          valid.forEach(function (id) {
            items.delete(id);
            tombstones.put({ id: id, deletedAt: now });
          });
        });
        notify();
        // 服务端同步：批量走 ?ids=，避免 N 次往返。
        callServer("DELETE", "ids=" + encodeURIComponent(valid.join(","))).catch(function () {});
        return true;
      } catch {
        return false;
      }
    }
    async function bulkSetFavoriteGalleryItems(ids, isFavorite) {
      try {
        if (!Array.isArray(ids) || ids.length === 0) return false;
        var valid = ids.filter(isNonEmptyString);
        if (valid.length === 0) return false;

        var db = await openDb();
        if (db === null) return false;

        await runTransaction(db, [STORE_ITEMS], "readwrite", function (tx) {
          var items = tx.objectStore(STORE_ITEMS);
          valid.forEach(function (id) {
            var getRequest = items.get(id);
            getRequest.onsuccess = function () {
              var record = getRequest.result;
              if (record === undefined || record === null) return;
              record.isFavorite = isFavorite === true;
              items.put(record);
            };
          });
        });
        notify();
        // 服务端同步：批量走 ids 数组。
        callServer("PATCH", "", { action: "favorite", ids: valid, isFavorite: isFavorite === true }).catch(function () {});
        return true;
      } catch {
        return false;
      }
    }
    /**
     * 清空全部——同时清墓碑。
     *
     * 语义是「用户主动要求从零开始」，保留墓碑会让他无法重新收集同样的图。
     */
    async function clearGallery() {
      try {
        var db = await openDb();
        if (db === null) return false;

        await runTransaction(db, [STORE_ITEMS, STORE_TOMBSTONES], "readwrite", function (tx) {
          tx.objectStore(STORE_ITEMS).clear();
          tx.objectStore(STORE_TOMBSTONES).clear();
        });
        notify();
        // 服务端同步：clear 会写墓碑，避免旧会话回填把图又扫回来。
        callServer("PATCH", "", { action: "clear" }).catch(function () {});
        return true;
      } catch {
        return false;
      }
    }

    /** 某个 id 是否被墓碑挡住（自测用，也可给「找回」功能用）。 */
    async function isTombstoned(id) {
      try {
        if (!isNonEmptyString(id)) return false;
        var db = await openDb();
        if (db === null) return false;
        var found = await runTransaction(db, [STORE_TOMBSTONES], "readonly", function (tx, setResult) {
          var request = tx.objectStore(STORE_TOMBSTONES).get(id);
          request.onsuccess = function () {
            setResult(request.result !== undefined && request.result !== null);
          };
        });
        return found === true;
      } catch {
        return false;
      }
    }

    var api = {
      DB_NAME: DB_NAME,
      DB_VERSION: DB_VERSION,
      STORE_ITEMS: STORE_ITEMS,
      STORE_TOMBSTONES: STORE_TOMBSTONES,
      STORE_PROMPTS: STORE_PROMPTS,
      IMAGE_MEDIA_TYPES: IMAGE_MEDIA_TYPES,
      subscribe: subscribe,
      notify: notify,
      available: available,
      galleryImageRoute: galleryImageRoute,
      setGalleryImageRoute: setGalleryImageRoute,
      parseAttachmentRef: parseAttachmentRef,
      normalizeWorkspacePath: normalizeWorkspacePath,
      isItemInWorkspace: isItemInWorkspace,
      saveGalleryItem: saveGalleryItem,
      getGalleryItems: getGalleryItems,
      toggleFavoriteGalleryItem: toggleFavoriteGalleryItem,
      deleteGalleryItem: deleteGalleryItem,
      bulkDeleteGalleryItems: bulkDeleteGalleryItems,
      bulkSetFavoriteGalleryItems: bulkSetFavoriteGalleryItems,
      addFavoritePrompt: addFavoritePrompt,
      removeFavoritePrompt: removeFavoritePrompt,
      toggleFavoritePrompt: toggleFavoritePrompt,
      getFavoritePrompts: getFavoritePrompts,
      clearGallery: clearGallery,
      isTombstoned: isTombstoned,
      GALLERY_ROUTE: GALLERY_ROUTE,
      /*
       * 工作区字段推导。放在 gallery 上而不是模块级：它依赖本闭包内的
       * `isNonEmptyString`，而模块级没有这个名字。外部（结果卡 / shared /
       * 画廊 chunk）一律通过 `gallery.xxx` 取，勿另起一份。
       */
      workspaceFieldsFrom: workspaceFieldsFrom,
      isVideoItem: isVideoItem,
      VIDEO_KIND: VIDEO_KIND,
      pickSessionCwd: pickSessionCwd,
      _internals: { openDb: openDb, requestAsPromise: requestAsPromise, runTransaction: runTransaction },
    };

    return api;
    })();


    // ── Host 路由（与 index.js 的 BASE/ROUTE_ 常量逐字对齐） ──────────────
    var BASE = "/plugins/dsh-doubao-image-free";
    var ROUTE_STATUS = BASE + "/api/status";
    var ROUTE_DOUBAO_SESSION = BASE + "/api/doubao/session";
    var ROUTE_DOUBAO_COOKIE = BASE + "/api/doubao/cookie";
    var ROUTE_DOUBAO_ACCOUNTS = BASE + "/api/doubao/accounts";
    var ROUTE_GPT_EDGE_LOGIN = BASE + "/api/gpt/edge-login";
    var ROUTE_DOUBAO_BROWSER_LOGIN = BASE + "/api/doubao/browser-login";
    var ROUTE_DOUBAO_RESET_PROFILE = BASE + "/api/doubao/reset-profile";
    var ROUTE_DOUBAO_NEW_CONVERSATION = BASE + "/api/doubao/new-conversation";
    var ROUTE_GPT_TOKEN = BASE + "/api/gpt/token";
    var ROUTE_GPT_SESSION = BASE + "/api/gpt/session";

    /**
     * 画廊取图端点（Host 第 8 条路由）。
     *
     * POST + `{attachment: <ImageAttachmentRef>}` → 裸图片字节；
     * 失败是 JSON `{ok:false, reason}`（400 invalid-attachment / 404 image-unavailable …）。
     */
    var IMAGE_ROUTE = BASE + "/api/image";
    gallery.setGalleryImageRoute(IMAGE_ROUTE);

    /**
     * 画廊取视频端点（Host 第 9 条路由）。
     *
     * POST + `{attachment: <FileAttachmentRef>}` → 裸视频字节。
     * 与 `IMAGE_ROUTE` 分开是必须的：那条走 `readImage`，入参要求
     * `mediaType` / `width` / `height`，视频引用一个都没有。
     */
    var VIDEO_ROUTE = BASE + "/api/video";

    // ── CSS ──────────────────────────────────────────────────────────────
    var CSS =
      ".__dbi_root{max-width:880px;display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary)}" +
      ".__dbi_group{border-top:1px solid var(--dsw-alias-border-l2);padding-top:18px;display:flex;flex-direction:column;gap:10px}" +
      /* 账号池列表：当前账号左侧加一道竖线，不只靠颜色区分（色弱也看得出来）。 */
      ".__dbi_accounts{display:flex;flex-direction:column;gap:6px;margin-top:2px}" +
      ".__dbi_account{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-l2)}" +
      ".__dbi_accountActive{border-left:3px solid var(--dsw-alias-brand-primary);padding-left:6px}" +
      ".__dbi_accountName{font-weight:600;min-width:4em}" +
      ".__dbi_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".__dbi_field{display:flex;flex-direction:column;gap:6px}" +
      ".__dbi_label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__dbi_hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}" +
      ".__dbi_input,.__dbi_textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:inherit;font:inherit;border-radius:6px;padding:9px 12px;min-height:40px}" +
      ".__dbi_textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px}" +
      ".__dbi_check{accent-color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      ".__dbi_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:inherit;font:inherit;font-size:12px;border-radius:6px;min-height:34px;padding:7px 14px;cursor:pointer}" +
      ".__dbi_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      ".__dbi_btn:disabled{opacity:.5;cursor:default}" +
      ".__dbi_btnPrimary{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff}" +
      ".__dbi_btnDanger{border-color:var(--dsw-alias-state-error-primary,#f85149);color:var(--dsw-alias-state-error-primary,#f85149)}" +
      ".__dbi_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dbi_error{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}" +
      ".__dbi_ok{font-size:12px;color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      ".__dbi_badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dbi_badgeOn{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      ".__dbi_qr{width:180px;height:180px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:#fff;padding:6px;box-sizing:content-box}" +
      ".__dbi_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px}" +
      ".__dbi_tile{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3)}" +
      ".__dbi_thumb{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:var(--dsw-alias-bg-layer-2,#0000);cursor:zoom-in}" +
      ".__dbi_tileMeta{padding:6px 8px;display:flex;flex-direction:column;gap:4px;min-width:0}" +
      ".__dbi_prompt{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__dbi_tileActions{display:flex;gap:4px;flex-wrap:wrap}" +
      ".__dbi_tileActions .__dbi_btn{min-height:26px;padding:3px 8px;font-size:11px}" +
      ".__dbi_star{background:none;border:0;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dbi_starOn{color:#f5a623}" +
      ".__dbi_lightbox{position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;box-sizing:border-box;cursor:zoom-out}" +
      ".__dbi_lightboxImg{max-width:92vw;max-height:82vh;object-fit:contain;border-radius:8px;cursor:default}" +
      ".__dbi_lightboxBar{position:absolute;left:24px;right:24px;bottom:18px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;color:#fff;font-size:12px}" +
      ".__dbi_empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      // ── 对话内结果卡片 ──────────────────────────────────────────────
      ".__dbi_result{display:flex;flex-direction:column;gap:8px;margin:4px 0}" +
      ".__dbi_resultImg{max-width:min(420px,100%);max-height:420px;object-fit:contain;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);display:block;cursor:zoom-in;background:var(--dsw-alias-bg-layer-2,#0000)}" +
      /* 视频卡：与图片卡同宽同圆角，但 `cursor:default` —— 它不可点放大（播放去画廊灯箱）。 */
      ".__dbi_resultVideo{max-width:min(420px,100%);max-height:420px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);display:block;background:#000;cursor:default}" +
      ".__dbi_resultPrompt{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}" +
      ".__dbi_resultMeta{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dbi_resultSavedTo{font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,ui-monospace,monospace);word-break:break-all;cursor:default}" +
      ".__dbi_resultLoading{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dbi_resultError{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}" +
      ".__dbi_resultList{display:flex;flex-direction:column;gap:10px;margin:4px 0}" +
      ".__dbi_promotedNotice{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      // ── 画廊标签页（conversation.view）────────────────────────
      ".__dbi_view{height:100%;box-sizing:border-box;overflow:auto;padding:14px 16px}" +
      ".__dbi_view .__dbi_group{border-top:0;padding-top:0}" +
      // ── D4 provider 状态徽章 ──────────────────────────────────────
      // 类名与官方 `dsh-ig-status-*` 同构（但不复用其 class 名，避免与官方
      // 插件在同一页撞样式）；浮层用 :hover 展开，与官方一致 —— 这样键盘
      // 焦点不会卡在一个打不开的层里。
      ".__dbi_statusWrap{position:relative;display:inline-flex;align-items:center}" +
      ".__dbi_statusBadge{height:30px;display:inline-flex;align-items:center;gap:7px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);cursor:pointer;user-select:none;transition:border-color .15s,background .15s}" +
      ".__dbi_statusBadge:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      ".__dbi_statusDot{width:7px;height:7px;min-width:7px;max-width:7px;border-radius:50%;flex-shrink:0;box-sizing:border-box}" +
      // 三色点：绿=已配置 / 灰=缺失 / 蓝=中性（状态未知或检查中）。
      ".__dbi_statusDot.__dbi_statusReady{background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.2)}" +
      ".__dbi_statusDot.__dbi_statusMuted{background:#9aa3b2;box-shadow:0 0 0 2px rgba(154,163,178,.2)}" +
      ".__dbi_statusDot.__dbi_statusNeutral{background:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px rgba(57,100,254,.2)}" +
      ".__dbi_statusText{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:1}" +
      ".__dbi_statusArrow{font-size:9px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}" +
      ".__dbi_statusWrap:hover .__dbi_statusArrow{transform:rotate(180deg)}" +
      ".__dbi_statusPopover{position:absolute;left:0;top:calc(100% + 6px);width:250px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;box-shadow:0 12px 36px rgba(20,28,45,.14);padding:10px 12px;z-index:40;opacity:0;pointer-events:none;transform:translateY(4px);transition:opacity .15s,transform .15s}" +
      ".__dbi_statusWrap:hover .__dbi_statusPopover{opacity:1;pointer-events:auto;transform:translateY(0)}" +
      ".__dbi_statusPopTitle{font-size:10px;font-weight:650;color:var(--dsw-alias-label-tertiary);margin-bottom:8px;letter-spacing:.02em;text-transform:uppercase}" +
      ".__dbi_statusList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}" +
      ".__dbi_statusList li{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:6px}" +
      ".__dbi_statusList li.__dbi_statusConfigured{background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.12)}" +
      ".__dbi_statusList li.__dbi_statusMissing{background:rgba(154,163,178,.05);border:1px solid rgba(154,163,178,.14)}" +
      ".__dbi_statusItemName{display:flex;flex-direction:column;min-width:0}" +
      ".__dbi_statusItemName strong{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:16px}" +
      ".__dbi_statusItemName small{font-size:9.5px;color:var(--dsw-alias-label-tertiary);line-height:14px}" +
      ".__dbi_statusItemTag{font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;flex-shrink:0}" +
      ".__dbi_statusConfigured .__dbi_statusItemTag{color:#059669;background:rgba(16,185,129,.14)}" +
      ".__dbi_statusMissing .__dbi_statusItemTag{color:#6b7280;background:rgba(154,163,178,.16)}" +
      // ── E2 多图网格 ───────────────────────────────────────────────
      ".__dbi_resultGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:4px 0}" +
      ".__dbi_resultGrid .__dbi_result{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px;background:var(--dsw-alias-bg-layer-3)}" +
      ".__dbi_resultGrid .__dbi_resultImg{max-width:100%;max-height:220px}" +
      ".__dbi_resultGrid .__dbi_resultPrompt{-webkit-line-clamp:2}" +
      // ── E4 重新生成 ───────────────────────────────────────────────
      ".__dbi_resultActions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}" +
      ".__dbi_resultActions .__dbi_btn{min-height:26px;padding:3px 9px;font-size:11px}" +
      ".__dbi_regenerateField{display:flex;flex-direction:column;gap:6px;margin-top:6px}" +
      ".__dbi_regenerateInput{width:100%;box-sizing:border-box;min-height:54px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#0000);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;resize:vertical}" +
      ".__dbi_regenerateInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3964fe)}" +
      "@media(prefers-reduced-motion:reduce){.__dbi_thumb{transition:none}}";

    /**
     * 注入样式表。
     *
     * **必须做**：本文件的 class 全是自定义的 `__dbi_*`，宿主不会替它们提供样式。
     * 早期版本只定义了 `CSS` 常量却从未注入（死代码），后果是结果卡里的
     * `max-width:420px` 不生效 —— 2048px 原图会以原始尺寸撑爆对话。
     * 范式照抄 `dsh-soul-md/client.js:74-81`：模块顶层插一次，按 tag 去重。
     */
    var CSS_TAG_ID = "dsh-doubao-image/client.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
      var styleTag = document.createElement("style");
      styleTag.dataset.plugin = "dsh-doubao-image";
      styleTag.dataset.pluginCss = CSS_TAG_ID;
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
    }

    // ── locale ───────────────────────────────────────────────────────────
    //
    // 本命名空间由 Client 自己注册（Host 半没有注册任何 locale 命名空间，
    // 已 grep 确认）。key 名刻意与 locale/zh.json 保持一致，便于对照。
    var NS = "doubaoImage";
    var inject = ["slots", "locale", "configForms"];

    /**
     * 一次批量写的落库判定。
     *
     * scope.mutate() 在 Host 拒绝时 resolve(false) 而不是 reject——不回读校验
     * 就会出现「提示已保存、实际没保存」。
     */
    /**
     * 把「当前表单值」翻译成一组 `{op:"set", path, value}`。
     *
     * 抽成纯函数是为了能被测试直接打中：保存路径一旦退回「整段替换」，
     * 就会把被 `role("secret")` 剥掉的凭据字段写成空串——那是数据丢失事故，
     * 而它在 UI 上完全看不出来（保存照常提示成功）。所以这条判据必须可测。
     *
     * @param {(field: object) => any} readField 取某个字段的当前界面值
     * @returns {{ops?: Array, error?: string}} 校验失败时给 `error`（字典 key）
     */
    function buildConfigOps(readField) {
      var ops = [];
      for (var i = 0; i < CONFIG_FIELDS.length; i++) {
        var field = CONFIG_FIELDS[i];
        var parsed = validateField(field, readField(field));
        if (parsed === null) {
          return { error: field.kind === "size" ? "settingsInvalidSize" : "settingsInvalidNumber" };
        }
        ops.push({ op: "set", path: field.path.slice(), value: field.toStored ? field.toStored(parsed) : parsed });
      }
      return { ops: ops };
    }

    /**
     * 按 path 取嵌套值（`["image","reuseConversation"]` → `value.image.reuseConversation`）。
     *
     * 路径全段都必须是普通对象；中途碰上 undefined / 非对象就返回 `{ found: false }`，
     * 好让调用方区分「值是 undefined」与「路径根本不存在」。
     */
    function readPathValue(root, path) {
      var node = root;
      for (var i = 0; i < path.length; i++) {
        if (node === null || typeof node !== "object") return { found: false, value: void 0 };
        var key = path[i];
        if (!Object.prototype.hasOwnProperty.call(node, key)) return { found: false, value: void 0 };
        node = node[key];
      }
      return { found: true, value: node };
    }

    /**
     * 回读校验：这批 ops 真的落到快照里了吗？
     *
     * **必须按整段 path 比较，不能只看 `path[0]`。** `CONFIG_FIELDS` 里的路径
     * 全是两段（`["image","reuseConversation"]`、`["video","enabled"]`…），
     * 只取首段等于拿「整个 image 段对象」去比「单个布尔值」，永远不相等
     * ⇒ 用户每次点保存都看到「写入未生效，请检查当前设置」，而配置其实
     * 已写进磁盘（2026-10-20 用户实测报障）。
     */
    function settingsOpsApplied(snapshot, ops) {
      if (!snapshot || snapshot.status !== "ready" || snapshot.value === void 0) return false;
      var user = snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
      for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (op.op === "unset") {
          // 清掉之后，user 覆盖层里不该再出现这个路径（或它的叶子键）。
          if (readPathValue(user, op.path).found) return false;
          continue;
        }
        var actual = readPathValue(snapshot.value, op.path);
        if (!actual.found) return false;
        if (JSON.stringify(actual.value) !== JSON.stringify(op.value)) return false;
      }
      return true;
    }

    /**
     * 应用一批命名空间操作，resolve「是否真的生效」。
     *
     * 多个字段必须合成**一个** ops 数组一次 mutate：分开调用时每批各有自己的
     * revision fence，第二批会被第一批刚顶掉的 revision 拒绝。
     *
     * `set` / `unset` 是**单段**接口（`set(field, value)` 只接受一个键名），
     * 传 `op.path[0]` 会把 `image.reuseConversation` 写成 `image = true`，
     * 整段覆盖。它只作为没有 `mutate()` 的降级路径存在——当前宿主
     * （`dsh-client-ui-settings` 的 `ConfigFormController`）一定有 `mutate`，
     * 这里不会被走到；写成正确的形式，是为了不让下一个读到它的人照抄错的。
     */
    function commitSettingsOps(scope, ops) {
      if (ops.length === 0) return Promise.resolve(true);
      var run;
      if (typeof scope.mutate === "function") {
        run = scope.mutate(ops, scope.getSnapshot().revision);
      } else {
        /*
         * 降级路径：逐段深入写。两段以上的路径用「读上一级 → 浅合并 → 写回」
         * 实现，保证不会像 `set(path[0], value)` 那样把整段替换掉。
         */
        run = ops.reduce(function (chain, op) {
          return chain.then(function () {
            var head = op.path[0];
            if (op.path.length === 1) {
              return op.op === "unset" ? scope.unset(head) : scope.set(head, op.value);
            }
            if (op.op === "unset") return scope.unset(head);
            var snapshot = scope.getSnapshot();
            var current = snapshot && snapshot.value ? snapshot.value[head] : void 0;
            var next = current && typeof current === "object" ? Object.assign({}, current) : {};
            next[op.path[1]] = op.value;
            return scope.set(head, next);
          });
        }, Promise.resolve());
      }
      return Promise.resolve(run).then(function () {
        return settingsOpsApplied(scope.getSnapshot(), ops);
      });
    }

    // ── 词典 ─────────────────────────────────────────────────────────────
    var zh = {
      nav: "豆包 / GPT 生图",
      intro: "用网页版豆包与免费账户的 ChatGPT 生图。登录凭据存在 DSH 凭据库里，画廊存在浏览器本地。",
      unavailable: "设置命名空间不可用（服务端未注册 doubao-image 配置命名空间？）",
      loading: "加载中…",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      error: "操作失败",
      notApplied: "写入未生效，请检查当前设置",
      busy: "处理中…",

      doubaoTitle: "豆包",
      doubaoDesc: "扫码登录后即可用免费账户生图；反斜杠图生图会重绘整张画面。",
      doubaoStatus: "登录状态",
      doubaoLoggedIn: "已登录",
      doubaoLoggedOut: "未登录",
      doubaoUpdatedAt: "最近更新",
      doubaoLogout: "退出登录",
      doubaoCookie: "手工粘贴 Cookie",
      doubaoCookieHint: "从开发者工具复制 www.doubao.com 的 Cookie 头，必须含 sessionid。",
      doubaoCookiePlaceholder: "sessionid=…; ttwid=…",
      doubaoSaveCookie: "保存 Cookie",
      doubaoCookieRequired: "请先粘贴 Cookie",

      gptTitle: "ChatGPT 免费账户",
      gptDesc: "用免费账户的网页版出图能力，需要先登录一次以取得 accessToken。",
      gptStatus: "登录状态",
      gptLoggedIn: "已登录",
      gptLoggedOut: "未登录",
      gptUpdatedAt: "最近更新",
      gptEdgeLogin: "拉起浏览器登录",
      gptEdgeLoginHint: "会打开一个独立的 Edge 窗口（不影响你自己的浏览器），登录完成后自动读取凭据。",
      doubaoBrowserLogin: "拉起浏览器登录（推荐）",
      doubaoBrowserHint: "打开独立浏览器窗口登录，一次性取回 Cookie 与设备身份。扫码登录只拿得到 Cookie，缺少设备身份会被豆包判为异常请求。",
      doubaoMultiHint: "同一个豆包账号重复登录只会更新那一条；换一个账号登录就会加成第二个账号。生图时先试当前账号，被限流或要求验证时自动换下一个。",
      doubaoResetProfile: "重置登录环境",
      doubaoResetConfirm: "重置会删掉豆包登录用的浏览器 profile（含登录态），相当于换一台设备。删除后需要重新点「登录豆包」。确定继续？",
      doubaoResetDone: "已重置豆包登录 profile，请重新点「登录豆包」以换一份设备身份。",
      doubaoResetHint: "设备身份被风控锁死、反复要求人机校验时用它。重置后要重新登录。",
      doubaoAccountsTitle: "已登录账号（{n} 个）",
      doubaoAccountActive: "当前",
      doubaoAccountUse: "设为当前",
      doubaoAccountRename: "改名",
      doubaoAccountRemove: "删除",
      doubaoAccountNoDevice: "缺设备身份（发不出图）",
      doubaoAccountNoMsToken: "无 msToken",
      doubaoRenamePrompt: "给这个账号起个名字（留空则显示序号）",
      doubaoRemoveConfirm: "确定删除账号 {name}？删除后它的登录信息不再保留。",
      doubaoBrowserWaiting: "请在打开的浏览器窗口里登录豆包…（最长 5 分钟）",
      doubaoBrowserDone: "豆包登录成功",
      gptWaiting: "等待登录…",
      gptPolling: "正在读取登录凭据…",
      gptDone: "已读取到登录凭据",
      gptLogout: "退出登录",
      gptToken: "手工粘贴 accessToken",
      gptTokenHint: "可在 chatgpt.com/api/auth/session 页面复制 accessToken；有效期约两周。",
      gptTokenPlaceholder: "eyJhbGciOi…",
      gptSaveToken: "保存 Token",
      gptTokenRequired: "请先粘贴 accessToken",
      gptProxy: "代理地址",
      gptProxyHint: "访问 chatgpt.com 需要走代理，留空则直连。",
      gptProxyPlaceholder: "http://127.0.0.1:7897",

      settingsTitle: "通用设置",
      settingsTimeout: "生图超时（秒）",
      settingsTimeoutHint: "单次生图的整体超时，豆包与 GPT 共用。",
      settingsDefaultSize: "默认尺寸",
      settingsDefaultSizeHint: "如 1024x1024；会被吸附到豆包支持的 1:1 / 4:3 / 16:9 / 9:16 比例。",
      settingsVideo: "启用视频生成",
      settingsVideoHint: "默认关闭。豆包生视频较慢且带水印。",
      settingsVideoModel: "视频模型",
      settingsVideoDuration: "默认视频时长（秒）",
      settingsInvalidNumber: "超时、时长必须是正整数",
      settingsInvalidSize: "默认尺寸格式应为 宽x高，如 1024x1024",

      resultLoading: "正在取回图片…",
      resultErrorPrefix: "图片取回失败：",
      resultProviderDoubao: "豆包",
      resultProviderGpt: "ChatGPT",
      resultPromoted: "图片已显示在下方对话中。",
      resultVideoHint: "视频已生成（带豆包水印）。文件路径见上方工具输出，可自行打开。",
      // 多图结果的张数行。曾漏定义：`t()` 拿不到 key 会把 key 本身当文案渲染，
      // 于是多图卡片上直接显示字符串 "resultCount"。文案与 galleryCount 对齐。
      resultCount: "共 {n} 张",
      resultSavedTo: "已存至 ",

      galleryTitle: "画廊",
      galleryEnabled: "启用画廊",
      galleryEnabledHint: "关闭后不再把新生成的图记入本地画廊（已有记录保留）。",
      autoSwitchAccount: "自动切换账号",
      autoSwitchAccountHint: "当前账号失败时自动换下一个账号重试。关掉后只用当前账号——测试用的号不会被悄悄换成主号。",
      reuseConversation: "固定生图会话",
      reuseConversationHint: "打开后所有生图都进同一个豆包会话，账号里只留 1 个会话；想换风格时点「新开会话」。关掉则每次生图新建会话。",
      newConversation: "新开会话",
      newConversationDone: "已换新会话，下次生图会新建。",
      newConversationNoAccount: "还没有豆包账号，先登录。",
      galleryNoRoute: "宿主未提供取图路由，无法显示缩略图。",
      galleryUnavailable: "当前浏览器不支持 IndexedDB，画廊不可用。",
      galleryEmpty: "画廊还是空的——生成一张图后会自动出现在这里。",
      galleryLoading: "加载中…",
      galleryCount: "共 {n} 张",
      galleryFilterAll: "全部工作区",
      galleryFilterHint: "按工作区过滤",
      galleryOnlyFavorites: "只看收藏",
      galleryFavorite: "收藏",
      galleryUnfavorite: "取消收藏",
      galleryDelete: "删除",
      galleryConfirmDelete: "删除这张图？",
      galleryClear: "清空全部",
      galleryConfirmClear: "清空整个画廊（含删除记录）？此操作不可撤销。",
      galleryCleared: "已清空",
      galleryFailed: "操作失败，请重试",
      galleryClose: "关闭",
      galleryDetail: "详情",
      galleryNoPrompt: "（无提示词）",

      newCanvas: "画布",
      newCanvasTip: "打开工作台",

      // ── D4 provider 状态徽章 ─────────────────────────────────────────
      statusProviderTitle: "通道状态",
      statusConfigured: "已配置",
      statusMissing: "缺失",
      statusNeutral: "未知",
      statusReadyCount: "{n} 个通道可用",
      statusNoneReady: "没有可用通道",
      statusReadyCountAll: "全部 {n} 个通道可用",
      statusItemConfigured: "已登录",
      statusItemMissing: "未登录",
      statusChecking: "检查中…",
      statusFetchFailed: "无法读取状态",
    };

    var en = {
      nav: "Doubao / GPT Images",
      intro: "Generate images with web Doubao and a free-tier ChatGPT account. Credentials live in the DSH vault; the gallery lives in your browser.",
      unavailable: "Settings namespace unavailable (doubao-image config namespace not registered server-side?)",
      loading: "Loading…",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      error: "Operation failed",
      notApplied: "Write did not take effect; check the current settings",
      busy: "Working…",

      doubaoTitle: "Doubao",
      doubaoDesc: "Scan the QR code once and the free account can generate images; image-to-image redraws the whole picture.",
      doubaoStatus: "Status",
      doubaoLoggedIn: "Signed in",
      doubaoLoggedOut: "Not signed in",
      doubaoUpdatedAt: "Last updated",
      doubaoLogout: "Sign out",
      doubaoCookie: "Paste cookie manually",
      doubaoCookieHint: "Copy the Cookie header of www.doubao.com from DevTools; sessionid is required.",
      doubaoCookiePlaceholder: "sessionid=…; ttwid=…",
      doubaoSaveCookie: "Save cookie",
      doubaoCookieRequired: "Paste a cookie first",

      gptTitle: "Free-tier ChatGPT",
      gptDesc: "Uses the free account's web image generation; sign in once so the access token can be read.",
      gptStatus: "Status",
      gptLoggedIn: "Signed in",
      gptLoggedOut: "Not signed in",
      gptUpdatedAt: "Last updated",
      gptEdgeLogin: "Open browser to sign in",
      gptEdgeLoginHint: "Opens a separate Edge window (your own browser is untouched) and reads the credentials once you finish signing in.",
      doubaoBrowserLogin: "Open browser to sign in (recommended)",
      doubaoBrowserHint: "Signs in through a separate browser window and captures both the cookie and this device's identity. QR sign-in only returns a cookie, and the missing device identity gets the request rejected by Doubao.",
      doubaoMultiHint: "Signing in with the same Doubao account only refreshes that entry; signing in with a different account adds a second one. Generation tries the current account first and switches when it is rate-limited or asked to verify.",
      doubaoResetProfile: "Reset sign-in environment",
      doubaoResetConfirm: "Resetting deletes the browser profile used for Doubao sign-in, including the login state — it is equivalent to switching to a new device. You will need to sign in again. Continue?",
      doubaoResetDone: "Doubao sign-in profile reset. Click \"Open browser to sign in\" to get a fresh device identity.",
      doubaoResetHint: "Use this when the device identity is locked by risk control and you keep getting challenged. You must sign in again afterwards.",
      doubaoAccountsTitle: "Signed-in accounts ({n})",
      doubaoAccountActive: "Current",
      doubaoAccountUse: "Use this",
      doubaoAccountRename: "Rename",
      doubaoAccountRemove: "Remove",
      doubaoAccountNoDevice: "missing device identity (cannot generate)",
      doubaoAccountNoMsToken: "no msToken",
      doubaoRenamePrompt: "Name this account (leave empty to show its index)",
      doubaoRemoveConfirm: "Remove account {name}? Its sign-in details will be discarded.",
      doubaoBrowserWaiting: "Sign in to Doubao in the browser window that just opened… (up to 5 minutes)",
      doubaoBrowserDone: "Signed in to Doubao",
      gptWaiting: "Waiting for sign-in…",
      gptPolling: "Reading credentials…",
      gptDone: "Credentials read",
      gptLogout: "Sign out",
      gptToken: "Paste access token manually",
      gptTokenHint: "Copy accessToken from chatgpt.com/api/auth/session; it stays valid for about two weeks.",
      gptTokenPlaceholder: "eyJhbGciOi…",
      gptSaveToken: "Save token",
      gptTokenRequired: "Paste an access token first",
      gptProxy: "Proxy URL",
      gptProxyHint: "chatgpt.com requires a proxy; leave empty for a direct connection.",
      gptProxyPlaceholder: "http://127.0.0.1:7897",

      settingsTitle: "General",
      settingsTimeout: "Generation timeout (seconds)",
      settingsTimeoutHint: "Overall timeout for one generation, shared by Doubao and GPT.",
      settingsDefaultSize: "Default size",
      settingsDefaultSizeHint: "e.g. 1024x1024; snapped to Doubao's supported 1:1 / 4:3 / 16:9 / 9:16 ratios.",
      settingsVideo: "Enable video generation",
      settingsVideoHint: "Off by default. Doubao video is slow and watermarked.",
      settingsVideoModel: "Video model",
      settingsVideoDuration: "Default video duration (seconds)",
      settingsInvalidNumber: "Timeout and duration must be positive integers",
      settingsInvalidSize: "Size must look like WIDTHxHEIGHT, e.g. 1024x1024",

      resultLoading: "Fetching the image…",
      resultErrorPrefix: "Could not load the image: ",
      resultProviderDoubao: "Doubao",
      resultProviderGpt: "ChatGPT",
      resultPromoted: "The image is shown in the conversation below.",
      resultVideoHint: "Video generated (with a Doubao watermark). Its file path is in the tool output above.",
      resultCount: "{n} images",
      resultSavedTo: "Saved to ",

      galleryTitle: "Gallery",
      galleryEnabled: "Enable gallery",
      galleryEnabledHint: "When off, newly generated images are no longer recorded locally (existing records stay).",
      autoSwitchAccount: "Auto-switch account",
      autoSwitchAccountHint: "Retry with the next account when the current one fails. When off, only the current account is used, so a test account will never be silently replaced by the main one.",
      reuseConversation: "Pin image conversation",
      reuseConversationHint: "When on, every image goes into the same Doubao conversation so the account keeps only one. Use \"New conversation\" to switch style. When off, each image starts a new conversation.",
      newConversation: "New conversation",
      newConversationDone: "Switched. The next image starts a new conversation.",
      newConversationNoAccount: "No Doubao account yet — sign in first.",
      galleryNoRoute: "The host exposes no image route, so thumbnails cannot be loaded.",
      galleryUnavailable: "This browser has no IndexedDB support; the gallery is unavailable.",
      galleryEmpty: "The gallery is empty — generate an image and it appears here.",
      galleryLoading: "Loading…",
      galleryCount: "{n} items",
      galleryFilterAll: "All workspaces",
      galleryFilterHint: "Filter by workspace",
      galleryOnlyFavorites: "Favorites only",
      galleryFavorite: "Favorite",
      galleryUnfavorite: "Unfavorite",
      galleryDelete: "Delete",
      galleryConfirmDelete: "Delete this image?",
      galleryClear: "Clear all",
      galleryConfirmClear: "Clear the whole gallery (including deletion records)? This cannot be undone.",
      galleryCleared: "Cleared",
      galleryFailed: "Operation failed, please retry",
      galleryClose: "Close",
      galleryDetail: "Details",
      galleryNoPrompt: "(no prompt)",

      newCanvas: "Canvas",
      newCanvasTip: "Open the studio",

      // ── D4 provider status badge ─────────────────────────────────────
      statusProviderTitle: "Provider status",
      statusConfigured: "Configured",
      statusMissing: "Missing",
      statusNeutral: "Unknown",
      statusReadyCount: "{n} provider(s) ready",
      statusNoneReady: "No provider ready",
      statusReadyCountAll: "All {n} providers ready",
      statusItemConfigured: "Signed in",
      statusItemMissing: "Not signed in",
      statusChecking: "Checking…",
      statusFetchFailed: "Status unavailable",
    };

    /*
     * 每个字段自带 `path`（写到哪里）与可选的 `toStored`（界面值 → 存储值的换算）。
     * 保存时按 `path` 逐字段写，**不做整段替换**——见 `onSaveConfig` 的说明。
     */
    var CONFIG_FIELDS = [
      { key: "timeoutSec", path: ["image", "timeoutMs"], kind: "intSeconds", toStored: function (v) { return v * 1000; }, label: "settingsTimeout", hint: "settingsTimeoutHint" },
      { key: "defaultSize", path: ["image", "defaultSize"], kind: "size", label: "settingsDefaultSize", hint: "settingsDefaultSizeHint" },
      { key: "videoEnabled", path: ["video", "enabled"], kind: "checkbox", label: "settingsVideo", hint: "settingsVideoHint" },
      { key: "videoModel", path: ["video", "model"], kind: "text", label: "settingsVideoModel" },
      { key: "videoDuration", path: ["video", "defaultDurationSec"], kind: "int", label: "settingsVideoDuration" },
      { key: "proxyUrl", path: ["gpt", "proxyUrl"], kind: "text", label: "gptProxy", hint: "gptProxyHint" },
      { key: "galleryEnabled", path: ["gallery", "enabled"], kind: "checkbox", label: "galleryEnabled", hint: "galleryEnabledHint" },
      { key: "reuseConversation", path: ["image", "reuseConversation"], kind: "checkbox", label: "reuseConversation", hint: "reuseConversationHint" },
      { key: "autoSwitchAccount", path: ["doubao", "autoSwitchAccount"], kind: "checkbox", label: "autoSwitchAccount", hint: "autoSwitchAccountHint" },
    ];

    var CONFIG_DEFAULTS = {
      timeoutMs: 300000,
      defaultSize: "1024x1024",
      videoEnabled: false,
      videoModel: "seedance_v2.0_mini",
      videoDuration: 5,
      proxyUrl: "http://127.0.0.1:7897",
      galleryEnabled: true,
      reuseConversation: false,
      autoSwitchAccount: true,
    };

    // ── 校验守卫 ─────────────────────────────────────────────────────────
    //
    // 每个守卫都必须能拒绝坏输入——自测里用「应该被拒绝的输入」逐条实测。

    /** 默认尺寸：宽x高，正整数，允许大写 X 与首尾空格。 */
    function parseSize(value) {
      if (typeof value !== "string") return null;
      var match = /^\s*(\d{2,5})\s*[xX×]\s*(\d{2,5})\s*$/.exec(value);
      if (match === null) return null;
      var width = Number(match[1]);
      var height = Number(match[2]);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
      if (width <= 0 || height <= 0) return null;
      return width + "x" + height;
    }

    /** 正整数（字符串输入也接受，便于直接接 input.value）。 */
    function parsePositiveInt(value, max) {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value <= 0) return null;
        if (max !== undefined && value > max) return null;
        return value;
      }
      if (typeof value !== "string") return null;
      var trimmed = value.trim();
      if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
      var parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
      if (max !== undefined && parsed > max) return null;
      return parsed;
    }

    /** 配置值的「形态」是否合法（不合法就不写，避免把坏值推进 Host）。 */
    function validateField(field, raw) {
      if (field.kind === "checkbox") return typeof raw === "boolean" ? raw : null;
      if (field.kind === "size") return parseSize(raw);
      if (field.kind === "int") return parsePositiveInt(raw, 3600);
      if (field.kind === "intSeconds") return parsePositiveInt(raw, 3600);
      if (field.kind === "text") return typeof raw === "string" ? raw.trim() : null;
      return null;
    }

    // ── 小组件 ───────────────────────────────────────────────────────────

    /** 跟随语言切换重渲染，不重挂表单。 */
    function useLocale(locale) {
      var refresh = react.useState(0)[1];
      react.useEffect(function () {
        if (!locale || typeof locale.subscribe !== "function") return;
        return locale.subscribe(function () { refresh(function (revision) { return revision + 1; }); });
      }, [locale]);
    }

    /** 订阅画廊「有变化了」信号，返回一个会自增的 tick。 */
    function useGalleryTick() {
      var pair = react.useState(0);
      var tick = pair[0];
      var setTick = pair[1];
      react.useEffect(function () {
        var un = gallery.subscribe(function () { setTick(function (t) { return t + 1; }); });
        return function () { if (typeof un === "function") un(); };
      }, []);
      return tick;
    }

    /**
     * 取一张图的 blob URL。
     *
     * 发请求前先用 `gallery.parseAttachmentRef` 过一遍——它的规则与 Host 的
     * `parseImageAttachmentRef` 完全相同。形状非法就直接进错误态，**不发请求**：
     * 明知会被 400 还打一趟网络，只会让日志噪声和错误归因变差。
     */
    function useAttachmentUrl(attachment, enabled) {
      var pair = react.useState({ url: "", error: "" });
      var state = pair[0];
      var setState = pair[1];

      /*
       * 视频走 `/api/video`，图片走 `/api/image`。判据是引用上的 `kind`：
       * 视频引用没有 `mediaType`，所以没法按 MIME 前缀分。
       * 这个布尔量提到 effect 外面，是为了让依赖数组能看见它——
       * 同一个组件从图片切到视频时必须重新取字节。
       */
      var isVideo = attachment !== null && typeof attachment === "object" && attachment.kind === gallery.VIDEO_KIND;
      var route = isVideo ? VIDEO_ROUTE : IMAGE_ROUTE;

      react.useEffect(function () {
        if (!enabled || route === "" || !attachment) {
          setState({ url: "", error: "" });
          return;
        }
        // 本地守卫：非法 ref 不发请求。
        if (gallery.parseAttachmentRef(attachment) === null) {
          setState({ url: "", error: "invalid-attachment" });
          return;
        }
        var alive = true;
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var objectUrl = "";
        fetch(route, {
          method: "POST",
          signal: controller ? controller.signal : undefined,
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachment: attachment }),
        }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.blob();
        }).then(function (blob) {
          if (!alive) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ url: objectUrl, error: "" });
        }).catch(function (error) {
          if (!alive) return;
          setState({ url: "", error: String(error && error.message || error) });
        });

        return function () {
          alive = false;
          // 清干净：中止请求 + 释放 blob URL，避免内存泄漏。
          if (controller) controller.abort();
          if (objectUrl !== "") URL.revokeObjectURL(objectUrl);
        };
      }, [attachment, enabled, route]);

      return state;
    }

    /** 缩略图：有了路由才取字节。 */
    function GalleryThumb(props) {
      var state = useAttachmentUrl(props.attachment, props.enabled);
      if (!props.enabled) {
        return h("div", { className: "__dbi_thumb", style: { display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, padding: 8, textAlign: "center", cursor: "default" } }, props.noRouteText);
      }
      if (state.url === "") {
        return h("div", { className: "__dbi_thumb", style: { display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, cursor: "default" } }, state.error !== "" ? state.error : "…");
      }
      return h("img", { className: "__dbi_thumb", src: state.url, alt: props.alt || "", loading: "lazy", onClick: props.onOpen });
    }

    /** 放大查看：Esc 关闭。 */
    function Lightbox(props) {
      var t = props.t;
      react.useEffect(function () {
        function onKey(event) {
          if (event.key === "Escape") props.onClose();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [props]);
      var state = useAttachmentUrl(props.item.attachment, props.enabled);
      return h("div", { className: "__dbi_lightbox", onClick: props.onClose },
        state.url !== ""
          ? h("img", { className: "__dbi_lightboxImg", src: state.url, alt: "", onClick: function (e) { e.stopPropagation(); } })
          : h("div", { style: { color: "#fff", fontSize: 13 } }, state.error !== "" ? state.error : t("galleryLoading")),
        h("div", { className: "__dbi_lightboxBar", onClick: function (e) { e.stopPropagation(); } },
          h("span", null, props.item.prompt || t("galleryNoPrompt")),
          h("span", null, props.item.model || props.item.provider || ""),
          h("button", { type: "button", className: "__dbi_btn", onClick: props.onClose }, t("galleryClose"))
        )
      );
    }

    // ── 画廊区块 ─────────────────────────────────────────────────────────

    function GallerySection(props) {
      var t = props.t;
      var tick = useGalleryTick();
      var pair = react.useState({ status: "loading", items: [] });
      var state = pair[0];
      var setState = pair[1];
      var filterPair = react.useState({ workspace: "", favoritesOnly: false });
      var filter = filterPair[0];
      var setFilter = filterPair[1];
      var openPair = react.useState(null);
      var openItem = openPair[0];
      var setOpenItem = openPair[1];
      var noticePair = react.useState(null);
      var notice = noticePair[0];
      var setNotice = noticePair[1];

      react.useEffect(function () {
        var alive = true;
        if (!gallery.available()) {
          setState({ status: "unavailable", items: [] });
          return;
        }
        setState(function (prev) { return { status: prev.items.length === 0 ? "loading" : prev.status, items: prev.items }; });
        gallery.getGalleryItems().then(function (items) {
          if (!alive) return;
          setState({ status: "ready", items: Array.isArray(items) ? items : [] });
        }).catch(function () {
          if (!alive) return;
          setState({ status: "ready", items: [] });
        });
        return function () { alive = false; };
      }, [tick]);

      if (state.status === "unavailable") return h("p", { className: "__dbi_hint" }, t("galleryUnavailable"));

      var items = state.items;
      // 工作区过滤：用 gallery.isItemInWorkspace 的同一套判据，不另写一份。
      var workspacePaths = [];
      items.forEach(function (item) {
        var path = typeof item.workspacePath === "string" ? item.workspacePath : "";
        if (path !== "" && workspacePaths.indexOf(path) === -1) workspacePaths.push(path);
      });
      workspacePaths.sort();

      var visible = items.filter(function (item) {
        if (filter.favoritesOnly && item.isFavorite !== true) return false;
        if (filter.workspace === "") return true;
        return gallery.isItemInWorkspace(item, { path: filter.workspace });
      });

      function run(op) {
        setNotice(null);
        Promise.resolve(op).then(function (ok) {
          if (ok === false) setNotice(t("galleryFailed"));
        }).catch(function () { setNotice(t("galleryFailed")); });
      }

      function onDelete(item) {
        if (!window.confirm(t("galleryConfirmDelete"))) return;
        run(gallery.deleteGalleryItem(item.id));
      }

      function onClear() {
        if (!window.confirm(t("galleryConfirmClear"))) return;
        run(gallery.clearGallery().then(function (ok) {
          if (ok) setNotice(t("galleryCleared"));
          return ok;
        }));
      }

      var routeOk = IMAGE_ROUTE !== "";

      return h("div", { className: "__dbi_group" },
        h("div", { className: "__dbi_row" },
          h("span", { className: "__dbi_label" }, t("galleryTitle")),
          h("span", { className: "__dbi_badge" }, t("galleryCount", { n: items.length }))
        ),
        !routeOk ? h("p", { className: "__dbi_error" }, t("galleryNoRoute")) : null,
        h("div", { className: "__dbi_row" },
          workspacePaths.length > 0
            ? h("label", { className: "__dbi_field", style: { flexDirection: "row", alignItems: "center", gap: 6 } },
                h("span", { className: "__dbi_hint" }, t("galleryFilterHint")),
                h("select", { className: "__dbi_input", style: { minHeight: 32, width: "auto" }, value: filter.workspace, onChange: function (e) { setFilter(function (p) { return Object.assign({}, p, { workspace: e.target.value }); }); } },
                  h("option", { value: "" }, t("galleryFilterAll")),
                  workspacePaths.map(function (path) { return h("option", { key: path, value: path }, path); })
                )
              )
            : null,
          h("label", { className: "__dbi_row", style: { gap: 6 } },
            h("input", { className: "__dbi_check", type: "checkbox", checked: filter.favoritesOnly, onChange: function (e) { setFilter(function (p) { return Object.assign({}, p, { favoritesOnly: e.target.checked }); }); } }),
            h("span", { className: "__dbi_hint" }, t("galleryOnlyFavorites"))
          ),
          items.length > 0 ? h("button", { type: "button", className: "__dbi_btn __dbi_btnDanger", onClick: onClear }, t("galleryClear")) : null,
          notice !== null ? h("span", { className: "__dbi_error" }, notice) : null
        ),
        state.status === "loading"
          ? h("p", { className: "__dbi_empty" }, t("galleryLoading"))
          : visible.length === 0
            ? h("p", { className: "__dbi_empty" }, t("galleryEmpty"))
            : h("div", { className: "__dbi_grid" },
                visible.map(function (item) {
                  return h("div", { key: item.id, className: "__dbi_tile" },
                    h(GalleryThumb, { attachment: item.attachment, enabled: routeOk, noRouteText: t("galleryNoRoute"), alt: item.prompt, onOpen: function () { setOpenItem(item); } }),
                    h("div", { className: "__dbi_tileMeta" },
                      h("span", { className: "__dbi_prompt", title: item.prompt }, item.prompt || t("galleryNoPrompt")),
                      h("div", { className: "__dbi_tileActions" },
                        h("button", {
                          type: "button",
                          className: "__dbi_star" + (item.isFavorite === true ? " __dbi_starOn" : ""),
                          title: item.isFavorite === true ? t("galleryUnfavorite") : t("galleryFavorite"),
                          onClick: function () { run(gallery.toggleFavoriteGalleryItem(item.id)); },
                        }, item.isFavorite === true ? "★" : "☆"),
                        h("button", { type: "button", className: "__dbi_btn", onClick: function () { setOpenItem(item); } }, t("galleryDetail")),
                        h("button", { type: "button", className: "__dbi_btn __dbi_btnDanger", onClick: function () { onDelete(item); } }, t("galleryDelete"))
                      )
                    )
                  );
                })
              ),
        openItem !== null ? h(Lightbox, { item: openItem, enabled: routeOk, t: t, onClose: function () { setOpenItem(null); } }) : null
      );
    }

    /**
     * 画廊标签页（`conversation.view` 槽）。
     *
     * **为什么要有**：设置页里那份画廊只有主动进设置才看得到；用户要的是
     * 像官方 `dsh-image-gen` 那样的**对话页入口**（`lib/client.js:125553`
     * 注册 `conversation.view`，`id: "gallery"`，`order: 20`）。
     *
     * 槽契约（`cordis_inspect_query` client/Slots/listSubTree 实测）：
     * `conversation.view` 是 **list 槽**、`scope: session`、
     * 注册参数只有 `{id, order?, label?}` —— **没有 key**，
     * 所以这里用 `id` 而不是 `key`（用 `key` 会注册失败）。
     */
    function GalleryView(props) {
      useLocale(props.locale);
      var t = props.t;
      return h("div", { className: "__dbi_view" }, h(GallerySection, { t: t }));
    }

    // ── 设置页主体 ───────────────────────────────────────────────────────

    /**
     * D4：provider 状态徽章 + 悬浮详情。
     *
     * 显示两条通道（豆包 / GPT 免费账户）的凭据配置状态。数据源是
     * `GET /api/status`（`ROUTE_STATUS`）—— 与设置页各分组下方的登录徽章
     * 是**同一份**数据，不另开接口。
     *
     * 点色三态（官方 `.dsh-ig-status-dot` 同构）：
     *   - 绿 `is-ready`   —— 至少一条通道已配置；
     *   - 灰 `is-muted`   —— 一条都没有；
     *   - 蓝（中性）      —— 还没读到状态（初次加载 / 请求失败）。
     *     中性态**不能**画成灰色：灰色在语义上是「确认没配置」，而这里
     *     只是「还不知道」，把两者混在一起会把加载中误报成失败。
     */
    function ProviderStatusBadge(props) {
      var t = props.t;
      var status = props.status;
      var failed = props.failed === true;

      var providers = buildProviderStatusList(status);
      var readyCount = providers.filter(function (p) { return p.configured; }).length;

      // 三态判定：读到状态才用绿/灰，否则一律中性蓝。
      var known = status !== null && status !== undefined;
      var dotClass = "__dbi_statusDot ";
      if (!known || failed) dotClass += "__dbi_statusNeutral";
      else if (readyCount > 0) dotClass += "__dbi_statusReady";
      else dotClass += "__dbi_statusMuted";

      var text;
      if (!known) text = t("statusChecking");
      else if (failed) text = t("statusFetchFailed");
      else if (readyCount === 0) text = t("statusNoneReady");
      else if (readyCount === providers.length) text = t("statusReadyCountAll", { n: readyCount });
      else text = t("statusReadyCount", { n: readyCount });

      var items = providers.map(function (provider) {
        return h("li", {
          key: provider.id,
          className: provider.configured ? "__dbi_statusConfigured" : "__dbi_statusMissing",
        },
          h("div", { className: "__dbi_statusItemName" },
            h("strong", null, provider.label),
            h("small", null, provider.detail)),
          h("span", { className: "__dbi_statusItemTag" },
            provider.configured ? t("statusItemConfigured") : t("statusItemMissing"))
        );
      });

      return h("div", { className: "__dbi_statusWrap" },
        h("div", { className: "__dbi_statusBadge", role: "status", "aria-label": t("statusProviderTitle") },
          h("span", { className: dotClass }),
          h("span", { className: "__dbi_statusText" }, text),
          h("span", { className: "__dbi_statusArrow", "aria-hidden": "true" }, "▼")
        ),
        h("div", { className: "__dbi_statusPopover", role: "tooltip" },
          h("div", { className: "__dbi_statusPopTitle" }, t("statusProviderTitle")),
          h("ul", { className: "__dbi_statusList" }, items)
        )
      );
    }

    /**
     * `/api/status` 的返回值 → 徽章要的通道列表（纯函数，供自测直接断言）。
     *
     * 只有两条通道，所以不建 provider 注册表 —— 硬编码两项，来源 URL 与
     * `index.js` 的 `ROUTE_STATUS` 返回值逐字段对应。
     */
    function buildProviderStatusList(status) {
      var s = status && typeof status === "object" ? status : {};
      var doubao = s.doubao && typeof s.doubao === "object" ? s.doubao : {};
      var gpt = s.gpt && typeof s.gpt === "object" ? s.gpt : {};

      return [
        {
          id: "doubao",
          label: "豆包",
          detail: updatedAtText(doubao.updatedAt),
          configured: doubao.loggedIn === true,
        },
        {
          id: "gpt",
          label: "ChatGPT",
          detail: updatedAtText(gpt.updatedAt),
          configured: gpt.loggedIn === true,
        },
      ];
    }

    /** 凭据的最近更新时间，只取日期部分，避免把一整串 ISO 塞进小字。 */
    function updatedAtText(value) {
      if (typeof value !== "string" || value === "") return "—";
      var match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
      return match ? match[1] : value.slice(0, 16);
    }

    /**
     * 豆包账号行的**纯数据**（渲染与断言都走它，不重复判断逻辑）。
     *
     * 每行要回答三件事：这是谁、是不是当前在用的、能不能真的出图。
     * 「能不能出图」由 hasDevice 决定——缺设备身份的账号豆包会判异常请求，
     * 界面上必须显式标出来，否则用户会以为登录了就能用。
     */
    function doubaoAccountRows(status) {
      var list = status && status.doubao && Array.isArray(status.doubao.accounts) ? status.doubao.accounts : [];
      return list.map(function (acc, index) {
        var active = acc.active === true;
        return {
          id: String(acc.id || ""),
          name: acc.label || ("账号 " + (index + 1)),
          active: active,
          // cookie 末四位是「备注名都空着」时唯一能区分的线索。
          tail: String(acc.cookieTail || ""),
          hasDevice: acc.hasDevice === true,
          hasMsToken: acc.hasMsToken === true,
          usable: acc.hasDevice === true,
        };
      });
    }

    function DoubaoImageSection(props) {
      useLocale(props.locale);
      var t = props.t;
      var scope = props.scope;

      var snapshotPair = react.useState(function () { return scope.getSnapshot(); });
      var snapshot = snapshotPair[0];
      var setSnapshot = snapshotPair[1];
      var statusPair = react.useState(null);
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var draftPair = react.useState({ timeoutSec: "", defaultSize: "", videoModel: "", videoDuration: "", proxyUrl: "", videoEnabled: null, galleryEnabled: null, reuseConversation: null, autoSwitchAccount: null });
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var cookiePair = react.useState("");
      var cookieDraft = cookiePair[0];
      var setCookieDraft = cookiePair[1];
      var tokenPair = react.useState("");
      var tokenDraft = tokenPair[0];
      var setTokenDraft = tokenPair[1];
      var edgePair = react.useState({ state: "idle", message: "" });
      var edge = edgePair[0];
      var setEdge = edgePair[1];
      /*
       * 豆包浏览器登录的进度状态。
       *
       * 与 GPT 的 edge 分开：两条链路各自独立，共用一个状态机的话，
       * 登录豆包会把 GPT 那句「已完成」冲掉，反之亦然。
       */
      var dbPair = react.useState({ state: "idle", message: "" });
      var dbBrowser = dbPair[0];
      var setDbBrowser = dbPair[1];
      var busyPair = react.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var noticePair = react.useState(null);
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      var errorPair = react.useState(null);
      var error = errorPair[0];
      var error2 = errorPair[1];
      var writePending = react.useRef(false);

      /**
       * scope 全插件只 bind 一次，卸载只 unsubscribe、**绝不 dispose**——
       * dispose 过的 scope 写入队列会静默 no-op。
       */
      react.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      /**
       * 读一次 /api/status 刷新登录态。
       *
       * 同时维护 `statusFailed`：徽章要把「读不到状态」画成中性蓝而不是灰色
       * ——「还不知道」与「确认没配置」是两回事。
       */
      var statusFailedPair = react.useState(false);
      var statusFailed = statusFailedPair[0];
      var setStatusFailed = statusFailedPair[1];

      var refreshStatus = react.useCallback(function () {
        return fetch(ROUTE_STATUS, { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (data && data.ok) { setStatus(data); setStatusFailed(false); }
            else setStatusFailed(true);
            return data;
          })
          .catch(function () { setStatusFailed(true); return null; });
      }, []);

      react.useEffect(function () { refreshStatus(); }, [refreshStatus]);

      /** GPT Edge 登录轮询：waiting 时每 2 秒问一次状态。 */
      react.useEffect(function () {
        if (edge.state !== "waiting") return;
        var alive = true;
        var timer = setInterval(function () {
          fetch(ROUTE_GPT_EDGE_LOGIN, { method: "GET", credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!alive || !data) return;
              if (data.status === "done") {
                setEdge({ state: "done", message: data.message || "" });
                refreshStatus();
                return;
              }
              if (data.status === "error") {
                setEdge({ state: "error", message: data.message || "" });
                return;
              }
              if (data.status === "idle") {
                // 宿主侧的登录会话不在了（插件重载/超时清理）：停轮询并回到初始态，
                // 否则会把 idle 当成 waiting，界面永远转圈。
                setEdge({ state: "idle", message: "" });
                return;
              }
              setEdge({ state: "waiting", message: data.message || "" });
            })
            .catch(function () {});
        }, 2000);
        return function () { alive = false; clearInterval(timer); };
      }, [edge.state, refreshStatus]);

      if (snapshot.status === "unavailable") return h("p", { className: "__dbi_hint" }, t("unavailable"));
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      if (!ready) return h("p", { className: "__dbi_status" }, t("loading"));

      var value = snapshot.value;
      var writable = snapshot.writable !== false;
      var doubaoValue = value.doubao && typeof value.doubao === "object" ? value.doubao : {};
      var gptValue = value.gpt && typeof value.gpt === "object" ? value.gpt : {};
      var imageValue = value.image && typeof value.image === "object" ? value.image : {};
      var videoValue = value.video && typeof value.video === "object" ? value.video : {};
      var galleryValue = value.gallery && typeof value.gallery === "object" ? value.gallery : {};
      /*
       * 「固定生图会话」的当前值。
       *
       * 按钮显隐靠它，所以必须与 fieldValue("reuseConversation") 同源：
       * 草稿优先（用户刚勾还没保存时按钮就该出现），否则读快照，再退回默认。
       */
      var reuseConversation = (function () {
        var draftBool = draft.reuseConversation;
        if (draftBool !== null && draftBool !== undefined) return Boolean(draftBool);
        return imageValue.reuseConversation !== undefined
          ? Boolean(imageValue.reuseConversation)
          : CONFIG_DEFAULTS.reuseConversation;
      })();

      function clearNotice() { setNotice(null); error2(null); }

      /** 统一写路径：只有回读校验通过才算成功。 */
      function runWrite(ops, onOk) {
        if (writePending.current) return;
        writePending.current = true;
        setBusy(true); clearNotice();
        commitSettingsOps(scope, ops).then(function (ok) {
          writePending.current = false;
          setBusy(false);
          setSnapshot(scope.getSnapshot());
          if (!ok) { error2({ key: "error", detailKey: "notApplied" }); return; }
          setNotice({ key: "saved" });
          if (onOk) onOk();
        }).catch(function (exception) {
          writePending.current = false;
          setBusy(false);
          setSnapshot(scope.getSnapshot());
          error2({ key: "error", detail: String(exception && exception.message || exception) });
        });
      }

      function messageText(message) {
        if (!message) return "";
        return t(message.key) + (message.detailKey ? "：" + t(message.detailKey) : message.detail ? "：" + message.detail : "");
      }

      /** 当前字段值：草稿优先，否则取快照，再退回默认值。 */
      function fieldValue(field) {
        var stored;
        if (field.key === "videoEnabled") stored = videoValue.enabled;
        else if (field.key === "videoModel") stored = videoValue.model;
        else if (field.key === "videoDuration") stored = videoValue.defaultDurationSec;
        else if (field.key === "galleryEnabled") stored = galleryValue.enabled;
        else if (field.key === "reuseConversation") stored = imageValue.reuseConversation;
        else if (field.key === "autoSwitchAccount") stored = doubaoValue.autoSwitchAccount;
        else if (field.key === "proxyUrl") stored = gptValue.proxyUrl;
        else if (field.key === "timeoutSec") stored = imageValue.timeoutMs;
        else if (field.key === "defaultSize") stored = imageValue.defaultSize;

        if (field.kind === "checkbox") {
          var draftBool = draft[field.key];
          if (draftBool !== null) return Boolean(draftBool);
          return stored !== undefined ? Boolean(stored) : CONFIG_DEFAULTS[field.key];
        }
        var draftValue = draft[field.key];
        if (draftValue !== "") return draftValue;
        if (stored === undefined) {
          var fallback = CONFIG_DEFAULTS[field.key];
          if (field.key === "timeoutSec") return String(fallback / 1000);
          return String(fallback);
        }
        if (field.key === "timeoutSec") return String(Math.round(Number(stored) / 1000));
        return String(stored);
      }

      function setField(field, raw) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[field.key] = raw; return next; });
        clearNotice();
      }

      /**
       * 配置保存：校验 → 按 `field.path` 逐字段写 → 一次 mutate。
       *
       * **绝不能整段替换**（`path: ["doubao"]` 这种）。宿主 `redactSecrets` 会把
       * `role("secret")` 的字段从 describe 里剥掉，所以 `snapshot.value` 里的
       * `doubao.cookieHeader` / `gpt.accessToken` / `gpt.cookieHeader` **永远是空的**；
       * 整段回写等于把用户手写的凭据清空。逐字段写只碰本页真正编辑的那几个键，
       * 凭据字段原样留在配置文件里。
       *
       * 旧实现里 `touchedX` 实际上恒为 true（`fieldValue` 总能返回有效值），
       * 于是每次保存都会覆盖全部五段——影响面比「只清 doubao」更大。
       */
      function onSaveConfig() {
        var built = buildConfigOps(fieldValue);
        if (built.error) { error2({ key: "error", detailKey: built.error }); return; }
        runWrite(built.ops, function () {
          setDraft({ timeoutSec: "", defaultSize: "", videoModel: "", videoDuration: "", proxyUrl: "", videoEnabled: null, galleryEnabled: null, reuseConversation: null, autoSwitchAccount: null });
        });
      }

      function postJson(url, body) {
        return fetch(url, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json().catch(function () { return null; }); });
      }

      function onSaveCookie() {
        var cookieHeader = cookieDraft.trim();
        if (cookieHeader === "") { error2({ key: "error", detailKey: "doubaoCookieRequired" }); return; }
        setBusy(true); clearNotice();
        postJson(ROUTE_DOUBAO_COOKIE, { cookieHeader: cookieHeader }).then(function (data) {
          setBusy(false);
          if (data && data.ok) { setCookieDraft(""); setNotice({ key: "saved" }); refreshStatus(); }
          else error2({ key: "error", detail: (data && data.reason) || t("error") });
        }).catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      function onDoubaoLogout() {
        setBusy(true); clearNotice();
        fetch(ROUTE_DOUBAO_SESSION, { method: "DELETE", credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setBusy(false);
            if (data && data.ok) { setDbBrowser({ state: "idle", message: "" }); refreshStatus(); }
            else error2({ key: "error", detail: (data && data.reason) || t("error") });
          }).catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      /** 账号池操作统一走一个 POST，失败一律显示原因而不是静默。 */
      function postAccounts(body, onOk) {
        setBusy(true); clearNotice();
        postJson(ROUTE_DOUBAO_ACCOUNTS, body)
          .then(function (data) {
            setBusy(false);
            if (data && data.ok) { onOk(data); refreshStatus(); }
            else error2({ key: "error", detail: (data && data.reason) || t("error") });
          })
          .catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      function onActivateAccount(id) {
        postAccounts({ action: "activate", id: id }, function () { });
      }

      function onRenameAccount(id, currentLabel) {
        // 用 prompt 而不是内联输入框：改名是低频动作，不值得为它占一行布局。
        var next = window.prompt(t("doubaoRenamePrompt"), currentLabel || "");
        if (next === null) return;
        postAccounts({ action: "rename", id: id, label: next }, function () { });
      }

      /** 删掉一个账号（不是退出全部）。最后一个是它自己时，池会变空=未登录。 */
      function onRemoveAccount(id, label) {
        if (!window.confirm(t("doubaoRemoveConfirm").replace("{name}", label || id))) return;
        setBusy(true); clearNotice();
        fetch(ROUTE_DOUBAO_SESSION + "?id=" + encodeURIComponent(id), { method: "DELETE", credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setBusy(false);
            if (data && data.ok) { setDbBrowser({ state: "idle", message: "" }); refreshStatus(); }
            else error2({ key: "error", detail: (data && data.reason) || t("error") });
          }).catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      /*
       * 拉起独立浏览器登录豆包。
       *
       * 这条既不是扫码（扫码只拿得到 cookie，拿不到设备身份）也不是手贴 Cookie
       * （同样拿不到身份）。豆包把 fp / device_id / web_id 与 cookie 交叉校验，
       * 缺了必被判异常请求，所以必须真的跑一次浏览器。
       *
       * 路由是阻塞式的（最长 300 秒），因此这里不设超时、只等结果；
       * 用户关掉浏览器窗口或超时都会拿到明确的失败文案。
       */
      function onDoubaoBrowserLogin() {
        setBusy(true); clearNotice();
        setDbBrowser({ state: "waiting", message: t("doubaoBrowserWaiting") });
        postJson(ROUTE_DOUBAO_BROWSER_LOGIN, {}).then(function (data) {
          setBusy(false);
          if (data && data.ok) {
            setDbBrowser({ state: "done", message: data.message || t("doubaoBrowserDone") });
            refreshStatus();
          } else {
            setDbBrowser({ state: "error", message: (data && data.message) || t("error") });
          }
        }).catch(function () {
          setBusy(false);
          setDbBrowser({ state: "error", message: t("error") });
        });
      }

      /**
       * 重置豆包登录 profile（L2）。
       *
       * 设备身份被风控锁死时，换一份 profile 等于换一台设备。以前只能手动去
       * `%TEMP%` 删目录 —— 出问题的人恰好是最不知道该删哪个目录的人。
       *
       * 删除不可撤销，所以先 confirm；服务端在浏览器还开着时会拒绝，这里把
       * 它返回的 message 原样显示出来，不自己编文案。
       */
      function onDoubaoResetProfile() {
        var confirmText = t("doubaoResetConfirm");
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          if (!window.confirm(confirmText)) return;
        }
        setBusy(true); clearNotice();
        postJson(ROUTE_DOUBAO_RESET_PROFILE, {}).then(function (data) {
          setBusy(false);
          if (data && data.ok) {
            setDbBrowser({ state: "done", message: data.message || t("doubaoResetDone") });
            refreshStatus();
          } else {
            setDbBrowser({ state: "error", message: (data && data.message) || t("error") });
          }
        }).catch(function () {
          setBusy(false);
          setDbBrowser({ state: "error", message: t("error") });
        });
      }

      /**
       * 换一个新的生图会话（界面上的「+」）。
       *
       * 只在「固定生图会话」打开时有意义：清掉账号上记住的会话 id，
       * 下一次生图会新建一个会话并记住它 —— 这就是「想换风格就点 +」。
       *
       * 不做 confirm：这一步可撤销（再点一次就是又一个新会话），
       * 而且它不删任何历史会话，只是「下次别复用旧的」。
       */
      function onNewConversation() {
        setBusy(true); clearNotice();
        postJson(ROUTE_DOUBAO_NEW_CONVERSATION, {}).then(function (data) {
          setBusy(false);
          if (data && data.ok) {
            setNotice(t("newConversationDone"));
          } else if (data && data.reason === "no-account") {
            setNotice(t("newConversationNoAccount"));
          } else {
            setNotice(t("error"));
          }
        }).catch(function () {
          setBusy(false);
          setNotice(t("error"));
        });
      }

      function onEdgeLogin() {
        setBusy(true); clearNotice();
        postJson(ROUTE_GPT_EDGE_LOGIN, {}).then(function (data) {
          setBusy(false);
          if (data && data.ok) setEdge({ state: "waiting", message: data.message || "" });
          else setEdge({ state: "error", message: (data && data.message) || t("error") });
        }).catch(function () { setBusy(false); setEdge({ state: "error", message: t("error") }); });
      }

      function onSaveToken() {
        var accessToken = tokenDraft.trim();
        if (accessToken === "") { error2({ key: "error", detailKey: "gptTokenRequired" }); return; }
        setBusy(true); clearNotice();
        postJson(ROUTE_GPT_TOKEN, { accessToken: accessToken }).then(function (data) {
          setBusy(false);
          if (data && data.ok) { setTokenDraft(""); setNotice({ key: "saved" }); refreshStatus(); }
          else error2({ key: "error", detail: (data && data.reason) || t("error") });
        }).catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      function onGptLogout() {
        setBusy(true); clearNotice();
        fetch(ROUTE_GPT_SESSION, { method: "DELETE", credentials: "same-origin" })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            setBusy(false);
            if (data && data.ok) { setEdge({ state: "idle", message: "" }); refreshStatus(); }
            else error2({ key: "error", detail: (data && data.reason) || t("error") });
          }).catch(function () { setBusy(false); error2({ key: "error", detail: t("error") }); });
      }

      var doubaoLoggedIn = Boolean(status && status.doubao && status.doubao.loggedIn);
      var gptLoggedIn = Boolean(status && status.gpt && status.gpt.loggedIn);
      var doubaoAccounts = doubaoAccountRows(status);

      /**
       * 账号列表。
       *
       * 每行显示：备注名 / 是不是当前账号 / 有没有设备身份与 msToken（没有就发不出图，
       * 用户需要知道）/ cookie 末四位（同一备注为空时唯一能区分它们的线索）。
       */
      function accountList() {
        if (doubaoAccounts.length === 0) return null;
        return h("div", { className: "__dbi_accounts" },
          h("span", { className: "__dbi_label" }, t("doubaoAccountsTitle").replace("{n}", String(doubaoAccounts.length))),
          doubaoAccounts.map(function (acc) {
            return h("div", { key: acc.id, className: "__dbi_account" + (acc.active ? " __dbi_accountActive" : "") },
              h("span", { className: "__dbi_accountName" }, acc.name),
              acc.active ? h("span", { className: "__dbi_badge __dbi_badgeOn" }, t("doubaoAccountActive")) : null,
              h("span", { className: "__dbi_hint" },
                "…" + acc.tail + (acc.hasDevice ? "" : " · " + t("doubaoAccountNoDevice")) + (acc.hasMsToken ? "" : " · " + t("doubaoAccountNoMsToken"))),
              h("span", { className: "__dbi_row", style: { gap: 6, marginLeft: "auto" } },
                acc.active ? null : h("button", { type: "button", className: "__dbi_btn", disabled: busy, onClick: function () { onActivateAccount(acc.id); } }, t("doubaoAccountUse")),
                h("button", { type: "button", className: "__dbi_btn", disabled: busy, onClick: function () { onRenameAccount(acc.id, acc.label); } }, t("doubaoAccountRename")),
                h("button", { type: "button", className: "__dbi_btn __dbi_btnDanger", disabled: busy, onClick: function () { onRemoveAccount(acc.id, acc.label); } }, t("doubaoAccountRemove"))
              )
            );
          })
        );
      }

      function badge(on, onText, offText) {
        return h("span", { className: "__dbi_badge" + (on ? " __dbi_badgeOn" : "") }, on ? onText : offText);
      }

      var edgeStateText = edge.state === "waiting" ? (edge.message || t("gptWaiting"))
        : edge.state === "done" ? t("gptDone")
        : edge.message;

      return h("div", { className: "__dbi_root" },
        h("div", { className: "__dbi_row" },
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("intro")),
          // D4：通道状态徽章（悬浮展开详情）。
          h(ProviderStatusBadge, { t: t, status: status, failed: statusFailed })
        ),

        // ── 豆包 ────────────────────────────────────────────────────────
        h("div", { className: "__dbi_group" },
          h("div", { className: "__dbi_row" },
            h("span", { className: "__dbi_label" }, t("doubaoTitle")),
            badge(doubaoLoggedIn, t("doubaoLoggedIn"), t("doubaoLoggedOut")),
            status && status.doubao && status.doubao.updatedAt
              ? h("span", { className: "__dbi_hint" }, t("doubaoUpdatedAt") + ": " + status.doubao.updatedAt)
              : null
          ),
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("doubaoDesc")),
          h("div", { className: "__dbi_row" },
            h("button", { type: "button", className: "__dbi_btn __dbi_btnPrimary", onClick: onDoubaoBrowserLogin, disabled: busy }, t("doubaoBrowserLogin")),
            h("button", { type: "button", className: "__dbi_btn __dbi_btnDanger", onClick: onDoubaoLogout, disabled: busy || !doubaoLoggedIn }, t("doubaoLogout")),
            h("button", { type: "button", className: "__dbi_btn", onClick: onDoubaoResetProfile, disabled: busy }, t("doubaoResetProfile")),
            /*
             * 「新开会话」只在固定会话打开时出现：关着的时候每次生图本来就是
             * 新会话，这个按钮没有意义，露出来只会让用户以为它能做别的事。
             */
            reuseConversation
              ? h("button", { type: "button", className: "__dbi_btn", onClick: onNewConversation, disabled: busy }, t("newConversation"))
              : null
          ),
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("doubaoBrowserHint")),
          /*
           * 多账号说明放在按钮旁边而不是折叠起来：用户点「登录」之前就该知道
           * 「再登一个会加成第二个账号，而不是覆盖原来那个」。
           */
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("doubaoMultiHint")),
          /*
           * 「重置登录环境」的说明单独一行：它是个有破坏性的按钮（删登录态），
           * 用户点之前该知道什么时候用它、点完会怎样。
           */
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("doubaoResetHint")),
          accountList(),
          dbBrowser.state !== "idle"
            ? h("span", { className: dbBrowser.state === "error" ? "__dbi_error" : "__dbi_status" },
                dbBrowser.state === "waiting" ? t("doubaoBrowserWaiting") : dbBrowser.message)
            : null,
          h("label", { className: "__dbi_field" },
            h("span", { className: "__dbi_label" }, t("doubaoCookie")),
            h("span", { className: "__dbi_hint" }, t("doubaoCookieHint")),
            h("input", { className: "__dbi_input", type: "text", value: cookieDraft, placeholder: t("doubaoCookiePlaceholder"), disabled: busy || !writable, onChange: function (e) { setCookieDraft(e.target.value); clearNotice(); } })
          ),
          h("div", { className: "__dbi_row" },
            h("button", { type: "button", className: "__dbi_btn", onClick: onSaveCookie, disabled: busy || !writable }, t("doubaoSaveCookie"))
          )
        ),

        // ── GPT ────────────────────────────────────────────────────────
        h("div", { className: "__dbi_group" },
          h("div", { className: "__dbi_row" },
            h("span", { className: "__dbi_label" }, t("gptTitle")),
            badge(gptLoggedIn, t("gptLoggedIn"), t("gptLoggedOut")),
            status && status.gpt && status.gpt.updatedAt
              ? h("span", { className: "__dbi_hint" }, t("gptUpdatedAt") + ": " + status.gpt.updatedAt)
              : null
          ),
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("gptDesc")),
          h("div", { className: "__dbi_row" },
            h("button", { type: "button", className: "__dbi_btn __dbi_btnPrimary", onClick: onEdgeLogin, disabled: busy }, t("gptEdgeLogin")),
            h("button", { type: "button", className: "__dbi_btn __dbi_btnDanger", onClick: onGptLogout, disabled: busy || !gptLoggedIn }, t("gptLogout"))
          ),
          h("p", { className: "__dbi_hint", style: { margin: 0 } }, t("gptEdgeLoginHint")),
          edgeStateText ? h("span", { className: edge.state === "error" ? "__dbi_error" : "__dbi_status" }, edgeStateText) : null,
          h("label", { className: "__dbi_field" },
            h("span", { className: "__dbi_label" }, t("gptToken")),
            h("span", { className: "__dbi_hint" }, t("gptTokenHint")),
            h("input", { className: "__dbi_input", type: "text", value: tokenDraft, placeholder: t("gptTokenPlaceholder"), disabled: busy || !writable, onChange: function (e) { setTokenDraft(e.target.value); clearNotice(); } })
          ),
          h("div", { className: "__dbi_row" },
            h("button", { type: "button", className: "__dbi_btn", onClick: onSaveToken, disabled: busy || !writable }, t("gptSaveToken"))
          )
        ),

        // ── 通用设置 ────────────────────────────────────────────────────
        h("div", { className: "__dbi_group" },
          h("span", { className: "__dbi_label" }, t("settingsTitle")),
          CONFIG_FIELDS.map(function (field) {
            if (field.kind === "checkbox") {
              return h("label", { key: field.key, className: "__dbi_field" },
                h("span", { className: "__dbi_row", style: { gap: 6 } },
                  h("input", { className: "__dbi_check", type: "checkbox", checked: Boolean(fieldValue(field)), disabled: busy || !writable, onChange: function (e) { setField(field, e.target.checked); } }),
                  h("span", { className: "__dbi_label" }, t(field.label))
                ),
                field.hint ? h("span", { className: "__dbi_hint" }, t(field.hint)) : null
              );
            }
            return h("label", { key: field.key, className: "__dbi_field" },
              h("span", { className: "__dbi_label" }, t(field.label)),
              field.hint ? h("span", { className: "__dbi_hint" }, t(field.hint)) : null,
              h("input", {
                className: "__dbi_input",
                type: field.kind === "text" ? "text" : "number",
                min: field.kind === "text" ? undefined : 1,
                value: fieldValue(field),
                placeholder: field.key === "proxyUrl" ? t("gptProxyPlaceholder") : undefined,
                disabled: busy || !writable,
                onChange: function (e) { setField(field, e.target.value); },
              })
            );
          }),
          h("div", { className: "__dbi_row" },
            h("button", { type: "button", className: "__dbi_btn __dbi_btnPrimary", onClick: onSaveConfig, disabled: busy || !writable }, t("save")),
            notice ? h("span", { className: "__dbi_ok" }, messageText(notice)) : null,
            busy ? h("span", { className: "__dbi_status" }, t("saving")) : null,
            error ? h("span", { className: "__dbi_error", role: "alert" }, messageText(error)) : null
          )
        ),

        // ── 画廊 ────────────────────────────────────────────────────────
        h(GallerySection, { t: t })
      );
    }

    // ── 对话内结果卡片与「图提升」 ───────────────────────────────────────

    /**
     * 本插件结果节点的 kind。
     *
     * **绝不能与 dsh-image-gen 的 `dsh-image-result` 相同**：两者都是全局注册的
     * chat node definition，kind 冲突会让后注册的那个直接抛错
     * （`uiConversation.events.register` 的契约是「already registered」即失败）。
     */
    var IMAGE_RESULT_NODE_KIND = "dsh-doubao-image-result";

    /** 写进 `presentationMeta` 的插件标记，用来把自己和别的插件的 tool/result 区分开。 */
    var META_MARK = "dsh-doubao-image";

    /**
     * 校验 Host 投影过来的 attachment。
     *
     * 形状规则与官方 `imageAttachment`（`dsh-image-gen/lib/client.js:123788`）
     * 逐条对齐：`mediaType` 必须在白名单里，`bytes`/`width`/`height` 必须是正安全整数。
     * 这里**不能**信任 Host —— meta 会经过序列化，缺字段或类型漂移都可能发生，
     * 形状不对就当没有图（宁可不显示，也不要发一个注定 400 的请求）。
     */
    function imageAttachmentFromMeta(value) {
      if (!value || typeof value !== "object") return null;
      if (typeof value.attachmentId !== "string") return null;
      if (gallery.IMAGE_MEDIA_TYPES.indexOf(value.mediaType) === -1) return null;
      if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) return null;
      if (!Number.isSafeInteger(value.width) || value.width <= 0) return null;
      if (!Number.isSafeInteger(value.height) || value.height <= 0) return null;
      return {
        attachmentId: value.attachmentId,
        mediaType: value.mediaType,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
      };
    }

    /**
     * 从工具结果块的 meta 解析可提升的图片结果。
     *
     * meta 由 Host 的 `presentationMeta` 投影而来。只认自己的标记
     * （`meta.plugin === META_MARK`）——别的插件的 tool/result 事件必须原样放过。
     * 视频的 meta 里 `attachment` 是 undefined（`saveFile` 产物没有
     * `mediaType`/`width`/`height`），这里自然返回空数组。
     *
     * **多图**：豆包一次可以出多张，Host 把第 1 张放在 `attachment`、其余放在
     * `attachments[]`。这里按 [attachment, ...attachments] 拼全 —— 早期版本
     * 只看 `attachment`，症状是「要了 3 张只在对话里看到 1 张」（第 2、3 张
     * 落盘了但从不渲染）。坏项单独丢弃，不连累其余的图。
     */
    function imageResultsFromMeta(meta) {
      if (!meta || typeof meta !== "object" || meta.plugin !== META_MARK) return [];

      var raw = [];
      if (meta.attachment !== undefined && meta.attachment !== null) raw.push(meta.attachment);
      if (Array.isArray(meta.attachments)) {
        for (var i = 0; i < meta.attachments.length; i++) raw.push(meta.attachments[i]);
      }

      var results = [];
      for (var j = 0; j < raw.length; j++) {
        var attachment = imageAttachmentFromMeta(raw[j]);
        // 形状不合法就跳过这一张：宁可不显示，也不要发一个注定 400 的请求。
        if (attachment === null) continue;
        results.push({
          attachment: attachment,
          prompt: typeof meta.prompt === "string" ? meta.prompt : "",
          provider: typeof meta.provider === "string" ? meta.provider : "",
          kind: typeof meta.kind === "string" ? meta.kind : "image",
          model: typeof meta.model === "string" ? meta.model : "",
          ratio: typeof meta.ratio === "string" ? meta.ratio : "",
          // 工作区落盘路径（Host 在 presentationMeta 里投影）。老 Host 没有
          // 这个字段，读成空串即可，卡片会自然退化成不显示路径行。
          savedTo: typeof meta.savedTo === "string" ? meta.savedTo : "",
        });
      }
      return results;
    }

    /** 结果块的 meta：宿主放在 `block.meta` 或 `block.resultView.meta`。 */
    function resultMetaFromBlock(block) {
      if (!block) return {};
      if (block.meta && typeof block.meta === "object") return block.meta;
      var view = block.resultView;
      if (view && view.meta && typeof view.meta === "object") return view.meta;
      return {};
    }

    /**
     * 从工具结果块的 meta 解析视频结果（0 或 1 条）。
     *
     * 视频与图片走**两套字段**：Host 的 `presentationMeta` 把图片放在
     * `attachment`、视频放在 `videoAttachment`（理由见 index.js 那段注释：
     * 视频引用没有 mediaType，混进 attachment 只会被图片校验器丢掉）。
     * 所以这里只认 `videoAttachment`，不去 `attachment` 里碰运气。
     *
     * @returns {{attachment: object, prompt: string, provider: string, model: string,
     *   ratio: string, duration: number, path: string, kind: string} | null}
     */
    function videoResultFromMeta(meta) {
      if (!meta || typeof meta !== "object" || meta.plugin !== META_MARK) return null;
      var raw = meta.videoAttachment;
      if (!raw || typeof raw !== "object") return null;
      // 借用存储层的同一个解析器：形状规则只有一份，两处不一致时
      // 就会出现「能存不能读」或反过来。
      var attachment = gallery.parseAttachmentRef(Object.assign({}, raw, { kind: gallery.VIDEO_KIND }));
      if (attachment === null) return null;
      return {
        attachment: attachment,
        prompt: typeof meta.prompt === "string" ? meta.prompt : "",
        provider: typeof meta.provider === "string" ? meta.provider : "",
        model: typeof meta.model === "string" ? meta.model : "",
        ratio: typeof meta.ratio === "string" ? meta.ratio : "",
        duration: typeof meta.duration === "number" && isFinite(meta.duration) ? meta.duration : 0,
        path: typeof meta.path === "string" ? meta.path : "",
        kind: gallery.VIDEO_KIND,
      };
    }

    /**
     * 从工具结果块取图片 attachment（兜底路径）。
     *
     * 与 dsh-image-gen 的 `imageRef` 同构：结果块带 `kind` 字段，图片项可能在
     * `resultView.content`（`card === "generic"`）或 `content` 里。取不到就返回
     * null —— 视频返回的是文本块，本来就没有 image 项。
     *
     * 这是**老宿主**（不投影 `attachment`）的兜底；新宿主走 `imageResultsFromMeta`。
     */
    function imageRefFromBlock(block) {
      if (!block || !("kind" in block)) return null;
      var view = block.resultView;
      var fromView = view && view.card === "generic" && Array.isArray(view.content)
        ? view.content.find(function (item) { return item && item.type === "image"; })
        : null;
      if (fromView) return fromView.attachment;
      var fromContent = Array.isArray(block.content)
        ? block.content.find(function (item) { return item && item.type === "image"; })
        : null;
      return fromContent ? fromContent.attachment : null;
    }

    /** 结果块 → 单个图片结果（含老宿主兜底）。**只取第一张**，多图请看 imageResultsFromBlock。 */
    function imageResultFromBlock(block) {
      return imageResultsFromBlock(block)[0] ?? null;
    }

    /**
     * 结果块 → 全部图片结果（多图卡片与提升节点共用）。
     *
     * 优先走 meta（新宿主会投影全部图），meta 取不到时退回结果块内容里
     * 的 image 块（老宿主兜底，那时只可能有第一张）。
     */
    function imageResultsFromBlock(block) {
      var fromMeta = imageResultsFromMeta(resultMetaFromBlock(block));
      if (fromMeta.length > 0) return fromMeta;

      var attachment = imageRefFromBlock(block);
      if (attachment === null) return [];
      var meta = resultMetaFromBlock(block);
      return [{
        attachment: attachment,
        prompt: typeof meta.prompt === "string" ? meta.prompt : "",
        provider: typeof meta.provider === "string" ? meta.provider : "",
        kind: "image",
        model: typeof meta.model === "string" ? meta.model : "",
        ratio: typeof meta.ratio === "string" ? meta.ratio : "",
        savedTo: typeof meta.savedTo === "string" ? meta.savedTo : "",
      }];
    }

    /**
     * 长路径缩略：保留末尾两段，前面用省略号代替。
     *
     * 卡片宽度有限，完整路径会把它撑变形；但路径的**区分度在末尾**
     * （目录都一样，文件名才不同），所以砍头不砍尾。完整值放 `title`。
     */
    function shortenPath(value) {
      var text = typeof value === "string" ? value : "";
      if (text.length <= 34) return text;
      var parts = text.split(/[\\/]+/).filter(function (part) { return part !== ""; });
      if (parts.length <= 2) return text;
      return "…\\" + parts.slice(-2).join("\\");
    }

    /**
     * 单张图片的结果卡（纯展示，不关心自己处在哪一层）。
     *
     * **为什么必须有**：内置 image 卡只认 `read_image`
     * （`dsh-client-ui-tool/lib/client.js:2825` 硬判 `call?.name !== "read_image"`），
     * 普通工具返回的 image 块没有任何渲染器 —— 实测症状是工具成功出图、
     * 对话里却不显示。官方 dsh-image-gen 同样是自注册卡片 + 自建取图路由。
     *
     * 图片字节走 Host 的 `POST /api/image`（同源、裸字节），不把豆包 CDN URL
     * 暴露到页面。
     */
    function ImageResultCard(props) {
      var t = props.t;
      var result = props.result;
      var attachment = result && result.attachment ? result.attachment : null;
      var prompt = result && typeof result.prompt === "string" ? result.prompt : "";
      var model = result && typeof result.model === "string" ? result.model : "";
      var ratio = result && typeof result.ratio === "string" ? result.ratio : "";
      var provider = result && typeof result.provider === "string" ? result.provider : "";
      // 工作区落盘路径；老 Host 没投影这个字段时为空串，卡片不显示这一行。
      var savedTo = result && typeof result.savedTo === "string" ? result.savedTo : "";

      var zoomPair = react.useState(false);
      var zoomed = zoomPair[0];
      var setZoomed = zoomPair[1];

      /**
       * E4：对话内重新生成。
       *
       * `regen` 三态对象：`{open, prompt, busy, message, error}`。按钮直接
       * `POST /api/regenerate`（与画廊 B8 共用同一路由与同一份
       * `buildRegenerateBody`），生成结果落进画廊 —— 对话区是只读的，
       * 我们不能往里插新消息，所以「新图去哪了」必须说清楚。
       */
      var regenPair = react.useState({ open: false, prompt: prompt, busy: false, message: "", error: "" });
      var regen = regenPair[0];
      var setRegen = regenPair[1];
      var regenAlive = react.useRef(true);
      react.useEffect(function () { return function () { regenAlive.current = false; }; }, []);

      // attachment 形状不合法时不取字节（useAttachmentUrl 内部也会再挡一层）。
      var state = useAttachmentUrl(attachment, attachment !== null);

      /**
       * 把这张图记进本地画廊。
       *
       * **为什么放在这里**：工具结果卡片是**唯一**能看到每张生成图的地方
       * （promoted 节点渲染同一批数据）。早期版本 `saveGalleryItem` 只有
       * 定义、全文件零调用点，症状就是设置页永远「共 0 张」。
       *
       * 依赖 `state.url`：只有字节真取到了才入库，避免把坏 ref 写进去；
       * `saveGalleryItem` 内部按 attachmentId 去重，重渲染不会产生重复记录。
       */
      react.useEffect(function () {
        if (attachment === null) return;
        if (state.url === "") return;
        if (galleryRecording.enabled !== true) return;
        gallery.saveGalleryItem(Object.assign({
          attachment: attachment,
          prompt: prompt,
          provider: provider,
          model: model,
          aspectRatio: ratio,
        }, gallery.workspaceFieldsFrom(props.cwd, props.sessionId)));
      }, [attachment, state.url, prompt, provider, model, ratio, savedTo, props.cwd, props.sessionId]);

      var metaLine = [];
      if (provider === "gpt") metaLine.push(t("resultProviderGpt"));
      else if (provider === "doubao") metaLine.push(t("resultProviderDoubao"));
      if (model !== "") metaLine.push(model);
      if (ratio !== "") metaLine.push(ratio);

      var children = [];
      if (prompt !== "") {
        children.push(h("div", { className: "__dbi_resultPrompt", title: prompt }, prompt));
      }

      if (attachment === null) {
        children.push(h("div", { className: "__dbi_resultMeta" }, t("resultVideoHint")));
      } else if (state.error !== "") {
        children.push(h("div", { className: "__dbi_resultError" }, t("resultErrorPrefix") + state.error));
      } else if (state.url === "") {
        children.push(h("div", { className: "__dbi_resultLoading" }, t("resultLoading")));
      } else {
        children.push(h("img", {
          className: "__dbi_resultImg",
          src: state.url,
          alt: prompt,
          onClick: function () { setZoomed(true); },
        }));
      }

      if (metaLine.length > 0) {
        children.push(h("div", { className: "__dbi_resultMeta" }, metaLine.join(" · ")));
      }

      /**
       * 工作区路径行。
       *
       * 让用户一眼看到「这张图也存成文件了、存在哪」。`title` 给完整路径，
       * 行内按尾部省略显示，避免长路径把卡片撑变形。
       */
      if (savedTo !== "") {
        children.push(h("div", {
          className: "__dbi_resultSavedTo",
          title: savedTo,
        }, t("resultSavedTo") + shortenPath(savedTo)));
      }

      if (zoomed && state.url !== "") {
        children.push(h("div", {
          className: "__dbi_lightbox",
          onClick: function () { setZoomed(false); },
        }, h("img", { className: "__dbi_lightboxImg", src: state.url, alt: prompt })));
      }

      return h("div", { className: "__dbi_result" }, children);
    }

    /**
     * 多图网格（E2 多图卡片 / `GeneratedImagesCard` 的等价物）。
     *
     * **为什么用网格而不是竖排**：豆包一次出 2–4 张时，竖排在对话里会拉出很
     * 长的一条，用户要滚很多屏才能看全。官方 dsh-image-gen 同样是网格。
     *
     * 列数交给 CSS 的 `auto-fill` + `minmax` 决定，不在 JS 里算宽度
     * ——组件拿不到容器宽度，硬算会在窄栏里溢出。
     */
    function ImageResultGrid(props) {
      var t = props.t;
      var results = props.results;
      return h("div", { className: "__dbi_resultGrid" }, results.map(function (result, index) {
        return h(ImageResultCard, {
          key: result.attachment.attachmentId + ":" + index,
          result: result,
          t: t,
          cwd: props.cwd,
          sessionId: props.sessionId,
          compact: true,
        });
      }));
    }

    /**
     * 一组图片结果（promoted 节点与多图卡片共用）。
     *
     * 单张仍竖排（保持原有视觉），多张走网格。
     */
    function ImageResultList(props) {
      var t = props.t;
      var results = props.results;
      if (results.length === 1) {
        return h("div", { className: "__dbi_resultList" },
          h(ImageResultCard, { result: results[0], t: t, cwd: props.cwd, sessionId: props.sessionId }));
      }
      return h("div", { className: "__dbi_resultList" },
        h("div", { className: "__dbi_resultMeta" }, t("resultCount", { n: results.length })),
        h(ImageResultGrid, { results: results, t: t, cwd: props.cwd, sessionId: props.sessionId }));
    }

    /**
     * 视频结果卡片（对话内那一份）。
     *
     * 与 `ImageResultCard` 的关系：**不复用它**。两者的 attachment 形状、
     * 预览元素（`<img>` vs `<video>`）、可做的操作都不一样（图片能重新
     * 生成，视频不能——重新生成要重跑 4 分钟且会再扣一次额度）。硬塞进
     * 一个组件会让每个分支都要问「这是不是视频」，反而更难读。
     *
     * 但**入画廊的规则完全一致**：同样走 `gallery.saveGalleryItem`、
     * 同样带工作区字段、同样只在字节真取到之后才入库。
     */
    function VideoResultCard(props) {
      var t = props.t;
      var result = props.result;
      var attachment = result && result.attachment ? result.attachment : null;
      var prompt = result && typeof result.prompt === "string" ? result.prompt : "";
      var model = result && typeof result.model === "string" ? result.model : "";
      var duration = result && typeof result.duration === "number" ? result.duration : 0;

      var state = useAttachmentUrl(attachment, attachment !== null);

      /*
       * 入画廊。与 `ImageResultCard` 同一条判据（字节到手才写），
       * 差别只在多带一个 `kind` —— 存储层靠它把记录归到「视频」栏。
       */
      react.useEffect(function () {
        if (attachment === null) return;
        if (state.url === "") return;
        if (galleryRecording.enabled !== true) return;
        gallery.saveGalleryItem(Object.assign({
          attachment: attachment,
          prompt: prompt,
          provider: result && typeof result.provider === "string" ? result.provider : "",
          model: model,
          kind: gallery.VIDEO_KIND,
          aspectRatio: result && typeof result.ratio === "string" ? result.ratio : "",
        }, gallery.workspaceFieldsFrom(props.cwd, props.sessionId)));
      }, [attachment, state.url, prompt, model, result, props.cwd, props.sessionId]);

      var children = [];
      if (state.url !== "") {
        /*
         * `preload="metadata"`：只拉头部拿到首帧与时长，不下载整段视频。
         * 不给 `controls` —— 对话里的卡片是「预览」，真正的播放交给画廊
         * 灯箱；这里给 controls 会和下方的下载/查看按钮功能重复。
         */
        children.push(h("video", {
          className: "__dbi_resultVideo",
          key: "v",
          src: state.url,
          preload: "metadata",
          muted: true,
          playsInline: true,
        }));
      } else {
        children.push(h("div", { className: "__dbi_resultMeta", key: "v" }, state.error !== "" ? state.error : t("loading")));
      }
      if (duration > 0) {
        children.push(h("div", { className: "__dbi_resultMeta", key: "d" }, duration.toFixed(1) + "s"));
      }
      if (prompt !== "") {
        children.push(h("div", { className: "__dbi_resultPrompt", key: "p" }, prompt));
      }
      return h("div", { className: "__dbi_result" }, children);
    }

    /**
     * `tool.call.toolview` 的卡片：折叠区内那一份。
     *
     * **提升生效时这里只留一行提示**，真正的图由 `PromotedImageResultNode`
     * 渲染成独立对话行 —— 否则同一张图会出现两次（官方 `PromotedResultNotice`
     * 就是干这个的）。
     *
     * 视频结果不会被提升（`imageResultsFromMeta` 对 video 返回空数组），
     * 所以这里仍要能把「无图」的情况渲染成文本卡。
     */
    function ResultCard(props) {
      var t = props.t;
      var block = props.block;
      var results = imageResultsFromBlock(block);

      if (props.promoted === true && results.length > 0) {
        return h("div", { className: "__dbi_promotedNotice" }, t("resultPromoted"));
      }

      if (results.length > 0) {
        /**
         * 多图时用网格（`GeneratedImagesCard` 的等价物），单图仍走单卡 ——
         * 单图套一层网格会多出一个无意义的容器层，视觉上没差别但 DOM 更脏。
         */
        if (results.length === 1) {
          return h(ImageResultCard, { result: results[0], t: t, cwd: props.cwd, sessionId: props.sessionId });
        }
        return h("div", { className: "__dbi_result" },
          h("div", { className: "__dbi_resultMeta" }, t("resultCount", { n: results.length })),
          h(ImageResultGrid, { results: results, t: t, cwd: props.cwd, sessionId: props.sessionId })
        );
      }

      // 无图（视频或失败）：视频有自己的卡片，失败则退化成文本。
      var meta = resultMetaFromBlock(block);
      var video = videoResultFromMeta(meta);
      if (video !== null) {
        return h(VideoResultCard, { result: video, t: t, cwd: props.cwd, sessionId: props.sessionId });
      }
      var view = block && block.resultView;
      var content = (view && view.card === "generic" ? view.content : block && block.content) || [];
      var texts = content.filter(function (item) { return item && item.type === "text"; });
      var children = [];
      if (meta.kind === "video") {
        children.push(h("div", { className: "__dbi_resultMeta" }, t("resultVideoHint")));
      }
      if (typeof meta.path === "string" && meta.path !== "") {
        children.push(h("div", { className: "__dbi_resultMeta" }, meta.path));
      }
      for (var i = 0; i < texts.length; i++) {
        children.push(h("div", { className: "__dbi_resultPrompt", key: i }, texts[i].text));
      }
      return h("div", { className: "__dbi_result" }, children);
    }

    /**
     * 被提升出来的图片结果节点（`conversation.chat.node`）。
     *
     * **为什么值得做**：默认情况下工具结果折叠在「已调用工具」卡片内，
     * 用户必须点开才能看到图。把结果注册成独立 chat node 后，图片直接
     * 出现在对话流里 —— 官方 dsh-image-gen 的做法完全一致。
     *
     * 节点数据由 `createImageResultDefinition()` 从事件流里构建。
     */
    function PromotedImageResultNode(props) {
      var t = props.t;
      var node = props.node;
      var results = node && node.data && Array.isArray(node.data.results) ? node.data.results : [];
      if (results.length === 0) return null;
      return h(ImageResultList, { results: results, t: t, cwd: props.cwd, sessionId: props.sessionId });
    }

    /** 取事件所属的 turn；形状不对返回 undefined（定义会被跳过）。 */
    function eventTurn(event) {
      var turn = event && event.data ? event.data.turn : undefined;
      return typeof turn === "number" && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined;
    }

    /**
     * 把图片工具结果提升成独立对话行的事件定义。
     *
     * 契约（`dsh-client-ui-conversation/lib/client.js:2647` 的
     * `ConversationEventRegistry.register`）：
     * - `kind` 全局唯一，重复注册直接抛错 —— 所以 kind 必须加插件前缀；
     * - `target` 与 `buildViewNode` 必须**同时**声明
     *   （`assertDefinitionTarget` L2688 会校验）；
     * - `match` 返回 `{id, role}`；`id` 用 `event.seq` 保证同一事件恒定；
     * - `start` 返回的状态会传给 `buildViewNode`。
     *
     * 只认自己 `presentationMeta` 打上 `plugin` 标记的结果，别的插件的
     * tool/result 事件一律返回 null 放过。
     */
    function createImageResultDefinition() {
      return {
        kind: IMAGE_RESULT_NODE_KIND,
        target: "chat",
        match: function (event) {
          if (!event || event.type !== "tool/result") return null;
          if (eventTurn(event) === undefined) return null;
          if (imageResultsFromMeta(event.data.meta).length === 0) return null;
          return { id: "result:" + event.seq, role: "start" };
        },
        start: function (context, match) {
          var turn = eventTurn(match.event);
          var results = imageResultsFromMeta(match.event.data.meta);
          if (turn === undefined || results.length === 0) {
            throw new Error("dsh-doubao-image result node requires an image tool result");
          }
          return {
            turn: turn,
            results: results.map(function (result) {
              return Object.assign({}, result, { seq: match.event.seq });
            }),
          };
        },
        /** 顶层工具调用一个事件即完整结果；后续事件不改状态。 */
        update: function (context) { return context.state; },
        buildViewNode: function (context) {
          var state = context.state;
          var first = state && Array.isArray(state.results) ? state.results[0] : undefined;
          if (first === undefined) return null;
          return {
            key: context.key,
            kind: IMAGE_RESULT_NODE_KIND,
            id: context.id,
            target: "chat",
            anchorSeq: first.seq,
            location: { kind: "session" },
            visibility: "visible",
            data: {
              turn: state.turn,
              results: state.results.map(function (result) {
                var copy = Object.assign({}, result);
                delete copy.seq;
                return copy;
              }),
            },
          };
        },
      };
    }

    /**
     * `uiConversation` 的可用性判定。
     *
     * 老宿主没有这个 service；`ctx.inject(["uiConversation"], ...)` 的
     * factory 会一直挂着等它出现。这里在 factory 内再判一次形状，
     * 不兼容就静默降级（只保留折叠区内的卡片），**不抛错**——抛错会让
     * 整个 client 半挂掉，设置页也跟着没了。
     */
    function asModernUiConversation(value) {
      if (value === null || typeof value !== "object") return undefined;
      var events = value.events;
      if (events === null || typeof events !== "object") return undefined;
      return typeof events.register === "function" ? value : undefined;
    }

    // ── plugin ───────────────────────────────────────────────────────────

    /**
     * 画廊是否在记录新图。
     *
     * 设置页的 `gallery.enabled` 是 Host 配置，卡片组件拿不到 scope，
     * 所以由 apply() 把它同步到这个模块级对象里。默认 true：配置还没
     * 读到时宁可记录，也不要因为一次读失败让用户永久丢图。
     */
    var galleryRecording = { enabled: true };

    function applyGalleryRecording(value) {
      var galleryValue = value && typeof value === "object" && value.gallery && typeof value.gallery === "object"
        ? value.gallery
        : {};
      galleryRecording.enabled = galleryValue.enabled !== false;
    }

    /* ── 给包内 chunk 用的共享运行时 ──────────────────────────────────────
     *
     * DSH 原生支持按需加载**包内 chunk**：主 bundle 调
     * `require.async("./client.x.js")`，宿主会去
     * `<bundle>/<id>/client.x.js?rev=<rev>` 取文件并执行它自己的
     * `window.__ModuleLoader__.load({id, chunk, factory})` 注册。
     * （已实测：`dsh-client-modules/lib/index.js:913-954` 的 `chunkRequest`，
     *  以及真实浏览器里 1.87 MB 的 tldraw chunk 加载成功。）
     *
     * chunk 的 factory 只拿得到平台种子词（react 等）——**拿不到本模块的
     * 内部函数**。所以公共设施从这里共享出去，避免每个 chunk 各复制一份
     * 而互相漂移。`exports.__shared` 与全局对象两条路都留着：
     * 前者给用 `exports.__shared` 引本包的场景，后者给不便引包的场景。
     */
    var shared = {
      react: react,
      h: h,
      NS: NS,
      BASE: BASE,
      IMAGE_ROUTE: IMAGE_ROUTE,
      /* 视频字节路由。画廊 chunk 的下载与视频卡都靠它，缺了会退回图片路由。 */
      VIDEO_ROUTE: VIDEO_ROUTE,
      gallery: gallery,
      useAttachmentUrl: useAttachmentUrl,
      useLocale: useLocale,
      useGalleryTick: useGalleryTick,
      parseAttachmentRef: gallery.parseAttachmentRef,
      isItemInWorkspace: gallery.isItemInWorkspace,
      normalizeWorkspacePath: gallery.normalizeWorkspacePath,
      /**
       * 工作区归属字段的推导（两份纯函数），chunk 里也要用。
       *
       * 为什么共享而不是各写一份：`client.gallery.js` 的导入 / 工作台生成
       * 与主 bundle 的工具结果卡必须产生**逐字一致**的字段名与「空即不写」
       * 语义，否则 `collectWorkspaces` 会按不同口径收出重复工作区。
       */
      workspaceFieldsFrom: gallery.workspaceFieldsFrom,
      pickSessionCwd: gallery.pickSessionCwd,
      /**
       * chunk 之间互相懒加载。
       *
       * 为什么共享：`client.gallery.js` 是 rail-tabs 容器，灵感库与工作台
       * 由它内嵌，而这两个实现分别在 `client.inspiration.js` 与
       * `client.studio.js` 里。每个 chunk 各写一份 useChunk 必然漂移
       * （判据、错误文案、重试语义都会分叉）。
       */
      useChunk: useChunk,
      ChunkMount: ChunkMount,
      /**
       * 过渡期共享：gallery chunk 的骨架先直接复用主 bundle 这份画廊实现，
       * 让「主 bundle → chunk」的加载链路先跑通、画廊功能不中断。
       * chunk 长出完整实现后就不再引用它（届时删掉这一行）。
       */
      GallerySection: GallerySection,
      /** chunk 各自注入样式：class 全是自定义前缀，宿主不会代劳。 */
      injectCss: function (tagId, css) {
        if (typeof document === "undefined") return;
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-doubao-image";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      },
    };
    if (typeof globalThis !== "undefined") globalThis.__dshDoubaoImageShared = shared;
    exports.__shared = shared;

    /**
     * 懒加载一个包内 chunk，只在组件首次渲染时下载一次。
     *
     * 为什么槽注册在主 bundle 里、组件实现却在 chunk 里：槽注册必须在
     * `apply()` 里同步完成，而 chunk 只能异步取；所以注册一个瘦包装组件，
     * 真正的实现等用户切到那个标签页时再下载。
     */
    function useChunk(fileName) {
      var pair = react.useState(null);
      var mod = pair[0];
      var setMod = pair[1];
      react.useEffect(function () {
        var alive = true;
        if (typeof require.async !== "function") return;
        require.async("./" + fileName).then(function (m) {
          if (alive) setMod(m);
        }).catch(function () {
          if (alive) setMod({ __loadError: fileName });
        });
        return function () { alive = false; };
      }, [fileName]);
      return mod;
    }

    /** 把 chunk 的 `Mount` 组件接进槽：加载中显示占位，失败显示原因。 */
    function ChunkMount(props) {
      var mod = useChunk(props.chunk);
      if (mod === null) return h("div", { className: "__dbi_loading" }, props.loadingText || "…");
      if (mod.__loadError !== undefined) {
        return h("div", { className: "__dbi_error" }, (props.errorText || "chunk load failed") + ": " + mod.__loadError);
      }
      if (typeof mod.Mount !== "function") return h("div", { className: "__dbi_error" }, "chunk has no Mount");
      return h(mod.Mount, props);
    }

    /**
     * 用户输入关键词拦截：监听对话区新消息，匹配「新建画布」等关键词后
     * 自动打开工作台。
     *
     * 实现：MutationObserver 监听 document.body 子树，当有新节点加入时
     * 扫描其文本内容，匹配关键词即触发 openStudioTab()。
     *
     * 防重复触发：
     * 1. 已触发的 sessionId 记录在一个 Set 里，同一 sessionId 只触发一次
     * 2. 全局 30 秒节流，防止短时间多次触发
     *
     * 注意：这里只是额外监听，不阻止消息正常发送。
     */
    var STUDIO_KEYWORD_RE = /新建画布|打开画布|new\s*canvas|创建工作台|打开工作台/i;
    var studioTriggeredSessions = new Set();
    var studioLastTriggerTime = 0;
    /** apply 内绑定的 locale t 函数，供 openStudioTab 取「画廊」文案。 */
    var studioT = null;

    /**
     * 切换到画廊标签页并打开工作台。
     *
     * 提取自原按钮的 onClick 逻辑，现在由关键词拦截触发。
     *
     * @param {string|undefined} sessionId 当前会话 ID，用于写 localStorage view 偏好
     */
    function openStudioTab(sessionId) {
      // 找到 conversation.view 标签按钮并模拟点击
      try {
        var galleryLabel = studioT ? studioT("galleryTitle") : "画廊";
        var tabsContainer = document.querySelector('[data-conversation-tabs]');
        if (tabsContainer) {
          var tabBtns = tabsContainer.querySelectorAll('button');
          for (var i = 0; i < tabBtns.length; i++) {
            var btnText = tabBtns[i].textContent || "";
            var btnId = tabBtns[i].getAttribute("data-tab-id") || tabBtns[i].getAttribute("aria-label") || "";
            if (btnId === "doubao-gallery" || btnText.indexOf(galleryLabel) >= 0) {
              tabBtns[i].click();
              break;
            }
          }
        } else {
          // 新会话可能没有标签页容器，尝试直接找所有按钮中含「画廊」的
          var allBtns = document.querySelectorAll('button');
          for (var j = 0; j < allBtns.length; j++) {
            var txt = allBtns[j].textContent || "";
            if (txt.indexOf(galleryLabel) >= 0) {
              allBtns[j].click();
              break;
            }
          }
        }
      } catch (e) {
        console.warn("[doubao-image] tab click failed:", e && e.message);
      }

      // 写 localStorage view 偏好（仅当有 sessionId 时）
      if (sessionId !== undefined) {
        try {
          var storeKey = "dsh.conversation." + sessionId;
          var raw = localStorage.getItem(storeKey);
          var stored = raw !== null ? JSON.parse(raw) : {};
          stored.view = "doubao-gallery";
          localStorage.setItem(storeKey, JSON.stringify(stored));
        } catch (e) {
          console.warn("[doubao-image] localStorage write failed:", e && e.message);
        }
      }
      if (typeof globalThis !== "undefined") {
        globalThis.__dshDoubaoImageOpenStudio = true;
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("dsh-doubao-image:open-studio"));
      }
    }

    function tryInterceptStudioKeyword(node) {
      if (!node || !node.textContent) return;
      var text = node.textContent;
      if (!STUDIO_KEYWORD_RE.test(text)) return;

      // 30 秒节流
      var now = Date.now();
      if (now - studioLastTriggerTime < 30000) return;

      // 尝试从 DOM 找当前 sessionId（从最近的 [data-session-id] 属性）
      var sessionId = undefined;
      try {
        var sessionEl = node.closest && node.closest('[data-session-id]');
        if (sessionEl) {
          sessionId = sessionEl.getAttribute('data-session-id') || undefined;
        }
      } catch (_) {}

      // 如果 sessionId 已知且已触发过，跳过
      if (sessionId !== undefined && studioTriggeredSessions.has(sessionId)) return;

      // 标记已触发
      if (sessionId !== undefined) {
        studioTriggeredSessions.add(sessionId);
      }
      studioLastTriggerTime = now;

      console.log("[doubao-image] intercepted studio keyword, opening studio tab", { sessionId: sessionId });
      openStudioTab(sessionId);
    }

    /**
     * 启动 MutationObserver 监听用户输入。
     *
     * 只在浏览器环境（有 document.body）下启动；Node 环境（自测）跳过。
     *
     * 监听策略：观察 document.body 的子树，当有新节点加入时，
     * 扫描其文本内容是否包含关键词。为了避免频繁遍历，只在
     * 新增节点数量较少时检查（大量节点变更通常是页面切换）。
     */
    function startStudioKeywordInterceptor() {
      if (typeof document === "undefined" || !document.body) return;
      if (typeof MutationObserver === "undefined") return;

      var observer = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var mutation = mutations[m];
          if (mutation.type !== 'childList') continue;
          var addedNodes = mutation.addedNodes;
          if (!addedNodes || addedNodes.length === 0) continue;
          // 大量节点变更通常是页面切换，跳过以避免误触发
          if (addedNodes.length > 50) continue;
          for (var n = 0; n < addedNodes.length; n++) {
            var node = addedNodes[n];
            // 只检查元素节点和文本节点
            if (node.nodeType !== 1 && node.nodeType !== 3) continue;
            tryInterceptStudioKeyword(node);
          }
        }
      });

      try {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
        });
      } catch (e) {
        console.warn("[doubao-image] failed to start keyword interceptor:", e && e.message);
      }
    }

    /**
     * @param {object} ctx Cordis 上下文
     */
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      // 缓存给 openStudioTab 用
      studioT = t;
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-doubao-image: dictionaries");

      // 命名空间只 bind 一次。
      var scope = ctx.configForms.get("doubao-image");

      // 让结果卡片知道「画廊是否在记录」。scope 变化时同步一次。
      try {
        applyGalleryRecording(scope.getSnapshot().value);
      } catch {
        applyGalleryRecording(null);
      }
      if (typeof scope.subscribe === "function") {
        ctx.effect(function () {
          return scope.subscribe(function () {
            try {
              applyGalleryRecording(scope.getSnapshot().value);
            } catch {
              applyGalleryRecording(null);
            }
          });
        }, "dsh-doubao-image: gallery recording flag");
      }

      /**
       * 提升是否真的装上了。
       *
       * 卡片要据此决定「只留一行提示」还是「自己渲染图」——
       * 如果 `uiConversation` 不存在（老宿主）却仍然只留提示，用户就永远
       * 看不到图了。
       */
      var promotion = { enabled: false };

      /**
       * 「新建画布」命令的状态通道。
       *
       * `ctx.inject(["uiConversation"], ...)` 的 factory 可能还没跑，
       * 所以这里用模块级闭包变量在 factory 跑过之后把实例塞进来。
       */
      var openStudio = { uiConversation: null };

      // 启动关键词拦截（浏览器环境下）
      startStudioKeywordInterceptor();

      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({
          name: "plugins.bundle.config",
          key: "dsh-doubao-image-free",
          locale: NS,
        }, function (props) {
          return h(DoubaoImageSection, Object.assign({}, props, { scope: scope, t: t, locale: ctx.locale }));
        });
      });

      /**
       * 把图片结果提升成独立对话行。
       *
       * 契约与官方 dsh-image-gen 相同：`uiConversation.events.register(...)`
       * 注册事件定义，`conversation.chat.node` 注册渲染器（key 必须是
       * 定义里的 `kind`）。
       *
       * `ctx.inject` 的 factory 在 service 缺失时会一直挂着等待，所以这里
       * 必须做形状判定并静默降级，绝不能抛错（抛错会连设置页一起搞挂）。
       */
      ctx.inject(["uiConversation"], function (owner) {
        promotion.injected = true;
        var uiConversation = asModernUiConversation(owner.get("uiConversation"));
        if (uiConversation === undefined) {
          promotion.reason = "incompatible-uiConversation";
          return;
        }
        // 让「新建画布」按钮能程序化切换 conversation.view。
        openStudio.uiConversation = uiConversation;
        var ownerRegister = owner.slots.register.bind(owner.slots);
        owner.effect(function () {
          return uiConversation.events.register(createImageResultDefinition());
        }, "dsh-doubao-image: promoted image result node");
        owner.slots.inject("conversation.chat.node", function () {
          return ownerRegister({
            name: "conversation.chat.node",
            key: IMAGE_RESULT_NODE_KIND,
            locale: NS,
          }, function (props) {
            return h(PromotedImageResultNode, Object.assign({}, props, { t: t }));
          });
        });
        promotion.enabled = true;
        promotion.reason = "ok";
      });

      /**
       * 对话内结果卡片：key 必须与 Host 注册的工具名逐字一致
       * （`dsh-client-ui-tool/lib/client.js:1863` 用 `entryKey: toolName` 查表）。
       * 两个工具各注册一张，缺一个那个工具就退化成通用卡片。
       */
      var resultCard = function (props) {
        return h(ResultCard, Object.assign({}, props, { t: t, promoted: promotion.enabled }));
      };
      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register({
          name: "tool.call.toolview",
          key: "doubao_image",
          locale: NS,
        }, resultCard);
      });
      ctx.slots.inject("tool.call.toolview", function () {
        return ctx.slots.register({
          name: "tool.call.toolview",
          key: "gpt_image",
          locale: NS,
        }, resultCard);
      });

      /**
       * 对话页的「画廊」入口。
       *
       * 契约（`cordis_inspect_query` client/Slots/listSubTree 实测）：
       * `conversation.view` 是 **list 槽**、`scope: session`、
       * 注册参数 `{id, order?, label?}` —— **没有 key**
       * （传 `key` 会注册失败）。官方 dsh-image-gen 用
       * `id: "gallery"` / `order: 20`（`lib/client.js:125553`），这里沿用同一形态。
       */
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "doubao-gallery",
          order: 20,
          label: function () { return t("galleryTitle"); },
          locale: NS,
        }, function (props) {
          /*
           * 真正的实现在包内 chunk 里，切到这个标签页时才下载。
           *
           * 为什么不在主 bundle 里直接渲染：画廊（含后续的灵感库与工作台）
           * 会持续长大，全塞进主 bundle 会让**每次打开 DSH** 都付这份体积；
           * 而 `conversation.view` 的注册必须同步完成，所以这里注册一个瘦
           * 包装组件，重活留给 `require.async`。
           *
           * **工作区**：本槽的 ownerProps 没有 `cwd`（只有 chat node 与
           * tool view 有），得自己从 standardProps 的 `useSessions` 里查
           * （官方同款写法见 `dsh-client-ui-tool/lib/client.js:2434`）。
           * 这里是整个画廊唯一允许调 `useSessions` 的地方 —— 再往下的组件
           * 一律通过 props 收 `cwd`，否则 hook 次数会随渲染分支变化。
           *
           * **selector 必须返回原语**：`useSyncExternalStore` 按 `Object.is`
           * 比较快照，返回新对象会让它判定「每次都变」并无限重渲染。
           * `gallery.pickSessionCwd` 正好只返回字符串，直接当 selector 本体。
           */
          var cwd = "";
          if (typeof props.useSessions === "function") {
            var found = props.useSessions(function (list) {
              return gallery.pickSessionCwd(list, props.sessionId);
            });
            if (typeof found === "string") cwd = found;
          }
          return h(ChunkMount, {
            chunk: "client.gallery.js",
            locale: ctx.locale,
            sessionId: props.sessionId,
            cwd: cwd,
            loadingText: t("galleryLoading"),
            errorText: t("galleryNoRoute"),
          });
        });
      });

      /**
       * apply 完成的自报标记。
       *
       * 为什么需要：离线自测用的是假 ctx，`browser-verify.mjs` 靠「样式注入了」
       * 间接推断 factory 跑过——都证明不了**槽真的注册进了真实运行时**。
       * 浏览器里又拿不到槽表（DSH 把它留在模块作用域内）。本机已有此惯例：
       * `dsh-client-ui-task-board/lib/client.js:3060` 就是
       * `globalThis.__dshTaskboardApplied = true`。这里记下实际注册的 key，
       * 让浏览器验证能直接读到结果。
       */
      if (typeof globalThis !== "undefined") {
        /**
         * 自报标记用 **getter** 暴露实时状态。
         *
         * 为什么不能用快照：`ctx.inject(["uiConversation"], factory)` 的 factory
         * 要等 service 就绪才跑，可能晚于 `apply()` 返回。快照会在 factory
         * 执行前就固化成 `promoted: false`，把「还没跑」误报成「跑失败」。
         */
        globalThis.__dshDoubaoImageApplied = {
          keys: ["doubao_image", "gpt_image"],
          bundleKey: "dsh-doubao-image",
          promotedKind: IMAGE_RESULT_NODE_KIND,
          get promoted() { return promotion.enabled === true; },
          get promotionInjected() { return promotion.injected === true; },
          get promotionReason() { return promotion.reason ?? "pending"; },
        };
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    // 给自测留出内部句柄（不影响运行时）。
    exports.__internals = {
      NS: NS,
      IMAGE_RESULT_NODE_KIND: IMAGE_RESULT_NODE_KIND,
      META_MARK: META_MARK,
      imageResultsFromMeta: imageResultsFromMeta,
      videoResultFromMeta: videoResultFromMeta,
      VideoResultCard: VideoResultCard,
      imageResultFromBlock: imageResultFromBlock,
      imageAttachmentFromMeta: imageAttachmentFromMeta,
      shortenPath: shortenPath,
      createImageResultDefinition: createImageResultDefinition,
      asModernUiConversation: asModernUiConversation,
      ResultCard: ResultCard,
      ImageResultCard: ImageResultCard,
      PromotedImageResultNode: PromotedImageResultNode,
      BASE: BASE,
      ROUTE_STATUS: ROUTE_STATUS,
      ROUTE_DOUBAO_SESSION: ROUTE_DOUBAO_SESSION,
      ROUTE_DOUBAO_COOKIE: ROUTE_DOUBAO_COOKIE,
      ROUTE_GPT_EDGE_LOGIN: ROUTE_GPT_EDGE_LOGIN,
      ROUTE_GPT_TOKEN: ROUTE_GPT_TOKEN,
      ROUTE_GPT_SESSION: ROUTE_GPT_SESSION,
      IMAGE_ROUTE: IMAGE_ROUTE,
      CONFIG_FIELDS: CONFIG_FIELDS,
      parseSize: parseSize,
      parsePositiveInt: parsePositiveInt,
      validateField: validateField,
      settingsOpsApplied: settingsOpsApplied,
      readPathValue: readPathValue,
      commitSettingsOps: commitSettingsOps,
      buildConfigOps: buildConfigOps,
      zh: zh,
      en: en,
      // 画廊持久层已内联进本文件，测试通过这里拿到它（浏览器里不需要）。
      gallery: gallery,
      // 「画廊是否在记录」的开关与 setter，供自测直接驱动。
      galleryRecording: galleryRecording,
      applyGalleryRecording: applyGalleryRecording,
      // 对话内结果卡的纯函数，供自测直接断言。
      imageRefFromBlock: imageRefFromBlock,
      resultMetaFromBlock: resultMetaFromBlock,
      ResultCard: ResultCard,
      // 关键词拦截与切换逻辑，供自测直接驱动。
      openStudioTab: openStudioTab,
      tryInterceptStudioKeyword: tryInterceptStudioKeyword,
      STUDIO_KEYWORD_RE: STUDIO_KEYWORD_RE,
      studioTriggeredSessions: studioTriggeredSessions,
      get studioLastTriggerTime() { return studioLastTriggerTime; },
      set studioLastTriggerTime(v) { studioLastTriggerTime = v; },
      // 清空节流与去重状态。仅自测用：节流是模块级全局状态，
      // 用例之间必须能隔离，否则前一个用例的节流会吞掉后一个用例的首次触发。
      __resetStudioThrottleForTest: function () {
        studioLastTriggerTime = 0;
        studioTriggeredSessions.clear();
      },
      // 设置页通道状态徽章那三件套。纯函数（buildProviderStatusList /
      // updatedAtText）要能脱离 DOM 直接断言文案与边界，组件也要能直接渲染。
      ProviderStatusBadge: ProviderStatusBadge,
      buildProviderStatusList: buildProviderStatusList,
      updatedAtText: updatedAtText,
      // 账号行的纯数据（渲染与断言共用一份判断逻辑）。
      doubaoAccountRows: doubaoAccountRows,
      // 多图渲染链。`imageResultsFromBlock` 是「meta 优先、老宿主兜底」的
      // 合流点，单测必须能单独喂它；两个容器组件按张数决定竖排还是网格，
      // 只能靠渲染后数 DOM 才能验证。
      imageResultsFromBlock: imageResultsFromBlock,
      ImageResultGrid: ImageResultGrid,
      ImageResultList: ImageResultList,
      /*
       * 共享运行时对象本身。
       *
       * 为什么连 `shared` 也导出：`client.gallery.js` / `client.studio.js`
       * 里的每个写入点都靠 `shared.workspaceFieldsFrom` 取推导函数，而这个
       * 键一旦在 `shared` 上消失（改名 / 漏挂），两个 chunk 会静默退化成
       * 「永远不写工作区」——出图照常，只是画廊筛选再也收不到工作区。
       * 只有能拿到 `shared` 本身，自测才能守住这条接线。
       */
      shared: shared,
    };
    return module.exports;
  }
});
