# 更新记录

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
