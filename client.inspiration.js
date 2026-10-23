/**
 * dsh-doubao-image —— 灵感库 chunk。
 *
 * 由 `client.gallery.js`（rail-tabs 容器）通过 `shared.ChunkMount` 内嵌，
 * 形态见 SPEC-chunks.md 第 2 节，接口冻结见第 9 节：
 *
 *   props = { locale, onUsePrompt(prompt, item) }
 *
 * 「用它生图」**只调 onUsePrompt**——切到工作台标签页是容器的职责，
 * 本 chunk 没有那个能力，也不该有。
 *
 * 数据：`GET shared.BASE + "/api/inspiration"`。该路由可能尚未就绪
 * （404 / 网络失败），此时显示失败态 + 重试，**不抛异常、不白屏**。
 *
 * 图片：一律 POST `shared.BASE + "/api/inspiration/image"`，body
 * `{sourceId, image}`，Host 代理取字节后回裸字节 → `URL.createObjectURL`。
 * 客户端**绝不直接访问外网 URL**（CSP + 隐私）。
 *
 * 布局对齐官方 `dsh-image-gen` 的 `InspirationView`：左网格 + 右 sticky
 * 检查器（`.dsh-ig-inspiration-layout` → `.__dbi_i_layout`），class 前缀
 * 按统一前缀换成 `__dbi_i_`。
 *
 * 收藏持久化：本机 localStorage（键 `dsh-dbi-inspiration-favorites`），
 * 不用 `shared.gallery`——见文件末尾 `readFavorites` 的说明。
 */
window.__ModuleLoader__.load({
  id: "dsh-doubao-image-free",
  chunk: "client.inspiration.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    /* ────────────────────────────────────────────────────────────────
     * 纯函数区：不依赖 shared / react / DOM，离线自测可直接调用。
     * 放在 shared 检查之前，是为了「shared 缺失」时这些规则依然可验证。
     * ──────────────────────────────────────────────────────────────── */

    /** 首屏渲染张数：数据可能上千条，一次全渲染会卡死页面。 */
    var DEFAULT_VISIBLE_LIMIT = 60;
    /** 「加载更多」每次追加的张数。 */
    var LOAD_MORE_STEP = 60;
    /** 分类导航跳转时，若目标分组还没渲染出来，把 limit 推到「刚好含它」。 */
    var LOAD_MORE_JUMP_SLACK = 60;
    /** 卡片右上角星标在 `favorites` 集合里的键前缀（见 `favoriteKey`）。 */
    var FAVORITES_STORAGE_KEY = "dsh-dbi-inspiration-favorites";

    /** 本 chunk 自带字典（不依赖主 bundle 的 t）。 */
    var COPY = {
      zh: {
        kicker: "提示词灵感",
        title: "灵感库",
        subtitle: "浏览公开案例，把喜欢的 Prompt 带回工作台。",
        search: "搜索标题、Prompt…",
        allCategories: "全部分类",
        allStyles: "全部风格",
        allScenes: "全部场景",
        onlyFeatured: "只看精选",
        onlyFavorites: "只看收藏",
        favorite: "收藏",
        favorited: "已收藏",
        results: "找到 {count} 个案例",
        loading: "正在读取灵感库…",
        loadFailed: "灵感库暂不可用，请稍后重试。",
        retry: "重新加载",
        empty: "没有匹配的案例，换个关键词或筛选条件试试。",
        emptyFeatured: "没有精选案例，试试关掉「只看精选」。",
        emptyFavorites: "还没有收藏的案例，点卡片右上角的星标即可收藏。",
        selectHint: "从左侧选一个案例查看完整 Prompt。",
        categoryNav: "分类导航",
        prompt: "完整 Prompt",
        copy: "复制 Prompt",
        copied: "已复制",
        copyFailed: "复制失败",
        use: "用它生图",
        useWithRef: "提示词 + 参考图",
        source: "查看来源",
        featured: "精选",
        close: "关闭",
        loadMore: "加载更多",
        allLoaded: "已展示全部 {count} 个案例",
        clearCache: "清缓存",
        refresh: "刷新",
        refreshing: "刷新中…",
        clearingCache: "清理中…",
        refreshed: "已刷新，共 {count} 个案例",
        refreshFailed: "刷新失败，请稍后重试。",
        cacheCleared: "已清理本地图片缓存",
        cacheClearFailed: "清理缓存失败。",
        imageLoading: "图片加载中…",
        imageFailed: "图片暂时无法读取",
      },
      en: {
        kicker: "Prompt inspiration",
        title: "Inspiration",
        subtitle: "Browse public examples and bring a prompt back to Studio.",
        search: "Search titles and prompts…",
        allCategories: "All categories",
        allStyles: "All styles",
        allScenes: "All scenes",
        onlyFeatured: "Featured only",
        onlyFavorites: "Favorites only",
        favorite: "Favorite",
        favorited: "Favorited",
        results: "{count} examples",
        loading: "Loading inspiration…",
        loadFailed: "The inspiration library is unavailable. Please retry later.",
        retry: "Retry",
        empty: "No matching examples. Try another keyword or filter.",
        emptyFeatured: "No featured examples. Try turning off “Featured only”.",
        emptyFavorites: "No favorites yet. Tap the star on a card to save one.",
        selectHint: "Pick an example on the left to see its full prompt.",
        categoryNav: "Category navigation",
        prompt: "Full prompt",
        copy: "Copy prompt",
        copied: "Copied",
        copyFailed: "Copy failed",
        use: "Use this prompt",
        useWithRef: "Prompt + reference",
        source: "View source",
        featured: "Featured",
        close: "Close",
        loadMore: "Load more",
        allLoaded: "All {count} examples displayed",
        clearCache: "Clear cache",
        refresh: "Refresh",
        refreshing: "Refreshing…",
        clearingCache: "Clearing…",
        refreshed: "Refreshed, {count} examples",
        refreshFailed: "Refresh failed. Please retry later.",
        cacheCleared: "Local image cache cleared",
        cacheClearFailed: "Failed to clear the cache.",
        imageLoading: "Loading image…",
        imageFailed: "Image is temporarily unavailable",
      },
    };

    /** 语言判定：locale 可能缺失，任何异常都退回中文。 */
    function pickLang(locale) {
      try {
        var active = locale && locale.getSnapshot && locale.getSnapshot().active;
        return typeof active === "string" && active.toLowerCase().indexOf("en") === 0 ? "en" : "zh";
      } catch {
        return "zh";
      }
    }

    /** 取词：缺 key 时回退 zh，再缺就返回 key 本身（不抛）。 */
    function makeT(lang) {
      return function (key, params) {
        var dict = COPY[lang] !== undefined ? COPY[lang] : COPY.zh;
        var value = dict[key] !== undefined ? dict[key] : COPY.zh[key];
        if (value === undefined) return key;
        if (params) {
          Object.keys(params).forEach(function (name) {
            value = value.replace("{" + name + "}", String(params[name]));
          });
        }
        return value;
      };
    }

    /**
     * 三级筛选 + 搜索 + 只看精选 + 只看收藏，可叠加。
     *
     * 搜索字段**限定** `title` / `prompt` / `promptPreview`——不含 category，
     * 也不含 styles/scenes：这三个下拉各自有独立筛选项，把标签混进全文搜索
     * 会让「按分类搜」和「按分类筛」给出不同结果集，用户无从理解。
     *
     * `filters.sourceId` 是「只看收藏」的必要输入：收藏键是
     * `favoriteKey(sourceId, caseId)`（带 sourceId 前缀），而 `item.id` 是裸
     * case id。**必须在这里拼前缀再比对**，否则永远筛出 0 张——这是曾经的
     * 真实缺陷：存储与渲染都用带前缀的键，唯独筛选用了裸 id。
     */
    function filterCases(cases, filters) {
      var list = Array.isArray(cases) ? cases : [];
      var f = filters !== undefined && filters !== null ? filters : {};
      var query = typeof f.search === "string" ? f.search.trim().toLowerCase() : "";
      var favSourceId = typeof f.sourceId === "string" ? f.sourceId : "";
      return list.filter(function (item) {
        if (item === null || typeof item !== "object") return false;
        if (f.onlyFeatured === true && item.featured !== true) return false;
        if (f.onlyFavorites === true && !isFavorited(f.favorites, favoriteKey(favSourceId, item.id))) return false;
        if (typeof f.category === "string" && f.category !== "" && item.category !== f.category) return false;
        if (typeof f.style === "string" && f.style !== "") {
          if (!Array.isArray(item.styles) || item.styles.indexOf(f.style) < 0) return false;
        }
        if (typeof f.scene === "string" && f.scene !== "") {
          if (!Array.isArray(item.scenes) || item.scenes.indexOf(f.scene) < 0) return false;
        }
        if (query === "") return true;
        var fields = [item.title, item.prompt, item.promptPreview];
        for (var i = 0; i < fields.length; i += 1) {
          if (typeof fields[i] === "string" && fields[i].toLowerCase().indexOf(query) >= 0) return true;
        }
        return false;
      });
    }

    /** 分页切片：limit 非正数 → 空数组（不是「全部」）。 */
    function sliceVisible(cases, limit) {
      var list = Array.isArray(cases) ? cases : [];
      var n = typeof limit === "number" && isFinite(limit) ? Math.floor(limit) : 0;
      if (n <= 0) return [];
      return list.slice(0, n);
    }

    /** 是否还有没渲染的条目（决定显示「加载更多」还是「已全部展示」）。 */
    function canLoadMore(total, limit) {
      var count = typeof total === "number" && isFinite(total) ? total : 0;
      var n = typeof limit === "number" && isFinite(limit) ? Math.floor(limit) : 0;
      return count > n;
    }

    /** 选中的数据源：优先命中 activeSourceId，否则退回第一个；空目录返回 null。 */
    function pickActiveSource(catalog, activeSourceId) {
      var sources = catalog !== null && catalog !== undefined && Array.isArray(catalog.sources) ? catalog.sources : [];
      if (sources.length === 0) return null;
      if (typeof activeSourceId === "string" && activeSourceId !== "") {
        for (var i = 0; i < sources.length; i += 1) {
          if (sources[i] !== null && typeof sources[i] === "object" && sources[i].id === activeSourceId) return sources[i];
        }
      }
      return sources[0] !== undefined ? sources[0] : null;
    }

    /* ──────────────────── C4 分组 / C2 分类导航计数 ──────────────────── */

    /**
     * 分类计数：**在筛选结果上统计**。
     *
     * 导航 chip 上的数字要和「点进去能看到几张」一致，所以口径必须是
     * `matching`（已叠加搜索/风格/场景/精选/收藏），不是全量 `cases`。
     * 用 Map 而不是对象：分类名来自数据集，可能是 `__proto__` 这类键，
     * 对象字面量会撞原型链。
     */
    function categoryCounts(cases) {
      var counts = new Map();
      var list = Array.isArray(cases) ? cases : [];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        if (item === null || typeof item !== "object") continue;
        var name = typeof item.category === "string" ? item.category : "";
        if (name === "") continue;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      return counts;
    }

    /** 取某分类的计数（缺失 = 0，不做 undefined 泄漏到 UI）。 */
    function countOf(counts, name) {
      if (counts === null || counts === undefined || typeof counts.get !== "function") return 0;
      var value = counts.get(name);
      return typeof value === "number" && isFinite(value) ? value : 0;
    }

    /**
     * 按分类把**已渲染的**条目分组（官方的 `visibleGroups`）。
     *
     * 两个刻意的选择：
     * - 只在 `visible` 上分组，不在 `matching` 上分组——否则「加载更多」
     *   之前后面那些空组标题就已经排上去了。
     * - 组顺序按 `source.categories`（数据集的权威顺序），而不是按 Map 的
     *   首次出现顺序；未列入 categories 的分类一律不出现。
     * - 空组在生产路径上不该存在（导航 chip 在 count 为 0 时是 disabled），
     *   但纯函数仍然过滤掉它们——调用方不该依赖「上游没给空组」这个假设。
     */
    function groupByCategory(visibleCases, categories) {
      var list = Array.isArray(visibleCases) ? visibleCases : [];
      var order = Array.isArray(categories) ? categories : [];
      var buckets = new Map();
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        if (item === null || typeof item !== "object") continue;
        var name = typeof item.category === "string" ? item.category : "";
        if (!buckets.has(name)) buckets.set(name, []);
        buckets.get(name).push(item);
      }
      var groups = [];
      for (var j = 0; j < order.length; j += 1) {
        var key = order[j];
        var items = buckets.get(key);
        if (items !== undefined && items.length > 0) groups.push({ name: key, items: items });
      }
      return groups;
    }

    /** 组签名：让 effect 只在**分组结构**变化时重跑（不是每帧）。 */
    function groupSignature(groups) {
      var list = Array.isArray(groups) ? groups : [];
      return list.map(function (group) { return String(group && group.name); }).join("\u0000");
    }

    /**
     * 分类 chip 跳转：把 limit 推到「至少包含该分类第一条」。
     *
     * 返回**原 limit** 表示无需调整（目标已在当前窗口内，或压根没有这个分类）；
     * 返回**更大的值**表示需要先扩容再滚动。返回 0 表示「够不着」——
     * 图表数据被截断之类，调用方应放弃滚动而不是死循环。
     *
     * 注意返回值恒 ≥ 传入的 limit（除了 0 这个哨兵），调用方 `setVisibleLimit`
     * 因此不会把窗口缩小。
     */
    function limitToRevealCategory(matching, category, limit) {
      var list = Array.isArray(matching) ? matching : [];
      var n = typeof limit === "number" && isFinite(limit) ? Math.floor(limit) : 0;
      if (n <= 0) n = DEFAULT_VISIBLE_LIMIT;
      if (typeof category !== "string" || category === "") return n;
      var index = -1;
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        if (item !== null && typeof item === "object" && item.category === category) {
          index = i;
          break;
        }
      }
      if (index < 0) return 0;
      if (index < n) return n;
      return index + LOAD_MORE_JUMP_SLACK;
    }

    /* ────────────────────────── C6 收藏 ────────────────────────── */

    /**
     * 收藏的唯一键：**必须带 sourceId**。
     *
     * 两个数据源里出现同名 case id 是可能的（数据集各自编号），只按 id 存
     * 会让 A 源的收藏点亮 B 源的卡片。官方只有单一 source 才敢只存 id。
     */
    function favoriteKey(sourceId, caseId) {
      var s = typeof sourceId === "string" ? sourceId : "";
      var c = caseId === null || caseId === undefined ? "" : String(caseId);
      if (s === "" || c === "") return "";
      return s + "/" + c;
    }

    /** 是否已收藏。`favorites` 可以是 Set / 数组 / 空值，一律不抛。 */
    function isFavorited(favorites, key) {
      if (typeof key !== "string" || key === "") return false;
      if (favorites instanceof Set) return favorites.has(key);
      if (Array.isArray(favorites)) return favorites.indexOf(key) >= 0;
      return false;
    }

    /** 切换收藏，返回**新集合**（不原地改，React 才看得到变化）。 */
    function toggleFavoriteKey(favorites, key) {
      var next = new Set(favorites instanceof Set ? favorites : []);
      if (typeof key !== "string" || key === "") return next;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    }

    /**
     * 把任意形状收敛成「字符串集合」（脏数据不炸）。
     *
     * 接受三种输入：Set（`toggleFavoriteKey` / `writeFavorites` 回传的就是它）、
     * 数组、JSON 字符串（localStorage 里躺着的那种），其余一律当空集合。
     */
    function normalizeFavorites(raw) {
      var out = new Set();
      var list = null;
      if (raw instanceof Set) {
        list = Array.from(raw);
      } else if (Array.isArray(raw)) {
        list = raw;
      } else if (typeof raw === "string") {
        try {
          var parsed = JSON.parse(raw);
          list = Array.isArray(parsed) ? parsed : null;
        } catch {
          list = null;
        }
      }
      if (list === null) return out;
      for (var i = 0; i < list.length; i += 1) {
        if (typeof list[i] === "string" && list[i] !== "") out.add(list[i]);
      }
      return out;
    }

    /**
     * 收藏持久化 —— 走本机 localStorage，**不用 `shared.gallery`**。
     *
     * 三条理由，按权重排序：
     * 1. `shared.gallery` 的 API（`saveGalleryItem` / `toggleFavoriteGalleryItem`）
     *    是围绕**已生成图片的附件**建的：`id` = `attachmentId`，
     *    还要 `attachment` 形状、`isItemInWorkspace` 之类的字段。灵感库收藏的
     *    是「数据集里的一个案例」（可能只是一条还没生成的 Prompt），没有附件，
     *    塞进去要在画廊里凭空多出一条没有图的记录。
     * 2. 任务硬约束：`gallery` 不支持「提示词 / 案例」收藏时，就在本 chunk 内部
     *    自己实现，**不许改 `client.js`**。gallery 的 IndexedDB 只有
     *    `items` object store，加 store 就要动 `client.js`。
     * 3. 官方 `dsh-image-gen` 自己也是 localStorage（`FAVORITES_STORAGE_KEY`），
     *    对齐官方形态。收藏是纯客户端偏好，量级几百个字符串，localStorage
     *    足够，且天然同步可读——IndexedDB 会强迫首帧走异步，星标要闪一下。
     *
     * 两条实现纪律：
     * - **`favoriteKey` 只有在 sourceId 与 id 都在时才非空**；空键不写库，
     *   避免脏数据攒成 `"/"` 这一条永远匹配不上的记录。
     * - 读写全部 try/catch：localStorage 在隐私模式 / 配额满时**会抛**，
     *   这里任何一次抛出都会白掉整个灵感库。
     */
    function readFavorites(storage) {
      try {
        var store = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
        if (store === null || store === undefined || typeof store.getItem !== "function") return new Set();
        return normalizeFavorites(store.getItem(FAVORITES_STORAGE_KEY));
      } catch {
        return new Set();
      }
    }

    /** 写回收藏；返回是否写成功（失败也不抛，UI 照常点亮，只是重启后丢）。 */
    function writeFavorites(favorites, storage) {
      try {
        var store = storage !== undefined ? storage : (typeof localStorage !== "undefined" ? localStorage : null);
        if (store === null || store === undefined || typeof store.setItem !== "function") return false;
        var keys = Array.from(normalizeFavorites(favorites));
        store.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(keys));
        return true;
      } catch {
        return false;
      }
    }

    /**
     * 复制文本。**永不 reject**：剪贴板在非安全上下文、无权限、或宿主
     * 未实现 `navigator.clipboard` 时都只是返回 false，调用方据此显示
     * 「复制失败」，不会产生未捕获的 Promise 异常。
     */
    function copyPromptText(text) {
      try {
        if (typeof navigator === "undefined" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
          return Promise.resolve(false);
        }
        return navigator.clipboard.writeText(String(text)).then(
          function () { return true; },
          function () { return false; }
        );
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    var shared = (typeof globalThis !== "undefined" && globalThis.__dshDoubaoImageShared) || null;

    if (shared === null) {
      // 主 bundle 一定先于本文件执行（是它 require.async 的本文件），
      // 所以走到这里只可能是有人手工加载了 chunk。
      exports.Mount = function () {
        return h("div", { className: "__dbi_error" }, "dsh-doubao-image: shared runtime missing");
      };
      return module.exports;
    }

    var INSPIRATION_ROUTE = shared.BASE + "/api/inspiration";
    var INSPIRATION_IMAGE_ROUTE = shared.BASE + "/api/inspiration/image";

    /* ────────────────────────── hooks ────────────────────────── */

    /**
     * 读灵感库目录。
     *
     * 失败（404 / 非 JSON / sources 形状不对）一律进 `error` 状态而不是抛出：
     * Host 路由是主代理并行实现的，它缺席时这里必须优雅降级。
     *
     * `retryToken` 是**唯一的触发源**：首次挂载、失败后重试、以及 C11 的
     * 「刷新」按钮都只是把它 +1。刻意不复用官方的 `GET /catalog` +
     * `POST /refresh` 两条路由——本机的 Host 只有一条 GET，而它每次都会
     * 让 Host 侧重新 `loadCatalog()`（见 `index.js` 的 `ROUTE_INSPIRATION`），
     * 所以「再 GET 一次」就是刷新，不需要客户端造第二条路由名。
     */
    function useCatalog(route) {
      var pair = react.useState({ status: "loading", catalog: null });
      var state = pair[0];
      var setState = pair[1];
      var retryPair = react.useState(0);
      var retryToken = retryPair[0];
      var setRetryToken = retryPair[1];

      react.useEffect(function () {
        var alive = true;
        setState({ status: "loading", catalog: null });
        fetch(route, {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "application/json" },
        }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        }).then(function (payload) {
          if (!alive) return;
          // Host 的失败回执是 200 + {ok:false}（见 index.js），要一并当成失败，
          // 否则客户端会把「目录读不出来」渲染成一个空的就绪态。
          if (payload === null || typeof payload !== "object" || payload.ok === false) {
            throw new Error("bad-payload");
          }
          if (!Array.isArray(payload.sources)) throw new Error("bad-payload");
          setState({ status: "ready", catalog: payload });
        }).catch(function () {
          if (!alive) return;
          setState({ status: "error", catalog: null });
        });
        return function () { alive = false; };
      }, [route, retryToken]);

      return {
        status: state.status,
        catalog: state.catalog,
        retry: function () { setRetryToken(function (n) { return n + 1; }); },
      };
    }

    /**
     * 取一张灵感图的 blob URL。
     *
     * 走 Host 代理路由，**不发外网请求**。带 abort + revokeObjectURL 清理：
     * 网格里同时存在几十张图，不 revoke 就是几十个泄漏的 blob。
     */
    function useInspirationImage(sourceId, image, enabled) {
      var pair = react.useState({ url: "", error: "" });
      var state = pair[0];
      var setState = pair[1];
      var shouldLoad = enabled !== false;

      react.useEffect(function () {
        if (!shouldLoad) return undefined;
        if (typeof sourceId !== "string" || sourceId === "" || typeof image !== "string" || image === "") {
          setState({ url: "", error: "" });
          return;
        }
        var alive = true;
        var controller = typeof AbortController === "function" ? new AbortController() : null;
        var objectUrl = "";
        fetch(INSPIRATION_IMAGE_ROUTE, {
          method: "POST",
          signal: controller !== null ? controller.signal : undefined,
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceId: sourceId, image: image }),
        }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.blob();
        }).then(function (blob) {
          if (!alive) return;
          if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
            setState({ url: "", error: "no-object-url" });
            return;
          }
          objectUrl = URL.createObjectURL(blob);
          setState({ url: objectUrl, error: "" });
        }).catch(function (error) {
          if (!alive) return;
          setState({ url: "", error: String((error && error.message) || error) });
        });

        return function () {
          alive = false;
          if (controller !== null) controller.abort();
          if (objectUrl !== "" && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(objectUrl);
          }
        };
      }, [sourceId, image, shouldLoad]);

      return state;
    }

    /* ────────────────────────── 组件 ────────────────────────── */

    /**
     * IntersectionObserver 懒加载包装：图进入视口（提前 200px）才让内部
     * 缩略图加载。环境不支持 IO 或拿不到 DOM ref 时立即加载（降级路径）。
     */
    function LazyInspirationThumb(props) {
      var pair = react.useState(false);
      var visible = pair[0];
      var setVisible = pair[1];
      var hostRef = react.useRef(null);

      react.useEffect(function () {
        var node = hostRef.current;
        if (visible) return undefined;
        if (typeof IntersectionObserver !== "function" || node === null || node === undefined) {
          setVisible(true);
          return undefined;
        }
        var observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].isIntersecting) {
              setVisible(true);
              observer.disconnect();
              break;
            }
          }
        }, { rootMargin: "200px" });
        observer.observe(node);
        return function () { observer.disconnect(); };
      });

      return h("div", { ref: hostRef, className: "__dbi_i_lazyWrap" },
        h(InspirationThumb, {
          sourceId: props.sourceId,
          image: props.image,
          alt: props.alt,
          loadingText: props.loadingText,
          failedText: props.failedText,
          enabled: visible,
        }));
    }

    /** 缩略图：只有拿到 blob URL 才渲染 img。 */
    function InspirationThumb(props) {
      var state = useInspirationImage(props.sourceId, props.image, props.enabled !== false);
      if (state.url === "") {
        return h("div", { className: "__dbi_i_thumbFallback" },
          state.error !== "" ? (props.failedText || "") : (props.loadingText || ""));
      }
      return h("img", {
        className: "__dbi_i_thumb",
        src: state.url,
        alt: props.alt || "",
        loading: "lazy",
      });
    }

    /**
     * 网格卡片：星标 + 1:1 视觉区 + 标题/分类两行。
     *
     * 无状态，避免展开时占 hook 槽。星标是**嵌套在卡片按钮里的 button**：
     * 外层卡片本身就是一个 button 元素，所以星标必须 `stopPropagation`，
     * 否则点星标会顺带把卡片选中——官方同款处理。
     */
    function InspirationCard(props) {
      var item = props.item;
      var t = props.t;
      var title = typeof item.title === "string" ? item.title : "";
      return h("button", {
        type: "button",
        className: "__dbi_i_card" + (props.selected ? " __dbi_i_cardOn" : ""),
        onClick: props.onOpen,
        title: title,
        "aria-pressed": props.selected === true,
      },
        h("div", { className: "__dbi_i_visual" },
          item.featured === true ? h("span", { className: "__dbi_i_featured" }, t("featured")) : null,
          h("button", {
            type: "button",
            className: "__dbi_i_cardStar" + (props.favorited ? " __dbi_i_cardStarOn" : ""),
            "aria-pressed": props.favorited === true,
            "aria-label": props.favorited ? t("favorited") : t("favorite"),
            title: props.favorited ? t("favorited") : t("favorite"),
            onClick: function (event) {
              if (event && typeof event.stopPropagation === "function") event.stopPropagation();
              props.onToggleFavorite();
            },
          }, "\u2605"),
          h(LazyInspirationThumb, {
            sourceId: props.sourceId,
            image: item.image,
            alt: item.imageAlt !== undefined ? item.imageAlt : item.title,
            loadingText: t("imageLoading"),
            failedText: t("imageFailed"),
          })
        ),
        h("div", { className: "__dbi_i_cardCopy" },
          h("strong", { className: "__dbi_i_cardTitle" }, title),
          h("span", { className: "__dbi_i_cardCategory" }, typeof item.category === "string" ? item.category : ""),
          typeof item.sourceLabel === "string" && item.sourceLabel !== ""
            ? h("span", { className: "__dbi_i_cardSource" }, item.sourceLabel)
            : null
        )
      );
    }

    /**
     * C5 右侧 sticky 检查器（对齐官方 `.dsh-ig-inspiration-inspector`）。
     *
     * 「图 + 标题 + 出处 + 标签 + Prompt + 操作按钮」全部塞在这里，不再用弹层。
     * 空选时给一句引导而不是留白——否则用户以为面板坏了。
     */
    function InspirationInspector(props) {
      var t = props.t;
      if (props.item === null) {
        return h("aside", { className: "__dbi_i_inspector", "aria-label": t("prompt") },
          h("div", { className: "__dbi_i_inspectorEmpty" }, t("selectHint")));
      }
      var item = props.item;
      var styleTags = Array.isArray(item.styles) ? item.styles.slice(0, 3) : [];
      var sceneTags = Array.isArray(item.scenes) ? item.scenes.slice(0, 3) : [];
      var prompt = item.prompt !== undefined ? String(item.prompt) : "";
      var url = typeof item.sourceUrl === "string" && item.sourceUrl !== ""
        ? item.sourceUrl
        : (typeof item.githubUrl === "string" && item.githubUrl !== "" ? item.githubUrl : "");

      return h("aside", { className: "__dbi_i_inspector", "aria-label": t("prompt") },
        h("div", { className: "__dbi_i_inspectorImage" },
          h(InspirationThumb, {
            sourceId: props.sourceId,
            image: item.image,
            alt: item.imageAlt !== undefined ? item.imageAlt : item.title,
            loadingText: t("imageLoading"),
            failedText: t("imageFailed"),
          })
        ),
        h("div", { className: "__dbi_i_inspectorBody" },
          h("div", { className: "__dbi_i_inspectorHead" },
            h("h2", { className: "__dbi_i_inspectorTitle" }, typeof item.title === "string" ? item.title : ""),
            h("button", {
              type: "button",
              className: "__dbi_i_inspectorFav" + (props.favorited ? " __dbi_i_inspectorFavOn" : ""),
              "aria-pressed": props.favorited === true,
              "aria-label": props.favorited ? t("favorited") : t("favorite"),
              title: props.favorited ? t("favorited") : t("favorite"),
              onClick: props.onToggleFavorite,
            }, "\u2605")
          ),
          typeof item.sourceLabel === "string" && item.sourceLabel !== ""
            ? h("p", { className: "__dbi_i_origin" }, item.sourceLabel)
            : null,
          h("div", { className: "__dbi_i_tags" },
            typeof item.category === "string" && item.category !== ""
              ? h("span", { key: "__cat", className: "__dbi_i_tag" }, item.category)
              : null,
            styleTags.map(function (name) { return h("span", { key: "s-" + name, className: "__dbi_i_tag" }, String(name)); }),
            sceneTags.map(function (name) { return h("span", { key: "c-" + name, className: "__dbi_i_tag" }, String(name)); })
          ),
          h("div", { className: "__dbi_i_promptLabel" },
            h("span", {}, t("prompt")),
            h("span", { className: "__dbi_i_promptCount" }, String(prompt.length))
          ),
          h("p", { className: "__dbi_i_prompt" }, prompt),
          h("div", { className: "__dbi_i_actions" },
            h("button", { type: "button", className: "__dbi_i_copy", onClick: props.onCopy },
              props.copied === "ok" ? t("copied") : (props.copied === "fail" ? t("copyFailed") : t("copy"))
            ),
            url !== ""
              ? h("a", {
                  className: "__dbi_i_link",
                  href: url,
                  target: "_blank",
                  rel: "noreferrer",
                }, t("source"))
              : null,
            /*
             * 两个按钮，对应官方灵感库的「使用这个 Prompt」与「提示词 + 参考图」。
             * onClick 必须包一层：直接把 props.onUse 给 React 会把点击
             * 事件对象当成第一个参数传进去。
             */
            h("button", { type: "button", className: "__dbi_i_use", onClick: function () { props.onUse("text"); } }, t("use")),
            h("button", { type: "button", className: "__dbi_i_useRef", onClick: function () { props.onUse("ref"); } }, t("useWithRef"))
          )
        )
      );
    }

    function Mount(props) {
      shared.useLocale(props.locale);
      var lang = pickLang(props.locale);
      var t = makeT(lang);

      var catalogState = useCatalog(INSPIRATION_ROUTE);
      var source = pickActiveSource(catalogState.catalog, "");

      var sourcePair = react.useState("");
      var activeSourceId = sourcePair[0];
      var setActiveSourceId = sourcePair[1];

      var searchPair = react.useState("");
      var search = searchPair[0];
      var setSearch = searchPair[1];

      var categoryPair = react.useState("");
      var category = categoryPair[0];
      var setCategory = categoryPair[1];

      var stylePair = react.useState("");
      var style = stylePair[0];
      var setStyle = stylePair[1];

      var scenePair = react.useState("");
      var scene = scenePair[0];
      var setScene = scenePair[1];

      var featuredPair = react.useState(false);
      var onlyFeatured = featuredPair[0];
      var setOnlyFeatured = featuredPair[1];

      var favOnlyPair = react.useState(false);
      var onlyFavorites = favOnlyPair[0];
      var setOnlyFavorites = favOnlyPair[1];

      var favoritesPair = react.useState(function () { return readFavorites(); });
      var favorites = favoritesPair[0];
      var setFavorites = favoritesPair[1];

      var limitPair = react.useState(DEFAULT_VISIBLE_LIMIT);
      var visibleLimit = limitPair[0];
      var setVisibleLimit = limitPair[1];

      var selectedPair = react.useState(null);
      var selected = selectedPair[0];
      var setSelected = selectedPair[1];

      var copiedPair = react.useState("");
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];

      var refreshPair = react.useState(false);
      var refreshing = refreshPair[0];
      var setRefreshing = refreshPair[1];

      var clearPair = react.useState(false);
      var clearingCache = clearPair[0];
      var setClearingCache = clearPair[1];

      var noticePair = react.useState(null);
      var notice = noticePair[0];
      var setNotice = noticePair[1];

      // C2 分类跳转的「待滚动目标」。声明位置刻意紧挨其他 state——
      // hook 顺序是 React 的硬约束，把 useState 夹在函数声明中间极易被
      // 后续编辑挪散，到时候是「渲染数不一致」这种最难查的崩法。
      var jumpPair = react.useState("");
      var pendingJump = jumpPair[0];
      var setPendingJump = jumpPair[1];

      source = pickActiveSource(catalogState.catalog, activeSourceId);

      var matching = react.useMemo(function () {
        return filterCases(source !== null ? source.cases : [], {
          search: search,
          category: category,
          style: style,
          scene: scene,
          onlyFeatured: onlyFeatured,
          onlyFavorites: onlyFavorites,
          favorites: favorites,
          sourceId: source !== null ? source.id : "",
        });
      }, [source, search, category, style, scene, onlyFeatured, onlyFavorites, favorites]);

      var categories = Array.isArray(source !== null ? source.categories : null) ? source.categories : [];

      // C2：计数口径 = 当前筛选结果，和「点进去能看几张」一致。
      var counts = react.useMemo(function () { return categoryCounts(matching); }, [matching]);

      var visible = sliceVisible(matching, visibleLimit);

      // C4：只对已渲染的条目分组，避免把还没加载出来的组标题提前排上。
      var groups = react.useMemo(function () { return groupByCategory(visible, categories); }, [visible, categories]);

      // 分组结构签名：C2 的「当前分组」高亮由它驱动，不是逐帧重算。
      var signature = groupSignature(groups);

      var groupRefs = react.useRef({});
      /** 见 `handleRefresh` 上方那段注释：区分「刚点下刷新」与「真的转过了」。 */
      var refreshSeenLoadingRef = react.useRef(false);

      /**
       * C2 的「当前可见分组」：IntersectionObserver 盯着每个组标题，
       * 谁在视口上沿附近就把谁标成 active。环境不支持 IO 时保持空——
       * 那只影响高亮，不影响功能。
       */
      var activeCatPair = react.useState("");
      var activeCategory = activeCatPair[0];
      var setActiveCategory = activeCatPair[1];

      react.useEffect(function () {
        if (typeof IntersectionObserver !== "function") return undefined;
        var targets = [];
        Object.keys(groupRefs.current).forEach(function (name) {
          if (groupRefs.current[name] !== null && groupRefs.current[name] !== undefined) targets.push(name);
        });
        if (targets.length === 0) return undefined;
        var observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].isIntersecting) {
              var name = entries[i].target && entries[i].target.__dbiCategory;
              if (typeof name === "string") setActiveCategory(name);
            }
          }
        }, { rootMargin: "0px 0px -75% 0px" });
        for (var i = 0; i < targets.length; i += 1) {
          var node = groupRefs.current[targets[i]];
          if (node !== null && node !== undefined) {
            try { node.__dbiCategory = targets[i]; } catch { /* 冻结节点：放弃高亮，不影响功能 */ }
            observer.observe(node);
          }
        }
        return function () { observer.disconnect(); };
      }, [signature]);

      // 筛选条件变了就回到首屏，否则用户会停在一个「已经滚过的」位置。
      react.useEffect(function () {
        setVisibleLimit(DEFAULT_VISIBLE_LIMIT);
      }, [search, category, style, scene, onlyFeatured, onlyFavorites, activeSourceId]);

      // 提示条自动消失：不引用任何 state，函数 ref 每次渲染都是新的，取最新的。
      var noticeRef = react.useRef(null);
      noticeRef.current = notice;

      react.useEffect(function () {
        if (notice === null) return undefined;
        if (typeof setTimeout !== "function") return undefined;
        var timer = setTimeout(function () {
          if (noticeRef.current === notice) setNotice(null);
        }, 2400);
        return function () {
          if (typeof clearTimeout === "function") clearTimeout(timer);
        };
      }, [notice]);

      // 自报标记：浏览器里拿不到槽表，靠这个确认 chunk 真的挂上了。
      react.useEffect(function () {
        if (typeof globalThis === "undefined") return;
        globalThis.__dshInspirationChunkMounted = {
          ok: true,
          sourceId: source !== null && typeof source.id === "string" ? source.id : "",
          total: matching.length,
          visible: visible.length,
          favorites: favorites instanceof Set ? favorites.size : 0,
        };
      });

      /** 切换数据源：清掉筛选（各 source 有自己的分类/风格/场景词表）。 */
      function switchSource(id) {
        if (id === activeSourceId) return;
        setActiveSourceId(id);
        setSearch("");
        setCategory("");
        setStyle("");
        setScene("");
        setOnlyFeatured(false);
        setOnlyFavorites(false);
        setActiveCategory("");
        setSelected(null);
        setCopied("");
      }

      function toggleFavorite(id) {
        if (source === null) return;
        var key = favoriteKey(source.id, id);
        if (key === "") return;
        setFavorites(function (prev) {
          var next = toggleFavoriteKey(prev, key);
          writeFavorites(next);
          return next;
        });
      }

      function clearFilters() {
        if (category !== "") setCategory("");
        setActiveCategory("");
      }

      /**
       * C2 分类 chip：**只跳转，不改 category**（官方 `jumpToCategory`）。
       *
       * 如果点了 chip 就顺手设 category，导航行会立刻塌缩成「只剩这一类」，
       * 用户就回不去了。所以这里：
       * - 若当前正处在某分类筛选态，先解除筛选；
       * - 若目标分组还没渲染出来（超出 visibleLimit），把窗口扩到含它为止；
       * - 渲染出来后由下面那个 effect 负责滚动。
       */
      function jumpToCategory(name) {
        if (category !== "") setCategory("");
        setPendingJump(name);
      }

      react.useEffect(function () {
        if (pendingJump === "") return undefined;
        var needed = limitToRevealCategory(matching, pendingJump, visibleLimit);
        if (needed === 0) {
          // 这个分类在当前筛选条件下一条都没有——放弃跳转，不要死循环。
          setPendingJump("");
          return undefined;
        }
        if (needed > visibleLimit) {
          setVisibleLimit(needed);
          return undefined;
        }
        if (typeof requestAnimationFrame !== "function") {
          setPendingJump("");
          return undefined;
        }
        var raf = requestAnimationFrame(function () {
          var node = groupRefs.current[pendingJump];
          if (node !== null && node !== undefined && typeof node.scrollIntoView === "function") {
            node.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          setPendingJump("");
        });
        return function () {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
        };
      }, [pendingJump, matching, visibleLimit]);

      /** C11「刷新」：重新 GET 目录（Host 每次 GET 都会重新读目录）。 */
      /**
       * 刷新中的收尾。
       *
       * 为什么不能写成「`status !== "loading"` 就收」：`setRefreshing(true)`
       * 那一次重渲染里 `status` 还是上一轮的 `"ready"`（`useCatalog` 要等到
       * 自己的 effect 跑完才置 `"loading"`），条件当场成立，转圈会立刻消失，
       * 用户看到的是一个毫无反馈的按钮。
       *
       * 所以改成「**见过一次 loading 之后**再收」：见 `refreshSeenLoadingRef`。
       */
      react.useEffect(function () {
        if (!refreshing) return;
        if (catalogState.status === "loading") {
          refreshSeenLoadingRef.current = true;
          return;
        }
        if (refreshSeenLoadingRef.current) {
          refreshSeenLoadingRef.current = false;
          setRefreshing(false);
        }
      }, [catalogState.status, refreshing]);

      function handleRefresh() {
        if (refreshing) return;
        refreshSeenLoadingRef.current = false;
        setRefreshing(true);
        // 走 catalogState.retry() 而不是自己 fetch：同一份状态机，
        // 失败态的重试与刷新在这里是同一个动作，不会出现两套竞态。
        catalogState.retry();
      }

      /**
       * C11「清缓存」：本插件**没有** Host 侧的缓存清理路由
       * （`index.js` 只有 GET /api/inspiration 与 POST /api/inspiration/image），
       * 所以这里清的是客户端这一侧能清的东西——已建立的 blob URL。
       *
       * 刻意**不**去 fetch 一个猜测的路由名（如 `/api/inspiration/cache/clear`）：
       * 那会打出一个保证 404 的请求，还会让「清缓存成功」这句话变成谎话。
       */
      function handleClearCache() {
        if (clearingCache) return;
        setClearingCache(true);
        var revoked = 0;
        try {
          // `location` 必须自己判存在：它在某些宿主里是自由变量而非全局属性，
          // 直接引用会抛 ReferenceError，被下面的 catch 吞掉后表现为
          // 「点了清缓存但一个 URL 都没释放」——一个静默失效的功能。
          var origin = typeof location !== "undefined" && location && typeof location.origin === "string"
            ? location.origin
            : "";
          if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function" && typeof document !== "undefined" && document.images) {
            var imgs = document.images;
            for (var i = 0; i < imgs.length; i += 1) {
              var src = imgs[i] && typeof imgs[i].src === "string" ? imgs[i].src : "";
              if (src.indexOf("blob:") !== 0) continue;
              // 只清本页的 blob：`blob:http://other-origin/...` 不是我们建的。
              if (origin !== "" && src.indexOf(origin) < 0) continue;
              URL.revokeObjectURL(src);
              revoked += 1;
            }
          }
        } catch { /* 清理失败不影响提示 */ }
        setClearingCache(false);
        setNotice({ kind: "ok", text: t("cacheCleared") });
        if (typeof globalThis !== "undefined") {
          globalThis.__dshInspirationCacheCleared = { ok: true, revoked: revoked, at: Date.now() };
        }
      }

      function handleCopy() {
        if (selected === null) return;
        copyPromptText(selected.prompt !== undefined ? selected.prompt : "").then(function (ok) {
          setCopied(ok ? "ok" : "fail");
        });
      }

      /*
       * 参数（全部可选，老容器只认前两个）：
       *   prompt, item, mode, sourceId
       *
       * `mode` 决定这次带不带参考图：
       *   "text" = 只把提示词送进工作台（当前行为）
       *   "ref"  = 提示词 + 案例效果图一起送进去，走图生图
       * `sourceId` 是取图必需的——Host 的 /api/inspiration/image 要
       * `{sourceId, image}` 才能定位到那个数据源。
       *
       * 第三个参数是**新增的**，老容器会忽略它并退回纯文生图——
       * 这是有意的降级，不是漏传。
       */
      function handleUse(mode) {
        if (selected === null) return;
        if (typeof props.onUsePrompt !== "function") return;
        props.onUsePrompt(
          selected.prompt !== undefined ? selected.prompt : "",
          selected,
          mode === "ref" ? "ref" : "text",
          source === null ? "" : source.id
        );
      }

      /* ── 头部（含 C11 两个按钮）── */
      var header = h("header", { className: "__dbi_i_head" },
        h("div", { className: "__dbi_i_headText" },
          h("p", { className: "__dbi_i_kicker" }, t("kicker")),
          h("h1", {}, t("title")),
          h("p", { className: "__dbi_i_subtitle" }, t("subtitle"))
        ),
        h("div", { className: "__dbi_i_headActions" },
          h("button", {
            type: "button",
            className: "__dbi_i_clearCache",
            disabled: clearingCache,
            title: t("clearCache"),
            onClick: handleClearCache,
          }, clearingCache ? t("clearingCache") : t("clearCache")),
          h("button", {
            type: "button",
            className: "__dbi_i_refresh",
            disabled: refreshing,
            title: t("refresh"),
            onClick: handleRefresh,
          }, refreshing ? t("refreshing") : t("refresh"))
        )
      );

      /* ── 主体 ── */
      var body;
      if (catalogState.status === "error") {
        body = h("div", { className: "__dbi_i_empty __dbi_i_error" },
          h("p", {}, t("loadFailed")),
          h("button", { type: "button", className: "__dbi_i_retry", onClick: catalogState.retry }, t("retry"))
        );
      } else if (catalogState.status === "loading") {
        body = h("div", { className: "__dbi_i_empty __dbi_i_loading" }, t("loading"));
      } else if (source === null) {
        body = h("div", { className: "__dbi_i_empty __dbi_i_error" },
          h("p", {}, t("loadFailed")),
          h("button", { type: "button", className: "__dbi_i_retry", onClick: catalogState.retry }, t("retry"))
        );
      } else {
        var sources = Array.isArray(catalogState.catalog.sources) ? catalogState.catalog.sources : [];

        var sourceTabs = sources.length > 1
          ? h("div", { className: "__dbi_i_sources", role: "tablist" },
              sources.map(function (item) {
                var on = item !== null && typeof item === "object" && item.id === source.id;
                return h("button", {
                  key: String(item && item.id),
                  type: "button",
                  role: "tab",
                  "aria-selected": on,
                  className: "__dbi_i_sourceChip" + (on ? " __dbi_i_sourceChipOn" : ""),
                  onClick: function () { switchSource(item.id); },
                }, String((item && item.name) || (item && item.label) || (item && item.id) || ""));
              })
            )
          : null;

        var styles = Array.isArray(source.styles) ? source.styles : [];
        var scenes = Array.isArray(source.scenes) ? source.scenes : [];

        var toolbar = h("div", { className: "__dbi_i_toolbar" },
          h("label", { className: "__dbi_i_search" },
            h("input", {
              type: "search",
              value: search,
              placeholder: t("search"),
              "aria-label": t("search"),
              onChange: function (event) { setSearch(event && event.target ? event.target.value : ""); },
            })
          ),
          h("button", {
            type: "button",
            className: "__dbi_i_favFilter" + (onlyFavorites ? " __dbi_i_favFilterOn" : ""),
            "aria-pressed": onlyFavorites,
            title: t("onlyFavorites"),
            onClick: function () { setOnlyFavorites(function (prev) { return !prev; }); },
          }, t("onlyFavorites") + (favorites.size > 0 ? " (" + favorites.size + ")" : "")),
          h("button", {
            type: "button",
            className: "__dbi_i_featuredToggle" + (onlyFeatured ? " __dbi_i_featuredToggleOn" : ""),
            "aria-pressed": onlyFeatured,
            onClick: function () { setOnlyFeatured(function (prev) { return !prev; }); },
          }, t("onlyFeatured")),
          h("select", {
            className: "__dbi_i_select",
            value: category,
            "aria-label": t("allCategories"),
            onChange: function (event) { setCategory(event && event.target ? event.target.value : ""); },
          },
            [h("option", { key: "__all", value: "" }, t("allCategories"))].concat(
              categories.map(function (name) { return h("option", { key: String(name), value: String(name) }, String(name)); })
            )
          ),
          h("select", {
            className: "__dbi_i_select",
            value: style,
            "aria-label": t("allStyles"),
            onChange: function (event) { setStyle(event && event.target ? event.target.value : ""); },
          },
            [h("option", { key: "__all", value: "" }, t("allStyles"))].concat(
              styles.map(function (name) { return h("option", { key: String(name), value: String(name) }, String(name)); })
            )
          ),
          h("select", {
            className: "__dbi_i_select",
            value: scene,
            "aria-label": t("allScenes"),
            onChange: function (event) { setScene(event && event.target ? event.target.value : ""); },
          },
            [h("option", { key: "__all", value: "" }, t("allScenes"))].concat(
              scenes.map(function (name) { return h("option", { key: String(name), value: String(name) }, String(name)); })
            )
          )
        );

        /* ── C2 分类导航（sticky，带计数）── */
        var catnav = h("nav", { className: "__dbi_i_catnav", "aria-label": t("categoryNav") },
          [
            h("button", {
              key: "__all",
              type: "button",
              className: "__dbi_i_catnavChip" + (category === "" && activeCategory === "" ? " __dbi_i_catnavChipOn" : ""),
              "aria-current": category === "" && activeCategory === "" ? "true" : undefined,
              onClick: clearFilters,
            },
              h("span", {}, t("allCategories")),
              h("em", { className: "__dbi_i_catnavCount" }, String(matching.length))
            )
          ].concat(
            categories.map(function (name) {
              var count = countOf(counts, name);
              var isActive = category === name || (category === "" && activeCategory === name);
              return h("button", {
                key: String(name),
                type: "button",
                disabled: count === 0,
                "aria-current": isActive ? "true" : undefined,
                className: "__dbi_i_catnavChip" + (isActive ? " __dbi_i_catnavChipOn" : ""),
                onClick: function () { jumpToCategory(name); },
              },
                h("span", {}, String(name)),
                h("em", { className: "__dbi_i_catnavCount" }, String(count))
              );
            })
          )
        );

        /* ── 左列：计数 + C4 分组 ── */
        var listBody;
        if (matching.length === 0) {
          listBody = h("div", { className: "__dbi_i_empty" },
            onlyFavorites ? t("emptyFavorites") : (onlyFeatured ? t("emptyFeatured") : t("empty")));
        } else {
          var groupNodes = groups.map(function (group) {
            var cards = group.items.map(function (item) {
              var key = favoriteKey(source.id, item.id);
              return h(InspirationCard, {
                key: String(item && item.id),
                item: item,
                sourceId: source.id,
                t: t,
                selected: selected !== null && selected.id === item.id,
                favorited: isFavorited(favorites, key),
                onToggleFavorite: function () { toggleFavorite(item.id); },
                onOpen: function () { setSelected(item); setCopied(""); },
              });
            });
            return h("section", {
              key: String(group.name),
              className: "__dbi_i_group",
            },
              h("h3", {
                className: "__dbi_i_groupHead",
                ref: function (node) { groupRefs.current[group.name] = node; },
              },
                h("span", {}, String(group.name)),
                h("em", { className: "__dbi_i_groupCount" }, String(countOf(counts, group.name) || group.items.length))
              ),
              h("div", { className: "__dbi_i_grid" }, cards)
            );
          });

          listBody = h("div", { className: "__dbi_i_list" },
            h("div", { className: "__dbi_i_groupWrap" }, groupNodes),
            canLoadMore(matching.length, visibleLimit)
              ? h("button", {
                  type: "button",
                  className: "__dbi_i_more",
                  onClick: function () { setVisibleLimit(function (n) { return n + LOAD_MORE_STEP; }); },
                }, t("loadMore"))
              : h("div", { className: "__dbi_i_endHint" }, t("allLoaded", { count: matching.length }))
          );
        }

        /* ── C7 左网格 + 右检查器 ── */
        body = h("div", { className: "__dbi_i_body" },
          sourceTabs,
          toolbar,
          catnav,
          h("div", { className: "__dbi_i_layout" },
            h("div", { className: "__dbi_i_main" },
              h("div", { className: "__dbi_i_summary" }, t("results", { count: matching.length })),
              listBody
            ),
            h(InspirationInspector, {
              item: selected,
              sourceId: source.id,
              t: t,
              copied: copied,
              favorited: selected !== null && isFavorited(favorites, favoriteKey(source.id, selected.id)),
              onToggleFavorite: function () { if (selected !== null) toggleFavorite(selected.id); },
              onCopy: handleCopy,
              onUse: handleUse,
            })
          )
        );
      }

      var noticeNode = notice === null
        ? null
        : h("div", {
            className: "__dbi_i_notice" + (notice.kind === "error" ? " __dbi_i_noticeError" : ""),
            role: "status",
          }, String(notice.text));

      return h("section", { className: "__dbi_i_root", "aria-label": t("title") },
        header,
        body,
        noticeNode
      );
    }

    shared.injectCss("dsh-doubao-image/inspiration.css", [
      /* 变量与根：与官方 INSPIRATION_STYLE 同构，换成 __dbi_i_ 前缀。 */
      ".__dbi_i_root{--dbi-i-blue:#2f64f5;--dbi-i-ink:#172033;--dbi-i-muted:#718099;--dbi-i-line:color-mix(in srgb,currentColor 11%,transparent);display:flex;flex-direction:column;gap:12px;padding:16px 20px 22px;box-sizing:border-box;min-height:0;flex:1 1 0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".__dbi_i_head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}",
      ".__dbi_i_headText{min-width:0}",
      ".__dbi_i_head h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.025em;color:var(--dsw-alias-label-primary)}",
      ".__dbi_i_kicker{margin:0 0 4px;font-size:11px;letter-spacing:.08em;font-weight:700;text-transform:uppercase;color:var(--dbi-i-blue)}",
      ".__dbi_i_subtitle{margin:5px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_i_headActions{display:flex;align-items:center;gap:8px;flex-shrink:0}",
      ".__dbi_i_refresh,.__dbi_i_clearCache{height:32px;padding:0 11px;display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}",
      ".__dbi_i_refresh:hover:not(:disabled){border-color:rgba(47,100,245,.42);color:var(--dbi-i-blue)}",
      ".__dbi_i_clearCache:hover:not(:disabled){border-color:rgba(239,68,68,.4);color:#ef4444}",
      ".__dbi_i_refresh:disabled,.__dbi_i_clearCache:disabled{opacity:.55;cursor:wait}",
      ".__dbi_i_sources{display:flex;flex-wrap:wrap;gap:7px}",
      ".__dbi_i_sourceChip{height:30px;padding:0 13px;display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}",
      ".__dbi_i_sourceChipOn{border-color:var(--dbi-i-blue);color:#fff;background:linear-gradient(135deg,#386cf6,#2758e7)}",
      /* C3：五列栅格工具栏（搜索 / 收藏筛选 / 精选 / 分类 / 风格 / 场景）。 */
      ".__dbi_i_toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto auto repeat(3,minmax(110px,140px));gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}",
      ".__dbi_i_search{min-width:0;position:relative}",
      ".__dbi_i_search input{width:100%;height:34px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;font:inherit;font-size:12px;outline:none}",
      ".__dbi_i_search input:focus,.__dbi_i_select:focus{border-color:var(--dbi-i-blue);box-shadow:0 0 0 3px rgba(47,100,245,.1)}",
      ".__dbi_i_featuredToggle,.__dbi_i_favFilter{height:34px;padding:0 12px;display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}",
      ".__dbi_i_featuredToggleOn,.__dbi_i_favFilterOn{background:#eef3ff;border-color:var(--dbi-i-blue);color:var(--dbi-i-blue);font-weight:600}",
      ".__dbi_i_select{width:100%;height:34px;box-sizing:border-box;border:1px solid transparent;border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 9px;font:inherit;font-size:12px;outline:none}",
      /* C2：sticky 分类导航。 */
      ".__dbi_i_catnav{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3)}",
      ".__dbi_i_catnavChip{height:26px;padding:0 11px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer}",
      ".__dbi_i_catnavChip:hover:not(:disabled){border-color:rgba(47,100,245,.46);color:var(--dbi-i-blue)}",
      ".__dbi_i_catnavChipOn{border-color:var(--dbi-i-blue);background:#eef3ff;color:var(--dbi-i-blue)}",
      ".__dbi_i_catnavChip:disabled{opacity:.4;cursor:default}",
      ".__dbi_i_catnavCount{font-style:normal;font-size:10px;opacity:.75}",
      /* C7：左网格 + 右 260–310px 检查器。 */
      ".__dbi_i_layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,310px);gap:18px;align-items:start}",
      ".__dbi_i_main{min-width:0}",
      ".__dbi_i_body{display:flex;flex-direction:column;gap:10px;min-height:0}",
      ".__dbi_i_list{display:flex;flex-direction:column}",
      ".__dbi_i_groupWrap{display:flex;flex-direction:column}",
      ".__dbi_i_summary{height:24px;display:flex;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
      /* C4：sticky 分组标题 + 组内计数。 */
      ".__dbi_i_group{margin:0}",
      ".__dbi_i_groupHead{position:sticky;top:48px;z-index:5;display:flex;align-items:center;gap:8px;margin:6px 0 10px;padding:7px 2px;font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);scroll-margin-top:48px}",
      ".__dbi_i_groupCount{font-style:normal;font-weight:600;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}",
      ".__dbi_i_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}",
      /* C12：content-visibility 懒渲染（与 LazyInspirationThumb 双保险）。 */
      ".__dbi_i_card{position:relative;min-width:0;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);text-align:left;cursor:pointer;display:flex;flex-direction:column;content-visibility:auto;contain-intrinsic-size:220px}",
      ".__dbi_i_card:hover{border-color:rgba(47,100,245,.58)}",
      ".__dbi_i_cardOn{border-color:var(--dbi-i-blue);box-shadow:0 0 0 1px var(--dbi-i-blue)}",
      ".__dbi_i_visual{position:relative;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden}",
      ".__dbi_i_thumb{width:100%;height:100%;object-fit:cover;display:block}",
      ".__dbi_i_lazyWrap{width:100%;height:100%}",
      ".__dbi_i_thumbFallback{padding:8px;font-size:11px;text-align:center;color:var(--dsw-alias-label-tertiary)}",
      ".__dbi_i_featured{position:absolute;top:6px;left:6px;padding:1px 6px;border-radius:999px;font-size:10px;background:var(--dbi-i-blue);color:#fff;z-index:2}",
      /* C6：卡片星标。默认半透明，收藏后常亮。 */
      ".__dbi_i_cardStar{position:absolute;top:6px;right:6px;z-index:3;width:24px;height:24px;display:grid;place-items:center;padding:0;border:none;border-radius:999px;background:rgba(15,23,42,.42);color:#fff;font-size:13px;line-height:1;cursor:pointer;opacity:.55;transition:opacity .15s ease,color .15s ease}",
      ".__dbi_i_card:hover .__dbi_i_cardStar{opacity:1}",
      ".__dbi_i_cardStarOn{opacity:1;color:#f59e0b}",
      ".__dbi_i_cardCopy{display:flex;flex-direction:column;gap:2px;padding:7px 8px}",
      ".__dbi_i_cardTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_i_cardCategory{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_i_cardSource{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_i_more{margin:12px auto 0;display:block;padding:6px 16px;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".__dbi_i_endHint{margin-top:12px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      /* C10：空态 / 失败态。 */
      ".__dbi_i_empty{min-height:180px;display:grid;place-items:center;padding:30px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;font-size:12px}",
      ".__dbi_i_error{display:flex;flex-direction:column;gap:12px}",
      ".__dbi_i_empty p{margin:0}",
      ".__dbi_i_retry{padding:6px 12px;border:none;border-radius:6px;background:rgba(47,100,245,.08);color:var(--dbi-i-blue);font:inherit;font-size:11px;font-weight:600;cursor:pointer}",
      /* C5：右侧 sticky 检查器。 */
      ".__dbi_i_inspector{position:sticky;top:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-3)}",
      ".__dbi_i_inspectorEmpty{min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:22px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}",
      ".__dbi_i_inspectorImage{aspect-ratio:16/10;position:relative;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;overflow:hidden}",
      ".__dbi_i_inspectorBody{padding:14px}",
      ".__dbi_i_inspectorHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}",
      ".__dbi_i_inspectorTitle{margin:0;font-size:14px;line-height:1.4;flex:1;color:var(--dsw-alias-label-primary)}",
      ".__dbi_i_inspectorFav{width:30px;height:30px;flex-shrink:0;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;display:grid;place-items:center;cursor:pointer}",
      ".__dbi_i_inspectorFav:hover{border-color:rgba(245,158,11,.4);color:#f59e0b}",
      ".__dbi_i_inspectorFavOn{color:#f59e0b;border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.08)}",
      ".__dbi_i_origin{margin:5px 0 12px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".__dbi_i_tags{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 12px}",
      ".__dbi_i_tag{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 6px;border-radius:4px;background:#eef3ff;color:#3e5fb8;font-size:10px}",
      ".__dbi_i_promptLabel{display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;font-size:10.5px;font-weight:650;color:var(--dsw-alias-label-tertiary)}",
      ".__dbi_i_promptCount{font-weight:500;opacity:.8}",
      ".__dbi_i_prompt{max-height:155px;margin:0;padding:9px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_i_actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px}",
      ".__dbi_i_actions button,.__dbi_i_link{height:34px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;text-decoration:none}",
      ".__dbi_i_actions button:hover,.__dbi_i_link:hover{border-color:rgba(47,100,245,.46);color:var(--dbi-i-blue)}",
      ".__dbi_i_use{grid-column:1/-1;border-color:var(--dbi-i-blue)!important;background:linear-gradient(135deg,#386cf6,#2758e7)!important;color:#fff!important}",
      ".__dbi_i_useRef{grid-column:1/-1;border-color:var(--dbi-i-blue)!important;background:transparent!important;color:var(--dbi-i-blue)!important}",
      ".__dbi_i_notice{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:9999;padding:9px 16px;border-radius:999px;background:rgba(15,23,42,.92);color:#fff;font-size:12px;font-weight:500}",
      ".__dbi_i_noticeError{background:rgba(185,28,28,.92)}",
      /* C13：三档响应式。 */
      "@media(max-width:980px){.__dbi_i_layout{grid-template-columns:1fr}.__dbi_i_inspector{position:relative;top:auto}.__dbi_i_inspectorEmpty{min-height:150px}}",
      "@media(max-width:700px){.__dbi_i_root{padding:12px}.__dbi_i_head{align-items:center}.__dbi_i_toolbar{grid-template-columns:1fr 1fr}.__dbi_i_search{grid-column:1/-1}.__dbi_i_favFilter{grid-column:1/-1}.__dbi_i_grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:9px}}",
      "@media(max-width:420px){.__dbi_i_toolbar{grid-template-columns:1fr}.__dbi_i_search{grid-column:auto}.__dbi_i_head{flex-direction:column}.__dbi_i_headActions{width:100%}}",
    ].join(""));

    exports.Mount = Mount;

    /**
     * 仅供离线自测的纯函数通道。
     *
     * **刻意挂在 globalThis 而不是 `exports` 上**：设计上冻结了 chunk 间
     * 契约——「每个 chunk 只导出 Mount」，容器只读 `mod.Mount`。把测试用的
     * 内部实现混进 exports 会扩大那个契约面，将来有人照着它写依赖就锁死了。
     * 这里只是「让自测能直接断言筛选 / 分页 / 收藏 / 分组这些规则本身」，
     * 而不是隔着渲染树去猜；与既有的 `__dshInspirationChunkMounted`
     * 自报标记同类。
     */
    if (typeof globalThis !== "undefined") {
      globalThis.__dshInspirationChunkInternals = {
        COPY: COPY,
        zh: COPY.zh,
        en: COPY.en,
        pickLang: pickLang,
        makeT: makeT,
        filterCases: filterCases,
        sliceVisible: sliceVisible,
        canLoadMore: canLoadMore,
        pickActiveSource: pickActiveSource,
        categoryCounts: categoryCounts,
        countOf: countOf,
        groupByCategory: groupByCategory,
        groupSignature: groupSignature,
        limitToRevealCategory: limitToRevealCategory,
        favoriteKey: favoriteKey,
        isFavorited: isFavorited,
        toggleFavoriteKey: toggleFavoriteKey,
        normalizeFavorites: normalizeFavorites,
        readFavorites: readFavorites,
        writeFavorites: writeFavorites,
        copyPromptText: copyPromptText,
        useInspirationImage: useInspirationImage,
        LazyInspirationThumb: LazyInspirationThumb,
        InspirationThumb: InspirationThumb,
        INSPIRATION_ROUTE: INSPIRATION_ROUTE,
        INSPIRATION_IMAGE_ROUTE: INSPIRATION_IMAGE_ROUTE,
        DEFAULT_VISIBLE_LIMIT: DEFAULT_VISIBLE_LIMIT,
        LOAD_MORE_STEP: LOAD_MORE_STEP,
        LOAD_MORE_JUMP_SLACK: LOAD_MORE_JUMP_SLACK,
        FAVORITES_STORAGE_KEY: FAVORITES_STORAGE_KEY,
      };
    }

    return module.exports;
  },
});
