/**
 * dsh-doubao-image —— 图像工作台 chunk（三栏 workbench：最近生成 / 无限画布 / 生成面板）。
 *
 * 形态见 SPEC-chunks.md 第 2 节。本文件由 `client.gallery.js` 容器用
 * `shared.ChunkMount` 内嵌，只导出 `Mount`。
 *
 * 布局对齐官方 `dsh-image-gen@0.8.5` 的 `.dsh-ig-workbench-grid`
 * （`C:\Users\1\.dsh\profiles\desktop\node_modules\dsh-image-gen\lib\client.js:123867`）：
 *   `190px | minmax(360px,1fr) | 300px`（宽屏是 `minmax(190px,238px) | 1fr | minmax(286px,340px)`，
 *   窄到 1120px 才收敛成这三档固定值——本 chunk 直接用官方窄档数值），
 *   左「最近生成 / 收藏」、中「无限画布」、右「生成面板」。
 *
 * 两个重依赖都不在主 bundle 里：
 *   - tldraw 走包内 chunk `client.tldraw.js`（1.78 MB，懒加载）；
 *   - 画廊图片走 `shared.gallery` + `shared.useAttachmentUrl`。
 *
 * 设计要点（对应验收标准）：
 *   1. 画布是主体，生成面板是辅助——容器**从不**传 `props.onGenerate`
 *      （见 `client.gallery.js:882-889`），所以面板在没有真生成接口时退化为
 *      「把参数写成一条可复制的指令」。一旦容器补上 `onGenerate`，
 *      同一套 UI 立刻变成真提交，「生成中」也才有真实来源。
 *   2. tldraw 加载失败必须**局部**降级：工作台其余两栏照常渲染，不白屏。
 *   3. 快照存 localStorage（前缀 `dsh-dbi-studio-`）。图片资产的 `src` 是
 *      blob URL，刷新即失效；因此 shape 的 meta 里记 attachment 引用，
 *      loadSnapshot 之后重新取字节回填 src。回填失败的图保留破图状态。
 *   4. 参数差异按需隐藏：豆包通道只有 `1:1 / 4:3 / 16:9 / 9:16` 四个比例、
 *      一次可出多张；GPT 通道画幅由模型自定、一次只出一张。所以比例与张数
 *      这两行对 GPT 是**隐藏**而不是禁用（禁用的空控件只会制造噪音）。
 *
 * 不做：A6 多模型对比切换、A10 清晰度下拉（用户明确划掉）。
 */

window.__ModuleLoader__.load({
  id: "dsh-doubao-image-free",
  chunk: "client.studio.js",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var shared = (typeof globalThis !== "undefined" && globalThis.__dshDoubaoImageShared) || null;

    if (shared === null) {
      // 主 bundle 一定先于本文件执行（是它 require.async 的本文件）。
      exports.Mount = function () {
        return h("div", { className: "__dbi_s_error" }, "dsh-doubao-image: shared runtime missing");
      };
      return module.exports;
    }

    /* ── 常量 ──────────────────────────────────────────────────────────── */

    /** localStorage key：前缀 `dsh-dbi-studio-` 是本 chunk 的命名空间。 */
    var SNAPSHOT_KEY = "dsh-dbi-studio-canvas-v1";
    /**
     * 本 chunk 的构建戳。**排查「服务端文件改了、浏览器还复现旧 bug」专用**：
     * 在控制台看 `__dshStudioChunkMounted.build` 就知道加载的是哪一版。
     * 每次改本文件都手动改这个值。
     */
    var STUDIO_BUILD = "2026-10-20-count-always-injected";
    /** 生图模型选择的持久化 key（同一前缀规则）。 */
    var TOOL_KEY = "dsh-dbi-studio-tool-v1";
    var TL_CSS_TAG = "dsh-doubao-image/tldraw.css";
    var CHUNK_CSS_TAG = "dsh-doubao-image/studio.css";
    var TL_CHUNK = "client.tldraw.js";
    /**
     * Host 的 **GET** 取图地址，画布资产 `src` 用它。
     *
     * 必须是绝对 URL 且是 http(s)：tldraw 的协议白名单会拒掉相对路径之外的
     * 一切非 http/https/data/asset 协议（`blob:` 尤其）。BASE 由主 bundle
     * 通过 `shared.BASE` 暴露，这里在 chunk 初始化时拼好。
     */
    var IMAGE_RAW_ROUTE = (typeof shared.BASE === "string" ? shared.BASE : "") + "/api/image/raw";
    /**
     * 灵感图代理路由。灵感库的案例图存在 CDN 上，浏览器直连会被跨域拦掉，
     * 所以统一走 Host 的 POST 代理：body `{sourceId, image}` → 裸字节。
     * 契约见 `index.js` 的 ROUTE_INSPIRATION_IMAGE。
     */
    var INSPIRATION_IMAGE_ROUTE = (typeof shared.BASE === "string" ? shared.BASE : "") + "/api/inspiration/image";

    /**
     * 把灵感案例的效果图取回来，包装成可直接当参考图的 File。
     *
     * 返回 `null` 表示取不到（网络失败、非图片响应、字节为空）——调用方
     * 据此走「提示词照用、参考图没带上」的降级路径，而不是抛异常把整个
     * 工作台打挂。
     *
     * @param {string} sourceId 数据源 id（Host 靠它定位目录）
     * @param {string} imagePath 案例里的 `image` 值（形如 /images/x.jpg）
     * @returns {Promise<File|null>}
     */
    function loadInspirationReference(sourceId, imagePath) {
      if (typeof fetch !== "function") return Promise.resolve(null);
      return fetch(INSPIRATION_IMAGE_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: sourceId, image: imagePath }),
      }).then(function (response) {
        if (!response.ok) return null;
        var type = String((response.headers && response.headers.get && response.headers.get("content-type")) || "");
        // 取图失败时 Host 回的是 200 + JSON 错误体，不能当图片用。
        if (type.indexOf("image/") !== 0) return null;
        return response.blob();
      }).then(function (blob) {
        if (blob === null || blob === undefined || blob.size === 0) return null;
        var name = imagePath.split("/").pop() || "reference";
        try {
          return new File([blob], name, { type: blob.type });
        } catch (error) {
          return null;
        }
      }).catch(function () {
        return null;
      });
    }
    /** 图片在画布上的最长边（与官方 dsh-image-gen 同一量级）。 */
    var MAX_DISPLAY_SIDE = 380;
    /** 相邻落图的最小间距。 */
    var LANDING_GAP = 40;
    /** store 变化到落盘的防抖窗口。 */
    var SAVE_DEBOUNCE_MS = 400;
    /** 文生图可选的生成比例。豆包通道实测只有这四种（`lib/doubao.mjs:56`）。 */
    var RATIOS = ["1:1", "4:3", "16:9", "9:16"];
    /** 图生图可选比例（豆包网页端八档，顺序同网页）：首项 auto＝按参考图取景，其余按所选比例出图。 */
    var EDIT_RATIOS = ["auto", "9:16", "2:3", "3:4", "1:1", "4:3", "3:2", "16:9"];
    /** 图生图默认值：未选＝按参考图。 */
    var EDIT_RATIO_DEFAULT = "auto";
    /** 生成张数档位（官方 `.dsh-ig-count-row` 同样是四档）。 */
    var COUNTS = [1, 2, 3, 4];
    /** 「生成中」占位动画至少显示这么久，否则一闪而过看不见。 */
    var ORBIT_MIN_MS = 900;
    /**
     * 可选的生图工具。key 与 Host 侧注册的工具名逐字一致
     * （`doubao_image` / `gpt_image`），生成指令里直接引用。
     *
     * `supportsRatio` / `supportsCount` 是**真实能力差异**，不是偏好：
     *   - 豆包：`ratio` 可选四种，prompt 里写明张数即可一次出多张；
     *   - GPT：`buildConversationBody` 只有 prompt + model（无尺寸参数），
     *     且免费通道实测一次只出一张。
     * 所以对 GPT 隐藏比例与张数控件，而不是留一个禁用控件骗人。
     */
    var TOOLS = [
      { key: "doubao_image", zh: "豆包", en: "Doubao", supportsRatio: true, supportsCount: true },
      { key: "gpt_image", zh: "GPT", en: "GPT", supportsRatio: false, supportsCount: false },
    ];

    /**
     * 生视频可选时长（秒）。
     *
     * 豆包这条通道 1-10 秒都接，但面板只放三档：5 秒已要 ~2 分钟，10 秒
     * 更久，把 1-10 每秒列一遍只是把选择成本推给用户。
     */
    var VIDEO_DURATIONS = [5, 8, 10];

    /**
     * 生视频只有豆包一条通道。
     *
     * GPT 免费账户不出视频，所以视频模式下提供商下拉只留豆包一项 ——
     * 列一个选不动/选了必失败的 GPT 只会让人以为插件坏了。
     */
    var VIDEO_TOOL = "doubao_image";

    /**
     * 豆包可选的生图模型，顺序即下拉顺序。
     *
     * 与 `lib/doubao.mjs` 的 DOUBAO_IMAGE_MODELS 必须一致——那里的注释说明了
     * 服务端按显示名字符串选模型（实测回显在 `placeholder.description`）。
     * 客户端 bundle 拿不到 lib 常量，所以这份清单只能靠测试守住同步。
     *
     * `subscribed: true` 表示需要豆包订阅套餐：免费账号选了会得到一句
     * 「这是豆包订阅标准套餐专属能力」。保留在列表里但标注清楚，
     * 比直接隐藏更能解释「为什么别人能用我点不动」。
     */
    var DOUBAO_MODELS = [
      { key: "Seedream 5.0 Flash", zh: "Seedream 5.0 Flash", en: "Seedream 5.0 Flash", subscribed: false },
      { key: "Seedream 4.5", zh: "Seedream 4.5", en: "Seedream 4.5", subscribed: false },
      { key: "Seedream 4.0", zh: "Seedream 4.0", en: "Seedream 4.0", subscribed: false },
      { key: "Seedream 5.0 Pro", zh: "Seedream 5.0 Pro（需订阅）", en: "Seedream 5.0 Pro (subscription)", subscribed: true },
    ];
    var MODEL_KEY = "dsh-dbi-studio-model-v1";

    /* ── 字典（自带 zh/en，不依赖主 bundle 的 t） ──────────────────────── */

    var COPY = {
      zh: {
        title: "图像工作台",
        collapseSidebar: "收起左栏",
        collapseGenerate: "收起生成面板",
        expandSidebar: "展开左栏",
        expandGenerate: "展开生成面板",
        recent: "最近生成",
        // 官方左栏二级 tab 的文案是「最新生成 / 收藏」（截图取证）。
        railTabRecent: "最新生成",
        railTabFavorites: "收藏",
        recentEmpty: "画布旁还没有图片",
        favEmpty: "还没有收藏的图片",
        favImages: "收藏的图片",
        // 收藏页左栏的两个区块标题与空态说明，逐字对齐官方截图。
        favPromptTitle: "收藏提示词",
        favPromptEmpty: "点提示词输入框旁的【☆ 收藏】后，提示词会显示在这里",
        favImageEmpty: "在图片操作区点【收藏】后，图片会显示在这里",
        promptFavorite: "收藏",
        promptFavorited: "已收藏",
        promptFavUnavailable: "当前环境不支持收藏提示词",
        promptFavFailed: "收藏提示词失败",
        promptFavApply: "用这段提示词",
        promptFavDelete: "取消收藏",
        loadMore: "加载更多（还剩 {n} 张）",
        recentLoading: "正在读取画廊…",
        recentFailed: "画廊读取失败",
        generatePanel: "生成面板",
        modeGenerate: "文生图",
        modeEdit: "图生图",
        modeVideo: "生视频",
        videoRefsHint: "可选：传参考图就走图生视频，不传就是文生视频",
        videoDurationLabel: "时长",
        videoDurationOption: "{n} 秒",
        videoModelLabel: "视频模型",
        videoModelFollowDefault: "按设置页默认",
        referencesCount: "参考图 {current}/{max}",
        upload: "上传参考图",
        uploadHint: "点击选择，或把图片拖进来",
        clearReferences: "清空",
        closeReference: "移除这张参考图",
        clear: "清空",
        promptLabel: "提示词 Prompt",
        promptPlaceholder: "描述主体、构图、风格、光线与需要出现的文字…",
        findInspiration: "找灵感",
        ratio: "比例",
        ratioAuto: "自动比例（按参考图）",
        provider: "提供商",
        model: "模型",
        gptModel: "免费账户出图",
        gptNoRatio: "GPT 通道画幅由模型自定，不支持指定比例",
        gptNoCount: "GPT 免费账户一次只出一张",
        count: "生成数量",
        start: "开始生成",
        startWithCount: "开始生成（{n} 张）",
        cancelGenerate: "取消",
        generating: "正在生成…",
        generatingCount: "正在生成 {count} 张…",
        generatingHint: "{model} · {ratio}",
        canvasLoading: "正在加载无限画布…",
        canvasLoadFailed: "无限画布加载失败",
        canvasRetry: "重试",
        canvasEmpty: "先从左侧选择一张图片，或在右侧开始新的生成。",
        canvasSyncing: "正在恢复画布上的图片…",
        zoomIn: "放大",
        zoomOut: "缩小",
        zoomFit: "适应窗口",
        zoomAuto: "自动",
        result: "结果",
        resultMeta: "{model} · {ratio} · {size} · {elapsed}",
        continueEdit: "继续编辑",
        regenerate: "重新生成",
        copyImage: "复制图片",
        copyImageOk: "图片已复制",
        copyImageFailed: "复制失败",
        download: "下载",
        downloadEmpty: "画布上没有可下载的图片",
        savedToGallery: "已存画廊",
        saveToGallery: "存画廊",
        saveToGalleryOk: "已存入画廊",
        saveToGalleryFailed: "存画廊失败",
        sendToChat: "送入对话",
        sendToChatFailed: "复制失败",
        needPrompt: "请先输入提示词",
        needReference: "图生图至少需要一张参考图",
        referenceLoading: "正在载入参考图…",
        referenceLoadFailed: "参考图没取到，提示词已填入，可以自己补一张图",
        clearCanvas: "清空画布",
        clearConfirm: "确定清空画布吗？画廊里已保存的图片不受影响。",
        canvasCleared: "画布已清空",
        exportPng: "导出 PNG",
        exportEmpty: "画布是空的",
        exportFailed: "导出失败",
        exportUnsupported: "当前画布不支持导出",
        exported: "已导出 PNG",
        instructionTitle: "生成指令（复制后发到对话里）",
        instructionTemplate: "请用 dsh-doubao-image-free 的 {tool} 工具生成 {count} 张图片。\n提示词：{prompt}\n比例：{ratio}",
        instructionEditTemplate: "请用 dsh-doubao-image-free 的 {tool} 工具，参考我从画廊选的图做图生图。\n提示词：{prompt}",
        instructionGptTemplate: "请用 dsh-doubao-image-free 的 {tool} 工具生成一张图片。\n提示词：{prompt}",
        instructionVideoTemplate: "请用 dsh-doubao-image-free 的 {tool} 工具生成 {duration} 秒的视频（参考图 {refs} 张，0 张即文生视频）。\n提示词：{prompt}",
        copy: "复制",
        copied: "已复制",
        copyFailed: "复制失败",
        landing: "正在放置图片…",
        landFailed: "这张图片的原始数据已不可用",
        persistNote: "画布内容保存在本机浏览器里。图片按附件引用重新取回，若原图已失效则只保留占位。",
        shapesCount: "画布上有 {n} 个元素",
        clearPrompt: "清空提示词",
      },
      en: {
        title: "Image studio",
        collapseSidebar: "Collapse the left rail",
        collapseGenerate: "Collapse the generate panel",
        expandSidebar: "Expand the left rail",
        expandGenerate: "Expand the generate panel",
        recent: "Recent",
        railTabRecent: "Recent",
        railTabFavorites: "Favorites",
        recentEmpty: "No images beside the canvas yet",
        favEmpty: "No favorited images yet",
        favImages: "Favorited images",
        favPromptTitle: "Saved prompts",
        favPromptEmpty: "Click 【☆ Save】 next to the prompt box and it will show up here",
        favImageEmpty: "Click 【Save】 in an image's action bar and it will show up here",
        promptFavorite: "Save",
        promptFavorited: "Saved",
        promptFavUnavailable: "Saving prompts is unavailable in this environment",
        promptFavFailed: "Could not save the prompt",
        promptFavApply: "Use this prompt",
        promptFavDelete: "Remove from saved",
        loadMore: "Load more ({n} left)",
        recentLoading: "Loading gallery…",
        recentFailed: "Could not read the gallery",
        generatePanel: "Generate",
        modeGenerate: "Text to image",
        modeEdit: "Image to image",
        modeVideo: "Video",
        videoRefsHint: "Optional: add a reference image for image-to-video, or leave it empty for text-to-video",
        videoDurationLabel: "Duration",
        videoDurationOption: "{n}s",
        videoModelLabel: "Video model",
        videoModelFollowDefault: "Use the Settings default",
        referencesCount: "References {current}/{max}",
        upload: "Upload a reference",
        uploadHint: "Click to pick, or drop an image here",
        clearReferences: "Clear",
        closeReference: "Remove this reference",
        clear: "Clear",
        promptLabel: "Prompt",
        promptPlaceholder: "Describe the subject, composition, style, lighting, and exact text…",
        findInspiration: "Find inspiration",
        ratio: "Aspect ratio",
        ratioAuto: "Auto (from reference)",
        provider: "Provider",
        model: "Model",
        gptModel: "Free-account image",
        gptNoRatio: "The GPT channel decides its own framing; no aspect ratio",
        gptNoCount: "A free GPT account returns one image per turn",
        count: "Count",
        start: "Start",
        startWithCount: "Start ({n})",
        cancelGenerate: "Cancel",
        generating: "Generating…",
        generatingCount: "Generating {count} images…",
        generatingHint: "{model} · {ratio}",
        canvasLoading: "Loading the infinite canvas…",
        canvasLoadFailed: "The infinite canvas failed to load",
        canvasRetry: "Retry",
        canvasEmpty: "Select an image on the left, or start a new generation on the right.",
        canvasSyncing: "Restoring the images on the canvas…",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        zoomFit: "Fit to view",
        zoomAuto: "AUTO",
        result: "Result",
        resultMeta: "{model} · {ratio} · {size} · {elapsed}",
        continueEdit: "Continue editing",
        regenerate: "Regenerate",
        copyImage: "Copy image",
        copyImageOk: "Image copied",
        copyImageFailed: "Copy failed",
        download: "Download",
        downloadEmpty: "No image on the canvas to download",
        savedToGallery: "In gallery",
        saveToGallery: "Save to gallery",
        saveToGalleryOk: "Saved to the gallery",
        saveToGalleryFailed: "Could not save to the gallery",
        sendToChat: "Send to chat",
        sendToChatFailed: "Copy failed",
        needPrompt: "Enter a prompt first",
        needReference: "Image-to-image needs at least one reference",
        referenceLoading: "Loading reference…",
        referenceLoadFailed: "Could not fetch the reference; the prompt is filled in, add an image yourself",
        clearCanvas: "Clear canvas",
        clearConfirm: "Clear the canvas? Images already saved in the gallery are unaffected.",
        canvasCleared: "Canvas cleared",
        exportPng: "Export PNG",
        exportEmpty: "The canvas is empty",
        exportFailed: "Export failed",
        exportUnsupported: "This canvas cannot be exported",
        exported: "PNG exported",
        instructionTitle: "Generation request (copy it into the chat)",
        instructionTemplate: "Generate {count} images with the dsh-doubao-image-free {tool} tool.\nPrompt: {prompt}\nAspect ratio: {ratio}",
        instructionEditTemplate: "Use the dsh-doubao-image-free {tool} tool to edit the image I picked from the gallery.\nPrompt: {prompt}",
        instructionGptTemplate: "Generate one image with the dsh-doubao-image-free {tool} tool.\nPrompt: {prompt}",
        instructionVideoTemplate: "Generate a {duration}s video with the dsh-doubao-image-free {tool} tool ({refs} reference image(s); 0 means text-to-video).\nPrompt: {prompt}",
        copy: "Copy",
        copied: "Copied",
        copyFailed: "Copy failed",
        landing: "Placing the image…",
        landFailed: "The original bytes of this image are no longer available",
        persistNote: "The canvas is stored in this browser. Images are re-fetched by attachment reference; if the original is gone only a placeholder remains.",
        shapesCount: "{n} elements on the canvas",
        clearPrompt: "Clear the prompt",
      },
    };
    /* __DBI_STUDIO_COPY_END__ */

    /* ── 工具函数 ──────────────────────────────────────────────────────── */

    /** 语言判定：locale 可能缺失，任何异常都退回中文。 */
    function pickLang(locale) {
      try {
        var active = locale && locale.getSnapshot && locale.getSnapshot().active;
        return typeof active === "string" && active.toLowerCase().indexOf("en") === 0 ? "en" : "zh";
      } catch (error) {
        return "zh";
      }
    }

    function translate(lang, key, values) {
      var dict = COPY[lang] || COPY.zh;
      var text = dict[key];
      if (text === undefined) text = COPY.zh[key];
      if (text === undefined) return key;
      if (values === undefined) return text;
      return String(text).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
      });
    }

    /** tldraw 的 id 形如 `prefix:rest`；rest 不能含 `:`，非法字符一律压平。 */
    function safeIdPart(value) {
      var raw = value === undefined || value === null ? "" : String(value);
      var flat = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
      return flat.length === 0 ? "item" : flat;
    }

    function positiveOr(value, fallback) {
      return typeof value === "number" && isFinite(value) && value > 0 ? value : fallback;
    }

    function displaySizeOf(attachment) {
      var width = positiveOr(attachment && attachment.width, 512);
      var height = positiveOr(attachment && attachment.height, 512);
      var scale = MAX_DISPLAY_SIDE / Math.max(width, height);
      return { w: Math.round(width * scale), h: Math.round(height * scale) };
    }

    function readSnapshot() {
      try {
        var raw = localStorage.getItem(SNAPSHOT_KEY);
        if (typeof raw !== "string" || raw.length === 0) return null;
        var parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return null;
        return parsed;
      } catch (error) {
        return null;
      }
    }

    /**
     * 读回上次选中的生图工具 key；不在 TOOLS 列表里则退回第一个。
     *
     * localStorage 抛异常（隐私模式 / 被禁用）时静默退默认值——
     * 与 readSnapshot 同一策略。
     */
    function readToolKey() {
      try {
        var raw = localStorage.getItem(TOOL_KEY);
        if (typeof raw === "string") {
          for (var i = 0; i < TOOLS.length; i++) {
            if (TOOLS[i].key === raw) return raw;
          }
        }
      } catch (error) { /* fallthrough */ }
      return TOOLS[0].key;
    }

    function writeToolKey(key) {
      try {
        localStorage.setItem(TOOL_KEY, key);
      } catch (error) { /* 同 readToolKey */ }
    }

    /** 读回上次选中的豆包模型；不在清单里则退回第一个。 */
    function readModelKey() {
      try {
        var raw = localStorage.getItem(MODEL_KEY);
        if (typeof raw === "string") {
          for (var i = 0; i < DOUBAO_MODELS.length; i++) {
            if (DOUBAO_MODELS[i].key === raw) return raw;
          }
        }
      } catch (error) { /* 同 readToolKey */ }
      return DOUBAO_MODELS[0].key;
    }

    function writeModelKey(key) {
      try {
        localStorage.setItem(MODEL_KEY, key);
      } catch (error) { /* 同 readToolKey */ }
    }

    /** 模型显示名（Pro 带「需订阅」标记，直接说明为什么可能用不了）。 */
    function modelLabel(lang, key) {
      for (var i = 0; i < DOUBAO_MODELS.length; i++) {
        if (DOUBAO_MODELS[i].key === key) return DOUBAO_MODELS[i][lang] || DOUBAO_MODELS[i].zh;
      }
      return key;
    }

    function toolSpec(key) {
      for (var i = 0; i < TOOLS.length; i++) {
        if (TOOLS[i].key === key) return TOOLS[i];
      }
      return TOOLS[0];
    }

    /** 生图工具对应的显示名（按当前语言）。 */
    function toolLabel(lang, key) {
      var spec = toolSpec(key);
      return spec[lang] || spec.zh;
    }

    /** 图生图允许的比例值：auto 或八档之一，别的值一律压回 auto。 */
    function normalizeEditRatio(value) {
      for (var i = 0; i < EDIT_RATIOS.length; i++) {
        if (EDIT_RATIOS[i] === value) return value;
      }
      return EDIT_RATIO_DEFAULT;
    }

    /** 豆包网页端只认这四个比例；别的值一律压回第一个。 */
    function normalizeRatio(value) {
      for (var i = 0; i < RATIOS.length; i++) {
        if (RATIOS[i] === value) return value;
      }
      return RATIOS[0];
    }

    function normalizeCount(value) {
      var num = Number(value);
      for (var i = 0; i < COUNTS.length; i++) {
        if (COUNTS[i] === num) return num;
      }
      return COUNTS[0];
    }

    /** 附件尺寸的人类可读形式；缺尺寸时给出中性短横而不是编一个数。 */
    function formatSize(attachment) {
      var width = attachment && attachment.width;
      var height = attachment && attachment.height;
      if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) {
        return width + " × " + height;
      }
      return "—";
    }

    /** 相对时间（与官方 `formatRelativeTime$1` 同一口径，不引依赖）。 */
    function formatRelativeTime(timestamp, lang) {
      var value = Number(timestamp);
      if (!isFinite(value) || value <= 0) return "—";
      var seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
      var en = lang === "en";
      if (seconds < 60) return en ? "just now" : "刚刚";
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return en ? minutes + " min ago" : minutes + " 分钟前";
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return en ? hours + " h ago" : hours + " 小时前";
      var days = Math.floor(hours / 24);
      return en ? days + " d ago" : days + " 天前";
    }

    /** 生成耗时的人类可读形式（毫秒 → 「12.3 秒」/「12.3s」）。 */
    function formatElapsed(ms, lang) {
      var value = Number(ms);
      if (!isFinite(value) || value < 0) return "—";
      var seconds = value / 1000;
      if (seconds < 60) {
        return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + (lang === "en" ? "s" : " 秒");
      }
      var minutes = Math.floor(seconds / 60);
      var rest = Math.round(seconds - minutes * 60);
      return minutes + (lang === "en" ? "m " : " 分 ") + rest + (lang === "en" ? "s" : " 秒");
    }

    /** 取附件字节：与 `useAttachmentUrl` 同一条 Host 路由。 */
    function fetchAttachmentBlob(attachment) {
      return fetch(shared.IMAGE_ROUTE, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachment: attachment }),
      }).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.blob();
      });
    }

    /* ── tldraw chunk 懒加载 ───────────────────────────────────────────── */

    /**
     * 加载 `client.tldraw.js`。
     *
     * 刻意不用 `shared.useChunk`：那个 hook 闭包捕获的是主 bundle 的
     * `require`，而这里需要断言「确实以 `./client.tldraw.js` 请求了本 chunk」，
     * 并且失败原因要能被本组件区分展示。两者最终走同一条 `require.async`。
     */
    function useTldrawChunk(attempt) {
      var pair = react.useState({ status: "loading", mod: null, error: "" });
      var state = pair[0];
      var setState = pair[1];
      react.useEffect(function () {
        setState({ status: "loading", mod: null, error: "" });
        var alive = true;
        if (typeof require.async !== "function") {
          setState({ status: "error", mod: null, error: "require.async unavailable" });
          return;
        }
        var pending;
        try {
          pending = require.async("./" + TL_CHUNK);
        } catch (error) {
          setState({ status: "error", mod: null, error: String((error && error.message) || error) });
          return;
        }
        Promise.resolve(pending).then(function (mod) {
          if (!alive) return;
          if (mod === null || typeof mod !== "object" || typeof mod.Tldraw !== "function") {
            setState({ status: "error", mod: null, error: "chunk has no Tldraw export" });
            return;
          }
          setState({ status: "ready", mod: mod, error: "" });
        }, function (error) {
          if (!alive) return;
          setState({ status: "error", mod: null, error: String((error && error.message) || error) });
        });
        return function () { alive = false; };
      }, [attempt]);
      return state;
    }

    /* ── 画布持久化 ───────────────────────────────────────────────────── */

    /**
     * 灌进 store **之前**先把快照里的非法 asset src 修掉。
     *
     * `loadSnapshot` → `loadStoreSnapshot` 会 `clear()` 之后**无条件 `put`
     * 快照里的每一条记录**，包括没有任何 shape 引用的孤儿 asset。只要有一条
     * 的 src 不在 tldraw 的白名单里（`{http, https, data, asset}`），那次
     * `put` 就抛 `ValidationError`（栈里是 `io → Eu.atomic → Eu.put`），
     * 整个画布被推进错误边界。
     *
     * **所以这里必须无条件扫所有 asset 记录**，不能只修「能配到 image shape」
     * 的那些——孤儿 asset 照样会被 put，照样会炸。这是第一版修法没生效的原因。
     *
     * 快照形状：`{ document: { schema, store: { [id]: record } }, session }`
     * （`getStoreSnapshot()` 返回 `{store, schema}`，`getSnapshot()` 把它放在
     * `document` 下——已从 tldraw 打包源确认）。所有字段都当作**不可信数据**：
     * 用户可能从旧版本升上来，也可能手改过 localStorage。形状不对就原样返回，
     * 交给 `loadSnapshot` 自己的 try/catch 处理。
     *
     * 换 src 需要知道这个 asset 对应哪个 attachment。优先从引用它的 image
     * shape 的 `meta.dbiAttachment` 取；取不到就**把 src 置空串**——空串在
     * tldraw 的校验里是合法的（`if (value === "") return;`），表现为一张
     * 待加载的图，用户重新从图库拖一张进来即可，总好过整个画布崩掉。
     */
    function sanitizeSnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== "object") return snapshot;
      var document = snapshot.document;
      if (document === null || typeof document !== "object") return snapshot;
      var store = document.store;
      if (store === null || typeof store !== "object" || Array.isArray(store)) return snapshot;

      var ids = Object.keys(store);

      // 先建 shape → asset 的附件索引，供下面替换 src 用。
      var byAsset = {};
      ids.forEach(function (id) {
        var record = store[id];
        if (record === null || typeof record !== "object") return;
        if (record.typeName !== "shape" || record.type !== "image") return;
        var attachment = record.meta && record.meta.dbiAttachment;
        var assetId = record.props && record.props.assetId;
        if (attachment === undefined || typeof assetId !== "string") return;
        byAsset[assetId] = attachment;
      });

      var changed = false;
      var nextStore = Object.assign({}, store);
      ids.forEach(function (id) {
        var record = store[id];
        if (record === null || typeof record !== "object") return;
        // 只看图片资产。其他类型（shape / page / instance …）一律不碰。
        if (record.typeName !== "asset" || record.type !== "image") return;
        var props = record.props;
        if (props === null || typeof props !== "object") return;
        var src = props.src;
        // 合法协议一律不碰：tldraw 的白名单是 {http, https, data, asset}。
        if (typeof src === "string" && /^(https?:|data:|asset:)/i.test(src)) return;
        var attachment = byAsset[id];
        changed = true;
        nextStore[id] = Object.assign({}, record, {
          // 有附件引用就用 http URL 重算；没有就置空串（合法，表现为待加载）。
          props: Object.assign({}, props, { src: attachment === undefined ? "" : canvasImageUrl(attachment) }),
        });
      });
      if (!changed) return snapshot;
      return Object.assign({}, snapshot, {
        document: Object.assign({}, document, { store: nextStore }),
      });
    }

    /**
     * 快照恢复后修掉画布资产里的 src。
     *
     * 新快照存的就是 http URL（见 `canvasImageUrl`），刷新后依然有效，
     * 因此**正常情况下这里什么都不用做**。
     *
     * 这段是 `sanitizeSnapshot` 的兜底：万一有记录的 src 是空的、或者
     * shape 与 asset 的配对信息在加载过程中才补上，这里再扫一遍。
     * 取不到引用的保持原样（继续破图），不删 shape——用户自己清理比静默
     * 丢图好。
     */
    function restoreImageSources(editor, isAlive) {
      var byAsset = {};
      var records;
      try {
        records = editor.store.allRecords();
      } catch (error) {
        return Promise.resolve(0);
      }
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (record.typeName !== "shape" || record.type !== "image") continue;
        var attachment = record.meta && record.meta.dbiAttachment;
        var assetId = record.props && record.props.assetId;
        if (attachment === undefined || typeof assetId !== "string") continue;
        byAsset[assetId] = attachment;
      }
      var updates = [];
      Object.keys(byAsset).forEach(function (assetId) {
        if (!isAlive()) return;
        var asset = editor.getAsset(assetId);
        if (asset === undefined || asset === null) return;
        var src = asset.props && asset.props.src;
        // 已经是**合法** src 的就别动。tldraw 的白名单是
        // {http, https, data, asset}，我们只修复 `blob:` 那种历史上写过、
        // 刷新后必然失效的地址；data: / asset: 都是有效的，重算反而会破坏它。
        if (typeof src === "string" && /^(https?:|data:|asset:)/i.test(src)) return;
        updates.push(Object.assign({}, asset, {
          props: Object.assign({}, asset.props, { src: canvasImageUrl(byAsset[assetId]) }),
        }));
      });
      if (updates.length > 0) editor.updateAssets(updates);
      return Promise.resolve(updates.length);
    }

    /* ── 落图（画廊 → 画布） ──────────────────────────────────────────── */

    function nextLandingPosition(editor, w, h) {
      var viewport = editor.getViewportPageBounds();
      var centerX = viewport && viewport.center ? viewport.center.x : 0;
      var centerY = viewport && viewport.center ? viewport.center.y : 0;
      var existing = editor.getCurrentPageShapes();
      if (existing.length === 0) {
        return { x: Math.round(centerX - w / 2), y: Math.round(centerY - h / 2) };
      }
      var bottom = -Infinity;
      for (var i = 0; i < existing.length; i++) {
        var bounds = editor.getShapePageBounds(existing[i].id);
        if (bounds && bounds.maxY > bottom) bottom = bounds.maxY;
      }
      if (!isFinite(bottom)) bottom = centerY;
      return { x: Math.round(centerX - w / 2), y: Math.round(bottom + LANDING_GAP) };
    }

    /**
     * 把一张画廊图片放到画布。
     *
     * `url` 是 `canvasImageUrl(attachment)` 算出的 http 地址 —— **必须是
     * http(s)**，tldraw 的 asset 协议白名单不收 `blob:`（见 `canvasImageUrl`
     * 的注释，那里记着踩坑经过）。
     *
     * 同一张图重复落图：shape 走稳定 id，已存在时只挪位置、不重复建，
     * 否则 tldraw 会因为 id 冲突抛错。资产同理，已有则保留原 src。
     */
    function landGalleryItem(editor, item, url) {
      var attachment = item && item.attachment ? item.attachment : {};
      var galleryId = safeIdPart(item && item.id);
      var assetId = "asset:dbi-" + galleryId;
      var shapeId = "shape:dbi-" + galleryId;
      var size = displaySizeOf(attachment);
      if (editor.getAsset(assetId) === undefined) {
        editor.createAssets([{
          id: assetId,
          typeName: "asset",
          type: "image",
          meta: {},
          props: {
            name: String(attachment.name || galleryId),
            src: url,
            w: positiveOr(attachment.width, 512),
            h: positiveOr(attachment.height, 512),
            mimeType: String(attachment.mediaType || "image/png"),
            isAnimated: attachment.mediaType === "image/gif",
            fileSize: positiveOr(attachment.bytes, 0),
          },
        }]);
      }
      var position = nextLandingPosition(editor, size.w, size.h);
      var meta = {
        dbiGalleryId: galleryId,
        dbiAttachment: attachment,
      };
      if (typeof item.prompt === "string" && item.prompt.length > 0) {
        meta.dbiPrompt = item.prompt.replace(/\s+/g, " ").trim().slice(0, 120);
      }
      // 结果元信息条（A20）要显示 模型 · 比例 · 尺寸 · 耗时，这些字段必须在落图
      // 时就随 shape 一起存下来——只留附件引用的话，刷新后面板就只剩尺寸了。
      if (typeof item.provider === "string" && item.provider.length > 0) meta.dbiProvider = item.provider;
      if (typeof item.model === "string" && item.model.length > 0) meta.dbiModel = item.model;
      var itemRatio = typeof item.aspectRatio === "string" ? item.aspectRatio : item.ratio;
      if (typeof itemRatio === "string" && itemRatio.length > 0) meta.dbiRatio = itemRatio;
      if (typeof item.createdAt === "number" && item.createdAt > 0) meta.dbiCreatedAt = item.createdAt;
      if (typeof item.elapsedMs === "number" && item.elapsedMs > 0) meta.dbiElapsedMs = item.elapsedMs;
      if (editor.getShape(shapeId) !== undefined) {
        // 已经在画布上：把它挪到新位置，而不是再建一个同 id 的。
        editor.updateShape({ id: shapeId, type: "image", x: position.x, y: position.y });
        focusLanding(editor, shapeId);
        return;
      }
      editor.createShape({
        id: shapeId,
        type: "image",
        x: position.x,
        y: position.y,
        props: { assetId: assetId, w: size.w, h: size.h },
        meta: meta,
      });
      focusLanding(editor, shapeId);
    }

    /**
     * 落图后把视角对准刚落下的那张图。
     *
     * **为什么必须有**：实测用户点一张 2048×1152 的图进画布，落图尺寸算得
     * 完全正确（380×214），但画布相机停在 **zoom 0.05** —— 380px 的图在 5%
     * 缩放下只剩 19px，视觉上就是「什么都没有」，用户报的是「图片被缩得
     * 这么小」。所以缺陷不在尺寸，在**视角没有跟着内容走**。
     *
     * 两条纪律：
     *  1. 只动**相机**，不碰形状尺寸——尺寸计算本来就是对的。
     *  2. 已经有合理视角时**不打扰**（比如用户自己缩放后继续放图）。判据取
     *     「相机可见范围与这张图相差是否悬殊」，悬殊才重新取景。
     */
    function focusLanding(editor, shapeId) {
      try {
        if (typeof editor.getShapePageBounds !== "function" || typeof editor.zoomToBounds !== "function") return;
        var bounds = editor.getShapePageBounds(shapeId);
        if (!bounds) return;
        var viewport = typeof editor.getViewportPageBounds === "function" ? editor.getViewportPageBounds() : null;
        if (viewport) {
          // 图已经落在视野内并且占了像样的比例：保持用户当前视角不动。
          var visible = viewport.width > 0 && viewport.height > 0
            && viewport.minX <= bounds.minX && viewport.maxX >= bounds.maxX
            && viewport.minY <= bounds.minY && viewport.maxY >= bounds.maxY;
          var ratio = viewport.width > 0 ? bounds.width / viewport.width : 0;
          if (visible && ratio > 0.1) return;
        }
        /*
         * `targetZoom: 1` 是**上限**（tldraw 内部是 `zoom = Math.min(targetZoom, zoom)`）：
         * 图小于视口时按原比例显示，不要为了「填满」把它放大。
         *
         * 为什么必须钉这个上限：无上限时 `zoomToBounds` 会让 380×214 的图
         * 撑满整块画布（实测被放到 2.35 倍，屏幕上是一大片糊掉的灰），
         * 用户看到的是「图变成了一块巨大的灰色」。图只该「看得清」，
         * 不该被拉大到失真。
         *
         * `inset` 留边，避免图贴死画布边缘；动画时长与 tldraw 默认一致。
         */
        editor.zoomToBounds(bounds, { animation: { duration: 220 }, inset: 48, targetZoom: 1 });
      } catch (error) {
        /*
         * 取景失败不该让落图失败——图已经在画布上了，这只是相机的锦上添花。
         * 上层 onLanded 的 catch 会把异常报成「落图失败」，那是误导。
         */
      }
    }

    /**
     * 取图 → 落图的桥。
     *
     * 现在**只剩「等一个渲染帧」这一个职责**：`src` 是纯函数算出来的 http
     * URL，不需要再取字节、也不需要等 blob。保留组件形态是为了让父级在
     * 渲染结束后才落图（同一帧里既渲染 bridge 又改 store 会触发 React 的
     * 更新顺序告警）。
     */
    function LandingBridge(props) {
      react.useEffect(function () {
        props.onReady(props.item, canvasImageUrl(props.item.attachment));
      }, [props.item, props.onReady]);
      return h("div", { className: "__dbi_s_landing", role: "status" }, props.label);
    }

    /**
     * 给画布资产用的 **http** 取图地址。
     *
     * **不能用 blob URL**——这是踩过的坑：tldraw 的 asset `src` 有一个协议
     * 白名单 `{http, https, data, asset}`（`@tldraw/validate`，打包在官方
     * `dsh-image-gen/lib/client.js:13986-13991`），`blob:` 会被判为非法协议
     * 抛 `ValidationError`；而建资产跑在 atomic 事务里，一抛就把整个事务回滚、
     * 画布崩成「Something went wrong」。实测触发路径：在图库点一张图落画布。
     *
     * 同时这也解决了原先的**生命周期**问题：blob URL 需要自己持有并 revoke，
     * 而画布资产活得比任何组件都久；http URL 没有所有权，不用管释放。
     *
     * Host 的 `GET /api/image/raw` 按 attachment 引用取字节，且带长缓存头
     * （同一个 attachmentId 内容不变），刷新画布时不会重复打穿存储层。
     */
    function canvasImageUrl(attachment) {
      var ref = attachment || {};
      var query = [
        ["attachmentId", String(ref.attachmentId || "")],
        ["mediaType", String(ref.mediaType || "image/png")],
        ["bytes", String(positiveOr(ref.bytes, 0))],
        ["width", String(positiveOr(ref.width, 0))],
        ["height", String(positiveOr(ref.height, 0))],
      ].map(function (pair) {
        return encodeURIComponent(pair[0]) + "=" + encodeURIComponent(pair[1]);
      }).join("&");
      return IMAGE_RAW_ROUTE + (IMAGE_RAW_ROUTE.indexOf("?") === -1 ? "?" : "&") + query;
    }

    /* ── 画布工具条：缩放读写（tldraw editor API 存在性检测） ─────────── */

    /*
     * tldraw 的 Editor 上 `getZoomLevel` / `zoomIn` / `zoomOut` / `zoomToFit`
     * 都是**方法**，不是属性；不同版本可能缺其中某个（我们的测试桩就只实现了
     * `getZoomLevel` + `zoomToBounds`）。所以一律 `typeof === "function"` 探测，
     * 缺失就走降级，绝不让工具条把整个工作台带崩。
     */
    function editorZoomPercent(editor) {
      if (editor === null) return null;
      if (typeof editor.getZoomLevel !== "function") return null;
      var level = Number(editor.getZoomLevel());
      if (!isFinite(level) || level <= 0) return null;
      return Math.round(level * 100);
    }

    /*
     * 缩放步进：优先用 tldraw 的 `zoomIn` / `zoomOut`（它自带 zoomSteps 与
     * 动画）；没有这两个方法时退回 `setCamera` 改 z（tldraw 的 camera 是
     * `{x, y, z}`）。两者都没有就返回 false，调用方据此禁用按钮。
     */
    function zoomByStep(editor, direction) {
      if (editor === null) return false;
      var method = direction > 0 ? editor.zoomIn : editor.zoomOut;
      if (typeof method === "function") {
        method.call(editor);
        return true;
      }
      if (typeof editor.getCamera !== "function" || typeof editor.setCamera !== "function") return false;
      var camera = editor.getCamera();
      if (camera === null || typeof camera !== "object") return false;
      var z = Number(camera.z);
      if (!isFinite(z) || z <= 0) return false;
      var next = direction > 0 ? z * 1.25 : z / 1.25;
      next = Math.min(8, Math.max(0.05, next));
      editor.setCamera({ x: Number(camera.x) || 0, y: Number(camera.y) || 0, z: next });
      return true;
    }

    function zoomToFitCanvas(editor) {
      if (editor === null) return false;
      if (typeof editor.zoomToFit !== "function") return false;
      editor.zoomToFit();
      return true;
    }

    /* ── 清空 / 导出 / 下载 / 复制 ────────────────────────────────────── */

    function clearCanvas(editor) {
      editor.run(function () {
        var pages = editor.getPages();
        for (var i = 0; i < pages.length; i++) {
          editor.deleteShapes(Array.from(editor.getPageShapeIds(pages[i].id)));
        }
        for (var j = 1; j < pages.length; j++) editor.deletePage(pages[j].id);
        editor.deleteAssets(editor.getAssets());
        editor.setCamera({ x: 0, y: 0, z: 1 });
      }, { history: "ignore", ignoreShapeLock: true });
      editor.clearHistory();
    }

    function svgSizeOf(element) {
      var viewBox = typeof element.getAttribute === "function" ? element.getAttribute("viewBox") : null;
      if (typeof viewBox === "string") {
        var parts = viewBox.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4 && isFinite(parts[2]) && isFinite(parts[3])) {
          return { width: parts[2], height: parts[3] };
        }
      }
      var attrW = typeof element.getAttribute === "function" ? Number(element.getAttribute("width")) : NaN;
      var attrH = typeof element.getAttribute === "function" ? Number(element.getAttribute("height")) : NaN;
      return {
        width: isFinite(attrW) && attrW > 0 ? attrW : 1024,
        height: isFinite(attrH) && attrH > 0 ? attrH : 768,
      };
    }

    /** SVG → PNG blob。走 canvas，因此 blob URL 的图片不会污染画布。 */
    function svgToPngBlob(svg, width, height) {
      return new Promise(function (resolve, reject) {
        var text = typeof svg === "string" ? svg : new XMLSerializer().serializeToString(svg);
        var blob = new Blob([text], { type: "image/svg+xml;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var image = new Image();
        image.onload = function () {
          try {
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(width));
            canvas.height = Math.max(1, Math.round(height));
            var context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (out) {
              URL.revokeObjectURL(url);
              if (out === null) { reject(new Error("toBlob returned null")); return; }
              resolve(out);
            }, "image/png");
          } catch (error) {
            URL.revokeObjectURL(url);
            reject(error);
          }
        };
        image.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("svg rasterization failed"));
        };
        image.src = url;
      });
    }

    function downloadBlob(blob, name) {
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      if (typeof link.remove === "function") link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /**
     * 导出当前页为 PNG。
     *
     * tldraw 的导出 API 有两代：新版 `getSvgString` 返回 `{svg,width,height}`，
     * 旧版 `getSvg` 返回 `SVGSVGElement`。两代都试；都没有就明确报不支持，
     * 不假装成功。
     */
    function exportCanvasPng(editor) {
      var ids = Array.from(editor.getCurrentPageShapeIds());
      if (ids.length === 0) return Promise.reject(new Error("empty-canvas"));
      var payload;
      if (typeof editor.getSvgString === "function") {
        payload = Promise.resolve(editor.getSvgString(ids)).then(function (result) {
          if (result === null || result === undefined || typeof result.svg !== "string") {
            throw new Error("svg-unavailable");
          }
          return { svg: result.svg, width: positiveOr(result.width, 1024), height: positiveOr(result.height, 768) };
        });
      } else if (typeof editor.getSvg === "function") {
        payload = Promise.resolve(editor.getSvg(ids)).then(function (element) {
          if (element === null || element === undefined) throw new Error("svg-unavailable");
          var size = svgSizeOf(element);
          return { svg: element, width: size.width, height: size.height };
        });
      } else {
        return Promise.reject(new Error("svg-unsupported"));
      }
      return payload
        .then(function (result) { return svgToPngBlob(result.svg, result.width, result.height); })
        .then(function (blob) { downloadBlob(blob, "studio-canvas.png"); });
    }

    /** 画布上第一张图片 shape（结果条 / 操作条都作用于它）。 */
    function firstImageShape(editor) {
      var shapes = editor.getCurrentPageShapes();
      for (var i = 0; i < shapes.length; i++) {
        if (shapes[i].type === "image") return shapes[i];
      }
      return null;
    }

    /** 从 shape 的 meta 还原出「结果」对象（供信息条/元信息条渲染）。 */
    function resultOf(editor) {
      if (editor === null) return null;
      var shape = firstImageShape(editor);
      if (shape === null) return null;
      var meta = shape.meta || {};
      var attachment = meta.dbiAttachment || null;
      return {
        id: safeIdPart(meta.dbiGalleryId || shape.id),
        prompt: typeof meta.dbiPrompt === "string" ? meta.dbiPrompt : "",
        attachment: attachment,
        provider: meta.dbiProvider || "",
        model: meta.dbiModel || "",
        ratio: meta.dbiRatio || "",
        createdAt: positiveOr(meta.dbiCreatedAt, 0),
        elapsedMs: positiveOr(meta.dbiElapsedMs, 0),
        shapeCount: editor.getCurrentPageShapes().length,
      };
    }

    /** 当前页的图片 shape → 结果对象数组（画布簇用）。 */
    function batchOf(editor) {
      if (editor === null) return [];
      var shapes = editor.getCurrentPageShapes();
      var out = [];
      for (var i = 0; i < shapes.length; i++) {
        if (shapes[i].type !== "image") continue;
        var meta = shapes[i].meta || {};
        out.push({
          id: shapes[i].id,
          attachment: meta.dbiAttachment || null,
          prompt: typeof meta.dbiPrompt === "string" ? meta.dbiPrompt : "",
          model: meta.dbiModel || "",
        });
      }
      return out;
    }

    /**
     * 把一张附件写进画廊（结果操作条的「存画廊」）。
     *
     * `wsFields` 是工作区归属字段（`workspacePath` / `sessionId`，缺省为
     * `{}`）。由 `StudioView` 从 props 推导后传进来——本函数是纯函数，
     * 不碰 hook，才能被单测直接驱动。
     */
    function saveAttachmentToGallery(result, wsFields) {
      if (shared.gallery === undefined || typeof shared.gallery.saveGalleryItem !== "function") {
        return Promise.reject(new Error("gallery-unavailable"));
      }
      var attachment = result.attachment;
      if (attachment === null || attachment === undefined) {
        return Promise.reject(new Error("no-attachment"));
      }
      var owned = wsFields !== null && typeof wsFields === "object" ? wsFields : {};
      return Promise.resolve(shared.gallery.saveGalleryItem(Object.assign({
        id: String(attachment.attachmentId || ""),
        attachment: attachment,
        prompt: result.prompt,
        provider: result.provider,
        model: result.model,
        aspectRatio: result.ratio,
        createdAt: Date.now(),
      }, owned)));
    }

    /** 复制图片字节到剪贴板（与官方 `copySelected` 同一路径）。 */
    function copyImageToClipboard(result) {
      var clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
      if (clipboard === undefined || typeof clipboard.write !== "function") {
        return Promise.reject(new Error("clipboard-unsupported"));
      }
      var ClipboardItemCtor = typeof globalThis !== "undefined" ? globalThis.ClipboardItem : undefined;
      if (typeof ClipboardItemCtor !== "function") {
        return Promise.reject(new Error("clipboard-item-unsupported"));
      }
      return fetchAttachmentBlob(result.attachment).then(function (blob) {
        var type = blob.type || String((result.attachment && result.attachment.mediaType) || "image/png");
        var item = {};
        item[type] = blob;
        return clipboard.write([new ClipboardItemCtor(item)]);
      });
    }

    /* ── 左栏：最近生成 / 收藏 ────────────────────────────────────────── */

    function RecentThumb(props) {
      var state = shared.useAttachmentUrl(props.item.attachment, true);
      if (state.url !== "") {
        return h("img", { className: "__dbi_s_recentThumb", src: state.url, alt: "", loading: "lazy" });
      }
      return h("span", { className: "__dbi_s_recentThumb __dbi_s_recentThumbEmpty" }, state.error !== "" ? "!" : "…");
    }

    function RecentItem(props) {
      var label = props.item.prompt !== "" ? props.item.prompt : String(props.item.id || "");
      return h("button", {
        type: "button",
        className: "__dbi_s_recentItem" + (props.active ? " is-active" : ""),
        title: label,
        onClick: function () { props.onPick(props.item); },
      }, h(RecentThumb, { item: props.item }));
    }

    /* ── 右栏：参考图缩略图卡 ─────────────────────────────────────────── */

    function ReferenceCard(props) {
      return h("div", { className: "__dbi_s_referenceCard" },
        h("img", { className: "__dbi_s_referenceThumb", src: props.item.previewUrl, alt: "" }),
        h("button", {
          type: "button",
          className: "__dbi_s_referenceRemove",
          title: props.removeLabel,
          "aria-label": props.removeLabel,
          onClick: function () { props.onRemove(props.item.id); },
        }, "×")
      );
    }

    /* ── 主体 ─────────────────────────────────────────────────────────── */

    function StudioView(props) {
      shared.useLocale(props.locale);
      var lang = pickLang(props.locale);
      var t = function (key, values) { return translate(lang, key, values); };

      /*
       * 工作区归属字段。`cwd` 由主 bundle 的 `conversation.view` 工厂从
       * `useSessions` 查好后逐层透传下来（画廊容器 → 本 chunk），本文件
       * 不再自己调 hook。缺省时是空对象，即「不写工作区」。
       */
      var wsFields = typeof shared.workspaceFieldsFrom === "function"
        ? shared.workspaceFieldsFrom(props.cwd, props.sessionId)
        : {};

      var promptPair = react.useState("");
      var prompt = promptPair[0];
      var setPrompt = promptPair[1];
      /**
       * 比例按模式分段保存：`generate` 段存文生图四档（默认 1:1），
       * `edit` 段存八档之一（默认 auto＝按参考图）。切换模式时各自还原，
       * 互不串值 —— 两个模式本来就是两套取景语义。
       */
      var generateRatioPair = react.useState(normalizeRatio(""));
      var generateRatio = generateRatioPair[0];
      var setGenerateRatio = generateRatioPair[1];
      var editRatioPair = react.useState(EDIT_RATIO_DEFAULT);
      var editRatio = editRatioPair[0];
      var setEditRatio = editRatioPair[1];
      var countPair = react.useState(COUNTS[0]);
      var count = countPair[0];
      var setCount = countPair[1];
      /** 生图工具：读 localStorage 回退默认值；切换时立刻写回。 */
      var toolPair = react.useState(readToolKey);
      var tool = toolPair[0];
      var setTool = toolPair[1];
      /** 豆包生图模型：同样持久化，跨会话保留用户选择。 */
      var modelPair = react.useState(readModelKey);
      var model = modelPair[0];
      var setModel = modelPair[1];
      /** 文生图 / 图生图 / 生视频。 */
      var modePair = react.useState("generate");
      var mode = modePair[0];
      var setMode = modePair[1];
      /**
       * 视频开关（`video.enabled`）。决定视频相关按键是否渲染。
       *
       * 由容器经 `props.videoEnabled` 传入。缺省 `false` 是有意的保守默认：
       * 拿不到配置时宁可少一个入口，也不要让用户点进一个必失败的模式。
       */
      var videoEnabled = props.videoEnabled === true;
      /**
       * 视频模型清单与设置页默认档。
       *
       * 唯一真相源是 Host 的 `/api/status`（`config.videoModels` /
       * `config.videoModel`），由容器透传进来。**这里不留一份写死的清单**：
       * 两边各存一份必然漂移，而漂移的症状是「设置页能选、生成时报模型不认识」。
       */
      var videoModels = Array.isArray(props.videoModels) ? props.videoModels : [];
      /** 当前选的视频模型：空串＝跟随设置页默认值。 */
      var videoModelPair = react.useState("");
      var videoModel = videoModelPair[0];
      var setVideoModel = videoModelPair[1];
      /** 生视频时长（秒）。 */
      var videoDurationPair = react.useState(5);
      var videoDuration = videoDurationPair[0];
      var setVideoDuration = videoDurationPair[1];
      var editorPair = react.useState(null);
      var editor = editorPair[0];
      var setEditor = editorPair[1];
      /** 参考图（图生图通道）：`{id, previewUrl}`。 */
      var refsPair = react.useState([]);
      var references = refsPair[0];
      var setReferences = refsPair[1];
      /**
       * 正在从灵感库取参考图。
       *
       * 取图是异步的，期间既没有图也没有生成在跑，界面必须显式说明「在
       * 载入」，否则用户会以为点了没反应。取到图才启动生成（见下面那个
       * 接收 initialPrompt 的 effect）。
       */
      var refLoadingPair = react.useState(false);
      var referenceLoading = refLoadingPair[0];
      var setReferenceLoading = refLoadingPair[1];
      var draggingPair = react.useState(false);
      var dragging = draggingPair[0];
      var setDragging = draggingPair[1];
      var railPair = react.useState("recent");
      var railTab = railPair[0];
      var setRailTab = railPair[1];
      /** 已收藏的提示词列表（最新在前）。 */
      var promptFavsPair = react.useState([]);
      var promptFavs = promptFavsPair[0];
      var setPromptFavs = promptFavsPair[1];
      /** 提示词是否已收藏，要按 trim 后的文本比对（存储层也是这么归一化的）。 */
      var promptTrimmed = String(prompt || "").trim();
      /*
       * 每次渲染重建一次 Set。不用 useMemo：收藏提示词是几十条量级的纯文本，
       * 构造代价远小于多一层缓存失效的风险，而且能少依赖一个 react 方法。
       */
      var promptFavIds = new Set();
      promptFavs.forEach(function (item) {
        if (item && typeof item.id === "string") promptFavIds.add(item.id);
      });
      var sidebarCollapsedPair = react.useState(false);
      var sidebarCollapsed = sidebarCollapsedPair[0];
      var setSidebarCollapsed = sidebarCollapsedPair[1];
      var generateCollapsedPair = react.useState(false);
      var generateCollapsed = generateCollapsedPair[0];
      var setGenerateCollapsed = generateCollapsedPair[1];
      /** 左栏数据：`{status, items}`。 */
      var railItemsPair = react.useState({ status: "idle", items: [] });
      var railItems = railItemsPair[0];
      var setRailItems = railItemsPair[1];
      var visiblePair = react.useState(30);
      var visibleLimit = visiblePair[0];
      var setVisibleLimit = visiblePair[1];
      var pendingPair = react.useState(null);
      var pending = pendingPair[0];
      var setPending = pendingPair[1];
      var noticePair = react.useState("");
      var notice = noticePair[0];
      var setNotice = noticePair[1];
      /** 递增的重试信号：失败后点「重试」重新走一次 require.async。 */
      var retryPair = react.useState(0);
      var retryToken = retryPair[0];
      var setRetryToken = retryPair[1];
      /** 「生成中」：目前唯一真实来源是容器送来的 initialPrompt（准备中）。 */
      var generatingPair = react.useState(false);
      var isGenerating = generatingPair[0];
      var setGenerating = generatingPair[1];
      var elapsedPair = react.useState(0);
      var elapsedMs = elapsedPair[0];
      var setElapsedMs = elapsedPair[1];
      var generationStartRef = react.useRef(0);
      var generationTimerRef = react.useRef(null);
      var fileInputRef = react.useRef(null);
      /** 画布上的结果随 store 变化，用一个 tick 触发重渲染。 */
      var tickPair = react.useState(0);
      var tick = tickPair[0];
      var setTick = tickPair[1];
      /** 画布缩放百分比：由 camera（scope:session）变化驱动，见下方订阅。 */
      var zoomPair = react.useState(null);
      var zoomPercent = zoomPair[0];
      var setZoomPercent = zoomPair[1];

      var tldraw = useTldrawChunk(retryToken);
      var galleryTick = typeof shared.useGalleryTick === "function" ? shared.useGalleryTick() : 0;

      var spec = toolSpec(tool);
      var gallery = shared.gallery;

      /* 左栏数据：挂载时拉一次，画廊变动（保存/删除/收藏）后重拉。 */
      react.useEffect(function () {
        if (gallery === undefined || typeof gallery.getGalleryItems !== "function") {
          setRailItems({ status: "error", items: [] });
          return;
        }
        var alive = true;
        setRailItems(function (previous) {
          return { status: previous.items.length > 0 ? "ready" : "loading", items: previous.items };
        });
        Promise.resolve(gallery.getGalleryItems()).then(function (items) {
          if (!alive) return;
          var list = Array.isArray(items) ? items.slice() : [];
          /*
           * 视频不进工作台。这里**过滤掉**而不是靠 UI 隐藏：
           * 工作台的「最近生成」是拿来当参考图（图生图）与提示词来源的，
           * 视频既不能当参考图上传给豆包（`mode=edit` 只收图片），
           * 它的 prompt 也拼了 `VIDEO_PROMPT_SUFFIX`，拿去再生成会跑偏。
           * 留在列表里只会让用户点了没反应。
           *
           * `isVideoItem` 缺失时（旧主 bundle 缓存）退化成不过滤，
           * 行为与改前一致，不会因此白屏。
           */
          if (typeof gallery.isVideoItem === "function") {
            list = list.filter(function (item) { return gallery.isVideoItem(item) !== true; });
          }
          list.sort(function (a, b) {
            return (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0);
          });
          setRailItems({ status: "ready", items: list });
        }, function () {
          if (!alive) return;
          setRailItems({ status: "error", items: [] });
        });
        return function () { alive = false; };
      }, [galleryTick, gallery]);

      /**
       * 收藏提示词。与左栏图片是两套数据，各拉各的。
       *
       * `promptFavs` 是当前已收藏的提示词列表（最新的在前），`promptFavIds`
       * 是它的 id 集合——渲染「☆ 收藏 / ★ 已收藏」要看当前提示词在不在里面，
       * 用 Set 比每次线性扫数组清楚。
       */
      react.useEffect(function () {
        if (gallery === undefined || typeof gallery.getFavoritePrompts !== "function") {
          setPromptFavs([]);
          return;
        }
        var alive = true;
        Promise.resolve(gallery.getFavoritePrompts()).then(function (items) {
          if (!alive) return;
          setPromptFavs(Array.isArray(items) ? items.slice() : []);
        }, function () {
          if (!alive) return;
          setPromptFavs([]);
        });
        return function () { alive = false; };
      }, [galleryTick, gallery]);

      /** 收藏 / 取消收藏当前提示词。空提示词不动作（按钮那边也会禁用）。 */
      var togglePromptFavorite = react.useCallback(function () {
        var text = String(prompt || "").trim();
        if (text === "") return;
        togglePromptFavoriteText(text);
      }, [prompt, gallery, t]);

      /**
       * 按**指定文本**切换收藏。
       *
       * 与上面那个分开：一个是「收藏我现在输入的」，一个是「取消收藏列表里
       * 某一行」。合成一个就得靠调用方先改 state 再触发，会有时序问题。
       */
      var togglePromptFavoriteText = react.useCallback(function (text) {
        var target = String(text || "").trim();
        if (target === "") return;
        if (gallery === undefined || typeof gallery.toggleFavoritePrompt !== "function") {
          setNotice(t("promptFavUnavailable"));
          return;
        }
        Promise.resolve(gallery.toggleFavoritePrompt(target)).then(function () {
          shared.gallery.notify();
        }, function () {
          setNotice(t("promptFavFailed"));
        });
      }, [gallery, t]);

      /**
       * 结束「生成中」：把真实耗时记进 state，再关掉状态机。
       *
       * 耗时必须是实测的，不能编——轨道动画停下来那一刻的 `Date.now()`
       * 减去开始时刻就是它。
       */
      var finishGeneration = react.useCallback(function () {
        if (generationTimerRef.current !== null) {
          clearTimeout(generationTimerRef.current);
          generationTimerRef.current = null;
        }
        if (generationStartRef.current > 0) {
          setElapsedMs(Date.now() - generationStartRef.current);
        }
        generationStartRef.current = 0;
        setGenerating(false);
      }, []);

      /**
       * 启动「生成中」。
       *
       * `autoFinishMs` 决定这层状态**要不要自己收尾**：
       *
       * - 传了毫秒（默认 `ORBIT_MIN_MS`）：用于**没有真生成接口**的场景
       *   （「灵感库 → 用它生图」、以及容器没给 `onGenerate` 时退化成
       *   「复制指令」）。这类场景没有 promise 可等，只能放一段短动画免得
       *   状态卡死。
       * - 传 `0`：**有真接口**时用。此时结束时刻由 `onGenerate` 的 promise
       *   决定，绝不能自带定时器——真实生成要几十秒，而 `ORBIT_MIN_MS`
       *   只有 0.9 秒，定时器会先把「生成中」收掉，此后直到图回来为止
       *   界面完全静默（用户实测：「没有等待中之类的提示，图片突然就
       *   出现」）。
       */
      var startGeneration = react.useCallback(function (autoFinishMs) {
        if (generationTimerRef.current !== null) clearTimeout(generationTimerRef.current);
        generationTimerRef.current = null;
        generationStartRef.current = Date.now();
        setGenerating(true);
        var waitMs = autoFinishMs === undefined ? ORBIT_MIN_MS : autoFinishMs;
        if (waitMs > 0) {
          generationTimerRef.current = setTimeout(function () {
            generationTimerRef.current = null;
            finishGeneration();
          }, waitMs);
        }
      }, [finishGeneration]);

      /* 卸载时别把定时器留在身后。 */
      react.useEffect(function () {
        return function () {
          if (generationTimerRef.current !== null) {
            clearTimeout(generationTimerRef.current);
            generationTimerRef.current = null;
          }
        };
      }, []);

      /*
       * 容器带来的灵感库草稿：后续变化也要跟上，所以依赖整个 initialPrompt。
       *
       * 两种形态：
       *   1. `{prompt, item}`                     → 只填提示词，立刻生成
       *   2. `{prompt, item, mode:"ref", sourceId, image}` → 还要先把案例
       *      效果图取回来当参考图，**等图到位再生成**——否则图生图会在
       *      参考图为空时启动，白白消耗一次额度还出一张错的图。
       */
      react.useEffect(function () {
        var incoming = props.initialPrompt;
        if (incoming === undefined || incoming === null) return;
        if (typeof incoming.prompt !== "string") return;

        var wantsReference = incoming.mode === "ref"
          && typeof incoming.sourceId === "string" && incoming.sourceId !== ""
          && typeof incoming.image === "string" && incoming.image !== "";

        setPrompt(incoming.prompt);

        if (!wantsReference) {
          startGeneration();
          return;
        }

        var cancelled = false;
        setReferenceLoading(true);
        loadInspirationReference(incoming.sourceId, incoming.image).then(function (file) {
          if (cancelled) return;
          setReferenceLoading(false);
          if (file === null) {
            // 取图失败不阻断：提示词已经在输入框里，用户可以自己补图。
            setNotice(t("referenceLoadFailed"));
            return;
          }
          setReferences(function (previous) {
            return previous.concat([{
              id: "ref-inspiration-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
              previewUrl: URL.createObjectURL(file),
              file: file,
            }]);
          });
          setMode("edit");
          startGeneration();
        });

        return function () {
          cancelled = true;
        };
      }, [props.initialPrompt, startGeneration]);

      /* 自报标记：浏览器里拿不到槽表，靠这个确认 chunk 真的挂上了。 */
      react.useEffect(function () {
        if (typeof globalThis === "undefined") return;
        var marker = {
          ok: true,
          // 版本戳：用来确认浏览器加载的**不是**被缓存的旧 chunk。
          // 排查「改了 profile 文件却仍然复现旧 bug」时，第一件事就是看它。
          build: STUDIO_BUILD,
          tldrawLoaded: tldraw.status === "ready",
          sanitizeSnapshot: typeof sanitizeSnapshot === "function",
          canvasImageUrl: typeof canvasImageUrl === "function",
        };
        if (tldraw.status === "error") marker.error = tldraw.error;
        globalThis.__dshStudioChunkMounted = marker;
      }, [tldraw.status, tldraw.error]);

      /* tldraw 自带样式（1.78 MB chunk 里的 CSS 文本），成功后才注入。 */
      react.useEffect(function () {
        if (tldraw.status !== "ready") return;
        var css = tldraw.mod && tldraw.mod.TL_CSS;
        if (typeof css === "string" && css.length > 0) shared.injectCss(TL_CSS_TAG, css);
      }, [tldraw.status, tldraw.mod]);

      /**
       * tldraw 挂载完成：先恢复快照，再注册自动保存。
       *
       * 顺序不能反——先注册保存会把「空画布」写回去，覆盖用户上次的内容。
       */
      var onMount = react.useCallback(function (mounted) {
        setEditor(mounted);
        var mod = tldraw.mod;
        try {
          if (typeof mounted.updateInstanceState === "function") mounted.updateInstanceState({ isGridMode: true });
        } catch (error) { /* 非致命 */ }
        var snapshot = readSnapshot();
        if (snapshot !== null && mod && typeof mod.loadSnapshot === "function") {
          try {
            // **必须先修快照再灌**。tldraw 在 `loadSnapshot` 内部就会对每条记录
            // 跑 schema 校验，历史快照里存着 `blob:` 的 asset src 会在那一刻抛
            // `ValidationError`（栈里是 io → Eu.atomic → Eu.put），整个画布被推进
            // 错误边界。等灌完再修（restoreImageSources）已经晚了。
            mod.loadSnapshot(mounted.store, sanitizeSnapshot(snapshot));
          } catch (error) { /* schema 不匹配：从空白画布开始，不阻断 */ }
        }
        var alive = true;
        restoreImageSources(mounted, function () { return alive; })
          .catch(function () { return 0; })
          .then(function () { if (alive) setTick(function (value) { return value + 1; }); });
        var timer = null;
        var save = function () {
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            try {
              localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(mod.getSnapshot(mounted.store)));
            } catch (error) { /* 禁用 / 超配额：静默降级为不持久化 */ }
            // 画布内容变了：结果条 / 画布簇 / 空态都要跟着变。
            setTick(function (value) { return value + 1; });
          }, SAVE_DEBOUNCE_MS);
        };
        var stop = null;
        try {
          stop = mounted.store.listen(save, { scope: "document" });
        } catch (error) {
          stop = null;
        }
        return function () {
          alive = false;
          if (timer !== null) clearTimeout(timer);
          if (typeof stop === "function") stop();
          try {
            localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(mod.getSnapshot(mounted.store)));
          } catch (error) { /* 同上 */ }
        };
      }, [tldraw.mod, retryToken]);

      /**
       * 工具条的缩放读数：camera 记录在 tldraw 里是 `scope:"session"`
       * （chunk 内 `Un("camera",{...scope:"session"})`），所以按 session 订阅
       * 才能拿到缩放/平移变化。`scope:"document"` 的订阅读不到它。
       *
       * 订阅不可用时退回「挂载后读一次」，读数会停在初始值——宁可数字旧，
       * 也不能让工具条把工作台带崩。
       */
      react.useEffect(function () {
        if (editor === null) { setZoomPercent(null); return; }
        setZoomPercent(editorZoomPercent(editor));
        var store = editor.store;
        if (store === undefined || store === null || typeof store.listen !== "function") return;
        var stop = null;
        try {
          stop = store.listen(function () {
            setZoomPercent(editorZoomPercent(editor));
          }, { scope: "session" });
        } catch (error) {
          stop = null;
        }
        return function () { if (typeof stop === "function") stop(); };
      }, [editor]);

      var onLanded = react.useCallback(function (item, url) {
        if (editor === null) { setPending(null); return; }
        /**
         * 落图必须自己兜住异常。
         *
         * `createAssets` / `createShape` 跑在 tldraw 的 atomic 事务里，任何
         * 抛错都会回滚整个事务并把画布推进错误边界（实测：`blob:` 触发的
         * `ValidationError` 直接把画布崩成「Something went wrong」）。落一张
         * 图失败不该赔上整块画布，所以这里降级成一条通知。
         */
        try {
          landGalleryItem(editor, item, url);
        } catch (error) {
          setNotice(t("landFailed"));
          setPending(null);
          return;
        }
        setPending(null);
        setTick(function (value) { return value + 1; });
      }, [editor, lang]);

      /** 统一的服务员：3 秒后自动消失的通知。 */
      var flash = react.useCallback(function (message) {
        setNotice(message);
      }, []);

      /* ── 生成面板动作 ─────────────────────────────────────────────── */

      /** 指令文本：模式与通道不同，参数面不同，指令就得跟着不同。 */
      var instructionText = function () {
        if (mode === "edit") {
          return translate(lang, "instructionEditTemplate", { prompt: prompt, tool: toolLabel(lang, tool) });
        }
        if (mode === "video") {
          return translate(lang, "instructionVideoTemplate", {
            prompt: prompt,
            tool: toolLabel(lang, tool),
            duration: String(videoDuration),
            refs: String(references.length),
          });
        }
        if (!spec.supportsRatio) {
          return translate(lang, "instructionGptTemplate", { prompt: prompt, tool: toolLabel(lang, tool) });
        }
        return translate(lang, "instructionTemplate", {
          prompt: prompt, ratio: normalizeRatio(generateRatio), count: String(count), tool: toolLabel(lang, tool),
        });
      };

      var onGenerate = function () {
        var text = prompt.trim();
        if (text.length === 0) {
          setNotice(t("needPrompt"));
          return;
        }
        if (mode === "edit" && references.length === 0) {
          setNotice(t("needReference"));
          return;
        }
        /*
         * 视频**不再拦「必须有参考图」**：同一个「生视频」按钮承载两种意图，
         * 有参考图走图生视频、没有就走文生视频（用户 2026-10-25 的明确要求）。
         * 拦截留在这里的后果是「想文生视频却被要求传图」，而那正是要消灭的分支。
         */
        setNotice("");
        var outgoing = text;
        /*
         * 豆包通道：把张数翻译进 prompt；比例、模式和参考图独立传给容器。
         *
         * **必须无条件注入，包括 1 张**。豆包请求体里没有任何张数字段
         * （`lib/doubao-upstream.mjs` 的 `imageRequestBody` 只有 messages /
         * completion_option / evaluate_option），张数完全由服务端读提示词
         * 自行决定。早先写成 `count > 1` 才注入，选「1」时等于什么都没说，
         * 实测被出了 4 张——控件选中 1 却出 4 张，用户会当成 bug。
         *
         * 视频没有张数概念（一次一个），所以视频模式既不注入也不显示该控件。
         */
        if (spec.supportsCount && mode !== "video") {
          outgoing = text + "\n\n" + (lang === "en"
            ? (count === 1 ? "Generate 1 image." : "Generate " + count + " images.")
            : "请生成 " + count + " 张图片。");
        }
        if (typeof props.onGenerate === "function") {
          // 容器给了真接口：进入「生成中」，**不设自动收尾**（传 0），
          // 结束时刻完全由 onGenerate 的 promise 决定——真实生成要几十秒，
          // 自带短定时器会让等待期静默。
          startGeneration(0);
          var outcome;
          try {
            /*
             * 比例透传规则：不支持比例的 GPT 一律空串；豆包文生图传所选四档，
             * 图生图传所选八档（auto＝按参考图，由网页端自行取景）。
             * 视频**不传**：服务端两种视频都不接受面板比例（图生视频跟随
             * 参考图、文生视频按 auto 取景），传一个用户没得选的值没有意义。
             */
            var outgoingRatio = mode === "video" ? ""
              : !spec.supportsRatio ? ""
              : mode === "edit" ? normalizeEditRatio(editRatio)
              : normalizeRatio(generateRatio);
            // 这个 bundle 保持 ES5 语法（不依赖构建期降级），所以不用展开运算符。
            var generateOptions = {
              mode: mode,
              /*
               * 参考图对视频是**可选**输入：有就带（图生视频），没有就空数组
               * （文生视频）。`edit` 分支仍然先过上面的「必须有图」守卫。
               */
              references: (mode === "edit" || mode === "video")
                ? references.map(function (reference) { return reference.file; })
                : [],
            };
            /*
             * 模型分两套，**不能混**：
             *   - 生图：`DOUBAO_MODELS` 里的图片模型显示名（`Seedream 5.0 Flash`）；
             *   - 生视频：设置页那份视频模型标识（`seedance_v2.0_mini` /
             *     `seedance_2.0_pc`），由 `props.videoModels` 透传。
             * 2026-10-24 实测：把图片模型名漏进视频请求，服务端 200 但不出片，
             * 且没有任何报错——所以两者必须走不同分支。
             */
            if (mode === "video") {
              if (typeof videoModel === "string" && videoModel !== "") generateOptions.model = videoModel;
            } else if (spec.supportsRatio) {
              generateOptions.model = model;
            }
            // 时长只对视频有意义，其它模式不传，免得 Host 误判成视频请求。
            if (mode === "video") generateOptions.duration = videoDuration;
            outcome = props.onGenerate(outgoing, outgoingRatio, tool, generateOptions);
          } catch (error) {
            finishGeneration();
            flash(error && error.message ? error.message : String(error));
            return;
          }
          if (outcome !== null && outcome !== undefined && typeof outcome.then === "function") {
            Promise.resolve(outcome).then(function (result) {
              finishGeneration();
              if (result && result.ok === false) flash(result.reason || "generate-failed");
            }, function (error) {
              finishGeneration();
              flash(error && error.message ? error.message : String(error));
            });
          } else {
            /*
             * 返回的不是 promise：没有可等的结束信号。此时**退回最短展示
             * 时长**收尾，否则「生成中」会永远卡住（传 0 意味着不自带
             * 定时器，必须在这里补回来）。
             */
            startGeneration(ORBIT_MIN_MS);
          }
          return;
        }
        // 容器没给 onGenerate（当前 `client.gallery.js:882-889` 就是这样）：
        // 退化成一次真实的「把这条指令复制走」。
        startGeneration();
        copyText(instructionText()).then(function () {
          finishGeneration();
          flash(t("copied"));
        }, function () {
          finishGeneration();
          flash(t("copyFailed"));
        });
      };

      var copyText = function (text) {
        try {
          var clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
          if (clipboard === undefined || typeof clipboard.writeText !== "function") {
            return Promise.reject(new Error("clipboard-unsupported"));
          }
          return Promise.resolve(clipboard.writeText(text));
        } catch (error) {
          return Promise.reject(error);
        }
      };

      /* ── 参考图（图生图） ─────────────────────────────────────────── */

      var addReferenceFiles = function (fileList) {
        if (fileList === undefined || fileList === null) return;
        var files = Array.prototype.slice.call(fileList);
        if (files.length === 0) return;
        var accepted = [];
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (file === null || file === undefined) continue;
          var type = String(file.type || "");
          if (type.indexOf("image/") !== 0) continue;
          accepted.push({
            id: "ref-" + Date.now() + "-" + i + "-" + Math.random().toString(36).slice(2, 8),
            previewUrl: URL.createObjectURL(file),
            file: file,
          });
        }
        if (accepted.length === 0) return;
        setReferences(function (previous) { return previous.concat(accepted); });
      };

      var removeReference = function (id) {
        setReferences(function (previous) {
          var out = [];
          for (var i = 0; i < previous.length; i++) {
            if (previous[i].id === id) {
              URL.revokeObjectURL(previous[i].previewUrl);
              continue;
            }
            out.push(previous[i]);
          }
          return out;
        });
      };

      var clearReferences = function () {
        setReferences(function (previous) {
          for (var i = 0; i < previous.length; i++) URL.revokeObjectURL(previous[i].previewUrl);
          return [];
        });
      };

      /* ── 左栏动作 ─────────────────────────────────────────────────── */

      var pickRecent = function (item) {
        if (editor === null) {
          // 画布还没就绪：先记下来，等 onMount 后再落图会丢上下文，所以只提示。
          setNotice(t("canvasLoading"));
          return;
        }
        setPending(item);
      };

      var toggleFavorite = function (item) {
        if (gallery === undefined || typeof gallery.toggleFavoriteGalleryItem !== "function") return;
        Promise.resolve(gallery.toggleFavoriteGalleryItem(item.id)).then(function () {
          setTick(function (value) { return value + 1; });
        }, function () { /* 静默：下一次 tick 会把它纠正回来 */ });
      };

      /* ── 结果操作条动作 ───────────────────────────────────────────── */

      var result = resultOf(editor);

      var onCopyImage = function () {
        if (result === null) return;
        copyImageToClipboard(result).then(function () {
          flash(t("copyImageOk"));
        }, function () {
          flash(t("copyImageFailed"));
        });
      };

      var onDownload = function () {
        if (result === null) {
          flash(t("downloadEmpty"));
          return;
        }
        fetchAttachmentBlob(result.attachment).then(function (blob) {
          downloadBlob(blob, safeIdPart(result.id) + ".png");
        }, function () {
          flash(t("downloadEmpty"));
        });
      };

      var onSaveGallery = function () {
        if (result === null) return;
        saveAttachmentToGallery(result, wsFields).then(function () {
          flash(t("saveToGalleryOk"));
          setTick(function (value) { return value + 1; });
        }, function () {
          flash(t("saveToGalleryFailed"));
        });
      };

      var onSendToChat = function () {
        var text = prompt.trim() !== "" ? prompt.trim() : (result !== null ? result.prompt : "");
        if (text === "") {
          flash(t("needPrompt"));
          return;
        }
        copyText(text).then(function () {
          flash(t("copied"));
        }, function () {
          flash(t("copyFailed"));
        });
      };

      var onRegenerate = function () {
        if (result === null) return;
        if (result.prompt !== "") setPrompt(result.prompt);
        setMode("generate");
        flash(t("copied"));
      };

      var onClear = function () {
        if (editor === null) return;
        var confirmed = true;
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          confirmed = window.confirm(t("clearConfirm"));
        }
        if (!confirmed) return;
        clearCanvas(editor);
        setNotice(t("canvasCleared"));
        setTick(function (value) { return value + 1; });
      };

      var onExport = function () {
        if (editor === null) return;
        exportCanvasPng(editor).then(function () {
          setNotice(t("exported"));
        }, function (error) {
          var message = String((error && error.message) || error);
          if (message === "empty-canvas") setNotice(t("exportEmpty"));
          else if (message === "svg-unsupported") setNotice(t("exportUnsupported"));
          else setNotice(t("exportFailed") + ": " + message);
        });
      };

      var onCopyInstruction = function () {
        copyText(instructionText()).then(function () {
          flash(t("copied"));
        }, function () {
          flash(t("copyFailed"));
        });
      };

      /* ── 画布区：三态，失败不白屏 ─────────────────────────────────── */

      var canvas;
      if (tldraw.status === "loading") {
        canvas = h("div", { className: "__dbi_s_canvasLoading", role: "status" }, t("canvasLoading"));
      } else if (tldraw.status === "error") {
        canvas = h("div", { className: "__dbi_s_canvasError", role: "alert" },
          h("div", { className: "__dbi_s_canvasErrorTitle" }, t("canvasLoadFailed")),
          h("div", { className: "__dbi_s_canvasErrorReason" }, tldraw.error),
          h("button", {
            type: "button",
            className: "__dbi_s_btn",
            onClick: function () { setRetryToken(retryToken + 1); },
          }, t("canvasRetry"))
        );
      } else {
        canvas = h(tldraw.mod.Tldraw, { onMount: onMount });
      }

      /* ── 中栏覆盖层：生成中 / 空态 ─────────────────────────────────── */

      var batch = batchOf(editor);
      var overlay = null;
      if (isGenerating) {
        overlay = h("div", { className: "__dbi_s_generatingState", role: "status" },
          h("div", { className: "__dbi_s_generationOrbit" }, "✦"),
          h("strong", null, count > 1 && spec.supportsCount
            ? t("generatingCount", { count: String(count) })
            : t("generating")),
          h("span", null, t("generatingHint", {
            model: toolLabel(lang, tool),
            ratio: spec.supportsRatio
              ? (mode === "edit" ? normalizeEditRatio(editRatio) : normalizeRatio(generateRatio))
              : "—",
          }))
        );
      } else if (batch.length > 0) {
        // 画布簇：2 张两列、3–4 张两列（用 data-count 切换栅格，CSS 侧管）。
        overlay = h("div", {
          className: "__dbi_s_canvasCluster",
          "data-count": String(Math.min(batch.length, 4)),
        }, batch.map(function (item, index) {
          return h("div", { key: item.id, className: "__dbi_s_canvasItem" },
            h("span", { className: "__dbi_s_canvasBadge" }, "#" + (index + 1)),
            h("span", { className: "__dbi_s_canvasCheck", "aria-hidden": "true" }),
            h("span", { className: "__dbi_s_canvasChip" }, item.model !== "" ? item.model : item.id)
          );
        }));
      } else if (tldraw.status === "ready" && !sidebarCollapsed) {
        /*
         * 空白态：图标 + 引导文案两行式，对齐官方 `.dsh-ig-canvas-empty`
         * （`dsh-image-gen/lib/client.js:118473-118475`，那里是 ImagePlus 图标
         * 加 `t("selectHistory")`）。
         *
         * 我们没法引官方的 lucide 图标组件，用同构的内联 SVG 画一个
         * 「方框 + 加号」——语义一致，且不引入图标依赖。
         */
        overlay = h("div", { className: "__dbi_s_canvasEmpty" },
          h("svg", {
            className: "__dbi_s_canvasEmptyIcon",
            width: 36, height: 36, viewBox: "0 0 24 24", fill: "none",
            stroke: "currentColor", strokeWidth: 1.6,
            strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
          },
            h("rect", { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }),
            h("circle", { cx: 8.8, cy: 8.8, r: 1.4 }),
            h("path", { d: "M21 15.5l-4.6-4.6L7 20.4" }),
            h("path", { d: "M17.5 3.2v5.6M14.7 6h5.6" })
          ),
          h("span", null, t("canvasEmpty"))
        );
      }

      /* ── 画布工具条 ───────────────────────────────────────────────── */

      /*
       * 与官方 `.dsh-ig-canvas-toolbar` 同构：高 46px 的 `1fr auto 1fr` 三区
       * 栅格（左＝面板展开入口，中＝缩放控制，右＝画布动作）。
       * 官方实现见 `dsh-image-gen/lib/client.js:118282-118421`。
       *
       * 中间的缩放读数来自 `zoomPercent`（订阅 `editor.store` 的 session
       * scope 变化），所以拖动画布时数字会跟着走，不是挂载时的一次性快照。
       */
      /*
       * 按钮可用的判据必须**跟着实际要调的方法**走，不能只看 `editor !== null`：
       * 取值读数用 `getZoomLevel`，步进用 `zoomIn`/`zoomOut`，适应用 `zoomToFit`。
       * 缺哪个就禁哪个——禁用优于点了没反应，也优于抛错把工作台带崩。
       */
      var canReadZoom = editor !== null && typeof editor.getZoomLevel === "function";
      var canStepZoom = editor !== null && (typeof editor.zoomIn === "function" || typeof editor.zoomOut === "function");
      var canFitZoom = editor !== null && typeof editor.zoomToFit === "function";
      /*
       * 步进/适应之后必须**主动**刷新读数：`zoomPercent` 的订阅只在 store
       * 变化时更新，而测试桩（以及某些 tldraw 版本）的 `zoomIn` 不经过 store。
       * 只靠 `setTick` 重渲染不会让 `zoomPercent` 这个 state 变。
       */
      var syncZoom = function () {
        setZoomPercent(editorZoomPercent(editor));
        setTick(function (v) { return v + 1; });
      };
      var zoomText = zoomPercent === null ? "—" : (zoomPercent + "%");
      var canvasToolbar = h("div", { className: "__dbi_s_canvasToolbar", role: "toolbar" },
        h("div", { className: "__dbi_s_canvasToolbarLeft" },
          sidebarCollapsed ? h("button", {
            type: "button",
            title: t("expandSidebar"),
            onClick: function () { setSidebarCollapsed(false); },
          }, t("recent"))
            : null
        ),
        h("div", { className: "__dbi_s_canvasToolbarCenter" },
          h("button", {
            type: "button",
            title: t("zoomOut"),
            disabled: !canStepZoom,
            onClick: function () { if (zoomByStep(editor, -1)) syncZoom(); },
          }, "−"),
          h("span", { className: "__dbi_s_zoomDisplay" }, zoomText),
          h("button", {
            type: "button",
            title: t("zoomIn"),
            disabled: !canStepZoom,
            onClick: function () { if (zoomByStep(editor, 1)) syncZoom(); },
          }, "+"),
          h("span", { className: "__dbi_s_toolbarDivider", "aria-hidden": "true" }),
          h("button", {
            type: "button",
            title: t("zoomFit"),
            disabled: !canFitZoom,
            onClick: function () { if (zoomToFitCanvas(editor)) syncZoom(); },
          }, t("zoomFit"))
        ),
        h("div", { className: "__dbi_s_canvasToolbarRight" },
          /*
           * 复用结果区那个 `onClear`（1612 行）：它已经带了 `clearConfirm`
           * 二次确认 + `canvasCleared` 反馈。工具条上另起一套会漏掉反馈，
           * 而且两处的行为会随时间漂移。
           */
          h("button", {
            type: "button",
            title: t("clearCanvas"),
            disabled: editor === null,
            onClick: onClear,
          }, t("clearCanvas"))
        )
      );

      /* ── 左栏 ─────────────────────────────────────────────────────── */

      var recentItems = railItems.items;
      /*
       * 只算「最近」要显示的那一页。
       *
       * 收藏页**不走这里**：它由下面的 `favImageItems` + `favImageBlock` 独立渲染
       * （两块内容形态完全不同——最近是方格缩略图，收藏是两个区块）。所以这里
       * 不要再算一份 `favoriteItems`：那曾经是一份**永远不生效的重复判据**，
       * 改了它不会产生任何行为差异（变异测试实测：把它的 filter 去掉，
       * 整个套件零反应，因为 `railBody` 只在 `railTab === "recent"` 时渲染）。
       *
       * 同一个判据只留一处，否则下次改收藏逻辑的人会改错地方。
       */
      var displayItems = recentItems.slice(0, visibleLimit);

      var railBody;
      if (railItems.status === "error") {
        railBody = h("div", { className: "__dbi_s_recentEmpty" }, t("recentFailed"));
      } else if (railItems.status === "loading" && recentItems.length === 0) {
        railBody = h("div", { className: "__dbi_s_recentEmpty" }, t("recentLoading"));
      } else if (displayItems.length === 0) {
        /*
         * `railBody` 只在「最近」页渲染（见下方 `railTab === "recent"` 的三元），
         * 所以这里恒为 recent 的空态，不再按 tab 二选一。
         * 收藏页的空态由 `favEmptyBox` 各自承担（图片区块 / 提示词区块各一个）。
         */
        railBody = h("div", { className: "__dbi_s_recentEmpty" }, t("recentEmpty"));
      } else {
        railBody = displayItems.map(function (item, index) {
          return h(RecentItem, {
            key: String(item && item.id !== undefined ? item.id : index),
            item: item,
            active: pending !== null && pending.id === item.id,
            onPick: function (picked) {
              if (railTab === "favorites") toggleFavorite(picked);
              else pickRecent(picked);
            },
          });
        });
      }

      /*
       * 收藏子视图的左栏：两个区块（收藏的图片 / 收藏提示词）。
       *
       * 布局要点（上一版在这里出过错，记下来）：不能把两个区块平放在一个
       * 纵向滚动容器里靠内容自然高度分配——图片用 `flex:1 1 0;height:0` 自己
       * 撑高度，在自然高度的父容器里会塌成一行且溢出（用户实测「收藏的图片
       * 被挤压」）。正确结构是：
       *   - 图片区块 `flex:1 1 auto`，自己吃满剩余空间、自己滚；
       *   - 提示词区块 `flex:0 1 auto`，**不抢**图片的空间，超过上限时自己滚。
       */
      var favImageItems = recentItems.filter(function (item) { return item && item.isFavorite === true; });

      var favImageBlock = h("div", { className: "__dbi_s_favBlock __dbi_s_favBlockGrow" },
        h("div", { className: "__dbi_s_favBlockTitle" },
          h("span", null, t("favImages")),
          h("span", { className: "__dbi_s_favBlockCount" }, String(favImageItems.length))
        ),
        favImageItems.length === 0
          ? h("div", { className: "__dbi_s_favEmptyBox" },
            h("span", { className: "__dbi_s_favEmptyIcon", "aria-hidden": "true" }, "♡"),
            h("span", null, t("favImageEmpty")))
          : h("div", { className: "__dbi_s_favGrid" }, favImageItems.map(function (item, index) {
            return h(RecentItem, {
              key: String(item && item.id !== undefined ? item.id : index),
              item: item,
              active: pending !== null && pending.id === item.id,
              onPick: function (picked) { toggleFavorite(picked); },
            });
          }))
      );

      var favPromptBlock = h("div", { className: "__dbi_s_favBlock __dbi_s_favBlockPrompt" },
        h("div", { className: "__dbi_s_favBlockTitle" },
          h("span", null, t("favPromptTitle")),
          h("span", { className: "__dbi_s_favBlockCount" }, String(promptFavs.length))
        ),
        promptFavs.length === 0
          ? h("div", { className: "__dbi_s_favEmptyBox" },
            h("span", { className: "__dbi_s_favEmptyIcon", "aria-hidden": "true" }, "☆"),
            h("span", null, t("favPromptEmpty")))
          : h("div", { className: "__dbi_s_favPromptList" }, promptFavs.map(function (item) {
            /*
             * 点一行＝把这段提示词填回提示词框（官方也是这个行为）；右侧的
             * 取消按钮单独走删除，两者不能共用一个 handler，否则点文本
             * 也会删掉收藏。
             */
            return h("div", { key: String(item.id), className: "__dbi_s_favPromptRow" },
              h("button", {
                type: "button",
                className: "__dbi_s_favPromptText",
                title: t("promptFavApply"),
                onClick: function () { setPrompt(String(item.text)); },
              }, String(item.text)),
              h("button", {
                type: "button",
                className: "__dbi_s_favPromptDel",
                title: t("promptFavDelete"),
                "aria-label": t("promptFavDelete"),
                onClick: function () { togglePromptFavoriteText(String(item.text)); },
              }, "×")
            );
          }))
      );

      var leftPanel = sidebarCollapsed ? null : h("aside", { className: "__dbi_s_recentPanel" },
        h("div", { className: "__dbi_s_panelTitle" },
          h("div", { className: "__dbi_s_panelTitleText" },
            h("span", null, railTab === "recent" ? t("recent") : t("railTabFavorites")),
            h("span", { className: "__dbi_s_countBadge" }, String(railTab === "recent" ? displayItems.length : favImageItems.length))
          ),
          h("button", {
            type: "button",
            className: "__dbi_s_collapseBtn",
            title: t("collapseSidebar"),
            "aria-label": t("collapseSidebar"),
            onClick: function () { setSidebarCollapsed(true); },
          }, "‹")
        ),
        h("div", { className: "__dbi_s_railTabs", role: "tablist" },
          h("button", {
            type: "button",
            role: "tab",
            "aria-selected": railTab === "recent",
            "data-rail-tab": "recent",
            className: "__dbi_s_railTab" + (railTab === "recent" ? " is-active" : ""),
            onClick: function () { setRailTab("recent"); },
          }, t("railTabRecent")),
          h("button", {
            type: "button",
            role: "tab",
            "aria-selected": railTab === "favorites",
            "data-rail-tab": "favorites",
            className: "__dbi_s_railTab" + (railTab === "favorites" ? " is-active" : ""),
            onClick: function () { setRailTab("favorites"); },
          }, t("railTabFavorites"))
        ),
        railTab === "recent"
          ? h("div", { className: "__dbi_s_recentScroll" }, railBody)
          : h("div", { className: "__dbi_s_favArea" }, favImageBlock, favPromptBlock),
        railTab === "recent" && recentItems.length > visibleLimit
          ? h("button", {
            type: "button",
            className: "__dbi_s_loadMore",
            onClick: function () { setVisibleLimit(visibleLimit + 30); },
          }, t("loadMore", { n: String(recentItems.length - visibleLimit) }))
          : null
      );

      /* ── 右栏：生成面板 ───────────────────────────────────────────── */

      /*
       * 参考图区：图生图必须有，生视频可选。
       *
       * 生视频下**常驻**是刻意的——它是「图生 / 文生」的唯一分流开关，藏起来
       * 用户就没法上传了。提示文案要说明「不传就是文生视频」，否则「可选」
       * 这件事在界面上看不出来。
       */
      var referencesField = (mode === "edit" || mode === "video") ? h("div", { className: "__dbi_s_field" },
        mode === "video" ? h("span", { className: "__dbi_s_hint" }, t("videoRefsHint")) : null,
        h("div", { className: "__dbi_s_fieldLabel" },
          h("label", { htmlFor: "__dbi_s_refs" }, t("referencesCount", {
            current: String(references.length),
            max: "4",
          })),
          references.length > 0 ? h("button", {
            type: "button",
            className: "__dbi_s_linkBtn",
            onClick: clearReferences,
          }, t("clearReferences")) : null
        ),
        references.length === 0 ? h("button", {
          type: "button",
          className: "__dbi_s_upload" + (dragging ? " is-dragging" : ""),
          onClick: function () { if (fileInputRef.current !== null) fileInputRef.current.click(); },
          onDragOver: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            setDragging(true);
          },
          onDragLeave: function () { setDragging(false); },
          onDrop: function (event) {
            if (event && typeof event.preventDefault === "function") event.preventDefault();
            setDragging(false);
            addReferenceFiles(event && event.dataTransfer ? event.dataTransfer.files : undefined);
          },
        },
          h("strong", null, t("upload")),
          h("small", null, t("uploadHint"))
        ) : h("div", { className: "__dbi_s_referenceGrid" },
          references.map(function (item) {
            return h(ReferenceCard, {
              key: item.id,
              item: item,
              removeLabel: t("closeReference"),
              onRemove: removeReference,
            });
          }),
          h("button", {
            type: "button",
            className: "__dbi_s_referenceAdd",
            title: t("upload"),
            onClick: function () { if (fileInputRef.current !== null) fileInputRef.current.click(); },
          }, "+")
        ),
        h("input", {
          id: "__dbi_s_refs",
          ref: fileInputRef,
          type: "file",
          multiple: true,
          accept: "image/png,image/jpeg,image/webp,image/gif",
          className: "__dbi_s_fileInput",
          onChange: function (event) {
            addReferenceFiles(event && event.target ? event.target.files : undefined);
            if (event && event.target) event.target.value = "";
          },
        })
      ) : null;

      /*
       * 提供商清单按模式收窄：视频只有豆包一条通道（GPT 免费账户不出视频）。
       *
       * 不用「禁用 GPT 选项」而是**根本不列**：禁用项会被理解成「再充点钱
       * 就能用」，而这个通道压根不存在。用户 2026-10-25 明确要求 GPT 不出现在
       * 生视频的提供商菜单里。
       */
      var providerOptions = mode === "video"
        ? TOOLS.filter(function (item) { return item.key === VIDEO_TOOL; })
        : TOOLS;
      /*
       * 手里拿着的 tool 可能不在当前模式的可选范围里（例如从「文生图+GPT」
       * 直接切到「生视频」）。这时不静默留着一个不存在的通道，而是渲染时
       * 就按视频通道显示；真正切换发生在下面的模式按钮 onClick 里。
       */
      var effectiveTool = mode === "video" ? VIDEO_TOOL : tool;

      var providerField = h("div", { className: "__dbi_s_fieldGrid" },
        h("label", { className: "__dbi_s_fieldSelect" },
          h("span", null, t("provider")),
          h("select", {
            className: "__dbi_s_select",
            value: effectiveTool,
            "aria-label": t("provider"),
            onChange: function (event) {
              var next = event.target.value;
              setTool(next);
              writeToolKey(next);
            },
          }, providerOptions.map(function (item) {
            return h("option", { key: item.key, value: item.key }, toolLabel(lang, item.key));
          }))
        ),
        h("label", { className: "__dbi_s_fieldSelect" },
          h("span", null, mode === "video" ? t("videoModelLabel") : t("model")),
          /*
           * 生视频的模型是另一套标识（`seedance_v2.0_mini` / `seedance_2.0_pc`），
           * 清单来自 Host 的 `/api/status`，与图片模型下拉不是同一个体系。
           * 视频下渲染真下拉（不再是禁用说明项）：两档要能选。
           */
          mode === "video"
            ? h("select", {
              className: "__dbi_s_select",
              value: videoModel,
              "aria-label": t("videoModelLabel"),
              onChange: function (event) { setVideoModel(event.target.value); },
            },
              /*
               * 空串＝跟随设置页默认档。这一项必须在：用户没主动选过时，
               * 界面要如实显示「按设置页」而不是硬塞一个模型名假装已选。
               */
              h("option", { key: "__default", value: "" }, t("videoModelFollowDefault")),
              videoModels.map(function (item) {
                return h("option", { key: item.key, value: item.key }, item.label);
              })
            )
            : spec.supportsRatio
            ? h("select", {
              className: "__dbi_s_select",
              value: model,
              "aria-label": t("model"),
              onChange: function (event) {
                var next = event.target.value;
                setModel(next);
                writeModelKey(next);
              },
            }, DOUBAO_MODELS.map(function (item) {
              return h("option", { key: item.key, value: item.key }, modelLabel(lang, item.key));
            }))
            /*
             * GPT 免费通道的模型由服务端固定，没有可选值——这里显示一个
             * 禁用的说明项，而不是塞一个假的豆包模型名。
             */
            : h("select", {
              className: "__dbi_s_select",
              value: "free",
              "aria-label": t("model"),
              disabled: true,
              onChange: function () {},
            }, h("option", { value: "free" }, t("gptModel")))
        )
      );

      /*
       * 比例字段：生视频下一律不渲染（连说明都不留）。
       *
       * 服务端两种视频都不吃面板比例 —— 图生视频跟随参考图的画幅、文生视频
       * 按 auto 取景。渲染一个选了也不生效的下拉是骗人；渲染「不支持比例」
       * 的说明又占版面，用户要的是这块直接消失（2026-10-25 要求）。
       */
      var ratioField = mode === "video"
        ? null
        : spec.supportsRatio && mode === "edit"
        ? h("div", { className: "__dbi_s_fieldGrid" },
          h("label", { className: "__dbi_s_fieldSelect" },
            h("span", null, t("ratio")),
            h("select", {
              className: "__dbi_s_select",
              value: normalizeEditRatio(editRatio),
              "aria-label": t("ratio"),
              onChange: function (event) { setEditRatio(normalizeEditRatio(event.target.value)); },
            }, EDIT_RATIOS.map(function (value) {
              // 首项 auto 复用「自动比例（按参考图）」文案，其余七项直接显示比例值。
              return h("option", { key: value, value: value }, value === "auto" ? t("ratioAuto") : value);
            }))
          )
        )
        : spec.supportsRatio ? h("div", { className: "__dbi_s_fieldGrid" },
        h("label", { className: "__dbi_s_fieldSelect" },
          h("span", null, t("ratio")),
          h("select", {
            className: "__dbi_s_select",
            value: normalizeRatio(generateRatio),
            "aria-label": t("ratio"),
            onChange: function (event) { setGenerateRatio(normalizeRatio(event.target.value)); },
          }, RATIOS.map(function (value) {
            return h("option", { key: value, value: value }, value);
          }))
        )
      ) : h("div", { className: "__dbi_s_inlineNote" }, t("gptNoRatio"));

      /*
       * 张数字段：生视频下同样不渲染。视频一次只出一个，四档按钮全是假的
       * 选择；Host 侧视频分支也根本不读这个参数。
       */
      var countField = mode === "video" ? null
        : spec.supportsCount ? h("div", { className: "__dbi_s_field" },
        h("label", null, t("count")),
        h("div", { className: "__dbi_s_countRow" },
          COUNTS.map(function (option) {
            return h("button", {
              key: String(option),
              type: "button",
              className: "__dbi_s_countPill" + (count === option ? " is-active" : ""),
              onClick: function () { setCount(option); },
            }, String(option));
          })
        )
      ) : h("div", { className: "__dbi_s_inlineNote" }, t("gptNoCount"));

      var generateButton = isGenerating
        ? h("button", {
          type: "button",
          className: "__dbi_s_generateButton is-cancel",
          onClick: function () { finishGeneration(); },
        }, t("cancelGenerate"))
        : h("button", {
          type: "button",
          className: "__dbi_s_generateButton",
          onClick: onGenerate,
        }, count > 1 && spec.supportsCount ? t("startWithCount", { n: String(count) }) : t("start"));

      var instruction = typeof props.onGenerate === "function" ? null
        : h("div", { className: "__dbi_s_instruction" },
          h("div", { className: "__dbi_s_instructionHead" }, t("instructionTitle")),
          h("textarea", {
            className: "__dbi_s_instructionText",
            readOnly: true,
            rows: 3,
            value: instructionText(),
          }),
          h("button", { type: "button", className: "__dbi_s_btn", onClick: onCopyInstruction }, t("copy"))
        );

      var rightPanel = generateCollapsed ? null : h("aside", { className: "__dbi_s_generatePanel" },
        h("div", { className: "__dbi_s_panelTitle" },
          h("span", null, t("generatePanel")),
          h("button", {
            type: "button",
            className: "__dbi_s_collapseBtn",
            title: t("collapseGenerate"),
            "aria-label": t("collapseGenerate"),
            onClick: function () { setGenerateCollapsed(true); },
          }, "›")
        ),
        h("div", { className: "__dbi_s_generatorForm" },
          h("div", { className: "__dbi_s_modeSwitch" + (videoEnabled ? " has-video" : ""), role: "group" },
            h("button", {
              type: "button",
              className: mode === "generate" ? "is-active" : "",
              onClick: function () { setMode("generate"); },
            }, t("modeGenerate")),
            h("button", {
              type: "button",
              className: mode === "edit" ? "is-active" : "",
              onClick: function () { setMode("edit"); },
            }, t("modeEdit")),
            /*
             * 生视频入口**只在视频开关打开时渲染**（不是禁用/置灰）。
             * 用户 2026-10-23 明确要求：关闭生视频功能时所有视频按键都消失。
             * 置灰仍占位，会被当成「这个功能坏了」。
             *
             * 一个按钮承载两种意图：参考图可有可无，有就走图生视频、没有就
             * 文生视频（用户 2026-10-25 要求合并掉原来的「图生视频」独立 tab）。
             * 切进来时顺手把通道切成豆包——视频只有它一条路。
             */
            videoEnabled ? h("button", {
              type: "button",
              className: mode === "video" ? "is-active" : "",
              onClick: function () {
                setMode("video");
                setTool(VIDEO_TOOL);
                writeToolKey(VIDEO_TOOL);
              },
            }, t("modeVideo")) : null
          ),
          referencesField,
          /*
           * 时长只在生视频出现。豆包这条通道 1-10 秒，实测 5 秒片段
           * 约 2 分钟出片。放参考图下面，因为时长是「这条路」的参数。
           */
          mode === "video" ? h("div", { className: "__dbi_s_field" },
            h("div", { className: "__dbi_s_fieldLabel" },
              h("label", { htmlFor: "__dbi_s_videoDuration" }, t("videoDurationLabel"))
            ),
            h("select", {
              id: "__dbi_s_videoDuration",
              className: "__dbi_s_select",
              value: String(videoDuration),
              onChange: function (event) {
                if (event && event.target) setVideoDuration(Number(event.target.value) || 5);
              },
            }, VIDEO_DURATIONS.map(function (seconds) {
              return h("option", { key: String(seconds), value: String(seconds) }, t("videoDurationOption", { n: String(seconds) }));
            }))
          ) : null,
          h("div", { className: "__dbi_s_field" },
            h("div", { className: "__dbi_s_fieldLabel" },
              h("label", { htmlFor: "__dbi_s_prompt" }, t("promptLabel")),
              h("button", {
                type: "button",
                className: "__dbi_s_findInspiration",
                onClick: function () { if (typeof props.onOpenInspiration === "function") props.onOpenInspiration(); },
              }, t("findInspiration")),
              /*
               * 【☆ 收藏】。官方在提示词框旁就是这颗按钮（用户截图取证）。
               * 空提示词时禁用而不是静默失败——按钮看着能点却没反应最容易被
               * 当成 bug。
               */
              h("button", {
                type: "button",
                className: "__dbi_s_promptFav" + (promptTrimmed !== "" && promptFavIds.has(promptTrimmed) ? " is-on" : ""),
                disabled: promptTrimmed === "",
                title: promptTrimmed !== "" && promptFavIds.has(promptTrimmed) ? t("promptFavorited") : t("promptFavorite"),
                "aria-label": promptTrimmed !== "" && promptFavIds.has(promptTrimmed) ? t("promptFavorited") : t("promptFavorite"),
                "aria-pressed": promptTrimmed !== "" && promptFavIds.has(promptTrimmed),
                onClick: togglePromptFavorite,
              }, (promptTrimmed !== "" && promptFavIds.has(promptTrimmed) ? "★ " : "☆ ") + t("promptFavorite")),
              h("button", {
                type: "button",
                className: "__dbi_s_linkBtn",
                onClick: function () { setPrompt(""); },
              }, t("clearPrompt"))
            ),
            h("textarea", {
              id: "__dbi_s_prompt",
              className: "__dbi_s_promptInput",
              value: prompt,
              placeholder: t("promptPlaceholder"),
              onChange: function (event) { setPrompt(event.target.value); },
            }),
            /*
             * 实时字数计数。直接渲染数值、不走字典——它是个数字，没有可翻译
             * 的成分，硬塞一个 `{n}` 模板反而多一层出错面。
             * 定位靠 CSS 的 absolute（见 `__dbi_s_promptCount`），父容器已
             * 设为 relative。
             */
            h("span", { className: "__dbi_s_promptCount", "aria-hidden": "true" }, String(prompt.length))
          ),
          providerField,
          ratioField,
          countField,
          // 「正在载入参考图」优先于普通 notice：此时用户刚点完
          // 「提示词 + 参考图」，最需要知道的是「图正在来」。
          referenceLoading
            ? h("div", { className: "__dbi_s_notice", role: "status" }, t("referenceLoading"))
            : (notice !== "" ? h("div", { className: "__dbi_s_notice", role: "status" }, notice) : null),
          generateButton,
          instruction
        )
      );

      var expanders = [
        sidebarCollapsed ? h("button", {
          key: "sidebar",
          type: "button",
          className: "__dbi_s_expander",
          title: t("expandSidebar"),
          onClick: function () { setSidebarCollapsed(false); },
        }, "›") : null,
        generateCollapsed ? h("button", {
          key: "generate",
          type: "button",
          className: "__dbi_s_expander __dbi_s_expanderRight",
          title: t("expandGenerate"),
          onClick: function () { setGenerateCollapsed(false); },
        }, "‹") : null,
      ];

      var resultStrip = result !== null ? h("div", { className: "__dbi_s_resultStrip" },
        h("span", null, t("result")),
        h("div", { className: "__dbi_s_resultButtons" },
          h("button", { type: "button", onClick: onRegenerate }, t("regenerate")),
          h("button", { type: "button", onClick: onExport }, t("exportPng")),
          h("button", { type: "button", disabled: editor === null, onClick: onClear }, t("clearCanvas"))
        )
      ) : null;

      var resultActions = result !== null ? h("div", { className: "__dbi_s_resultActions" },
        h("p", { title: result.prompt !== "" ? result.prompt : undefined }, result.prompt !== "" ? result.prompt : "—"),
        h("div", { className: "__dbi_s_resultButtons" },
          h("button", { type: "button", onClick: onSaveGallery }, t("saveToGallery")),
          h("button", { type: "button", onClick: onCopyImage }, t("copyImage")),
          h("button", { type: "button", onClick: onDownload }, t("download")),
          h("button", { type: "button", onClick: onSendToChat }, t("sendToChat"))
        )
      ) : null;

      var resultMeta = result !== null ? h("div", { className: "__dbi_s_resultMeta" },
        h("span", null, formatRelativeTime(result.createdAt, lang)),
        result.provider !== "" ? h("span", null, result.provider) : null,
        result.model !== "" ? h("span", null, result.model) : null,
        h("span", null, formatSize(result.attachment)),
        h("span", null, elapsedMs > 0 ? formatElapsed(elapsedMs, lang) : "—")
      ) : null;

      return h("section", { className: "__dbi_s_workbench", "aria-label": t("title") },
        h("div", {
          className: "__dbi_s_workbenchGrid"
            + (sidebarCollapsed ? " is-sidebar-collapsed" : "")
            + (generateCollapsed ? " is-generate-collapsed" : ""),
        },
          leftPanel,
          h("div", { className: "__dbi_s_canvasColumn" },
            canvasToolbar,
            h("div", { className: "__dbi_s_canvas", "data-batch": String(batch.length) },
              canvas,
              overlay,
              pending !== null && editor !== null
                ? h(LandingBridge, {
                  item: pending,
                  onReady: onLanded,
                  label: t("landing"),
                })
                : null
            ),
            resultStrip,
            resultActions,
            resultMeta
          ),
          rightPanel
        ),
        expanders,
        h("div", { className: "__dbi_s_persistNote" }, t("persistNote"))
      );
    }

    shared.injectCss(CHUNK_CSS_TAG, [
      /* 工作台外框：与官方 `.dsh-ig-workbench` 同一职责。 */
      ".__dbi_s_workbench{position:relative;display:flex;flex-direction:column;box-sizing:border-box;height:100%;min-height:0;padding:12px;color:var(--dsw-alias-label-primary,#0f172a);background:var(--dsw-alias-bg-layer-1,#fff)}",
      /* A1 三栏栅格：官方 `.dsh-ig-workbench-grid`（client.js:123867-123870 / 123987）。 */
      ".__dbi_s_workbenchGrid{display:grid;grid-template-columns:minmax(190px,238px) minmax(0,1fr) minmax(286px,340px);grid-template-rows:minmax(0,1fr);min-height:0;height:0;flex:1 1 0;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 12px 32px rgba(30,42,76,.05);transition:grid-template-columns .2s ease}",
      ".__dbi_s_workbenchGrid.is-sidebar-collapsed{grid-template-columns:minmax(0,1fr) minmax(286px,340px)}",
      ".__dbi_s_workbenchGrid.is-generate-collapsed{grid-template-columns:minmax(190px,238px) minmax(0,1fr)}",
      ".__dbi_s_workbenchGrid.is-sidebar-collapsed.is-generate-collapsed{grid-template-columns:minmax(0,1fr)}",
      /* A2/A3 左栏。 */
      ".__dbi_s_recentPanel{min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l2,#e2e8f0);background:var(--dsw-alias-bg-layer-1,#fff)}",
      /* 画布工具条：规格照官方 `.dsh-ig-canvas-toolbar`（client.js:1238xx），
         三区栅格，中间区居中、左右区贴边。 */
      ".__dbi_s_canvasToolbar{height:46px;flex:0 0 46px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e8f0);min-width:0}",
      ".__dbi_s_canvasToolbarLeft,.__dbi_s_canvasToolbarRight{display:flex;align-items:center;gap:6px;min-width:0}",
      ".__dbi_s_canvasToolbarLeft{justify-self:start}",
      ".__dbi_s_canvasToolbarRight{justify-self:end}",
      ".__dbi_s_canvasToolbarCenter{display:flex;align-items:center;justify-self:center;gap:6px;min-width:0}",
      ".__dbi_s_canvasToolbar button{height:30px;min-width:30px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f172a);font:inherit;font-size:11.5px;font-weight:500;cursor:pointer;transition:border-color .15s,background .15s,color .15s}",
      ".__dbi_s_canvasToolbar button:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_canvasToolbar button:disabled{opacity:.45;cursor:default}",
      ".__dbi_s_toolbarDivider{width:1px;height:16px;background:var(--dsw-alias-border-l2,#e2e8f0);flex-shrink:0;margin:0 2px}",
      ".__dbi_s_zoomDisplay{font-size:11px;min-width:38px;text-align:center;color:var(--dsw-alias-label-secondary,#64748b);user-select:none;font-variant-numeric:tabular-nums}",
      ".__dbi_s_canvasEmptyIcon{color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_panelTitle{flex:0 0 auto;height:44px;padding:0 10px 0 12px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:650;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e8f0)}",
      ".__dbi_s_panelTitleText{display:flex;align-items:center;gap:8px;min-width:0}",
      ".__dbi_s_countBadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-secondary,#64748b);font-size:10px;font-weight:600}",
      ".__dbi_s_collapseBtn{appearance:none;width:24px;height:24px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#64748b);font-size:13px;line-height:1;cursor:pointer;transition:all .15s}",
      ".__dbi_s_collapseBtn:hover{border-color:var(--dsw-alias-border-l2,#e2e8f0);background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-primary,#0f172a)}",
      ".__dbi_s_railTabs{flex:0 0 auto;display:flex;gap:4px;padding:4px 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e8f0)}",
      ".__dbi_s_railTab{flex:1;appearance:none;height:26px;display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#64748b);font:inherit;font-size:12px;cursor:pointer;transition:all .15s}",
      ".__dbi_s_railTab:hover{background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-primary,#0f172a)}",
      ".__dbi_s_railTab.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-state-business-primary,#3964fe);font-weight:600}",
      ".__dbi_s_recentScroll{flex:1 1 0;height:0;padding:8px;overflow-x:hidden;overflow-y:auto;min-height:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;align-content:start}",
      ".__dbi_s_favScroll{flex:1 1 0;height:0;overflow-x:hidden;overflow-y:auto;min-height:0;padding:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;align-content:start}",
      // 收藏子视图：两个纵向区块（收藏的图片 / 收藏提示词），整块可滚。
      ".__dbi_s_favArea{flex:1 1 0;height:0;overflow-x:hidden;overflow-y:auto;min-height:0;padding:8px;display:flex;flex-direction:column;gap:12px}",
      ".__dbi_s_favBlock{display:flex;flex-direction:column;gap:7px;min-height:0}",
      // 图片区块吃满剩余空间并自己滚；提示词区块不抢它的空间，超过上限自己滚。
      ".__dbi_s_favBlockGrow{flex:1 1 auto;min-height:120px}",
      // 提示词最多占左栏一半高——再多就会把图片挤没了（用户实测反馈）。
      ".__dbi_s_favBlockPrompt{flex:0 1 auto;max-height:50%;min-height:0}",
      ".__dbi_s_favGrid{flex:1 1 0;min-height:0;overflow-x:hidden;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;align-content:start}",
      ".__dbi_s_favBlockTitle{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#0f172a)}",
      ".__dbi_s_favBlockCount{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary,#64748b)}",
      // 空态：虚线框 + 居中说明，与官方「收藏图片」区块同形。
      ".__dbi_s_favEmptyBox{min-height:78px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:14px 12px;border:1px dashed var(--dsw-alias-border-l2,#e2e8f0);border-radius:9px;text-align:center;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_favEmptyIcon{font-size:17px;line-height:1;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_favPromptList{flex:1 1 0;min-height:0;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;gap:5px}",
      ".__dbi_s_favPromptRow{display:flex;align-items:stretch;gap:4px}",
      ".__dbi_s_favPromptText{flex:1;min-width:0;text-align:left;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1.5;cursor:pointer;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;transition:border-color .15s,background .15s}",
      ".__dbi_s_favPromptText:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-bg-layer-3,#f1f5f9)}",
      ".__dbi_s_favPromptDel{flex:0 0 26px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary,#94a3b8);font:inherit;font-size:14px;line-height:1;cursor:pointer}",
      ".__dbi_s_favPromptDel:hover{border-color:var(--dsw-alias-state-error-primary,#f85149);color:var(--dsw-alias-state-error-primary,#f85149)}",
      ".__dbi_s_recentEmpty{grid-column:1/-1;min-height:180px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;padding:12px;color:var(--dsw-alias-label-tertiary,#94a3b8);font-size:12px;text-align:center}",
      ".__dbi_s_recentItem{appearance:none;position:relative;width:100%;aspect-ratio:1;align-self:start;padding:0;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .16s,box-shadow .16s}",
      ".__dbi_s_recentItem:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 1px 4px rgba(30,42,76,.14)}",
      ".__dbi_s_recentItem.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:0 0 0 2px rgba(47,100,245,.18)}",
      ".__dbi_s_recentThumb{display:block;width:100%;height:100%;object-fit:cover;background:var(--dsw-alias-bg-layer-3,#f1f5f9)}",
      ".__dbi_s_recentThumbEmpty{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#94a3b8);font-size:12px}",
      ".__dbi_s_loadMore{appearance:none;grid-column:1/-1;width:100%;height:32px;margin:4px 0 2px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#64748b);font:inherit;font-size:11px;cursor:pointer;transition:background .15s,color .15s}",
      ".__dbi_s_loadMore:hover{background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      /* 中栏。 */
      ".__dbi_s_canvasColumn{min-width:0;min-height:0;height:100%;overflow:hidden;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#f8fafc)}",
      /* A23 点阵背景（官方 `.dsh-ig-canvas` 的 4 层 linear-gradient，client.js:123948）。 */
      ".__dbi_s_canvas{position:relative;flex:1 1 0;height:0;min-height:0;overflow:hidden;background-image:linear-gradient(45deg,var(--dsw-alias-border-l2,rgba(114,128,156,.14)) 25%,transparent 25%),linear-gradient(-45deg,var(--dsw-alias-border-l2,rgba(114,128,156,.14)) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,var(--dsw-alias-border-l2,rgba(114,128,156,.14)) 75%),linear-gradient(-45deg,transparent 75%,var(--dsw-alias-border-l2,rgba(114,128,156,.14)) 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}",
      /* A22 拖拽平移：tldraw 自带手势；这里只给出可抓取的鼠标语义，不接管事件。 */
      ".__dbi_s_canvas{cursor:grab;touch-action:none;user-select:none}",
      ".__dbi_s_canvas.is-dragging{cursor:grabbing}",
      ".__dbi_s_canvasLoading,.__dbi_s_canvasError{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:320px;padding:20px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#64748b)}",
      ".__dbi_s_canvasErrorTitle{font-weight:600;color:var(--dsw-alias-label-primary,#0f172a)}",
      ".__dbi_s_canvasErrorReason{font-size:11.5px;word-break:break-all;max-width:420px}",
      ".__dbi_s_landing{position:absolute;left:12px;bottom:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}",
      /* A15 生成中：旋转轨道动画（官方 `.dsh-ig-generation-orbit` + dshIgPulse）。 */
      ".__dbi_s_generatingState{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;pointer-events:none;background:var(--dsw-alias-bg-layer-2,#f8fafc)}",
      ".__dbi_s_generatingState strong{font-size:15px;color:var(--dsw-alias-label-primary,#0f172a)}",
      ".__dbi_s_generatingState span{font-size:11px;color:var(--dsw-alias-label-secondary,#64748b)}",
      ".__dbi_s_generationOrbit{width:66px;height:66px;border-radius:50%;display:grid;place-items:center;font-size:26px;color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-bg-layer-3,#f1f5f9);box-shadow:0 0 0 10px var(--dsw-alias-bg-layer-2,#f8fafc);animation:dshIgPulse 1.8s ease-in-out infinite}",
      "@keyframes dshIgPulse{50%{transform:scale(1.06);box-shadow:0 0 0 16px var(--dsw-alias-bg-layer-3,#f1f5f9)}}",
      ".__dbi_s_canvasEmpty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#94a3b8);pointer-events:none}",
      /* A16 画布多图簇：data-count 切栅格（官方 client.js:123997-123999）。 */
      ".__dbi_s_canvasCluster{position:absolute;left:0;right:0;bottom:12px;display:grid;gap:8px;align-items:center;justify-content:center;padding:0 12px;pointer-events:none;grid-template-columns:repeat(2,minmax(0,1fr))}",
      ".__dbi_s_canvasCluster[data-count=\"1\"]{grid-template-columns:minmax(0,240px)}",
      ".__dbi_s_canvasCluster[data-count=\"2\"]{grid-template-columns:repeat(2,minmax(0,240px))}",
      ".__dbi_s_canvasCluster[data-count=\"3\"],.__dbi_s_canvasCluster[data-count=\"4\"]{grid-template-columns:repeat(2,minmax(0,190px))}",
      ".__dbi_s_canvasItem{position:relative;display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);min-width:0}",
      ".__dbi_s_canvasItem.is-checked{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      /* A17 角标 / A18 多选圆勾。 */
      ".__dbi_s_canvasBadge{font-size:10px;font-weight:650;color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_canvasCheck{position:absolute;top:5px;right:5px;width:14px;height:14px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".__dbi_s_canvasChip{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#94a3b8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* A19/A20/A21 结果三条。 */
      ".__dbi_s_resultStrip,.__dbi_s_resultActions{flex:0 0 auto;min-height:34px;padding:4px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#e2e8f0);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".__dbi_s_resultStrip>span{font-size:12px;font-weight:650}",
      ".__dbi_s_resultActions p{margin:0;min-width:0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary,#64748b)}",
      ".__dbi_s_resultButtons{display:flex;gap:7px;flex-wrap:wrap}",
      ".__dbi_s_resultStrip button,.__dbi_s_resultActions button{appearance:none;height:26px;display:inline-flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:11px;cursor:pointer}",
      ".__dbi_s_resultStrip button:hover:not([disabled]),.__dbi_s_resultActions button:hover:not([disabled]){border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_resultStrip button[disabled]{opacity:.5;cursor:not-allowed}",
      ".__dbi_s_resultMeta{flex:0 0 auto;min-height:22px;padding:3px 12px;display:flex;gap:11px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#e2e8f0);background:var(--dsw-alias-bg-layer-1,#fff);font-size:10px;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_resultMeta span+span::before{content:'·';margin-right:11px}",
      /* A4 右栏生成面板。 */
      ".__dbi_s_generatePanel{min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2,#e2e8f0);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".__dbi_s_generatorForm{flex:1 1 0;height:0;padding:15px;display:flex;flex-direction:column;gap:15px;overflow-x:hidden;overflow-y:auto;min-height:0}",
      /* A5 模式切换。 */
      ".__dbi_s_modeSwitch{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
      ".__dbi_s_modeSwitch button{appearance:none;height:39px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#64748b);display:flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:12px;cursor:pointer}",
      ".__dbi_s_modeSwitch button.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-bg-layer-3,#f1f5f9)}",
      /* A7/A8/A9/A11 生成面板字段。 */
      ".__dbi_s_field{position:relative;display:flex;flex-direction:column;gap:7px}",
      ".__dbi_s_field>label{font-size:11.5px;font-weight:630}",
      ".__dbi_s_fieldLabel{display:flex;align-items:center;gap:10px;min-width:0}",
      ".__dbi_s_fieldLabel label{flex:1;font-size:11.5px;font-weight:630;min-width:0}",
      ".__dbi_s_fieldGrid{display:grid;grid-template-columns:1fr 1fr;gap:9px;align-items:start}",
      ".__dbi_s_fieldSelect{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".__dbi_s_fieldSelect>span{font-size:11px;font-weight:620}",
      ".__dbi_s_select{width:100%;height:36px;padding:0 26px 0 9px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:11px;outline:none;text-overflow:ellipsis}",
      ".__dbi_s_select:focus{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_select[disabled]{opacity:.7;cursor:not-allowed}",
      ".__dbi_s_promptInput{width:100%;height:112px;padding:11px 12px 22px;box-sizing:border-box;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;line-height:19px;outline:none}",
      ".__dbi_s_promptInput:focus{border-color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_promptCount{position:absolute;right:9px;bottom:7px;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_findInspiration,.__dbi_s_linkBtn{appearance:none;flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#94a3b8);font:inherit;font-size:10.5px;cursor:pointer}",
      ".__dbi_s_findInspiration:hover,.__dbi_s_linkBtn:hover{color:var(--dsw-alias-state-business-primary,#3964fe)}",
      /*
       * 提示条配色走主题变量，不照抄官方的 `rgba(245,158,11,…)`。
       * 官方能硬编码是因为它自带 `--ig-*` 变量体系；本插件的样式守卫
       * （自测的「样式不写死颜色」）要求颜色类声明
       * 一律落到 `--dsw-alias-*`，唯一的例外是 A14 正向钉住的官方渐变。
       */
      ".__dbi_s_inlineNote{padding:9px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fffbeb);border:1px solid var(--dsw-alias-border-l2,#fcd34d);color:var(--dsw-alias-label-primary,#b45309);font-size:10.5px;line-height:16px}",
      ".__dbi_s_countRow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}",
      ".__dbi_s_countPill{appearance:none;height:34px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#64748b);font:inherit;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s}",
      ".__dbi_s_countPill:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_countPill.is-active{border-color:var(--dsw-alias-state-business-primary,#3964fe);background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-state-business-primary,#3964fe);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,#3964fe)}",
      /* A12/A13 参考图。 */
      ".__dbi_s_upload{height:92px;width:100%;box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l2,#e2e8f0);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:var(--dsw-alias-label-tertiary,#94a3b8);font:inherit;cursor:pointer}",
      ".__dbi_s_upload strong{font-size:11px;font-weight:570}",
      ".__dbi_s_upload small{font-size:9.5px}",
      ".__dbi_s_upload:hover,.__dbi_s_upload.is-dragging{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_referenceGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:8px}",
      ".__dbi_s_referenceCard{position:relative;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;overflow:hidden;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-3,#f1f5f9)}",
      ".__dbi_s_referenceThumb{display:block;width:100%;height:100%;object-fit:cover}",
      ".__dbi_s_referenceRemove{position:absolute;top:3px;right:3px;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#64748b);font-size:12px;line-height:1;cursor:pointer}",
      ".__dbi_s_referenceAdd{appearance:none;aspect-ratio:1/1;border:1px dashed var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#94a3b8);font-size:16px;cursor:pointer}",
      ".__dbi_s_referenceAdd:hover{border-color:var(--dsw-alias-state-business-primary,#3964fe);color:var(--dsw-alias-state-business-primary,#3964fe)}",
      ".__dbi_s_fileInput{display:none}",
      /* A14 主按钮（渐变）/ 生成中变红。 */
      ".__dbi_s_generateButton{appearance:none;height:42px;flex:0 0 auto;border:0;border-radius:8px;background:linear-gradient(135deg,#386cf6,#2758e7);color:var(--dsw-alias-label-primary-inverse,#fff);display:flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:650;cursor:pointer;box-shadow:0 8px 18px rgba(47,100,245,.22);transition:transform .16s,box-shadow .16s}",
      ".__dbi_s_generateButton:hover:not([disabled]){transform:translateY(-1px)}",
      ".__dbi_s_generateButton[disabled]{opacity:.55;cursor:not-allowed;box-shadow:none}",
      ".__dbi_s_generateButton.is-cancel{background:linear-gradient(135deg,#ef4444,#dc2626);box-shadow:0 8px 18px rgba(239,68,68,.25)}",
      /* 无 onGenerate 时的指令面。 */
      ".__dbi_s_instruction{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px}",
      ".__dbi_s_instructionHead{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_instructionText{width:100%;box-sizing:border-box;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#f8fafc);color:var(--dsw-alias-label-secondary,#64748b);font:inherit;font-size:11px;line-height:17px;outline:none}",
      ".__dbi_s_btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;font-weight:500;cursor:pointer}",
      ".__dbi_s_btn:hover:not([disabled]){background:var(--dsw-alias-bg-layer-3,#f1f5f9)}",
      ".__dbi_s_btn[disabled]{opacity:.5;cursor:not-allowed}",
      ".__dbi_s_notice{padding:6px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-3,#f1f5f9);color:var(--dsw-alias-label-secondary,#64748b);font-size:11px;line-height:16px}",
      /* A24 折叠后的展开条。 */
      ".__dbi_s_expander{position:absolute;top:50%;transform:translateY(-50%);left:8px;z-index:5;width:22px;height:46px;padding:0;border:1px solid var(--dsw-alias-border-l2,#e2e8f0);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#64748b);font-size:13px;cursor:pointer}",
      ".__dbi_s_expanderRight{left:auto;right:8px}",
      ".__dbi_s_persistNote{flex:0 0 auto;padding:8px 2px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#94a3b8)}",
      ".__dbi_s_error{padding:12px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#64748b)}",
      /* A25 提供商快捷切换：窄到 900px 才收起文字。 */
      ".__dbi_s_quickProvider{display:flex;align-items:center;gap:8px}",
      /* A26 响应式四档断点（官方 1120 / 900 / 560 + 侧栏变体）。 */
      "@media(max-width:1120px){.__dbi_s_workbenchGrid{grid-template-columns:190px minmax(360px,1fr) 300px}}",
      "@media(max-width:900px){.__dbi_s_workbench{padding:8px}.__dbi_s_workbenchGrid{height:auto;display:flex;flex:none;flex-direction:column;overflow:visible}.__dbi_s_recentPanel{height:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,#e2e8f0)}.__dbi_s_recentScroll{height:auto;display:flex;overflow-x:auto;overflow-y:hidden;padding:8px}.__dbi_s_favScroll{height:auto;flex:none;overflow:visible}.__dbi_s_recentItem{min-width:96px;aspect-ratio:auto;height:96px}.__dbi_s_canvasColumn{height:auto;min-height:560px}.__dbi_s_generatePanel{height:auto;border-left:0;border-top:1px solid var(--dsw-alias-border-l2,#e2e8f0);min-height:420px}.__dbi_s_generatorForm{height:auto;overflow:visible}.__dbi_s_canvas{flex:none;height:auto;min-height:360px}}",
      "@media(max-width:560px){.__dbi_s_workbench{position:relative}.__dbi_s_canvas{padding:12px;min-height:300px}.__dbi_s_resultStrip,.__dbi_s_resultActions{align-items:flex-start;flex-direction:column}.__dbi_s_resultButtons{width:100%}.__dbi_s_resultStrip button,.__dbi_s_resultActions button{flex:1;justify-content:center}.__dbi_s_fieldGrid{grid-template-columns:1fr}.__dbi_s_resultMeta span+span::before{display:none}.__dbi_s_generationOrbit{width:54px;height:54px;font-size:22px}}",
      /* A27 prefers-reduced-motion 降级（官方 client.js:123990 同一手法）。 */
      "@media(prefers-reduced-motion:reduce){.__dbi_s_workbench *{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}",
    ].join(""));

    exports.Mount = StudioView;
    return module.exports;
  },
});
