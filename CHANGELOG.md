# 更新记录

## 0.3.0 — 2026-11-01

灵感库体验与画廊细节的一批增强：灵感库支持中英双语、灵感图改为落盘缓存并可点开放大看、画廊记住上次的标签页与阅读位置。

### 新增

- **灵感库中英双语**：`awesome-gpt-image-2` 那 541 条案例原本只有英文 prompt，现在配了中文译文覆盖层 `lib/inspiration/i18n/awesome-gpt-image-2.zh.json`（结构 `{ "<caseId>": "中文" }`），**不改动原始数据集**——上游更新数据集时覆盖层照样生效，缺的条目自动回退英文。
  - 页头「清缓存」旁与检查器 Prompt 标签行右侧各一个 `中 / EN` 分段按钮，两处绑同一状态；切一次，prompt 正文、分类名、风格名、场景名、分组标题一起换。
  - **默认跟随界面语言**：没手动选过时中文界面读中文、英文界面读英文，不把某种语言硬编码成默认；点过开关之后该选择记进 `localStorage`（`dsh-dbi-inspiration-prompt-lang`）并优先生效。
  - **对照模式**：Prompt 区右上角「对照」按钮，上下双框同时给出英文原文与中文译文（中文框带浅蓝底），状态存 `dsh-dbi-inspiration-dual`。
  - **双语搜索**：`filterCases` 的搜索字段从 `[title, prompt, promptPreview]` 扩到再加上 `promptZh`、`promptPreviewZh`；**搜索始终双语**，不跟随界面语言开关。
  - **复制与「用它生图」仍用英文原文**（`handleCopy()` / `handleUse(mode)` 读的都是 `selected.prompt`）——界面可能正显示中文，所以复制按钮的 tooltip 写明了这点。
  - **缺译回退**：中文模式下未翻译的案例显示英文原文 + 一行提示，不会出现空白框。页头 summary 行追加「已翻译 N/M 条」。
  - `TAG_ZH` 只映射显示名，**不改数据值**：三个筛选 `<select>` 的 `<option>` 文本换语言，`value` 仍是英文，筛选逻辑与 URL 参数不受影响。
- **灵感图落盘缓存**：`lib/inspiration.mjs` 的 `fetchInspirationImageCached` 变成**内存 → 磁盘 → 外网**三级。
  - 缓存目录 `$DSH_HOME/storages/dsh-doubao-image/inspiration-images/`（与画廊数据同级，卸载插件可整目录删）。
  - 文件名 = `sha1(sourceId|version|imagePath)` + 原扩展名：用哈希而不是把数据集给的路径直接拼进文件系统，既躲开 `..`，也顺带压平 handraw 那批 `/images/individual/001-200/001.webp` 的子目录。
  - 读失败 / 空文件 / 超过 12MiB / 扩展名不认识 → 一律当未命中；写失败静默忽略。缓存只影响速度，不影响正确性。
  - 实测同一张 `case544.jpg` 首次 2.3–2.5s，落盘后再取 **1–4ms**。
- **灵感图放大查看**：灵感库卡片右上角（收藏星标左边）多一个半透明放大按钮 🔍，`stopPropagation` 只开弹层、不选中卡片。弹层是全屏「纯看图」：深色遮罩 + 等比大图，右上角一个 `×`，`Esc`／点遮罩／点 × 三条退路都能关，两侧箭头与 `←` `→` 键翻页（顺序按**屏幕上分组后的阅读顺序**，不是数据集原始顺序）。**底部不放任何控件**。
  - 按用途取舍：这批案例图是用来「看清排版和画法」的，不是抠像素，所以没有缩放 / 平移，直接用最朴素的「点开看大图」。
  - 大图走既有的三级缓存取图路径，未新增路由、未新增计费。
- **画廊标签页与滚动位置记忆**：不再每次点进工具都回到图库首屏。
  - 模块级 `VIEW_STATE_STORAGE_KEY = "dsh-dbi-gallery-view"`，存 `{ tab, scroll: {[tabId]: px}, anchor: {[tabId]: caseId} }`。
  - `readViewState()` 任何异常（没有 `localStorage`、JSON 坏了、形状不对、数值非法）一律退回空形状；`writeViewState(patch)` 读-合并-写，`patch.scroll` / `patch.anchor` **按标签页局部覆盖**，不会把别的标签页记下的位置抹掉。
  - `Mount` 的 `activePair` 惰性初始化自存档，**存档里的 id 不在 `TABS` 里时回落 `"gallery"`**（插件升级后删掉的标签页不会渲染成空白）；所有切标签页入口（点标签、灵感库「用它生图」跳工作台）统一走 `switchTab(id)`。
  - 新增 `findScrollHost(container)`：按 `getComputedStyle(node).overflowY === "auto" | "scroll"` 找真正的滚动者，**不写死类名**——图库/视频是 `.__dbi_g_pageBody`，灵感库是它自己 chunk 里的 `.__dbi_i_root`，工作台又是另一套。
  - **灵感库用「锚点法」**：灵感库是分页渲染的（首屏 60 张，其余靠手点「加载更多」），切回来时容器里根本没有原来那么高的内容，**像素位置无从还原**，所以记住「上次停在哪个案例上」——卡片渲染 `data-case-id`；滚动停下 150ms 后 `topVisibleCaseId()` 在 DOM 上**二分**找出视口顶部那张卡（DOM 顺序即视觉顺序，541 张卡上线性扫每帧要读几百次 `getBoundingClientRect`）；切回来时 `limitToRevealCase()` 先把窗口推到「含这张卡 + 下面再留一页」（留一页是因为滚动位置受 `scrollHeight - clientHeight` 限制，锚点若是最后一张就只能停在视口底部，位置会差一屏），渲染完再按 `getBoundingClientRect().top` 差算偏移赋给 `root.scrollTop`——**不用 `scrollIntoView`**，那会连外层页面一起滚。
  - 锚点法的收敛方式与插件原有的分类跳转（`jumpToCategory`）一致：`needed > visibleLimit` 就扩窗并等重渲染，`needed === 0`（锚点不在当前结果里，比如换了筛选）就放弃；同一个锚点只处理一次，否则用户一滚动就被拽回去。装了锚点的标签页不再走像素恢复，两种定位不打架；图库 / 视频这些同步渲染的标签页仍用像素。
  - **灵感库目录加了模块级缓存**：目录约 1.9 MB / 976 条案例，以前每次切回来都要重新 `fetch` + `JSON.parse` + 三级分组；现在只缓存**成功**的结果（失败不写，免得一次网络抖动被记一辈子），「刷新」按钮仍强制重拉。

### 改动

- `lib/inspiration.mjs`：`parseSource(value, meta, zhMap)` 增加第三参；新增 `loadTranslations(sourceId)` 与 `MAX_TRANSLATION_BYTES`（4MiB）。有译文时 case 上多出 `promptZh` 与 `promptPreviewZh`（`promptZh.slice(0, 280)`），**无译文时这两个键不出现**，客户端据此判断。
- `client.inspiration.js`：新增 `LangSwitch` 组件、`TAG_ZH`（13 分类 + 19 风格 + 10 场景）、`pickPrompt` / `isTranslated` / `countTranslated` / `tagLabel` / `resolvePromptLang` / `readPromptLang` / `writePromptLang` / `readDual` / `writeDual` / `limitToRevealCase` / `topVisibleCaseId` / `escapeAnchorId` / `InspirationZoom`。
- `client.gallery.js`：新增 `VIEW_STATE_STORAGE_KEY` / `readViewState` / `writeViewState` / `findScrollHost` / `switchTab` / `anchorMemory` / `rememberAnchor`。
- `client.js`：画廊在 `conversation.view` 里的 `order` 由 **20 → 22**。上游取 20 是照官方 `dsh-image-gen` 的写法，但常见第三方视图会占 20 / 21，同值会让画廊夹在两者中间；22 落在它们之后、「上下文」（30）之前。**只改自己注册项的 order，不碰别人的注册项，也不依赖宿主内部结构。**

### 修正

- **切来切去滚动位置会被重置**：恢复逻辑里有两处把「假 0」当真——① 切回来时 chunk 还在异步加载，`scrollHeight` 是 0，读到的 `scrollTop` 自然也是 0；② 切走时 React 已经把子树从 DOM 摘掉，`useEffect` 的 cleanup 再去读 `host.scrollTop` 还是 0。于是「上次滑到 3000」被洗成 0 落盘，下次回来就停在顶部。现在加了两道闸门：`settled`（内容高度没长起来之前一律不落盘）+ `host.isConnected`（节点已脱离文档就不重读），滚动位置只由 `scroll` 事件持续记忆。

### 说明

- 只用了 `localStorage` 两个键 + 目录缓存，**不新增路由、不写 Host 侧状态**；清掉浏览器站点数据最多退回默认视图。
- 译文是**可选增强**：覆盖层缺失、解析失败、体积超限，`loadTranslations` 一律返回 `{}`，灵感库退回纯英文，不会因为译文文件坏掉而整个罢工。
- 磁盘缓存没有接进界面的「清缓存」按钮（那个按钮只 revoke 内存里的 blob URL）；要清就删上面那个目录。缓存文件名含数据集里的 `version` 提交号，上游换 commit 才会换 key。
- 维护提示：改完任何 `client.*.js` 都要**戳一下 `client.js` 的 mtime** 再 reload——`?rev=` 取自 `client.js` 的 `mtime + ctime + size`，改 chunk 不影响 rev，服务端会按旧 rev 返回缓存字节（详见 README「chunk 架构」）。


## 0.2.3 — 2026-10-28

同步开发仓库 `439b42f → 83dc4ca`。修复桌面端（Electron）下画廊缩略图 / 灵感库 / 工作台全部 403 不可用的问题。

### 修复

- **桌面端全部请求 403（画廊图挂、灵感库加载失败、工作台打不开）**：Electron 的 `protocol.handle` 把 `dsh-app://app` 页面的请求转发到本地 HTTP 服务时（`app.asar` `main.js` 的 `forwardWebRequest`），**明确删除 `host` / `origin` / `cookie` / `sec-fetch-site` 四个头**，只注入宿主签发的 auth cookie。旧实现要求「缺 Origin 时 `sec-fetch-site` 必须是 `same-origin`/`none`」，两个头都被删掉的请求一律判 403 —— 桌面端因此全军覆没（浏览器端不受影响，浏览器会正常带这两个头）。
  现在新增**桌面协议桥兼容分支**：只在 Origin 与 `sec-fetch-site` **都缺失**时，调用宿主自己的认证入口 `ctx.connection.requestRejection(req)`（签名 Cookie + live Peer 校验，`HttpOnly` + `SameSite=Strict` + HMAC + 过期）判定放行与否。桌面桥转发的请求带着宿主注入的 cookie 能过；curl / 跨站脚本拿不到这个 cookie，过不了。**其余判据一字未放宽**——带 Origin、带 `sec-fetch-site` 的请求照旧严格同源比对，`same-site` / `cross-site` / Origin 不匹配仍然拒绝。
- **工作台标签页「加载失败：client.studio.js」**：chunk 注册 id 还是开发期的旧包名 `dsh-doubao-image`，宿主按包名 `dsh-doubao-image-free` 去 `importChunk` 找不到对应注册，整个工作台 chunk 加载失败。画廊 / 灵感库两个 chunk 的注册 id 本来就是对的，所以只有工作台受影响。
- **`Origin: null` 显式拒**：它来自沙箱 iframe / `file://` 页面 / 跨源重定向，不是可核验的同源证据。
- **`origin-rejected` 拒绝点加诊断日志**：写入 `~/.dsh/logs/dsh-doubao-image-api.log`（method / url / host / origin / site / UA），下次再有来源校验问题可直接看真实请求头，不用靠猜。

### 验证

- 全量自测 **1985 项通过 / 0 失败**，变异测试 **62/62 全部捕获**（0 逃逸、0 锚点失效）。
- 真机复验：桌面端画廊缩略图、灵感库、工作台全部恢复正常（用户确认「这回可以了」）。
- 安全边界反向验证：无 connection service / 宿主认证 401·403 / `requestRejection` 抛错 / 非回环 Host / 带 `cross-site` / 空串 site —— 六类全部拒绝（fail-closed）。

## 0.2.2 — 2026-10-28

同步开发仓库 `3a3a901 → 3d54fe7`。这一版全部是**安全加固**，没有新功能。

### 安全

- **账号 id 就是 `sessionid` 明文**：账号池里每个账号的 `id` 直接取自 cookie 里的 `sessionid`（32 位 hex），并随 `/api/status`、`doubao.accounts` 路由和工具返回值一路返回给界面与模型。任何能看到这些输出的人（截图、会话历史、日志）等于拿到了完整登录凭据。
  现在 `id` 是 `acc_` + `sha256(sessionid)` 前 16 位：不可逆、天然是去重键，登录态变化时仍是同一个 id（不会重复计入同一份额度）。存量记录在下次读取时自动重写，无需手工迁移。
- **SSE 错误详情未脱敏**：豆包 gateway 错误原文（可能含 cookie 片段）被拼进 `Error.message`、`err.gatewayDetail`、`err.replyText`、`err.failures` 四处，会冒到工具返回值与会话历史。四处现在统一走 `safeSnippet`；`gatewayError` 本体保持原文，因为内部鉴权失败判据仍要读它。
- **视频通道所有用户共享同一套设备身份**：`videoSecurityParams` 把 `device_id` / `web_id` / `tea_uuid` / `fp` 写死成常量，调用方传进来的账号 `device` 被静默丢弃。现在这四个字段优先取账号真实设备身份，为空则回落协议常量（真实账号的 `deviceId` / `teaUuid` 本来就是空串，直接取会发出空值）。`pc_version` / `channel` 等**仍保持常量**——它们是端点协议的一部分（桌面构建标识），不是账号身份。
- **参考图可读任意本机文件并上传到第三方存储**：`reference_images` 是模型给的字符串，旧实现 `isAbsolute(file) ? file : join(process.cwd(), file)` 后直接 `readFile` 上传 ImageX。模型传 `~/.ssh/id_rsa` 就等于把私钥 POST 给字节跳动。现在三道关：**工作区边界**（`relative` + `..` 判据，越界报错并提示先把图放进工作区）、**20 MiB 上限**（先 `stat` 再 `readFile`，防止先读进内存再拒绝）、**字节嗅探**（`mediaType` 由文件头决定，不信扩展名）。
- **本机任意网页都能调插件接口（CSRF）**：路由的同源校验在白名单里放了 `same-site`，注释写「只可能来自 localhost 与 127.0.0.1 的写法差异」。实测（真实 Chromium + 双端口探针）证明这是错的：`sec-fetch-site` 按 **host** 判定、**端口不参与**，所以从 `127.0.0.1:任意端口` 的网页打过来报的是 `same-site` 而非 `cross-site` —— 白名单等于给本机所有网页开了门（`fetch` 只读接口能直接拿走画廊与灵感库全文）。现在白名单只收 `same-origin` 与 `none`，缺头一律拒。

  **这一条挡不住什么**：本机任意进程（curl / PowerShell / 脚本）可以伪造 `sec-fetch-site: same-origin`，要彻底收口需要 token 级鉴权。本次只关掉浏览器侧的 CSRF 面。

### 验证

- 全量自测 **1984 项通过 / 0 失败**，变异测试 **62/62 全部捕获**（0 逃逸、0 锚点失效）。
- 回环鉴权真机复验：无凭据访问 `/api/status`、`/api/gallery`、`/api/inspiration` 全部 **403**（修复前分别是 200 / 9.6 KB / 1.7 MB）；`same-site` / `cross-site` / 空串 / 非回环 Host 全部 403；`none` 200。
- 用 CDP 监听真实 GUI 页面确认前端请求全部是 `same-origin`（`fetch` 的 cors 与 no-cors 形态、`XHR`、`<img>` 四种都测了），页面功能不受影响。

## 0.2.1 — 2026-10-27

### 修复

- **`gpt_image` 工具完全不可用**：`execute` 里返回了 `count`，但 `output.schema` 从未声明这个字段。宿主用 `additionalProperties: false` 校验整个返回值，多一个未声明字段就判整次调用失败，真实报错是 `tool "gpt_image" returned invalid output: "value.count" is not a declared property`。该缺陷从 0.2.0 之前的开发提交（2026-10-18）就存在，0.2.0 也带出去了 —— **0.2.0 的 GPT 生图通道实际一调用就报错**，升级到 0.2.1 修复。豆包的 `doubao_image` 不受影响。

## 0.2.0 — 2026-10-27

同步开发仓库 `29661d6 → 6a07477` 的 17 个提交（3 个新功能、4 个修复，其余为文档）。

### 新增

- **视频无水印**：生视频接上豆包的免水印流。此前判定「豆包对视频烧服务端水印、没有免水印通路」是**错的** —— 错在把图片那套 `body {uri:[key]}` 直接套到了视频上。视频必须用 `{vid:[vid]}`，响应在 `data.download_video[vid].download_url`；用 `uri` 只会回 `{"code":0,"data":{"without_watermark":true}}`，没有 URL。实测无水印流与网页 `<video>` 的 `currentSrc` 字节完全一致。
- **设置页「去掉视频水印」开关**（`video.removeWatermark`，默认开）：关掉则下载带烧录水印的版本，供需要标注 AI 生成来源的平台使用。取不到无水印流时自动回退并在结果里如实标注。
- **图生视频**：`doubao_image` 的 `mode: "video"` 现在接受 `reference_images`，以参考图为首帧构图来源。画幅跟随参考图，此时 `ratio` 会被服务端忽略。
- **生视频合并为单入口**：工作台不再区分「文生视频 / 图生视频」两个按钮，有无参考图自动判断。
- **两档视频模型**：`seedance_v2.0_mini`（Seedance 2.0 Mini，默认，保持升级前行为）与 `seedance_2.0_pc`（Seedance 2.0），设置页可选。
- **GPT 生完图隐藏会话**：每张图生成后自动 `PATCH {is_visible:false}`，避免账号里堆一堆对话。失败不影响出图，原因随结果返回。

### 修复

- **点历史会话被劫持到工作台**（用户报「有概率」）：根因是一个 `MutationObserver` 在扫 `document.body` 找关键词（「新建画布」「打开工作台」等），点开含这些词的历史会话时，历史消息作为新节点被捕获 → 误判成用户输入 → 切换视图。**该功能已整体删除**，工作台入口改为画廊里的普通标签，行为可预期。
- **设置页画廊的视频卡是破图**：视频是 mp4，`<img>` 解不了，浏览器渲染成破图 + alt 文字。设置页画廊现在只列图片，有视频时给一行提示指向「画廊」标签页。
- **视频卡角标显示错误模型名**：UI 误传 + 落盘白名单 + 渲染接线三处链路一起修。

### 其它

- `doubao_image` 的 `mode: "video"` 描述补充图生视频语义（`video` 本身在 0.1.0 已存在）。
- 已知限制里删掉「视频无免水印通路」这条已被实测推翻的陈述。

## 0.1.0

首个可用版本：豆包文生图 / 图生图、GPT 免费账户文生图、Web 设置页、IndexedDB 画廊、灵感库、tldraw 工作台。
