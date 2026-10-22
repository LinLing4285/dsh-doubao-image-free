/**
 * dsh-doubao-image —— 画廊 chunk（`conversation.view` 槽的实现）。
 *
 * 形态说明见 SPEC-chunks.md 第 2 节：本文件由主 bundle 的
 * `require.async("./client.gallery.js")` 拉起，宿主取回后执行下面这个
 * `window.__ModuleLoader__.load(...)` 注册，主 bundle 拿到 `module.exports`。
 *
 * 本 chunk 是 rail-tabs 容器（画廊 / 灵感库 / 工作台）。画廊标签页自己
 * 实现（搜索 / 来源 / 比例 / 排序 / 工作区 / 收藏夹 / 批量管理 / 导入 /
 * 灯箱），后两个标签页走 `shared.ChunkMount` 内嵌各自的 chunk。
 *
 * 对外只有 `exports.Mount` 一个键。
 */
window.__ModuleLoader__.load({
  id: "dsh-doubao-image",
  chunk: "client.gallery.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    /*
     * 公共设施来自主 bundle。chunk 的 factory 只拿得到平台种子词，
     * 拿不到主 bundle 的内部函数，所以这份共享对象是唯一的通道。
     */
    var shared = (typeof globalThis !== "undefined" && globalThis.__dshDoubaoImageShared) || null;

    if (shared === null) {
      // 主 bundle 一定先于本文件执行（是它 require.async 的本文件），
      // 所以走到这里只可能是有人手工加载了 chunk。
      exports.Mount = function () {
        return h("div", { className: "__dbi_error" }, "dsh-doubao-image: shared runtime missing");
      };
      return module.exports;
    }

    var NS = shared.NS;
    var BASE = typeof shared.BASE === "string" ? shared.BASE : "/plugins/dsh-doubao-image";
    /**
     * 工作区归属字段的推导。
     *
     * 主 bundle 与 chunk 必须用**同一份**实现：字段名或「空即不写」的语义
     * 一旦分叉，`collectWorkspaces` 就会把同一个工作区收成两项。
     * 主 bundle 还没更新（旧版本被浏览器缓存）时退化成「不写工作区」，
     * 不影响出图与存库。
     */
    var workspaceFieldsFrom = shared && typeof shared.workspaceFieldsFrom === "function"
      ? shared.workspaceFieldsFrom
      : function () { return {}; };
    var pickSessionCwd = shared && typeof shared.pickSessionCwd === "function"
      ? shared.pickSessionCwd
      : function () { return ""; };
    /**
     * 这条记录是不是视频。
     *
     * 优先用主 bundle 的 `gallery.isVideoItem`（判据只有一份），缺失时
     * 按同一套规则就地兜底：`record.kind` 或 `attachment.kind` 命中即视频。
     * 兜底不是多余——chunk 与主 bundle 是两个独立的缓存单元，用户升级后
     * 完全可能「新 chunk + 旧主 bundle」，那时 `shared.gallery.isVideoItem`
     * 不存在，不兜底就是整个画廊页崩在 `undefined is not a function`。
     */
    var isVideoItem = shared && shared.gallery && typeof shared.gallery.isVideoItem === "function"
      ? shared.gallery.isVideoItem
      : function (item) {
        if (item === null || typeof item !== "object") return false;
        if (item.kind === "video") return true;
        var att = item.attachment;
        return att !== null && typeof att === "object" && att.kind === "video";
      };
    var IMPORT_ROUTE = BASE + "/api/import";
    /**
     * B8 的重新生成路由。
     *
     * 主 bundle **没有**这条路由（`index.js:45-55` 只有 11 条，全是登录 /
     * 图片字节 / 导入 / 灵感库）。请求打到未注册路径会 404，前端按
     * `regenerateFailed` 如实报错——这里**不假装能用**，也绝不静默伪造一张图。
     * Host 侧补齐 `POST /api/regenerate` 后此功能自动可用。
     */
    var REGENERATE_ROUTE = BASE + "/api/regenerate";
    var CSS_TAG = "dsh-doubao-image/gallery.css";

    /**
     * 内联图标。
     *
     * 官方用的是 lucide-react 组件，本插件不能引入依赖，
     * 所以按官方 `defaultAttributes` 逐字复刻 `svg` 外壳，`iconNode` 换成
     * 等价的静态子元素数组。属性值取自 dsh-image-gen 的 lucide v1.38.0
     * 实现：viewBox 0 0 24 24 / fill none / stroke currentColor /
     * strokeWidth 2 / linecap+linejoin round。
     */
    function makeIcon(size, children) {
      return h("svg", {
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      }, children);
    }

    /**
     * 四个顶层 tab 的图标，路径与官方所用的 lucide 图标逐字一致：
     * image / sliders-horizontal / sparkles / heart。
     */
    var ICONS = {
      image: function (size) {
        return makeIcon(size, [
          h("rect", { key: "r", width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }),
          h("circle", { key: "c", cx: 9, cy: 9, r: 2 }),
          h("path", { key: "p", d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }),
        ]);
      },
      /* 播放三角。lucide `play` 的轮廓，与上面几个图标同一套 stroke 风格。 */
      video: function (size) {
        return makeIcon(size, [
          h("path", { key: "a", d: "m6 3 14 9-14 9V3z" }),
        ]);
      },
      sliders: function (size) {
        return makeIcon(size, [
          h("path", { key: "a", d: "M10 5H3" }),
          h("path", { key: "b", d: "M12 19H3" }),
          h("path", { key: "c", d: "M14 3v4" }),
          h("path", { key: "d", d: "M16 17v4" }),
          h("path", { key: "e", d: "M21 12h-9" }),
          h("path", { key: "f", d: "M21 19h-5" }),
          h("path", { key: "g", d: "M21 5h-7" }),
          h("path", { key: "i", d: "M8 10v4" }),
          h("path", { key: "j", d: "M8 12H3" }),
        ]);
      },
      sparkles: function (size) {
        return makeIcon(size, [
          h("path", {
            key: "a",
            d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
          }),
          h("path", { key: "b", d: "M20 2v4" }),
          h("path", { key: "c", d: "M22 4h-4" }),
          h("circle", { key: "d", cx: 4, cy: 20, r: 2 }),
        ]);
      },
    };

    /**
     * 第一层 tab：图库 / 工作台 / 灵感。
     *
     * 顺序与官方 `.dsh-ig-studio-tabs-bar` 一致（图库 → 工作台 → 灵感）。
     * **官方还有一个顶层「收藏」，我们刻意不做**：收藏的图片来自图库，单独
     * 提一个顶层 tab 只会得到与图库页看不出区别的第二个网格（用户实测反馈
     * 2026-10-17：「收藏就是收藏，这样搞得跟图库栏一点区别都没有」）。
     * 收藏的入口留在图库内的二级视图，以及工作台左栏。
     *
     * 顺序是契约，但**数组下标不是**——测试要按 `id` 找。
     * 文案一律走字典（`label` 是字典键），不在本表里再写一份。
     */
    var TABS = [
      { id: "gallery", label: "tabGallery", icon: ICONS.image },
      /*
       * 视频单独一栏，不混进图库。
       *
       * 理由不只是「分类好看」：图库那一栏的工具条（比例筛选、重新生成、
       * 导入）对视频全都无意义——视频没有 `aspectRatio` 的可选集合，重新
       * 生成要重跑四分钟且再扣一次额度。分成两栏后，视频栏只保留对视频
       * 成立的操作（预览/下载/收藏/删除），不用在每个按钮里判类型。
       */
      { id: "videos", label: "tabVideos", icon: ICONS.video },
      { id: "studio", label: "tabStudio", icon: ICONS.sliders, chunk: "client.studio.js" },
      { id: "inspiration", label: "tabInspiration", icon: ICONS.sparkles, chunk: "client.inspiration.js" },
    ];

    /**
     * 第二层 tab（图库页内）：最新 / 收藏。
     *
     * 与顶层 `TABS` 同规矩：`label` 是字典键，不在这里再写一份文案
     * （此前这里是硬编码 zh/en，与 DICT 里的 `subRecent`/`subFavorites`
     * 各存一份、互不同步）。
     */
    var SUB_TABS = [
      { id: "recent", label: "subRecent" },
      { id: "favorites", label: "subFavorites" },
    ];

    // ── 语言 ────────────────────────────────────────────────────────────
    //
    // 每个 chunk 自带字典，不依赖主 bundle 的 t：三方并行开发时
    // 主 bundle 不可能收录所有 chunk 的词条。zh 与 en 的 key 必须完全一致，
    // 自测里有断言。

    var DICT = {
      zh: {
        tabGallery: "图库",
        tabVideos: "视频",
        tabStudio: "工作台",
        tabInspiration: "灵感",
        subRecent: "最新",
        subFavorites: "收藏",
        searchPlaceholder: "搜索提示词、模型或标签…",
        filterAllProviders: "全部来源",
        filterDoubao: "豆包",
        filterGpt: "GPT",
        filterImport: "导入",
        filterAllRatios: "全部比例",
        sortNewest: "最新优先",
        sortOldest: "最旧优先",
        workspaceAll: "全部工作区",
        workspaceBadge: "{selected}/{total}",
        importImages: "导入本地图",
        manage: "批量管理",
        exitManage: "退出管理",
        selectAll: "全选",
        /** B4：官方文案就是「反选 / Invert」。 */
        invertSelect: "反选",
        clearSelect: "取消全选",
        selectedCount: "已选 {count} 张",
        batchDelete: "批量删除",
        batchFavorite: "批量收藏",
        /** B5：官方进度文案「打包中 ({current}/{total})…」，逐字对齐。 */
        batchDownload: "批量下载",
        batchDownloading: "打包中 ({current}/{total})…",
        batchDownloadZipToast: "已打包 {count} 张",
        batchDownloadFailed: "打包失败",
        batchNoneSelected: "先选几张再下载",
        download: "下载",
        downloadFailed: "下载失败",
        copyImage: "复制图片",
        copySuccess: "已复制到剪贴板",
        copyFailed: "复制失败",
        regenerate: "重新生成",
        regenerating: "正在重新生成…",
        regenerateTitle: "重新生成",
        regenerateHint: "可以改提示词再生成一张，新图会存进画廊。",
        regenerateConfirm: "开始生成",
        regenerateCancel: "取消",
        regenerateSuccess: "已重新生成",
        regenerateSaveFailed: "生成成功但存入画廊失败",
        regenerateFailed: "重新生成失败",
        regenerateEmptyPrompt: "提示词不能为空",
        // 工作台「开始生成」的反馈文案。三类失败分开给，用户才知道该修什么。
        studioGenerateSuccess: "已生成并存入画廊",
        studioGenerateSaveFailed: "已生成，但存入画廊失败",
        studioGenerateEmptyPrompt: "提示词不能为空",
        studioGenerateNetworkFailed: "生成失败：无法连接服务，请检查插件服务是否运行",
        studioGenerateHttpFailed: "生成失败：服务返回 {status}",
        studioGenerateFailed: "生成失败：{detail}",
        delete: "删除",
        close: "关闭",
        favorite: "收藏",
        deleteConfirm: "确定删除这张图？此操作不可撤销。",
        batchDeleteConfirm: "确定删除选中的 {count} 张图？此操作不可撤销。",
        /** `buildDeleteMessage` 用的计数文案（单删/批删共用）。 */
        bulkDeleteMessage: "确定删除 {count} 张图？此操作不可撤销。",
        /**
         * B11：Host 侧没有「删除工作区磁盘文件」路由（本插件 11 条路由里没有）。
         * 按任务书要求只做勾选框，并在确认框里**如实说明**当前不落盘删除，
         * 绝不假装删了。
         */
        deleteWorkspaceFilesOpt: "同时清理工作区磁盘文件",
        deleteWorkspaceFilesUnsupported: "当前仅从画廊移除，不会删除磁盘文件（Host 尚未提供该接口）。",
        deleteFailedBusy: "删除失败：文件被占用",
        deleteFailedDatabase: "删除失败：画廊数据库异常",
        batchDeletedToast: "已删除 {count} 张",
        favoriteAddedToast: "已收藏 {count} 张",
        unfavoriteToast: "已取消收藏",
        favoriteToast: "已收藏",
        emptyTitle: "画廊还是空的",
        emptyDesc: "生成图片后会自动收进这里，也可以手动导入本地图。",
        videoEmptyTitle: "还没有视频",
        videoEmptyDesc: "用 doubao_image 工具并传 mode: video 生成，完成后自动收进这里。",
        favEmptyTitle: "还没有收藏",
        favEmptyDesc: "点卡片上的心形，把喜欢的图收进收藏夹。",
        noMatchTitle: "没有匹配的图",
        noMatchDesc: "换个关键词，或清掉来源 / 比例 / 工作区筛选。",
        noMatchVideoTitle: "没有匹配的视频",
        noMatchVideoDesc: "换个关键词，或清掉来源 / 比例 / 工作区筛选。",
        loading: "加载中…",
        unavailable: "画廊不可用：当前环境没有 IndexedDB。",
        noPrompt: "（无提示词）",
        justNow: "刚刚",
        minutesAgo: "{count} 分钟前",
        hoursAgo: "{count} 小时前",
        daysAgo: "{count} 天前",
        lightboxPrev: "上一张",
        lightboxNext: "下一张",
        importFailed: "导入失败",
        importAdded: "已导入 {count} 张",
        /** B13：部分失败要如实报「导入 N 张，M 张失败」，官方同款文案。 */
        importPartial: "导入 {count} 张，{fail} 张失败",
        tabLoadFailed: "该标签页加载失败",
      },
      en: {
        tabGallery: "Gallery",
        tabVideos: "Videos",
        tabStudio: "Studio",
        tabInspiration: "Inspiration",
        subRecent: "Recent",
        subFavorites: "Favorites",
        searchPlaceholder: "Search prompt, model or tag…",
        filterAllProviders: "All sources",
        filterDoubao: "Doubao",
        filterGpt: "GPT",
        filterImport: "Imported",
        filterAllRatios: "All ratios",
        sortNewest: "Newest first",
        sortOldest: "Oldest first",
        workspaceAll: "All workspaces",
        workspaceBadge: "{selected}/{total}",
        importImages: "Import images",
        manage: "Manage",
        exitManage: "Exit manage",
        selectAll: "Select all",
        invertSelect: "Invert",
        clearSelect: "Clear",
        selectedCount: "{count} selected",
        batchDelete: "Delete selected",
        batchFavorite: "Favorite selected",
        batchDownload: "Download selected",
        batchDownloading: "Packaging ({current}/{total})…",
        batchDownloadZipToast: "Packaged {count} images",
        batchDownloadFailed: "Packaging failed",
        batchNoneSelected: "Select images to download first",
        download: "Download",
        downloadFailed: "Download failed",
        copyImage: "Copy image",
        copySuccess: "Copied to clipboard",
        copyFailed: "Copy failed",
        regenerate: "Regenerate",
        regenerating: "Regenerating…",
        regenerateTitle: "Regenerate",
        regenerateHint: "Edit the prompt and generate a new image; it is saved to the gallery.",
        regenerateConfirm: "Generate",
        regenerateCancel: "Cancel",
        regenerateSuccess: "Regenerated",
        regenerateSaveFailed: "Generated, but saving to the gallery failed",
        regenerateFailed: "Regeneration failed",
        regenerateEmptyPrompt: "Prompt cannot be empty",
        studioGenerateSuccess: "Generated and saved to the gallery",
        studioGenerateSaveFailed: "Generated, but saving to the gallery failed",
        studioGenerateEmptyPrompt: "Prompt cannot be empty",
        studioGenerateNetworkFailed: "Generation failed: cannot reach the service — check that the plugin service is running",
        studioGenerateHttpFailed: "Generation failed: the service returned {status}",
        studioGenerateFailed: "Generation failed: {detail}",
        delete: "Delete",
        close: "Close",
        favorite: "Favorite",
        deleteConfirm: "Delete this image? This cannot be undone.",
        batchDeleteConfirm: "Delete the {count} selected images? This cannot be undone.",
        bulkDeleteMessage: "Delete {count} images? This cannot be undone.",
        deleteWorkspaceFilesOpt: "Also delete workspace disk files",
        deleteWorkspaceFilesUnsupported: "Currently only removes from the gallery; disk files are kept (the Host exposes no such route yet).",
        deleteFailedBusy: "Delete failed: file is in use",
        deleteFailedDatabase: "Delete failed: gallery database error",
        batchDeletedToast: "Deleted {count}",
        favoriteAddedToast: "Favorited {count}",
        unfavoriteToast: "Unfavorited",
        favoriteToast: "Favorited",
        emptyTitle: "Your gallery is empty",
        emptyDesc: "Generated images land here automatically, or import local files.",
        videoEmptyTitle: "No videos yet",
        videoEmptyDesc: "Generate with the doubao_image tool and mode: video; finished clips land here automatically.",
        favEmptyTitle: "No favorites yet",
        favEmptyDesc: "Tap the heart on a card to keep it here.",
        noMatchTitle: "No matching images",
        noMatchDesc: "Try another keyword, or clear the source / ratio / workspace filters.",
        noMatchVideoTitle: "No matching videos",
        noMatchVideoDesc: "Try another keyword, or clear the source / ratio / workspace filters.",
        loading: "Loading…",
        unavailable: "Gallery unavailable: IndexedDB is not available here.",
        noPrompt: "(no prompt)",
        justNow: "Just now",
        minutesAgo: "{count}m ago",
        hoursAgo: "{count}h ago",
        daysAgo: "{count}d ago",
        lightboxPrev: "Previous",
        lightboxNext: "Next",
        importFailed: "Import failed",
        importAdded: "Imported {count}",
        importPartial: "Imported {count}, {fail} failed",
        tabLoadFailed: "Failed to load this tab",
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

    /** 造一个 `t(key, params)`；缺 key 时回退中文再回退 key 本身。 */
    function makeT(lang) {
      var dict = lang === "en" ? DICT.en : DICT.zh;
      return function (key, params) {
        var text = dict[key] !== undefined ? dict[key] : DICT.zh[key];
        if (text === undefined) text = key;
        if (params) {
          var names = Object.keys(params);
          for (var i = 0; i < names.length; i++) {
            text = text.replace("{" + names[i] + "}", String(params[names[i]]));
          }
        }
        return text;
      };
    }

    // ── ZIP 打包（B5） ──────────────────────────────────────────────────
    //
    // 官方 `dsh-image-gen` 也没用 jszip，是手写的（`lib/client.js:1876-1958`）。
    // 这里按同一结构复现：本地文件头 + 中央目录 + 结尾记录，**store 模式
    // （compression method = 0，不压缩）**——图片本来就是压缩过的，再套一层
    // deflate 收益极小而实现风险大。
    //
    // 字节结构（全部小端）：
    //   本地文件头  30 字节 + 文件名 + 数据   签名 0x04034b50
    //   中央目录项  46 字节 + 文件名          签名 0x02014b50
    //   结尾记录    22 字节                   签名 0x06054b50

    /** CRC-32（IEEE 802.3）查找表，与 zip 规范一致。 */
    var CRC_TABLE = (function () {
      var table = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
        table[i] = c;
      }
      return table;
    })();

    /** 算 `bytes` 的 CRC-32，返回无符号 32 位整数。 */
    function crc32(bytes) {
      var crc = 4294967295;
      for (var i = 0; i < bytes.length; i++) {
        crc = (CRC_TABLE[(crc ^ bytes[i]) & 255] ^ crc >>> 8) >>> 0;
      }
      return (crc ^ 4294967295) >>> 0;
    }

    /**
     * 一张图在 ZIP 里的文件名。
     *
     * `provider` 与 id 前 8 位足以分辨，扩展名由 mediaType 决定——图片是
     * 二进制，扩展名错了有些解压器会拒开。`used` 是去重集合，重名追加 `-N`。
     */
    function zipEntryName(item, used) {
      var mediaType = item && item.attachment && typeof item.attachment.mediaType === "string"
        ? item.attachment.mediaType
        : "";
      /*
       * 视频没有 `mediaType`（Host `saveFile` 不存），靠 `kind` 认。
       * 扩展名必须是 `.mp4`：豆包视频接口产出的就是 MP4，而下载下来的
       * 文件双击要靠扩展名关联播放器——叫 `.png` 的 MP4 打不开。
       */
      var isVideo = isVideoItem(item);
      var ext = isVideo ? "mp4"
        : mediaType === "image/jpeg" ? "jpg"
          : mediaType === "image/webp" ? "webp"
            : mediaType === "image/gif" ? "gif"
              : "png";
      var provider = item && typeof item.provider === "string" && item.provider !== "" ? item.provider : "image";
      var id = item && typeof item.id === "string" ? item.id : "";
      var base = "dsh-" + provider + "-" + id.slice(0, 8) + "." + ext;
      var name = base;
      var n = 1;
      while (used[name] === true) {
        name = base.replace(/\.[^.]+$/, "") + "-" + String(n) + "." + ext;
        n += 1;
      }
      used[name] = true;
      return name;
    }

    /**
     * 手写 ZIP：入参 `[{name, data: Uint8Array}]`，返回 `Uint8Array` 字节。
     *
     * 返回字节而不是 `Blob`：自测要能**逐字节**核对头部与中央目录
     * （断言针对规则本身），而 Blob 在 Node 里要绕一圈
     * 才能读出来。UI 侧再包成 `Blob` 交给 `URL.createObjectURL`。
     */
    function buildZip(files) {
      var list = Array.isArray(files) ? files : [];
      var encoder = new TextEncoder();
      var parts = [];
      var central = [];
      var offset = 0;

      for (var i = 0; i < list.length; i++) {
        var entry = list[i] || {};
        var nameBytes = encoder.encode(String(entry.name === undefined ? "" : entry.name));
        var data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || 0);
        var crc = crc32(data);
        var size = data.length;

        var local = new Uint8Array(30);
        var lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true); // 本地文件头签名
        lv.setUint16(4, 20, true); // 解压所需版本 2.0
        lv.setUint16(6, 0, true); // 通用标志位
        lv.setUint16(8, 0, true); // 压缩方法 0 = store
        lv.setUint16(10, 0, true); // 最后修改时间
        lv.setUint16(12, 0, true); // 最后修改日期
        lv.setUint32(14, crc, true); // CRC-32
        lv.setUint32(18, size, true); // 压缩后大小
        lv.setUint32(22, size, true); // 原始大小
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true); // 扩展字段长度
        parts.push(local, nameBytes, data);

        var cd = new Uint8Array(46);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true); // 中央目录签名
        cv.setUint16(4, 20, true); // 生成方版本
        cv.setUint16(6, 20, true); // 解压所需版本
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true); // 扩展字段长度
        cv.setUint16(32, 0, true); // 注释长度
        cv.setUint16(34, 0, true); // 起始磁盘号
        cv.setUint16(36, 0, true); // 内部属性
        cv.setUint32(38, 0, true); // 外部属性
        cv.setUint32(42, offset, true); // 本地头相对偏移
        central.push(cd, nameBytes);

        offset += local.length + nameBytes.length + data.length;
      }

      var cdOffset = offset;
      var cdSize = 0;
      for (var j = 0; j < central.length; j++) cdSize += central[j].byteLength;

      var eocd = new Uint8Array(22);
      var ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true); // 结尾记录签名
      ev.setUint16(4, 0, true); // 当前磁盘号
      ev.setUint16(6, 0, true); // 中央目录起始磁盘号
      ev.setUint16(8, list.length, true); // 本磁盘条目数
      ev.setUint16(10, list.length, true); // 总条目数
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, cdOffset, true);
      ev.setUint16(20, 0, true); // 注释长度

      return concatBytes(parts.concat(central, [eocd]));
    }

    /** 把若干 Uint8Array 拼成一个。 */
    function concatBytes(chunks) {
      var total = 0;
      for (var i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
      var out = new Uint8Array(total);
      var at = 0;
      for (var j = 0; j < chunks.length; j++) {
        out.set(chunks[j], at);
        at += chunks[j].byteLength;
      }
      return out;
    }

    /** 从 `/api/image` 取回图片字节。失败抛错（调用处计一次失败）。 */
    function fetchImageBytes(attachment, ctx) {
      /*
       * 视频走 `ctx.videoRoute`。两条路由的服务端实现不同（`readImage` vs
       * `readFileStream`），拿视频引用去调图片路由必然 400。
       * `videoRoute` 缺失时退回图片路由：老宿主没有那条路由，行为与改前一致。
       */
      var isVideo = attachment !== null && typeof attachment === "object" && attachment.kind === "video";
      var route = isVideo && typeof ctx.videoRoute === "string" && ctx.videoRoute !== ""
        ? ctx.videoRoute
        : ctx.imageRoute;
      return Promise.resolve(ctx.fetch(route, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachment: attachment }),
      })).then(function (response) {
        if (!response || response.ok !== true) throw new Error("HTTP " + String(response && response.status));
        return response.arrayBuffer();
      }).then(function (buffer) {
        return new Uint8Array(buffer);
      });
    }

    /**
     * 批量下载：逐张取字节 → 打 ZIP → 触发下载（B5）。
     *
     * `ctx`：`{fetch, imageRoute, saveBlobUrl(url, filename), revokeBlobUrl(url),
     * onProgress(current, total), makeBlob(parts, type), now()}`。
     *
     * 单张失败**不中断**整体（与官方一致：官方也是整包 catch），但会记进
     * `failed` 并如实回报——「8 张里 2 张取不到」不该被静默吞掉。
     */
    function buildGalleryZip(items, ctx) {
      var list = Array.isArray(items) ? items : [];
      var used = {};
      var files = [];
      var failed = 0;

      return list.reduce(function (chain, item) {
        return chain.then(function () {
          var index = files.length + failed;
          if (typeof ctx.onProgress === "function") ctx.onProgress(index, list.length);
          if (!item || !item.attachment) {
            failed += 1;
            return null;
          }
          return fetchImageBytes(item.attachment, ctx).then(function (bytes) {
            files.push({ name: zipEntryName(item, used), data: bytes });
            return null;
          }, function () {
            failed += 1;
            return null;
          });
        });
      }, Promise.resolve()).then(function () {
        if (typeof ctx.onProgress === "function") ctx.onProgress(list.length, list.length);
        if (files.length === 0) return { ok: false, packed: 0, failed: failed, url: "" };
        var bytes = buildZip(files);
        var blob = typeof ctx.makeBlob === "function"
          ? ctx.makeBlob([bytes], "application/zip")
          : new Blob([bytes], { type: "application/zip" });
        var url = ctx.saveBlobUrl(blob, zipFileName(ctx.now()));
        return { ok: true, packed: files.length, failed: failed, url: url, bytes: bytes };
      });
    }

    /** ZIP 文件名：`dsh-gallery-YYYYMMDD.zip`（官方同款）。 */
    function zipFileName(timestamp) {
      var d = new Date(typeof timestamp === "number" && isFinite(timestamp) ? timestamp : 0);
      var pad = function (n) { return n < 10 ? "0" + String(n) : String(n); };
      return "dsh-gallery-" + String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + ".zip";
    }

    // ── 复制图片 / 单图下载（B6 / B7） ──────────────────────────────────

    /**
     * 复制图片到剪贴板（B7）。
     *
     * 走 `ClipboardItem` + `navigator.clipboard.write`（官方同款实现，
     * `lib/client.js:1801`）。**先取到 PNG 字节**：剪贴板只稳定支持
     * `image/png`，其他格式要先过 canvas 转（这里不做，非 PNG 直接报不支持，
     * 免得静默复制出一张打不开的图）。
     */
    function copyImageToClipboard(attachment, ctx) {
      if (typeof ctx.clipboardItem !== "function" || !ctx.clipboard || typeof ctx.clipboard.write !== "function") {
        return Promise.resolve(false);
      }
      return fetchImageBytes(attachment, ctx).then(function (bytes) {
        var mediaType = attachment && typeof attachment.mediaType === "string" ? attachment.mediaType : "image/png";
        var type = mediaType === "image/png" ? "image/png" : mediaType;
        var blob = ctx.makeBlob([bytes], type);
        return ctx.clipboard.write([ctx.clipboardItem({ "image/png": blob })]).then(function () {
          return true;
        });
      });
    }

    /** 单图/单视频下载（B6）：同样的字节流，走 `a[download]`。 */
    function downloadSingleImage(item, ctx) {
      if (!item || !item.attachment) return Promise.resolve(false);
      return fetchImageBytes(item.attachment, ctx).then(function (bytes) {
        var used = {};
        var name = zipEntryName(item, used);
        /*
         * 视频的 `mediaType` 是空的，必须显式给 `video/mp4`。
         * 不写的话会落成 `image/png` 的 Blob —— 字节是对的，但
         * `a[download]` 保存下来后系统按 MIME 关联，双击仍打不开。
         */
        var isVideo = isVideoItem(item);
        var type = isVideo ? "video/mp4" : (item.attachment.mediaType || "image/png");
        var blob = ctx.makeBlob([bytes], type);
        ctx.saveBlobUrl(blob, name);
        return true;
      });
    }

    /**
     * 触发一次「另存为」：造临时 `<a href=blobUrl download=name>` 点一下再撤销。
     *
     * 撤销用 `setTimeout(…, 0)` 而不是立刻——立刻 revoke 会让部分浏览器
     * 来不及开始下载（官方也是先 revoke 后置空，这里保守一点）。
     */
    function triggerDownload(url, filename, doc) {
      var document0 = doc || (typeof document !== "undefined" ? document : null);
      if (document0 === null || !document0.body) return false;
      var anchor = document0.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = "none";
      document0.body.appendChild(anchor);
      anchor.click();
      document0.body.removeChild(anchor);
      return true;
    }

    // ── 重新生成（B8） ──────────────────────────────────────────────────

    /**
     * `/api/regenerate` 的请求体。
     *
     * `provider` 决定走哪条通道（豆包 / GPT），`aspectRatio` 作为提示词之外
     * 唯一的画幅线索透传——本插件 Host 侧的生成工具只认 `size`/`ratio`，
     * 没有官方那套 `quality`。
     */
    function buildRegenerateBody(item, prompt) {
      var body = { prompt: String(prompt === undefined || prompt === null ? "" : prompt) };
      if (item && typeof item.provider === "string" && item.provider !== "" && item.provider !== "import") {
        body.provider = item.provider;
      }
      if (item && typeof item.aspectRatio === "string" && item.aspectRatio !== "") {
        body.ratio = item.aspectRatio;
      }
      return body;
    }

    /**
     * 重新生成一张图并落进画廊（B8）。
     *
     * `ctx`：`{fetch, route, saveItem, now, idFor(attachment)}`。
     * 返回 `{ok, item}` 或 `{ok:false, reason}`——调用处据此给 toast。
     */
    function performRegenerate(item, prompt, ctx) {
      var text = typeof prompt === "string" ? prompt.trim() : "";
      if (text === "") return Promise.resolve({ ok: false, reason: "empty-prompt" });

      return Promise.resolve(ctx.fetch(ctx.route, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegenerateBody(item, text)),
      })).then(function (response) {
        return Promise.resolve(response && response.json ? response.json().catch(function () { return null; }) : null)
          .then(function (payload) {
            if (!response || response.ok !== true || !payload || !payload.attachment) {
              var reason = payload && payload.message ? payload.message : (payload && payload.reason ? payload.reason : "HTTP " + String(response && response.status));
              throw new Error(String(reason));
            }
            return payload;
          });
      }).then(function (payload) {
        var attachment = payload.attachment;
        var next = {
          id: String(attachment.attachmentId),
          attachment: attachment,
          prompt: typeof payload.prompt === "string" ? payload.prompt : text,
          provider: typeof payload.provider === "string" ? payload.provider : (item && item.provider) || "",
          model: typeof payload.model === "string" ? payload.model : "",
          createdAt: typeof payload.createdAt === "number" ? payload.createdAt : ctx.now(),
          isFavorite: false,
        };
        if (item && typeof item.aspectRatio === "string" && item.aspectRatio !== "") next.aspectRatio = item.aspectRatio;
        if (item && typeof item.workspacePath === "string" && item.workspacePath !== "") next.workspacePath = item.workspacePath;
        if (item && typeof item.workspaceId === "string" && item.workspaceId !== "") next.workspaceId = item.workspaceId;
        if (item && typeof item.sessionId === "string" && item.sessionId !== "") next.sessionId = item.sessionId;
        return Promise.resolve(ctx.saveItem(next)).then(function (saved) {
          return { ok: true, item: next, saved: saved !== false };
        });
      }).catch(function (error) {
        return { ok: false, reason: error && error.message ? error.message : String(error) };
      });
    }

    // ── 工作台「开始生成」的真实出图（studio chunk 的 onGenerate） ────────
    //
    // 工作台的生成面板把「开始生成」委派给容器的 `props.onGenerate(prompt,
    // ratio, tool)`。容器不重造请求口径，直接复用上面 B8 已有的
    // `/api/regenerate`——两条入口打同一条路由、落同一个画廊，才不会出现
    // 「重新生成能出图、工作台出不了」这种分裂。

    /**
     * 工作台生成用的请求体。
     *
     * 与 B8 的差别只有一个：工作台的通道与画幅来自面板下拉，而不是来自被
     * 重生成的旧图，所以参数直接取面板传入值，不需要 `item`。
     *
     * `tool` 是面板通道（`"doubao"` / `"gpt"`），空了就不带 provider，让
     * Host 走自己的缺省；`ratio` 只在通道支持画幅时才有值（GPT 通道面板
     * 传空串），所以这里同样按「空即不带」处理，不去编一个默认比例——
     * 编一个会让 GPT 通道凭空多出一个它本来不接受的画幅线索。
     */
    function buildStudioGenerateBody(prompt, ratio, tool, options) {
      var body = { prompt: String(prompt === undefined || prompt === null ? "" : prompt) };
      if (typeof tool === "string" && tool !== "") body.provider = tool === "gpt_image" ? "gpt" : tool === "doubao_image" ? "doubao" : tool;
      if (typeof ratio === "string" && ratio !== "") body.ratio = ratio;
      if (options) {
        body.mode = options.mode;
        body.references = options.references || [];
        /*
         * 模型只在豆包通道有。空值与 GPT 通道都不带——带个空串会让 Host
         * 的 `body.model !== ""` 判据退化成「未指定」，不如不写。
         */
        if (typeof options.model === "string" && options.model !== "" && body.provider === "doubao") {
          body.model = options.model;
        }
      }
      return body;
    }

    /**
     * 工作台生成的结果 → toast key。
     *
     * 三类失败必须能分开，用户才知道该去修什么：网络层没打通、Host 这一跳
     * 返了非 200、Host 回了业务拒绝（`ok:false`）。前两类在 `performStudioGenerate`
     * 里被规范成不同的 reason 前缀，这里按前缀分流；**不做「失败也当成功」
     * 的兜底**——静默吞掉失败会让用户以为图已经生成了。
     */
    function studioGenerateToastKey(result) {
      if (result && result.ok === true) return result.saved === true ? "studioGenerateSuccess" : "studioGenerateSaveFailed";
      var reason = result && typeof result.reason === "string" ? result.reason : "";
      if (reason.indexOf("empty-prompt") === 0) return "studioGenerateEmptyPrompt";
      if (reason.indexOf("network-") === 0) return "studioGenerateNetworkFailed";
      if (reason.indexOf("http-") === 0) return "studioGenerateHttpFailed";
      return "studioGenerateFailed";
    }

    /**
     * 工作台「开始生成」的真实实现。签名与工作台 chunk 的接缝一致：
     * `onGenerate(prompt, ratio, tool, {mode, references: File[]}) → promise`。
     * 原三参数仍是文生图；图生图复用导入路由上传字节后传附件引用。
     * 失败返回可见原因，容器 toast 与工作台通知均可展示。
     *
     * `ctx`：`{fetch, route, saveItem, now, workspaceFields}`，与 B8 的
     * `performRegenerate` 同形，便于测试用同一套桩驱动。`workspaceFields`
     * 是**可选的**工作区归属字段（`{workspacePath, sessionId}`）：容器从宿主
     * 的 `cwd` 推导后透传进来，缺省时不写——见 `workspaceFieldsFrom` 的注释。
     */
    function performStudioGenerate(prompt, ratio, tool, ctx, options) {
      var text = typeof prompt === "string" ? prompt.trim() : "";
      if (text === "") return Promise.resolve({ ok: false, reason: "empty-prompt" });
      // 存库时统一并进每条记录；放在这里而不是每个字面量里，避免漏掉某条分支。
      var wsFields = ctx !== null && typeof ctx === "object" && ctx.workspaceFields !== null && typeof ctx.workspaceFields === "object"
        ? ctx.workspaceFields
        : {};

      var response;
      var requestOptions;
      return Promise.resolve()
        .then(function () {
          if (!options) return;
          if (options.mode !== "edit" && options.mode !== "generate") throw new Error("invalid-mode");
          requestOptions = { mode: options.mode, references: [] };
          // 模型是面板选定的通道参数，和 mode 同级透传；缺省不写，交给 Host 用设置值。
          if (typeof options.model === "string" && options.model !== "") requestOptions.model = options.model;
          if (options.mode !== "edit") return;
          /*
           * GPT 图生图已支持（2026-10-22）：参考图先经 `/api/import` 落成本地
           * attachment，再随 `references` 发给 Host，由 Host 上传到 ChatGPT 文件
           * 服务并用 `image_asset_pointer` 引用。这里原先有一条 GPT 硬拒，
           * 那是实现缺失时的占位，已移除。
           */
          var files = options.references;
          if (!Array.isArray(files) || files.length === 0) throw new Error("reference-required");
          return files.reduce(function (chain, file) {
            return chain.then(function () {
              return (ctx.readFile || readFileAsDataUrl)(file);
            }).then(function (dataUrl) {
              return ctx.fetch(ctx.importRoute || IMPORT_ROUTE, {
                method: "POST", credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(buildImportBody(file.name || "reference-image", dataUrl)),
              });
            }).then(function (res) {
              return Promise.resolve(res.json()).then(function (payload) {
                if (!res.ok || !payload || payload.ok !== true || !payload.attachment) {
                  throw new Error(payload && (payload.message || payload.reason) || "reference-upload-failed");
                }
                requestOptions.references.push(payload.attachment);
              });
            });
          }, Promise.resolve());
        })
        .then(function () {
          /*
           * fetch 抛异常（断网 / 被拦截）时**同步抛**与**返回 rejected promise**
           * 是两条不同的路径：把调用包在 try 里，两种都归一成 `network-` 前缀，
           * 否则同步抛会绕过 `.catch` 直接落到最外层，reason 里就丢了前缀，
           * 用户看到的是「生成失败」而不是「无法连接服务」。
           */
          var call;
          try {
            call = ctx.fetch(ctx.route, {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(buildStudioGenerateBody(text, ratio, tool, requestOptions)),
            });
          } catch (error) {
            throw new Error("network-" + String(error && error.message ? error.message : error));
          }
          return Promise.resolve(call).catch(function (error) {
            throw new Error("network-" + String(error && error.message ? error.message : error));
          });
        })
        .then(function (res) {
          response = res || null;
          return Promise.resolve(response && response.json ? response.json().catch(function () { return null; }) : null);
        })
        .then(function (payload) {
          // 先把「没出图」判掉：非 200、或 200 却没有附件，都不许往下走去存库。
          if (response === null || response.ok !== true) {
            var detail = payload && payload.message ? payload.message : (payload && payload.reason ? payload.reason : "");
            throw new Error("http-" + String(response === null ? "no-response" : response.status) + (detail === "" ? "" : " " + detail));
          }
          if (!payload || payload.ok !== true || !payload.attachment) {
            throw new Error(payload ? [payload.reason, payload.message].filter(Boolean).join(": ") || "no-attachment" : "no-attachment");
          }
          if (requestOptions && requestOptions.mode === "edit") {
            var outputs = [payload.attachment].concat(Array.isArray(payload.extraAttachments) ? payload.extraAttachments : []);
            if (outputs.some(function (attachment) {
              return !attachment || typeof attachment.attachmentId !== "string" || requestOptions.references.some(function (ref) { return ref.attachmentId === attachment.attachmentId; });
            })) throw new Error("通道返回了参考图原件或无效附件，未产生新图片");
            var ratios = Array.isArray(payload.itemRatios) ? payload.itemRatios : null;
            var editedItems = outputs.map(function (attachment, index) {
              var next = Object.assign({
                id: String(attachment.attachmentId), attachment: attachment,
                prompt: typeof payload.prompt === "string" ? payload.prompt : text,
                provider: typeof payload.provider === "string" ? payload.provider : "doubao",
                model: typeof payload.model === "string" ? payload.model : "",
                createdAt: typeof payload.createdAt === "number" ? payload.createdAt : ctx.now(),
                isFavorite: false,
              }, wsFields);
              /*
               * 路由现在对**文生图与图生图**都回传模型信息（两条链路同端点），
               * 所以判据是「有没有 requestModel」，不再是模式或 modelProvenance。
               */
              if (typeof payload.requestModel === "string" && payload.requestModel !== "") {
                next.requestModel = payload.requestModel;
                if (typeof payload.actualModel === "string") next.actualModel = payload.actualModel;
              }
              // 图生图只存服务端逐图回显；缺失或空串不回退面板旧比例。
              var actualRatio = ratios ? ratios[index] : (index === 0 ? payload.ratio : "");
              if (typeof actualRatio === "string" && actualRatio !== "") next.aspectRatio = actualRatio;
              return next;
            });
            return editedItems.reduce(function (chain, next) {
              return chain.then(function (saved) {
                return Promise.resolve(ctx.saveItem(next)).then(function (ok) { return saved && ok !== false; });
              });
            }, Promise.resolve(true)).then(function (saved) {
              return { ok: true, item: editedItems[0], items: editedItems, saved: saved };
            });
          }

          var attachment = payload.attachment;
          var next = Object.assign({
            id: String(attachment.attachmentId),
            attachment: attachment,
            prompt: typeof payload.prompt === "string" ? payload.prompt : text,
            provider: typeof payload.provider === "string" ? payload.provider : (typeof tool === "string" ? tool : ""),
            model: typeof payload.model === "string" ? payload.model : "",
            createdAt: typeof payload.createdAt === "number" ? payload.createdAt : ctx.now(),
            isFavorite: false,
          }, wsFields);
          // 画幅优先信 Host 回给的那一个：Host 会把豆包吸附成最终比例，
          // 写面板原始值会让画廊比例筛选和实际图片对不上。
          var finalRatio = typeof payload.ratio === "string" && payload.ratio !== ""
            ? payload.ratio
            : (typeof ratio === "string" ? ratio : "");
          if (finalRatio !== "") next.aspectRatio = finalRatio;

          return Promise.resolve(ctx.saveItem(next)).then(function (saved) {
            return { ok: true, item: next, saved: saved !== false };
          });
        })
        .catch(function (error) {
          return { ok: false, reason: error && error.message ? error.message : String(error) };
        });
    }

    /** 删除失败分类（B12）：按错误内容分出「占用」与「数据库」两把文案。 */
    function classifyDeleteError(error) {
      var text = String(error && error.message ? error.message : error || "").toLowerCase();
      if (/ebusy|eperm|eacces|lock|locked|occup|busy|in use|sharing violation/.test(text)) return "busy";
      return "database";
    }

    // ── 纯函数（过滤 / 排序 / 收集 / 导入 / 批量） ───────────────────────
    //
    // 全部是纯的、不碰 React，所以自测能逐个断言判据本身，而不是只断言
    // 「渲染没崩」。

    var normalizeWs = typeof shared.normalizeWorkspacePath === "function"
      ? shared.normalizeWorkspacePath
      : function (raw) {
        if (typeof raw !== "string") return "";
        var p = raw.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
        if (p.length > 1) p = p.replace(/\/+$/, "");
        return p.toLowerCase();
      };

    /** 比例筛选的判据就是 `item.aspectRatio` 本身。 */
    function itemRatio(item) {
      if (!item || typeof item !== "object") return "";
      return typeof item.aspectRatio === "string" ? item.aspectRatio.trim() : "";
    }

    /**
     * 相对时间（B15，官方同款分档）。
     *
     * 阈值与官方一致：<1 分钟「刚刚」、<1 小时「N 分钟前」、<1 天「N 小时前」、
     * <30 天「N 天前」，再往前直接给 `YYYY/M/D`。
     */
    function relativeTime(createdAt, t, now) {
      var ts = typeof createdAt === "number" && isFinite(createdAt) ? createdAt : 0;
      var current = typeof now === "number" && isFinite(now) ? now : Date.now();
      var diff = current - ts;
      if (diff < 0) diff = 0;
      if (diff < 60000) return t("justNow");
      if (diff < 3600000) return t("minutesAgo", { count: String(Math.floor(diff / 60000)) });
      if (diff < 86400000) return t("hoursAgo", { count: String(Math.floor(diff / 3600000)) });
      if (diff < 2592000000) return t("daysAgo", { count: String(Math.floor(diff / 86400000)) });
      var d = new Date(ts);
      return String(d.getFullYear()) + "/" + String(d.getMonth() + 1) + "/" + String(d.getDate());
    }

    /**
     * 反选（B4）：在 `filtered` 里把没选的补上、选了的去掉。
     *
     * 独立成纯函数而不是内联在 onClick 里——官方 `handleInvertSelect`
     * （`lib/client.js:122627`）就是这个语义，但内联版本没法单独断言。
     */
    function invertSelection(filtered, selectedIds) {
      var list = Array.isArray(filtered) ? filtered : [];
      var current = Array.isArray(selectedIds) ? selectedIds : [];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var id = list[i] && list[i].id;
        if (current.indexOf(id) === -1) out.push(id);
      }
      return out;
    }

    /**
     * 全选 / 反选 / 清空三态（B4）。
     *
     * 官方把「清空」也放在管理模式里（`全选 / 反选 / 清空`），这里照做：
     * `mode="all"` 全选当前筛选结果，`"invert"` 反选，`"clear"` 清空。
     */
    function applySelection(mode, filtered, selectedIds) {
      var list = Array.isArray(filtered) ? filtered : [];
      if (mode === "all") return list.map(function (item) { return item && item.id; });
      if (mode === "clear") return [];
      if (mode === "invert") return invertSelection(list, selectedIds);
      return Array.isArray(selectedIds) ? selectedIds.slice() : [];
    }

    /** B13：导入结果的一条文案（三态：全成功 / 部分失败 / 全失败）。 */
    function importToastKey(result) {
      var added = result && typeof result.added === "number" ? result.added : 0;
      var failed = result && typeof result.failed === "number" ? result.failed : 0;
      if (added > 0 && failed > 0) return "importPartial";
      if (added > 0) return "importAdded";
      return "importFailed";
    }

    /** 当前灯箱项在筛选结果里的下标；找不到返回 -1。 */
    function previewIndex(filtered, item) {
      var list = Array.isArray(filtered) ? filtered : [];
      if (!item || typeof item.id !== "string") return -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === item.id) return i;
      }
      return -1;
    }

    /**
     * 灯箱翻页（B9 / B10）。
     *
     * 越界时不回绕——首张按「上一张」停在首张，末张按「下一张」停在末张，
     * 与官方 `goToPrev`/`goToNext`（`lib/client.js:122454`）的边界语义一致
     * （官方靠 `hasPrev/hasNext` 把按钮藏掉，这里两者都做：藏按钮 + 边界钳制）。
     */
    function stepPreview(filtered, item, delta) {
      var list = Array.isArray(filtered) ? filtered : [];
      var at = previewIndex(list, item);
      if (at === -1) return item;
      var next = at + delta;
      if (next < 0 || next >= list.length) return item;
      return list[next];
    }

    /** 出现过的比例值（去重 + 字典序）。 */
    function collectRatios(items) {
      var seen = {};
      var out = [];
      var list = Array.isArray(items) ? items : [];
      for (var i = 0; i < list.length; i++) {
        var ratio = itemRatio(list[i]);
        if (ratio === "" || seen[ratio] === true) continue;
        seen[ratio] = true;
        out.push(ratio);
      }
      out.sort();
      return out;
    }

    /**
     * 出现过的 workspacePath（去重 + 计数）。
     *
     * 去重按归一化路径，返回的 `path` 是原始值——下拉里显示用户认识的
     * 那个写法，筛选时再交给共享的 `isItemInWorkspace` 判定。
     */
    function collectWorkspaces(items) {
      var map = {};
      var order = [];
      var list = Array.isArray(items) ? items : [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var raw = item && item.workspacePath;
        if (typeof raw !== "string" || raw === "") continue;
        var key = normalizeWs(raw);
        if (key === "") continue;
        if (map[key] === undefined) {
          map[key] = { path: raw, count: 0 };
          order.push(key);
        }
        map[key].count += 1;
      }
      order.sort();
      return order.map(function (key) { return map[key]; });
    }

    /**
     * 搜索命中：提示词 / 模型 / 来源 / 标签，任一包含即算。
     *
     * query 在这里自己转小写——调用方（含将来的别的 chunk）不该为了用这个
     * 函数而记住「先 lower 再传」这种隐藏约定。
     */
    function matchSearch(item, query) {
      if (!item || typeof item !== "object") return false;
      var q = typeof query === "string" ? query.trim().toLowerCase() : "";
      if (q === "") return true;
      var fields = [item.prompt, item.model, item.provider];
      for (var i = 0; i < fields.length; i++) {
        if (typeof fields[i] === "string" && fields[i].toLowerCase().indexOf(q) !== -1) return true;
      }
      if (Array.isArray(item.tags)) {
        for (var j = 0; j < item.tags.length; j++) {
          if (typeof item.tags[j] === "string" && item.tags[j].toLowerCase().indexOf(q) !== -1) return true;
        }
      }
      return false;
    }

    /**
     * 过滤。判据顺序与官方一致：收藏 → 来源 → 比例 → 搜索 → 工作区。
     *
     * `opts`：`{tab, provider, ratio, search, workspacePath, isItemInWorkspace}`。
     * 工作区判定**必须**走传入的共享判据（默认取 `shared.gallery.isItemInWorkspace`），
     * 不在这里另写一份。
     */
    function filterItems(items, opts) {
      var list = Array.isArray(items) ? items : [];
      var options = opts || {};
      var inWorkspace = typeof options.isItemInWorkspace === "function"
        ? options.isItemInWorkspace
        : shared.gallery.isItemInWorkspace;
      var q = typeof options.search === "string" ? options.search.trim().toLowerCase() : "";
      /*
       * 按类型分栏。`"video"` 只留视频，`"image"` 只留非视频。
       *
       * 用 `isVideoItem` 而不是直接读 `item.kind`：老记录没有这个字段
       * （图片从来不写），新视频记录两处都可能带，判据收在一处才不会
       * 出现「视频栏里混进一张图」这种半截状态。
       */
      var wantVideo = options.kind === "video";
      
      var out = [];

      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (!item || typeof item !== "object") continue;
        if (options.kind === "video" || options.kind === "image") {
          if (isVideoItem(item) !== wantVideo) continue;
        }
        if (options.tab === "favorites" && item.isFavorite !== true) continue;
        if (options.provider && options.provider !== "all" && item.provider !== options.provider) continue;
        if (options.ratio && options.ratio !== "all" && itemRatio(item) !== options.ratio) continue;
        if (q !== "" && !matchSearch(item, q)) continue;
        if (options.workspacePath && options.workspacePath !== "all") {
          if (inWorkspace(item, { path: options.workspacePath }) !== true) continue;
        }
        out.push(item);
      }
      return out;
    }

    /** 排序：默认最新在前。返回新数组，不动入参。 */
    function sortItems(items, sortBy) {
      var copy = Array.isArray(items) ? items.slice() : [];
      copy.sort(function (a, b) {
        var ta = a && typeof a.createdAt === "number" && isFinite(a.createdAt) ? a.createdAt : 0;
        var tb = b && typeof b.createdAt === "number" && isFinite(b.createdAt) ? b.createdAt : 0;
        if (sortBy === "oldest") return ta - tb;
        return tb - ta;
      });
      return copy;
    }

    /** `/api/import` 的请求体形状。 */
    function buildImportBody(name, dataUrl) {
      return { name: name, dataUrl: dataUrl };
    }

    /** 读本地文件成 data URL。 */
    function readFileAsDataUrl(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result)); };
        reader.onerror = function () { reject(reader.error || new Error("read-failed")); };
        reader.readAsDataURL(file);
      });
    }

    /**
     * 导入本地图：逐个 `readAsDataURL` → POST `/api/import` →
     * `saveGalleryItem({attachment, prompt: 文件名, provider: "import"})`。
     *
     * `ctx`：`{fetch, saveItem, t, workspaceFields?}`。串行处理，避免一次点选
     * 几十个文件时把 Host 打满。`workspaceFields` 可选，缺省不写工作区字段。
     *
     * 返回 `{added, failed, total}`：`total` 是**用户选中的全部文件数**
     * （含非图片）。B13 的「导入 N 张，M 张失败」里的 M 必须是这个口径——
     * 官方 `lib/client.js:122292` 也是这么算的（`all.length - picked.length`
     * 计入失败），否则「选了 3 个 txt」会显示成「导入 0 张」而没有失败数。
     */
    function performImport(files, ctx) {
      // FileList（真实 UI 里 `e.target.files` 的类型）不是数组：`Array.isArray`
      // 对它返回 false。只判 isArray 会让 all 恒为空 ⇒ picked 恒为空 ⇒ 用户
      // 选完文件什么都不发生（静默失效）。类数组统一转成真数组再处理。
      var all = Array.isArray(files)
        ? files
        : (files !== null && typeof files === "object" && typeof files.length === "number"
          ? Array.prototype.slice.call(files)
          : []);
      var picked = [];
      for (var i = 0; i < all.length; i++) {
        var file = all[i];
        if (file && typeof file.type === "string" && file.type.indexOf("image/") === 0) picked.push(file);
      }
      var total = all.length;
      var skipped = total - picked.length;
      if (picked.length === 0) {
        return Promise.resolve({ added: 0, failed: skipped, total: total });
      }
      var wsFields = ctx !== null && typeof ctx === "object" && ctx.workspaceFields !== null && typeof ctx.workspaceFields === "object"
        ? ctx.workspaceFields
        : {};

      return picked.reduce(function (chain, file) {
        return chain.then(function (acc) {
          return readFileAsDataUrl(file).then(function (dataUrl) {
            return ctx.fetch(IMPORT_ROUTE, {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(buildImportBody(file.name, dataUrl)),
            });
          }).then(function (response) {
            if (!response || response.ok !== true) {
              throw new Error("HTTP " + String(response && response.status));
            }
            return response.json();
          }).then(function (payload) {
            var attachment = payload && payload.attachment;
            if (!attachment) throw new Error("no-attachment");
            return ctx.saveItem(Object.assign({
              attachment: attachment,
              prompt: file.name,
              provider: "import",
            }, wsFields));
          }).then(function (saved) {
            if (saved === false) acc.failed += 1;
            else acc.added += 1;
            return acc;
          }, function () {
            // 读文件 / 请求 / 落库任一失败都只算这一张失败，继续下一张。
            acc.failed += 1;
            return acc;
          });
        });
      }, Promise.resolve({ added: 0, failed: skipped, total: total }));
    }

    /**
     * 批量删除：先确认再调共享的 `bulkDeleteGalleryItems`。
     * 空集合是合法的无操作（不弹确认框）。
     *
     * 返回 `{ok, deleted, error?}`：调用处据此给 toast（B14）并按 B12 细分
     * 失败原因。**不再吞掉异常**——原实现里 `bulkDeleteGalleryItems` 抛错会
     * 一路冒到 unhandled rejection，界面毫无反馈。
     */
    function runBulkDelete(ids, ctx) {
      if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve({ ok: false, deleted: 0, reason: "empty" });
      return Promise.resolve(ctx.confirm(ctx.t("bulkDeleteMessage", { count: String(ids.length) })))
        .then(function (ok) {
          if (ok !== true) return { ok: false, deleted: 0, reason: "cancelled" };
          return Promise.resolve(ctx.gallery.bulkDeleteGalleryItems(ids)).then(function () {
            return { ok: true, deleted: ids.length };
          }, function (error) {
            return { ok: false, deleted: 0, reason: classifyDeleteError(error), error: error };
          });
        });
    }

    /**
     * 删除确认框的正文（B11 / B12）。
     *
     * B11：勾了「同时清理工作区磁盘文件」时**必须如实说明**。本插件 Host 侧
     * 只有 11 条路由（`index.js:45-55`），没有官方 `DELETE_ROUTE` 那样的
     * 删盘接口，所以这里明确写「当前仅从画廊移除」——绝不假装删了磁盘文件。
     */
    function buildDeleteMessage(itemCount, cleanWorkspaceFiles, t, opts) {
      var options = opts || {};
      var hasRoute = options.hasWorkspaceDeleteRoute === true;
      var lines = [t("batchDeleteConfirm", { count: String(itemCount) })];
      if (cleanWorkspaceFiles === true && hasRoute !== true) {
        lines.push(t("deleteWorkspaceFilesUnsupported"));
      }
      return lines.join("\n");
    }

    /** 批量收藏：空集合是合法的无操作。 */
    function runBulkFavorite(ids, ctx) {
      if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve(false);
      return Promise.resolve(ctx.gallery.bulkSetFavoriteGalleryItems(ids, true));
    }

    /** 单删：先确认。返回与 `runBulkDelete` 同形，便于统一 toast。 */
    function runSingleDelete(id, ctx) {
      if (typeof id !== "string" || id === "") return Promise.resolve({ ok: false, deleted: 0, reason: "empty" });
      var message = buildDeleteMessage(1, ctx.cleanWorkspaceFiles === true, ctx.t, ctx);
      return Promise.resolve(ctx.confirm(message)).then(function (ok) {
        if (ok !== true) return { ok: false, deleted: 0, reason: "cancelled" };
        return Promise.resolve(ctx.gallery.deleteGalleryItem(id)).then(function () {
          return { ok: true, deleted: 1 };
        }, function (error) {
          return { ok: false, deleted: 0, reason: classifyDeleteError(error), error: error };
        });
      });
    }

    /** 按删除结果取 toast 文案（B12 / B14）。 */
    function deleteToastText(result, t, count) {
      if (result && result.ok === true) {
        return String(count === undefined ? (result.deleted || 0) : count) === "1"
          ? t("batchDeletedToast", { count: "1" })
          : t("batchDeletedToast", { count: String(count === undefined ? result.deleted : count) });
      }
      if (result && result.reason === "busy") return t("deleteFailedBusy");
      if (result && result.reason === "database") return t("deleteFailedDatabase");
      return "";
    }

    // ── 组件 ────────────────────────────────────────────────────────────

    /**
     * 灯箱。
     *
     * B9：← / → 切换、Esc 关闭（官方三个键齐全，`ArrowLeft/ArrowRight/Escape`）。
     * B10：左右切换按钮（官方 `.dsh-ig-lightbox-nav`）。
     * 另外挂了单图下载 / 复制 / 重新生成的入口。
     */
    function Lightbox(props) {
      var t = props.t;
      var item = props.item;
      var state = shared.useAttachmentUrl(item.attachment, true);

      /*
       * 键盘。依赖数组里放 `props.onPrev/onNext/onClose` 而不是空数组——
       * 这几个回调随当前索引变化（闭包捕获 item），锁死空数组会让
       * 「切到下一张后再按 →」仍然用旧索引，永远只在第一张打转。
       */
      react.useEffect(function () {
        function onKey(event) {
          if (event.key === "Escape") props.onClose();
          else if (event.key === "ArrowLeft") props.onPrev();
          else if (event.key === "ArrowRight") props.onNext();
        }
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [props.onClose, props.onPrev, props.onNext]);

      var nav = function (className, label, onClick, text) {
        return h("button", {
          type: "button",
          className: className,
          title: label,
          "aria-label": label,
          onClick: function (e) { e.stopPropagation(); onClick(); },
        }, text);
      };

      return h("div", { className: "__dbi_g_lightbox", onClick: props.onClose },
        props.hasPrev === true
          ? nav("__dbi_g_lightboxNav __dbi_g_lightboxPrev", t("lightboxPrev"), props.onPrev, "‹")
          : null,
        state.url !== ""
          ? (isVideoItem(item)
            /*
             * 视频灯箱：给全套 `controls`（播放/进度/音量/全屏），这才是
             * 「点开能看」。`autoPlay` 不开——用户是点卡片进来的，但静音
             * 自动播也会抢注意力；让他自己按播放更稳。
             * `key` 绑 attachmentId：切到下一个视频时必须换元素，否则
             * 浏览器会沿用上一个的播放位置。
             */
            ? h("video", {
              className: "__dbi_g_lightboxImg __dbi_g_lightboxVideo",
              key: item.attachment && item.attachment.attachmentId ? item.attachment.attachmentId : "v",
              src: state.url,
              controls: true,
              playsInline: true,
              onClick: function (e) { e.stopPropagation(); },
            })
            : h("img", {
              className: "__dbi_g_lightboxImg",
              src: state.url,
              alt: item.prompt || "",
              onClick: function (e) { e.stopPropagation(); },
            }))
          : h("div", { className: "__dbi_g_lightboxHint" }, state.error !== "" ? state.error : t("loading")),
        props.hasNext === true
          ? nav("__dbi_g_lightboxNav __dbi_g_lightboxNext", t("lightboxNext"), props.onNext, "›")
          : null,
        h("div", {
          className: "__dbi_g_lightboxBar",
          onClick: function (e) { e.stopPropagation(); },
        },
          h("span", { className: "__dbi_g_lightboxPrompt" }, item.prompt || t("noPrompt")),
          h("span", { className: "__dbi_g_lightboxModel" }, item.model || item.provider || ""),
          h("button", {
            type: "button",
            className: "__dbi_g_btn",
            disabled: props.busy === true,
            onClick: function () { props.onDownload(item); },
          }, t("download")),
          /*
           * 视频不显示「复制图片」与「重新生成」：
           * - 复制图片走 `navigator.clipboard.write([ClipboardItem(image/png)])`，
           *   视频没有对应的可复制剪贴板类型（`video/mp4` 不被接受）。
           * - 重新生成要重跑四分钟且会再扣一次额度，与「点一下再试一次」的
           *   心理预期不符，放在灯箱里容易被误触。
           * 下载按钮保留——那才是用户拿到视频的正路。
           */
          isVideoItem(item)
            ? null
            : h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: props.busy === true,
              onClick: function () { props.onCopy(item); },
            }, t("copyImage")),
          isVideoItem(item)
            ? null
            : h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: props.busy === true,
              onClick: function () { props.onRegenerate(item); },
            }, t("regenerate")),
          h("button", {
            type: "button",
            className: "__dbi_g_btn",
            onClick: function () { props.onClose(); },
          }, t("close"))
        ),
        props.busy === true
          ? h("div", { className: "__dbi_g_lightboxBusy" }, t("regenerating"))
          : null
      );
    }

    /** B8 的改词重生成弹层。 */
    function RegenerateModal(props) {
      var t = props.t;
      var pair = react.useState(props.initialPrompt || "");
      var prompt = pair[0];
      var setPrompt = pair[1];
      var busy = props.busy === true;

      return h("div", { className: "__dbi_g_modal", onClick: busy ? null : props.onCancel },
        h("div", {
          className: "__dbi_g_modalCard",
          onClick: function (e) { e.stopPropagation(); },
        },
          h("div", { className: "__dbi_g_modalTitle" }, t("regenerateTitle")),
          h("div", { className: "__dbi_g_modalHint" }, t("regenerateHint")),
          h("textarea", {
            className: "__dbi_g_modalInput",
            value: prompt,
            rows: 4,
            disabled: busy,
            onChange: function (e) { setPrompt(e.target.value); },
          }),
          h("div", { className: "__dbi_g_modalRow" },
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: busy,
              onClick: function () { props.onCancel(); },
            }, t("regenerateCancel")),
            h("button", {
              type: "button",
              className: "__dbi_g_btn __dbi_g_btnOn",
              disabled: busy || String(prompt).trim() === "",
              onClick: function () { props.onConfirm(prompt); },
            }, busy ? t("regenerating") : t("regenerateConfirm"))
          )
        )
      );
    }

    /** 单张卡片。 */
    function GalleryCard(props) {
      var t = props.t;
      var item = props.item;
      var state = shared.useAttachmentUrl(item.attachment, true);
      var badge = item.model || item.provider || "";
      var stop = function (fn) {
        return function (e) {
          if (e && typeof e.stopPropagation === "function") e.stopPropagation();
          fn();
        };
      };
      return h("div", {
        className: "__dbi_g_card" + (props.selected ? " __dbi_g_cardSel" : ""),
        onClick: function () { props.onActivate(item); },
      },
        h("div", { className: "__dbi_g_cardMedia" },
          props.manage === true
            ? h("span", {
              className: "__dbi_g_cardCheck" + (props.selected ? " __dbi_g_cardCheckOn" : ""),
              role: "checkbox",
              "aria-checked": props.selected === true,
            }, props.selected === true ? "✓" : "")
            : null,
          state.url !== ""
            ? (isVideoItem(item)
              /*
               * 视频卡片用 `<video>` 自身渲染首帧 —— 这就是「像文件夹里那样预览」。
               * `preload="metadata"` 只拉文件头（首帧 + 时长），不下载整段；
               * 不给 controls：卡片尺寸小，控件挤在一起反而不好点，播放交给灯箱。
               * `muted` 是必须的：现代浏览器对静音视频允许无用户手势自动出首帧，
               * 带声音的视频在部分版本里首帧是黑的。
               */
              ? h("video", {
                className: "__dbi_g_cardImg __dbi_g_cardVideo",
                src: state.url,
                preload: "metadata",
                muted: true,
                playsInline: true,
              })
              : h("img", { className: "__dbi_g_cardImg", src: state.url, alt: item.prompt || "", loading: "lazy" }))
            : h("div", { className: "__dbi_g_cardPending" }, state.error !== "" ? state.error : "…"),
          h("div", { className: "__dbi_g_cardTools" },
            h("button", {
              type: "button",
              className: "__dbi_g_toolBtn",
              title: t("favorite"),
              onClick: stop(function () { props.onToggleFavorite(item.id); }),
            }, item.isFavorite === true ? "♥" : "♡"),
            h("button", {
              type: "button",
              className: "__dbi_g_toolBtn",
              title: t("download"),
              onClick: stop(function () { props.onDownload(item); }),
            }, "⭳"),
            h("button", {
              type: "button",
              className: "__dbi_g_toolBtn",
              title: t("copyImage"),
              onClick: stop(function () { props.onCopy(item); }),
            }, "⧉"),
            h("button", {
              type: "button",
              className: "__dbi_g_toolBtn __dbi_g_toolBtnDanger",
              title: t("delete"),
              onClick: stop(function () { props.onRequestDelete(item.id); }),
            }, "🗑")
          )
        ),
        h("div", { className: "__dbi_g_cardMeta" },
          h("span", { className: "__dbi_g_cardBadge", title: badge }, badge),
          h("span", { className: "__dbi_g_cardPrompt", title: item.prompt || "" }, item.prompt || t("noPrompt")),
          h("span", { className: "__dbi_g_cardFoot" },
            (itemRatio(item) || "") + "  " + relativeTime(item.createdAt, t, props.now))
        )
      );
    }

    /**
     * 画廊页：第二层 tab + 工具条 + 网格 + 管理模式 + 灯箱 + toast。
     *
     * 本组件是 B4–B14 的落点：反选、批量下载 ZIP、单图下载、复制图片、
     * 重新生成、灯箱键盘/翻页、磁盘清理勾选、删除失败细分、导入部分失败、
     * 全量 toast 反馈。
     */
    function GalleryPanel(props) {
      var t = props.t;
      var gallery = shared.gallery;
      var tick = shared.useGalleryTick();

      var available = true;
      try {
        available = gallery.available() !== false;
      } catch {
        available = false;
      }

      var itemsPair = react.useState([]);
      var items = itemsPair[0];
      var setItems = itemsPair[1];
      var loadedPair = react.useState(false);
      var loaded = loadedPair[0];
      var setLoaded = loadedPair[1];

      var subPair = react.useState("recent");
      var subTab = subPair[0];
      var setSubTab = subPair[1];

      var searchPair = react.useState("");
      var search = searchPair[0];
      var setSearch = searchPair[1];

      var providerPair = react.useState("all");
      var provider = providerPair[0];
      var setProvider = providerPair[1];

      var ratioPair = react.useState("all");
      var ratio = ratioPair[0];
      var setRatio = ratioPair[1];

      var sortPair = react.useState("newest");
      var sortBy = sortPair[0];
      var setSortBy = sortPair[1];

      var wsPair = react.useState("all");
      var workspace = wsPair[0];
      var setWorkspace = wsPair[1];

      var managePair = react.useState(false);
      var manage = managePair[0];
      var setManage = managePair[1];

      var selectedPair = react.useState([]);
      var selectedIds = selectedPair[0];
      var setSelectedIds = selectedPair[1];

      var previewPair = react.useState(null);
      var previewItem = previewPair[0];
      var setPreviewItem = previewPair[1];

      var toastPair = react.useState(null);
      var toast = toastPair[0];
      var setToast = toastPair[1];

      var importingPair = react.useState(false);
      var importing = importingPair[0];
      var setImporting = importingPair[1];

      var importInput = react.useRef(null);

      // ── B4–B14 新增状态 ──
      var zipPair = react.useState(null);
      var zipProgress = zipPair[0];
      var setZipProgress = zipPair[1];

      var regenPair = react.useState(null);
      var regenItem = regenPair[0];
      var setRegenItem = regenPair[1];

      var regenBusyPair = react.useState(false);
      var regenBusy = regenBusyPair[0];
      var setRegenBusy = regenBusyPair[1];

      // B11：默认不勾。勾了也只是写进确认框文案——Host 没有删盘路由。
      var cleanPair = react.useState(false);
      var cleanWorkspaceFiles = cleanPair[0];
      var setCleanWorkspaceFiles = cleanPair[1];

      react.useEffect(function () {
        var alive = true;
        Promise.resolve(gallery.getGalleryItems()).then(function (list) {
          if (!alive) return;
          setItems(Array.isArray(list) ? list : []);
          setLoaded(true);
        }, function () {
          if (!alive) return;
          setItems([]);
          setLoaded(true);
        });
        return function () { alive = false; };
      }, [tick]);

      function showToast(message) {
        if (typeof message !== "string" || message === "") return;
        setToast(message);
        var timer = setTimeout(function () { setToast(null); }, 2000);
        // 浏览器里没有 unref，Node 里自测需要它，否则进程会等满 2 秒。
        if (timer && typeof timer.unref === "function") timer.unref();
      }

      function confirmFn(message) {
        if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
        return window.confirm(message);
      }

      /**
       * 造一个 blob URL 并立刻触发下载。
       *
       * 撤销交给 `triggerDownload` 里排的 `setTimeout(…, 0)`：立刻 revoke
       * 会让部分浏览器来不及开始下载。
       */
      function saveBlobUrl(blob, filename) {
        var url = URL.createObjectURL(blob);
        triggerDownload(url, filename);
        var timer = setTimeout(function () { URL.revokeObjectURL(url); }, 0);
        if (timer && typeof timer.unref === "function") timer.unref();
        return url;
      }

      var ratios = collectRatios(items);
      var workspaces = collectWorkspaces(items);
      /*
       * 本栏只看自己那一类。视频栏传 `"video"`、图库栏传 `"image"`。
       * 计数（工作区/收藏）也走同一个 `kind`，否则视频栏的下拉会显示
       * 「D:\work (12)」而下面只有 3 个视频 —— 数字和列表对不上。
       */
      var kindFilter = props.videosOnly === true ? "video" : "image";
      /*
       * 视频栏不是「另一个图库」：导入图片、收藏、批量管理对视频都没有
       * 意义（视频没有收藏，批量删也只在图库栏做过）。这里留一个布尔，
       * 下面按它把图库专属的控件摘掉，免得用户点了没反应。
       */
      var videosOnly = props.videosOnly === true;
      var filtered = sortItems(filterItems(items, {
        tab: subTab,
        provider: provider,
        ratio: ratio,
        search: search,
        workspacePath: workspace,
        kind: kindFilter,
        isItemInWorkspace: gallery.isItemInWorkspace,
      }), sortBy);

      var workspaceCount = workspace === "all"
        ? filterItems(items, { kind: kindFilter }).length
        : filterItems(items, { workspacePath: workspace, kind: kindFilter, isItemInWorkspace: gallery.isItemInWorkspace }).length;

      var favoriteCount = 0;
      var kindItems = filterItems(items, { kind: kindFilter });
      for (var fi = 0; fi < kindItems.length; fi++) {
        if (kindItems[fi] && kindItems[fi].isFavorite === true) favoriteCount += 1;
      }

      function toggleSelected(id) {
        var next = selectedIds.slice();
        var at = next.indexOf(id);
        if (at === -1) next.push(id);
        else next.splice(at, 1);
        setSelectedIds(next);
      }

      /** B11 要求的「被占用 / 数据库异常」细分提示（B12）。 */
      function showDeleteResult(result, count) {
        if (result && result.ok === true) {
          showToast(t("batchDeletedToast", { count: String(count) }));
          return;
        }
        if (!result || result.reason === "cancelled" || result.reason === "empty") return;
        showToast(result.reason === "busy" ? t("deleteFailedBusy") : t("deleteFailedDatabase"));
      }

      function handleImport(files) {
        if (importing) return;
        setImporting(true);
        performImport(files, {
          fetch: function (url, init) { return fetch(url, init); },
          saveItem: function (item) { return gallery.saveGalleryItem(item); },
          t: t,
          // 导入的图也要归到当前工作区，否则「全部工作区」下拉里永远只有
          // 生成出来的图算进去，导入的会被当成无归属。
          workspaceFields: workspaceFieldsFrom(props.cwd, props.sessionId),
        }).then(function (result) {
          setImporting(false);
          // B13：三态文案，部分失败要如实报数。
          showToast(t(importToastKey(result), {
            count: String(result.added),
            fail: String(result.failed),
          }));
        });
      }

      /** B5：把选中项打成一个 ZIP 下载，按钮上显示「打包中 (n/N)…」。 */
      function handleBatchDownload() {
        if (zipProgress !== null) return;
        if (selectedIds.length === 0) {
          showToast(t("batchNoneSelected"));
          return;
        }
        var targets = filtered.filter(function (item) { return selectedIds.indexOf(item.id) !== -1; });
        if (targets.length === 0) {
          showToast(t("batchNoneSelected"));
          return;
        }
        setZipProgress({ current: 0, total: targets.length });
        buildGalleryZip(targets, {
          fetch: function (url, init) { return fetch(url, init); },
          imageRoute: shared.IMAGE_ROUTE,
          saveBlobUrl: saveBlobUrl,
          makeBlob: function (parts, type) { return new Blob(parts, { type: type }); },
          now: function () { return Date.now(); },
          onProgress: function (current, total) { setZipProgress({ current: current, total: total }); },
        }).then(function (result) {
          setZipProgress(null);
          if (result.ok !== true) {
            showToast(t("batchDownloadFailed"));
            return;
          }
          showToast(t("batchDownloadZipToast", { count: String(result.packed) }));
        }, function () {
          setZipProgress(null);
          showToast(t("batchDownloadFailed"));
        });
      }

      /** B6。 */
      function handleDownloadItem(item) {
        if (!item || !item.attachment) return;
        downloadSingleImage(item, {
          fetch: function (url, init) { return fetch(url, init); },
          imageRoute: shared.IMAGE_ROUTE,
          videoRoute: shared.VIDEO_ROUTE,
          saveBlobUrl: saveBlobUrl,
          makeBlob: function (parts, type) { return new Blob(parts, { type: type }); },
        }).then(function (done) {
          if (done !== true) showToast(t("downloadFailed"));
        }, function () {
          showToast(t("downloadFailed"));
        });
      }

      /** B7。 */
      function handleCopyItem(item) {
        if (!item || !item.attachment) return;
        /*
         * 视频不进剪贴板：`ClipboardItem` 不接受 `video/mp4`，硬调只会抛
         * 一个用户看不懂的 `NotAllowedError`。灯箱里已经不给这个按钮了，
         * 这里再挡一层是防别的入口（批量工具条）误调。
         */
        if (isVideoItem(item)) {
          showToast(t("copyFailed"));
          return;
        }
        var clipboardItem = typeof ClipboardItem !== "undefined" ? ClipboardItem : null;
        copyImageToClipboard(item.attachment, {
          fetch: function (url, init) { return fetch(url, init); },
          imageRoute: shared.IMAGE_ROUTE,
          makeBlob: function (parts, type) { return new Blob(parts, { type: type }); },
          clipboardItem: clipboardItem,
          clipboard: typeof navigator !== "undefined" ? navigator.clipboard : null,
        }).then(function (done) {
          showToast(t(done === true ? "copySuccess" : "copyFailed"));
        }, function () {
          showToast(t("copyFailed"));
        });
      }

      /** B8：打开改词重生成弹层。 */
      function handleOpenRegenerate(item) {
        if (regenBusy) return;
        setRegenItem(item);
      }

      /** B8：确认后原地重生成一张并落进画廊。 */
      function handleConfirmRegenerate(prompt) {
        if (regenBusy || regenItem === null) return;
        if (typeof prompt !== "string" || prompt.trim() === "") {
          showToast(t("regenerateEmptyPrompt"));
          return;
        }
        setRegenBusy(true);
        performRegenerate(regenItem, prompt, {
          fetch: function (url, init) { return fetch(url, init); },
          route: REGENERATE_ROUTE,
          saveItem: function (item) { return gallery.saveGalleryItem(item); },
          now: function () { return Date.now(); },
        }).then(function (result) {
          setRegenBusy(false);
          if (result.ok !== true) {
            showToast(result.reason === "empty-prompt" ? t("regenerateEmptyPrompt") : t("regenerateFailed"));
            return;
          }
          setRegenItem(null);
          setPreviewItem(result.item);
          showToast(t(result.saved === true ? "regenerateSuccess" : "regenerateSaveFailed"));
        }, function () {
          setRegenBusy(false);
          showToast(t("regenerateFailed"));
        });
      }

      var body;
      if (available !== true) {
        body = h("div", { className: "__dbi_g_unavailable" }, t("unavailable"));
      } else if (loaded !== true) {
        body = h("div", { className: "__dbi_g_loading" }, t("loading"));
      } else if (kindItems.length === 0) {
        /*
         * 空态文案必须分栏：视频栏里说「生成图片后会自动收进这里」
         * 会让用户以为视频进错了地方（2026-10-22 真实页面验收发现）。
         *
         * 判据用 `kindItems` 而不是 `items`：图库里有 12 张图、一个视频都
         * 没有时，视频栏的 `items.length` 是 12，会跳过本分支落到
         * 「没有匹配的图」——用户看到的是「筛选没结果」而不是「还没有视频」。
         */
        body = h("div", { className: "__dbi_g_empty" },
          h("div", { className: "__dbi_g_emptyIcon" }, videosOnly ? "🎬" : "🖼️"),
          h("div", { className: "__dbi_g_emptyTitle" }, t(videosOnly ? "videoEmptyTitle" : "emptyTitle")),
          h("div", { className: "__dbi_g_emptyDesc" }, t(videosOnly ? "videoEmptyDesc" : "emptyDesc"))
        );
      } else if (filtered.length === 0) {
        var isFavEmpty = subTab === "favorites" && search === "" && provider === "all" && ratio === "all" && workspace === "all";
        var noMatchTitle = isFavEmpty ? "favEmptyTitle" : (videosOnly ? "noMatchVideoTitle" : "noMatchTitle");
        var noMatchDesc = isFavEmpty ? "favEmptyDesc" : (videosOnly ? "noMatchVideoDesc" : "noMatchDesc");
        body = h("div", { className: "__dbi_g_empty" },
          h("div", { className: "__dbi_g_emptyIcon" }, isFavEmpty ? "🤍" : "🔍"),
          h("div", { className: "__dbi_g_emptyTitle" }, t(noMatchTitle)),
          h("div", { className: "__dbi_g_emptyDesc" }, t(noMatchDesc))
        );
      } else {
        body = h("div", { className: "__dbi_g_grid" },
          filtered.map(function (item) {
            return h(GalleryCard, {
              key: item.id,
              item: item,
              t: t,
              manage: manage,
              selected: selectedIds.indexOf(item.id) !== -1,
              now: props.now,
              onActivate: function (target) {
                if (manage) toggleSelected(target.id);
                else setPreviewItem(target);
              },
              onToggleFavorite: function (id) {
                Promise.resolve(gallery.toggleFavoriteGalleryItem(id)).then(function (on) {
                  // B14：收藏/取消收藏各有文案，不再复用「删除」的 key。
                  showToast(t(on === true ? "favoriteToast" : "unfavoriteToast"));
                });
              },
              onDownload: handleDownloadItem,
              onCopy: handleCopyItem,
              onRequestDelete: function (id) {
                runSingleDelete(id, {
                  gallery: gallery,
                  confirm: confirmFn,
                  t: t,
                  cleanWorkspaceFiles: cleanWorkspaceFiles,
                }).then(function (result) { showDeleteResult(result, 1); });
              },
            });
          })
        );
      }

      var providerOptions = [
        { value: "all", label: t("filterAllProviders") },
        { value: "doubao", label: t("filterDoubao") },
        { value: "gpt", label: t("filterGpt") },
        { value: "import", label: t("filterImport") },
      ];

      var ratioOptions = [{ value: "all", label: t("filterAllRatios") }].concat(ratios.map(function (value) {
        return { value: value, label: value };
      }));

      var workspaceOptions = [{ value: "all", label: t("workspaceAll") }].concat(workspaces.map(function (entry) {
        return { value: entry.path, label: entry.path + " (" + String(entry.count) + ")" };
      }));

      var allSelected = filtered.length > 0 && selectedIds.length >= filtered.length;

      /* B5 的按钮文案：打包中时显示官方那句「打包中 (3/8)…」。 */
      var batchDownloadLabel = zipProgress === null
        ? t("batchDownload")
        : t("batchDownloading", {
          current: String(zipProgress.current),
          total: String(zipProgress.total),
        });

      return h("div", { className: "__dbi_g_panel" },
        h("div", { className: "__dbi_g_subtabs", role: "tablist" },
          SUB_TABS.map(function (tab) {
            var on = tab.id === subTab;
            var count = tab.id === "favorites" ? favoriteCount : items.length;
            return h("button", {
              key: tab.id,
              type: "button",
              role: "tab",
              "aria-selected": on,
              "data-subtab": tab.id,
              className: "__dbi_g_subtab" + (on ? " __dbi_g_subtabOn" : ""),
              onClick: function () { setSubTab(tab.id); },
            }, props.t(tab.label),
              h("span", { className: "__dbi_g_count" }, String(count)));
          })
        ),

        h("div", { className: "__dbi_g_toolbar" },
          h("input", {
            className: "__dbi_g_search",
            type: "search",
            value: search,
            placeholder: t("searchPlaceholder"),
            onChange: function (e) { setSearch(e.target.value); },
          }),
          h("select", {
            className: "__dbi_g_select",
            value: provider,
            onChange: function (e) { setProvider(e.target.value); },
          }, providerOptions.map(function (option) {
            return h("option", { key: option.value, value: option.value }, option.label);
          })),
          h("select", {
            className: "__dbi_g_select",
            value: ratio,
            onChange: function (e) { setRatio(e.target.value); },
          }, ratioOptions.map(function (option) {
            return h("option", { key: option.value, value: option.value }, option.label);
          })),
          h("select", {
            className: "__dbi_g_select",
            value: sortBy,
            onChange: function (e) { setSortBy(e.target.value); },
          },
            h("option", { value: "newest" }, t("sortNewest")),
            h("option", { value: "oldest" }, t("sortOldest"))
          ),
          h("span", { className: "__dbi_g_wsWrap" },
            h("select", {
              className: "__dbi_g_select",
              value: workspace,
              onChange: function (e) { setWorkspace(e.target.value); },
            }, workspaceOptions.map(function (option) {
              return h("option", { key: option.value, value: option.value }, option.label);
            })),
            h("span", { className: "__dbi_g_badge" }, t("workspaceBadge", {
              selected: String(workspaceCount),
              total: String(items.length),
            }))
          ),
          videosOnly ? null : h("input", {
            ref: importInput,
            className: "__dbi_g_file",
            type: "file",
            accept: "image/*",
            multiple: true,
            onChange: function (e) {
              var files = e.target && e.target.files ? e.target.files : [];
              handleImport(files);
            },
          }),
          videosOnly ? null : h("button", {
            type: "button",
            className: "__dbi_g_btn",
            disabled: importing,
            onClick: function () {
              if (importInput.current && typeof importInput.current.click === "function") importInput.current.click();
            },
          }, t("importImages")),
          h("button", {
            type: "button",
            className: "__dbi_g_btn" + (manage ? " __dbi_g_btnOn" : ""),
            onClick: function () {
              if (manage) {
                setManage(false);
                setSelectedIds([]);
              } else {
                setManage(true);
              }
            },
          }, manage ? t("exitManage") : t("manage"))
        ),

        manage
          ? h("div", { className: "__dbi_g_managebar" },
            /* B4：官方三按钮 全选 / 反选 / 清空。 */
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              onClick: function () { setSelectedIds(applySelection("all", filtered, selectedIds)); },
            }, t("selectAll")),
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              onClick: function () { setSelectedIds(applySelection("invert", filtered, selectedIds)); },
            }, t("invertSelect")),
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: selectedIds.length === 0,
              onClick: function () { setSelectedIds(applySelection("clear", filtered, selectedIds)); },
            }, t("clearSelect")),
            h("span", { className: "__dbi_g_manageInfo" }, t("selectedCount", { count: String(selectedIds.length) })),
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: selectedIds.length === 0,
              onClick: function () {
                runBulkFavorite(selectedIds, { gallery: gallery, t: t }).then(function (ok) {
                  if (ok !== false) showToast(t("favoriteAddedToast", { count: String(selectedIds.length) }));
                });
              },
            }, t("batchFavorite")),
            h("button", {
              type: "button",
              className: "__dbi_g_btn",
              disabled: selectedIds.length === 0 || zipProgress !== null,
              onClick: handleBatchDownload,
            }, batchDownloadLabel),
            h("button", {
              type: "button",
              className: "__dbi_g_btn __dbi_g_btnDanger",
              disabled: selectedIds.length === 0,
              onClick: function () {
                var count = selectedIds.length;
                runBulkDelete(selectedIds, {
                  gallery: gallery,
                  confirm: confirmFn,
                  t: t,
                  cleanWorkspaceFiles: cleanWorkspaceFiles,
                }).then(function (result) {
                  if (result.ok === true) setSelectedIds([]);
                  showDeleteResult(result, count);
                });
              },
            }, t("batchDelete")),
            /* B11：磁盘清理勾选框。Host 没有删盘路由，文案里已如实说明。 */
            h("label", { className: "__dbi_g_checkWrap", title: t("deleteWorkspaceFilesUnsupported") },
              h("input", {
                type: "checkbox",
                className: "__dbi_g_check",
                checked: cleanWorkspaceFiles,
                onChange: function (e) { setCleanWorkspaceFiles(e.target.checked === true); },
              }),
              h("span", { className: "__dbi_g_checkLabel" }, t("deleteWorkspaceFilesOpt"))
            )
          )
          : null,

        h("div", { className: "__dbi_g_pageBody" }, body),

        toast !== null ? h("div", { className: "__dbi_g_toast" }, toast) : null,

        /* B9 / B10：灯箱带键盘与左右切换按钮。 */
        previewItem !== null
          ? h(Lightbox, {
            item: previewItem,
            t: t,
            busy: regenBusy,
            hasPrev: previewIndex(filtered, previewItem) > 0,
            hasNext: previewIndex(filtered, previewItem) >= 0 && previewIndex(filtered, previewItem) < filtered.length - 1,
            onPrev: function () { setPreviewItem(stepPreview(filtered, previewItem, -1)); },
            onNext: function () { setPreviewItem(stepPreview(filtered, previewItem, 1)); },
            onClose: function () { setPreviewItem(null); },
            onDownload: handleDownloadItem,
            onCopy: handleCopyItem,
            onRegenerate: handleOpenRegenerate,
          })
          : null,

        regenItem !== null
          ? h(RegenerateModal, {
            t: t,
            initialPrompt: regenItem.prompt || "",
            busy: regenBusy,
            onCancel: function () { if (!regenBusy) setRegenItem(null); },
            onConfirm: handleConfirmRegenerate,
          })
          : null
      );
    }

    function Mount(props) {
      shared.useLocale(props.locale);
      var lang = pickLang(props.locale);
      var t = makeT(lang);
      var activePair = react.useState("gallery");
      var active = activePair[0];
      var setActive = activePair[1];

      /*
       * 当前会话的工作区归属字段。
       *
       * `cwd` 由主 bundle 的 `conversation.view` 工厂解析后透传进来（那个
       * 槽的 ownerProps 没有 `cwd`，只能从 `useSessions` 查）。本 chunk
       * **不再自己调 hook** —— 逐层传 prop 是唯一不会破坏 hooks 顺序的做法。
       *
       * 三项写入（导入 / 工作台文生图 / 工作台图生图）共用这一份，
       * 避免各自推导出不同字段。
       */
      var wsFields = workspaceFieldsFrom(props.cwd, props.sessionId);

      /*
       * 「灵感库 → 用它生图」的链路。
       *
       * 灵感库调 `onUsePrompt(prompt, item)`，容器把它存进 studioDraft 并切到
       * 工作台标签页；工作台通过 `initialPrompt` prop 收到。两个 chunk 之间
       * 没有直接依赖——这是唯一的通道。
       */
      var draftPair = react.useState(undefined);
      var studioDraft = draftPair[0];
      var setStudioDraft = draftPair[1];

      /*
       * 灵感库 → 工作台。
       *
       * `mode === "ref"` 时还要带一张参考图：取图信息（sourceId + 案例的
       * image 路径）一起塞进草稿，由工作台自己去 POST 取字节。
       * 这里**不取图**——取图是异步的，工作台拿到草稿才能决定先显示
       * 「正在载入参考图」再启动生成；放在这层取会让切换标签页等待。
       */
      var usePrompt = react.useCallback(function (prompt, item, mode, sourceId) {
        var draft = { prompt: prompt, item: item };
        if (mode === "ref") {
          var imagePath = item !== null && typeof item === "object" && typeof item.image === "string" ? item.image : "";
          if (imagePath !== "" && typeof sourceId === "string" && sourceId !== "") {
            draft.mode = "ref";
            draft.sourceId = sourceId;
            draft.image = imagePath;
          }
        }
        setStudioDraft(draft);
        setActive("studio");
      }, []);

      /**
       * 画廊视图下隐藏宿主输入框（composer）。
       *
       * 为什么这么做：宿主的 `.scrollBody` 把 `composerSeat`（输入框座位）
       * 当作**正常流子元素**排在视图下面，高 142px。画廊要的是整屏铺满的
       * 工作区，那 142px 纯属浪费（用户已确认：宁可失去输入能力也要整屏）。
       *
       * 为什么不能写死类名：`wskVav_` 是 CSS-modules 哈希，宿主升级必变，
       * 写死会**静默失配**（不报错、只是不生效）。所以这里从 DOM 现读：
       * 从本 chunk 的根节点往上找到含 `overflow` 滚动的祖先，再找那个
       * 高度最接近 142px 的兄弟元素，用它的真实 class 生成规则。
       *
       * 只在挂载期间生效；卸载时把 <style> 一起摘掉，切回「对话」立刻恢复。
       */
      react.useEffect(function () {
        if (typeof document === "undefined") return;

        var STYLE_ID = "dsh-doubao-image/hide-host-composer";
        var rootEl = document.querySelector(".__dbi_g_root");
        if (rootEl === null) return;

        /**
         * 从根节点往上找「输入框座位」。
         *
         * 判据两步，缺一不可：
         *   1. 几何：兄弟高 100~220px（座位是个大块）
         *   2. **内容：子树里真的有输入控件**（textarea / contenteditable）
         *
         * 只靠几何会抓错东西——画布、结果区这类兄弟同样可能是 150px 高，
         * 藏掉它们比留着输入框更糟。内容判据才是身份判断。
         */
        function findSeat(hostRoot) {
          var node = hostRoot.parentElement;
          var depth = 0;
          while (node !== null && node !== document.body && depth < 8) {
            var kids = node.children;
            for (var i = 0; i < kids.length; i++) {
              var kid = kids[i];
              if (kid === hostRoot || kid.contains(hostRoot)) continue;
              var h = kid.getBoundingClientRect ? kid.getBoundingClientRect().height : 0;
              if (h < 100 || h > 220) continue;
              if (!hasInputControl(kid)) continue;
              return { seat: kid, container: node };
            }
            node = node.parentElement;
            depth++;
          }
          return null;
        }

        /** 子树里有没有真正的输入控件（用来确认这就是输入框座位）。 */
        function hasInputControl(el) {
          if (typeof el.querySelector !== "function") return false;
          return el.querySelector("textarea") !== null
            || el.querySelector("[contenteditable]") !== null
            || el.querySelector("input") !== null;
        }

        function apply() {
          var old = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
          if (old !== null) old.parentNode.removeChild(old);

          var found = findSeat(rootEl);
          if (found === null) {
            // 探测不到就什么都不做——宁可留着输入框，也不要用错的类名
            // 把别的东西隐藏掉。
            return;
          }
          var cls = String(found.seat.className || "").split(/\s+/).filter(Boolean)[0];
          if (cls === undefined) return;

          var style = document.createElement("style");
          style.dataset.plugin = "dsh-doubao-image";
          style.dataset.pluginCss = STYLE_ID;
          // 用 id 之外的 token 类名做选择器；token 里可能带 `--`，要转义。
          style.textContent = "." + cls.replace(/([^\w-])/g, "\\$1") + "{display:none!important}";
          document.head.appendChild(style);
        }

        apply();
        // 宿主可能在我们之后才把座位渲染出来（异步挂载），补一次。
        var raf = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(apply)
          : null;

        return function () {
          if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
          var style = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]');
          if (style !== null && style.parentNode !== null) style.parentNode.removeChild(style);
        };
      }, [active]);

      // 自报标记：浏览器里拿不到槽表，靠这个确认 chunk 真的挂上了。
      react.useEffect(function () {
        if (typeof globalThis === "undefined") return;
        globalThis.__dshGalleryChunkMounted = {
          ok: true,
          active: active,
          tabs: TABS.map(function (tab) { return tab.id; }),
        };
      }, [active]);

      /**
       * 「新建画布」按钮的跨 chunk 通道。
       *
       * 主 bundle 的按钮点击后既 dispatch 事件、又设全局 pending 标记。
       * 这里两条都接：事件用于 chunk 已挂载时的热路径；pending 标记用于
       * chunk 尚未加载（用户首次点按钮）时的冷路径——Mount 挂载后读标记
       * 即可补上 setActive。
       */
      react.useEffect(function () {
        if (typeof window === "undefined") return;
        var onOpenStudio = function () { setActive("studio"); };
        window.addEventListener("dsh-doubao-image:open-studio", onOpenStudio);
        if (typeof globalThis !== "undefined" && globalThis.__dshDoubaoImageOpenStudio === true) {
          globalThis.__dshDoubaoImageOpenStudio = false;
          setActive("studio");
        }
        return function () {
          window.removeEventListener("dsh-doubao-image:open-studio", onOpenStudio);
        };
      }, []);

      var current = null;
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].id === active) current = TABS[i];
      }
      if (current === null) current = TABS[0];

      /*
       * 工作台「开始生成」的真实出图链路。
       *
       * 工作台 chunk 自己不碰网络：它把 `props.onGenerate(prompt, ratio, tool)`
       * 的结果交回来，由容器打 `/api/regenerate` 并落进画廊。落库后推一次
       * `gallery` 的变更，工作台左栏「最近生成」与画廊标签页都是订阅同一份
       * 数据的，所以一次 notify 就能让两边同时看到新图——不需要容器另存一份。
       *
       * toast 状态放在容器这一层，而不是画廊标签页里：用户在工作台生成失败
       * 时，画廊标签页并未挂载，它的 toast 无处显示，失败就会被静默吞掉。
       */
      var studioToastPair = react.useState(null);
      var studioToast = studioToastPair[0];
      var setStudioToast = studioToastPair[1];

      var showStudioToast = function (message) {
        if (typeof message !== "string" || message === "") return;
        setStudioToast(message);
        var timer = setTimeout(function () { setStudioToast(null); }, 3000);
        // 与画廊页的 toast 同理：Node 自测里不加 unref 会白等满 3 秒。
        if (timer && typeof timer.unref === "function") timer.unref();
      };

      var studioGenerate = react.useCallback(function (prompt, ratio, tool, options) {
        return performStudioGenerate(prompt, ratio, tool, {
          fetch: function (url, init) { return fetch(url, init); },
          route: REGENERATE_ROUTE,
          saveItem: function (item) { return shared.gallery.saveGalleryItem(item); },
          now: function () { return Date.now(); },
          workspaceFields: wsFields,
        }, options).then(function (result) {
          var key = studioGenerateToastKey(result);
          var reason = result && typeof result.reason === "string" ? result.reason : "";
          // 状态码与业务原因拼进文案：只写「生成失败」用户没法判断是服务没起
          // 还是提示词被拒。
          var params = {
            status: reason.indexOf("http-") === 0 ? reason.slice("http-".length).split(" ")[0] : "",
            detail: reason,
          };
          showStudioToast(t(key, params));
          // 生成了但没落库时也必须刷新一次：Host 侧可能已经写了盘，画廊要跟上。
          if (result && result.ok === true) shared.gallery.notify();
          return result;
        });
        // 依赖原始值而不是 `wsFields` 对象：后者每次渲染都是新引用，会让
        // useCallback 每轮失效，进而把工作台的 onGenerate 变成新函数。
      }, [props.cwd, props.sessionId]);

      var body;
      if (current.id === "inspiration") {
        body = h(shared.ChunkMount, {
          chunk: current.chunk,
          locale: props.locale,
          onUsePrompt: usePrompt,
          loadingText: t("loading"),
          errorText: t("tabLoadFailed"),
        });
      } else if (current.id === "studio") {
        body = h(shared.ChunkMount, {
          chunk: current.chunk,
          locale: props.locale,
          sessionId: props.sessionId,
          // 工作台自己也要推导工作区字段（「存画廊」那条写入点）。
          // 漏了它，工作台里点存画廊的图就永远没有归属——而生成路径
          // （走下面那个 onGenerate）是有的，症状只在「存画廊」按钮上。
          cwd: props.cwd,
          initialPrompt: studioDraft,
          // 工作台靠「有没有这个 prop」决定是「真出图」还是退回
          // 「复制一条指令」——所以这里必须是真函数，不能传 undefined。
          onGenerate: studioGenerate,
          loadingText: t("loading"),
          errorText: t("tabLoadFailed"),
        });
      } else {
        /*
         * 图库与视频共用同一个面板，靠 `videosOnly` 分开数据源。
         * 不复制一份 `VideoPanel` 的理由：卡片、灯箱、管理模式、
         * 批量删除、收藏、工作区下拉这些逻辑两边完全一样，只有
         * 「渲染 img 还是 video」和「哪些工具条按钮该出现」不同。
         */
        body = h(GalleryPanel, {
          t: t,
          lang: lang,
          locale: props.locale,
          sessionId: props.sessionId,
          cwd: props.cwd,
          videosOnly: current.id === "videos",
        });
      }

      return h("div", { className: "__dbi_g_root" },
        h("header", { className: "__dbi_g_tabs", role: "tablist" },
          TABS.map(function (tab) {
            var on = tab.id === active;
            return h("button", {
              key: tab.id,
              type: "button",
              role: "tab",
              "aria-selected": on,
              "data-tab": tab.id,
              className: "__dbi_g_tab" + (on ? " __dbi_g_tabOn" : ""),
              onClick: function () { setActive(tab.id); },
            },
              tab.icon === undefined ? null : tab.icon(15),
              h("span", null, t(tab.label)));
          })
        ),
        h("div", { className: "__dbi_g_body" }, body),
        // 容器级 toast：工作台生成失败时画廊标签页并没有挂载，没有它失败就看不见。
        studioToast !== null
          ? h("div", { className: "__dbi_g_toast" }, studioToast)
          : null
      );
    }

    // ── 样式 ────────────────────────────────────────────────────────────
    //
    // class 全是 `__dbi_g_` 前缀，颜色一律走主题变量，
    // 不写死色值。

    var CSS = [
      /*
       * 根容器同时给 `height:100%` 和 `flex:1`。
       *
       * 宿主（`dsh-client-ui-conversation` 的 `.wSkVaW_viewArea`）是
       * `display:flex;flex-direction:column;flex:1;min-height:0`，我们是它的
       * flex 子项。在 flex 容器里百分比高度参照的是父元素的**内容高度**，
       * 而父元素高度本身由 `flex:1` 算出——这条百分比链不可靠，光有
       * `height:100%` 会让内容按自然高度铺开，一直铺到输入框底下。
       * `flex:1` 才是让子项自己争取剩余空间的正确写法。
       */
      ".__dbi_g_root{display:flex;flex-direction:column;flex:1 1 0;min-height:0;height:100%;box-sizing:border-box;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".__dbi_g_tabs{flex:none;display:flex;align-items:center;gap:6px;padding:6px 24px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-shrink:0}",
      ".__dbi_g_tab{appearance:none;-webkit-appearance:none;border:0;background:transparent;display:inline-flex;align-items:center;gap:7px;padding:7px 14px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;transition:color .15s ease,background-color .15s ease}",
      ".__dbi_g_tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".__dbi_g_tabOn{color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600;background:rgba(37,99,235,0.08)}",
      ".__dbi_g_tabOn:hover{color:var(--dsw-alias-state-business-primary,#3964fe);background:rgba(37,99,235,0.08)}",
      ".__dbi_g_body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".__dbi_g_panel{position:relative;display:flex;flex-direction:column;min-height:0;height:100%}",
      ".__dbi_g_subtabs{flex:none;display:flex;gap:4px;padding:6px 10px 0}",
      ".__dbi_g_subtab{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:6px;background:transparent;padding:4px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".__dbi_g_subtab:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}",
      ".__dbi_g_subtabOn{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}",
      ".__dbi_g_count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;padding:0 5px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_toolbar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 10px}",
      ".__dbi_g_search{flex:1;min-width:120px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary);box-sizing:border-box}",
      ".__dbi_g_search::placeholder{color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_select{height:26px;max-width:180px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".__dbi_g_wsWrap{display:inline-flex;align-items:center;gap:4px}",
      ".__dbi_g_badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-3);font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".__dbi_g_btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;font-size:12px;color:var(--dsw-alias-label-primary);cursor:pointer;transition:all .15s}",
      ".__dbi_g_btn:hover{background:var(--dsw-alias-bg-layer-3)}",
      ".__dbi_g_btn:disabled{opacity:.5;cursor:default}",
      ".__dbi_g_btnOn{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_g_btnDanger{border-color:var(--dsw-alias-border-l2);color:#d94a4a}",
      ".__dbi_g_file{display:none}",
      ".__dbi_g_managebar{flex:none;display:flex;align-items:center;gap:8px;padding:0 10px 8px}",
      ".__dbi_g_manageInfo{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_pageBody{flex:1;min-height:0;overflow:auto;padding:0 10px 12px}",
      ".__dbi_g_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}",
      ".__dbi_g_card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:border-color .15s}",
      ".__dbi_g_card:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_g_cardSel{border-color:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_g_cardMedia{position:relative;width:100%;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-3);overflow:hidden}",
      ".__dbi_g_cardImg{width:100%;height:100%;object-fit:cover;display:block}",
      /* 视频卡：封面裁切与图片一致，但底色给黑——首帧解码前不会闪白块。 */
      ".__dbi_g_cardVideo{background:#000}",
      ".__dbi_g_cardPending{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_cardCheck{position:absolute;top:6px;left:6px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-3);font-size:11px;color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_g_cardCheckOn{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_g_cardTools{position:absolute;right:6px;bottom:6px;display:flex;gap:4px;opacity:0;transition:opacity .15s}",
      ".__dbi_g_card:hover .__dbi_g_cardTools{opacity:1}",
      ".__dbi_g_toolBtn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-3);font-size:11px;line-height:1;color:var(--dsw-alias-label-primary);cursor:pointer}",
      ".__dbi_g_toolBtnDanger{color:#d94a4a}",
      ".__dbi_g_cardMeta{display:flex;flex-direction:column;gap:2px;padding:6px 8px}",
      ".__dbi_g_cardBadge{align-self:flex-start;max-width:100%;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-3);font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_g_cardPrompt{font-size:11px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_g_cardFoot{font-size:10px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:48px 16px;text-align:center}",
      ".__dbi_g_emptyIcon{font-size:26px}",
      ".__dbi_g_emptyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".__dbi_g_emptyDesc{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_loading{display:flex;align-items:center;justify-content:center;padding:48px 16px;font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_unavailable{display:flex;align-items:center;justify-content:center;padding:48px 16px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center}",
      ".__dbi_g_toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);padding:6px 12px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-primary);pointer-events:none}",
      ".__dbi_g_lightbox{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.72);padding:24px;box-sizing:border-box}",
      ".__dbi_g_lightboxImg{max-width:100%;max-height:calc(100% - 72px);object-fit:contain;border-radius:6px}",
      /* 灯箱里的视频给一个最小高度，否则未播放时 `<video>` 会塌成 0 高，
         用户看到的是「点开了但什么都没有」。 */
      ".__dbi_g_lightboxVideo{min-height:min(60vh,420px);background:#000}",
      ".__dbi_g_lightboxHint{font-size:13px;color:#fff}",
      ".__dbi_g_lightboxBar{display:flex;align-items:center;gap:12px;max-width:100%;padding:8px 12px;border-radius:6px;background:rgba(0,0,0,.55);font-size:12px;color:#fff}",
      ".__dbi_g_lightboxPrompt{max-width:52vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".__dbi_g_lightboxModel{color:rgba(255,255,255,.7)}",
      // B10：灯箱左右切换按钮，纵向居中贴在两侧。
      ".__dbi_g_lightboxNav{position:fixed;top:50%;transform:translateY(-50%);width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:rgba(0,0,0,.45);color:#fff;font-size:20px;line-height:1;cursor:pointer}",
      ".__dbi_g_lightboxNav:hover{background:rgba(0,0,0,.7)}",
      ".__dbi_g_lightboxPrev{left:18px}",
      ".__dbi_g_lightboxNext{right:18px}",
      ".__dbi_g_lightboxBusy{position:fixed;left:50%;top:18px;transform:translateX(-50%);padding:6px 12px;border-radius:6px;background:rgba(0,0,0,.6);font-size:12px;color:#fff}",
      // B11：管理模式里的勾选框。
      ".__dbi_g_checkWrap{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
      ".__dbi_g_check{cursor:pointer}",
      ".__dbi_g_checkLabel{font-size:12px}",
      // B8：改词重生成弹层。
      ".__dbi_g_modal{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:24px;box-sizing:border-box}",
      ".__dbi_g_modalCard{width:min(520px,100%);display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);box-sizing:border-box}",
      ".__dbi_g_modalTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".__dbi_g_modalHint{font-size:12px;color:var(--dsw-alias-label-secondary)}",
      ".__dbi_g_modalInput{width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);resize:vertical;box-sizing:border-box}",
      ".__dbi_g_modalRow{display:flex;justify-content:flex-end;gap:8px}",
    ].join("");

    shared.injectCss(CSS_TAG, CSS);

    /*
     * 离线自测用的内部视图。
     *
     * 这**不是第二个导出**——`exports` 上仍然只有 `Mount` 一个键；这里只是
     * 把纯函数挂在函数对象上，好让自测逐个断言
     * 过滤 / 排序 / 导入 / 批量操作的判据本身，而不是只断言「渲染没崩」。
     */
    Mount.__internal = {
      DICT: DICT,
      TABS: TABS,
      SUB_TABS: SUB_TABS,
      CSS: CSS,
      IMPORT_ROUTE: IMPORT_ROUTE,
      REGENERATE_ROUTE: REGENERATE_ROUTE,
      pickLang: pickLang,
      makeT: makeT,
      itemRatio: itemRatio,
      relativeTime: relativeTime,
      collectRatios: collectRatios,
      collectWorkspaces: collectWorkspaces,
      matchSearch: matchSearch,
      filterItems: filterItems,
      sortItems: sortItems,
      buildImportBody: buildImportBody,
      readFileAsDataUrl: readFileAsDataUrl,
      performImport: performImport,
      importToastKey: importToastKey,
      runBulkDelete: runBulkDelete,
      runBulkFavorite: runBulkFavorite,
      runSingleDelete: runSingleDelete,
      buildDeleteMessage: buildDeleteMessage,
      deleteToastText: deleteToastText,
      classifyDeleteError: classifyDeleteError,
      invertSelection: invertSelection,
      applySelection: applySelection,
      previewIndex: previewIndex,
      stepPreview: stepPreview,
      crc32: crc32,
      buildZip: buildZip,
      zipEntryName: zipEntryName,
      zipFileName: zipFileName,
      concatBytes: concatBytes,
      fetchImageBytes: fetchImageBytes,
      buildGalleryZip: buildGalleryZip,
      copyImageToClipboard: copyImageToClipboard,
      downloadSingleImage: downloadSingleImage,
      triggerDownload: triggerDownload,
      buildRegenerateBody: buildRegenerateBody,
      performRegenerate: performRegenerate,
      buildStudioGenerateBody: buildStudioGenerateBody,
      studioGenerateToastKey: studioGenerateToastKey,
      performStudioGenerate: performStudioGenerate,
    };

    exports.Mount = Mount;
    return module.exports;
  },
});
