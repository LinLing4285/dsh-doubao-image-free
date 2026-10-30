# dsh-doubao-image-free

[![npm](https://img.shields.io/npm/v/dsh-doubao-image-free)](https://www.npmjs.com/package/dsh-doubao-image-free)

把**网页版豆包**与**网页版 ChatGPT 免费账户**的生图能力接进 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件。在插件设置页里扫码或粘贴凭据即可使用，带自建画廊、灵感库与 tldraw 工作台。

> **和 npm 上的 `dsh-doubao-image` 不是同一个项目。** 那个包的作者是 `xt765`，注册 `doubao_generate_image` / `doubao_image_status`，依赖 Tabbit CLI 驱动浏览器。本项目注册 `doubao_image` / `gpt_image`，走纯 HTTP，不依赖任何外部 CLI。安装时请认准包名带 `-free` 后缀。
>
> - npm：<https://www.npmjs.com/package/dsh-doubao-image-free>
> - GitHub：<https://github.com/LinLing4285/dsh-doubao-image-free>

> 面向个人自用。走的是网页端私有接口的协议复刻，**可能违反平台服务条款**，请自行评估账号风险。

## 功能

| 能力 | 豆包 | ChatGPT 免费账户 |
|---|---|---|
| 文生图 | ✅ 2048px 无水印原图 | ✅ 已实测出图 |
| 图生图 | ✅ 参考图引导重生成 | ✅ 参考图上传 + multimodal 引用 |
| 生视频 | ✅ 无水印 mp4（默认关闭，消耗每日免费额度） | ❌ |
| 登录方式 | 扫码（纯 HTTP，无需浏览器） | 拉起 Edge 自动抓取 / 手工粘贴 Token |

设置页提供：豆包扫码登录、Cookie 手工粘贴、GPT 拉起 Edge 登录、accessToken 粘贴、代理地址、超时与默认尺寸、视频开关（含「去掉视频水印」）、画廊开关。

### 对话页的「画廊」视图

会话页顶部的「画廊」标签（`conversation.view` 槽）里再分四个顶层 tab：

| tab | 内容 |
|---|---|
| **图库** | 图片生成历史：搜索、来源筛选（豆包 / GPT / 导入）、比例筛选、排序、工作区过滤、收藏夹、批量管理、导入本地图、灯箱 |
| **视频** | 视频生成历史：首帧缩略图 + 灯箱播放，支持批量下载（不进工作台参考图） |
| **工作台** | tldraw 无限画布，可把画廊里的图放上去，画布状态存 localStorage |
| **灵感库** | 内置 976 条提示词案例（两个上游数据集），三级筛选 + 搜索 + 详情弹层 +「用它生图」 |

这几个视图是**懒加载的独立 chunk**（见下文「chunk 架构」），首屏不加载。

### 灵感库中英双语（新增）

> 以下能力是相对 0.2.3 的增量，上游 npm 包没有。

`awesome-gpt-image-2` 那 541 条案例原本只有英文 prompt。这里给它们配了中文译文，并在灵感库里加了全局语言开关：

| 能力 | 说明 |
|---|---|
| **页头 `中 / EN` 开关** | 切一次，整个灵感库的 prompt、分类名、风格名、场景名一起换语言，跟着存 localStorage |
| **检查器内小号开关** | 详情弹层 Prompt 标签右侧也有一个，和页头那个是同一个状态 |
| **对照模式** | Prompt 区右上角「对照」按钮，上下双框同时显示英文原文与中文译文 |
| **双语搜索** | 搜索框始终同时匹配标题、英文 prompt、中文译文，不受界面语言开关影响 |
| **复制永远给英文** | 界面上可能正显示中文，但「复制」和「用它生图」传给下游的一定是英文原文；复制按钮的 tooltip 写明了这点 |
| **缺译文自动回退** | 未翻译的案例在中文模式下显示英文原文 + 一行提示，不会出现空白框 |

**默认读哪种语言**：没手动选过时**跟随界面语言**（中文界面读中文、英文界面读英文），不把某种语言硬编码成默认；点过开关之后，那个选择记进 localStorage 并优先生效。

译文放在独立的覆盖层文件 `lib/inspiration/i18n/awesome-gpt-image-2.zh.json`（结构 `{ "<caseId>": "中文" }`），**不改动原始数据集**——上游更新数据集时覆盖层照样生效，缺的条目自动回退英文。`lib/inspiration.mjs` 在解析时把译文并进 case 的 `promptZh` / `promptPreviewZh` 字段，没有译文的 case 不带这两个键。

翻译遵守的规则：`[占位符]` 与英文双引号里要求「画面上真的出现」的文字保留原文、另加中文括注（否则等于改了画面内容）；数字、比例、专名（作者名 / 品牌名 / 流派名）保留；否定约束的强度不削弱；逐句对应，不做概括。

### 灵感图落盘缓存（新增）

数据集里只存相对路径，图片本体在上游 GitHub 仓库。本机只有 `gpt-image2.canghe.ai` 镜像可达，单张 1.5–3 秒，976 张合计约 100 MB——所以原版那套「内存缓存 100 条 / 10 分钟」一翻两屏就被淘汰干净，每次浏览都要重下几十 MB。

`fetchInspirationImageCached` 改成**内存 → 磁盘 → 外网**三级：

- 缓存目录 `$DSH_HOME/storages/dsh-doubao-image/inspiration-images/`（与画廊数据同级）。
- 文件名 `sha1(sourceId|version|imagePath)` + 原扩展名，不把数据集给的路径直接拼进文件系统。
- 读失败 / 空 / 超 12 MiB / 扩展名不认识 → 当未命中；写失败静默忽略。缓存只影响速度，不影响正确性。
- 实测：首次 2.3 s，落盘后再取 **3–9 ms**。

清理：直接删上面那个目录（界面的「清缓存」按钮只 revoke 内存里的 blob URL，不动磁盘）。

### 标签栏位置（新增）

对话页顶部那排标签来自 `conversation.view` 这个 **list 槽**：按 `priority` 再按 `order` 升序渲染。官方 `dsh-image-gen` 用 `order: 20`，本插件取 **22**：

| 标签 | id | order | 注册方 |
| --- | --- | --- | --- |
| 对话 | `chat` | 0 | 宿主（`app.asar`） |
| 轨迹 | `trajectory` | 10 | 宿主（`app.asar`） |
| 常见第三方视图 | — | 20 / 21 | 其他插件（如千星沙箱的模拟器、美术-图元工具） |
| 画廊 | `doubao-gallery` | **22** | 本插件 |
| 上下文 | `bili-context` | 30 | billion-context |

- `order` 撞值时相对次序取决于注册先后，画廊会随机夹在别人中间。取 22 是主动让开一格：排在常见视图（20 / 21）之后、「上下文」这类收尾视图（30）之前。
- 只改自己注册项的 order，不碰别人的注册项，也不依赖宿主的内部结构。

### 灵感图放大查看（新增）

灵感库的卡片只有 ~150px 宽，看不清图。卡片右上角、收藏星标左边多了一个半透明 🔍 按钮（悬停显形），点开是全屏大图：

| 操作 | 效果 |
| --- | --- |
| 点卡片上的 🔍 | 打开大图（样式与图库灯箱一致：深色遮罩 + 等比缩放的大图） |
| `←` `→` / 两侧箭头 | 上一张 / 下一张（按**屏幕上分组后的顺序**，不是数据集原始顺序） |
| 右上角 `×` / `Esc` / 点遮罩 | 收起 |

- **刻意不做缩放和平移**：这批案例图的用途是看清排版和画法，不是抠像素；滚轮 + 指针捕获 + 变换矩阵换来的收益不成比例。
- **刻意不带图库灯箱底部那条工具栏**（下载 / 复制图片 / 重新生成 / 关闭）：这是纯看图入口，要操作回卡片进检查器。所以关闭放在右上角一个 ×。
- 大图复用既有的图片代理与三级缓存（内存 → 磁盘 → 外网），不新增接口、不产生额外计费。
- 放大按钮 `stopPropagation`，点它只开弹层、不会顺带把卡片选中。

### 画廊位置记忆（新增）

以前每次点进「画廊」都回到图库首屏，翻到一半的列表和正在看的标签页都白翻了。现在会记住：

| 记住什么 | 说明 |
| --- | --- |
| 上次停在哪个标签页 | 图库 / 视频 / 工作台 / 灵感库，包括从灵感库点「用它生图」跳到工作台这一跳 |
| 每个标签页各自的滚动位置 | 分开记，互不覆盖；切回来时恢复到原来那一条 |

- 存在 localStorage 的 `dsh-dbi-gallery-view` 里，**不新增接口、不写 Host 侧状态**。清掉浏览器站点数据最多退回首屏。
- 滚动者是**按计算样式**（`overflow-y: auto | scroll`）在容器里找的，不写死类名——图库/视频滚的是 `.__dbi_g_pageBody`，灵感库滚的是它自己 chunk 的 `.__dbi_i_root`，工作台又是另一套。
- 内容异步加载，所以恢复位置会重试几拍（切回去瞬间 `scrollHeight` 还没长起来，直接赋值会被夹到 0）。
- 存档里的标签页 id 若已不存在（比如以后删掉某个标签），会安静退回图库首屏，不会渲染成一片空白。
- **灵感库走「锚点法」**：它是分页渲染的（首屏 60 张，「加载更多」要手点），切回来时容器里没有原来那么高的内容，像素无从还原。所以改记「停在哪个案例上」——卡片带 `data-case-id`，滚动停下后二分找出视口顶部那张，切回来时先把渲染窗口扩到含它、下面再留一页（否则锚点会停在视口底部而不是顶部），再用 `scrollTop` 精确对齐。锚点不在当前筛选结果里就安静回到顶部。
- 顺带把**目录**加了模块级缓存：这份目录 ~1.9 MB / 976 条，以前每次切回来都要重新拉一遍并重新分组；现在只在第一次和按「刷新」时拉取。

## 安装

两条安装路径，**优先用 npm**（快、不依赖 git）：

```
# npm（推荐）：约 5 秒
dsh plugin --profile <profile> add dsh-doubao-image-free

# GitHub：约 11 秒，需要本机有 git
dsh plugin --profile <profile> add github:LinLing4285/dsh-doubao-image-free
```

`<profile>` 取 `desktop`（桌面端）或 `web`（命令行 `dsh web`）。`dsh plugin` 会自动把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`。

> **桌面端用户注意**：桌面端（Electron）**不自带 PATH 里的 `dsh` 命令**。它的 CLI 在 `D:\DSH2\resources\runtime\cli\bin\dsh.cmd`（路径随安装位置变化），需要写完整路径调用。若用 `github:` 方式安装，还要求 `git` 在 PATH 里、且 **DSH 已完全退出**（否则 profile 的 `package.json` 被占用会失败）。
>
> 安装失败的常见原因是 `github:` 拉取不通时 DSH 会**回退到 npm 上的同名包**。本项目已改名为 `dsh-doubao-image-free` 避开这个坑；若你装到的是 `dsh-doubao-image`，那是 `xt765` 的另一个项目（见文首说明）。

安装后到「设置 → 插件 → dsh-doubao-image-free」完成登录。

> **Host 半改动不会热重载**。`index.js` 与 `lib/*.mjs` 只在 app 启动时加载一次（Node ESM 按 URL 缓存模块命名空间，禁用/启用插件只切换 cordis fiber）。改完必须**完全退出 DSH 再重开**，刷新页面不够。Client 半（`client*.js`）刷新即可，但 chunk 有缓存坑，见下文。

## 工具

插件注册两个工具给 Agent 调用：

- **`doubao_image`** — `{ prompt, size?, reference_images?, mode?, ratio?, duration? }`
  `mode` 取 `auto` / `generate` / `edit` / `video`；缺省时按有无参考图自动判断。
- **`gpt_image`** — `{ prompt }`（GPT 侧图生图走 `doubao_image` 的 `provider: "gpt"` + `reference_images`，该工具本身只接受提示词）

> 工具名刻意**不叫** `generate_image`。DSH 的工具注册在同一层不允许重名，而 `dsh-image-gen` 已占用 `generate_image` / `edit_image`，同名会让后来的注册直接失败并拖垮插件加载。

## 凭据存放

凭据存在 DSH `credentials` 服务的 record 半（`grant` payload），落盘 `$DSH_HOME/.credentials.yaml`，带文件锁与原子写：

- `dsh-doubao-image/doubao-session` — `{ cookieHeader, device, updatedAt }`（`device` 是豆包风控需要的设备指纹，登录时自动采集）
- `dsh-doubao-image/gpt-session` — `{ accessToken, cookieHeader, oaiDeviceId, updatedAt }`

> 这两条 scope 用的是改名前的 `dsh-doubao-image`，**故意没有跟着包名改成 `-free`**：scope 是用户数据的命名空间，改了等于把老用户的登录态全部作废。画廊落盘路径 `$DSH_HOME/storages/dsh-doubao-image/gallery.json` 同理。

服务不可用时插件降级为「设置页可看、工具报错」，不会崩。

## 已知限制

- **生视频**：与图片同源，走 `get_without_watermark` 换 `lr=unwatermarked` 的流（`body {vid:[vid]}`，注意视频要用 `vid` 而不是 `uri`）。取不到时回退到带水印文件并在结果里如实标注。设置页的「去掉视频水印」默认开；关掉则直接下带水印文件（部分平台要求标注 AI 生成来源时用）。消耗每日免费额度，故默认关闭。
- **GPT 侧登录**：Chrome 136 起 `--remote-debugging-port` 对默认用户数据目录失效，所以拉起的是**独立 user-data-dir 的全新 Edge 窗口**，需要在新窗口里重新登录一次，无法复用日常浏览器的登录态。不想重登就用手工粘贴 Token（约 2 周一次）。
- **豆包比例**：只有 1:1 / 4:3 / 16:9 / 9:16 四档，输出固定 2048px 长边，`size` 不精确控制像素。
- **图生图语义**：豆包这条通路是「参考引导的重新生成」，**不保持原构图、背景与视角**；GPT 侧保留度更高但也不是像素级编辑。
- **依赖私有接口**：平台改版即失效。
- **本机同源校验不是鉴权**：所有 HTTP 路由都校验 `Host` 必须是回环、`sec-fetch-site` 只接受 `same-origin` / `none`，这挡的是**浏览器侧 CSRF**（任意网页偷偷调你的插件接口）。但本机任意进程（curl、PowerShell、脚本）可以伪造 `sec-fetch-site: same-origin` 直接打到接口，要彻底收口需要 token 级鉴权。**机器上有不受信任的进程时，别把它当保护。**

## 未验证项（如实记录）

- accessToken 的精确过期周期（经验值约 2 周，未做长期跟踪）
- 豆包 4:3 / 16:9 / 9:16 三档比例（只实测过 1:1 与 16:9）
- 灵感库 976 条案例：已逐条取过一次（976/976 成功，落盘缓存约 100 MB），但没有逐条与其上游仓库比对内容

已由真实账号 / 真实浏览器验证过的：豆包文生图、图生图、生视频（5.06s HEVC 1280×720 + AAC）；GPT 免费账户文生图（`gpt-5-3`）与图生图（参考图上传 → multimodal 引用 → 输出保留主体改背景）；全部 HTTP 路由在真实运行时跑通；三个 chunk 在真实浏览器里挂载成功（tldraw 正常加载）。

## 结构

```
index.js               Host 半：工具注册、HTTP 路由、Edge 登录编排
client.js              Client 半（单文件，免构建）：设置页 + 结果卡片 + 提升节点 + shared 运行时
client.gallery.js      画廊 chunk（顶层 tabs 容器）
client.inspiration.js  灵感库 chunk
client.studio.js       工作台 chunk（tldraw 画布）
client.tldraw.js       tldraw 构建产物（1.9 MB）
lib/doubao.mjs         豆包协议入口（转发到下面几个模块）
lib/doubao-core.mjs    豆包协议公共层：请求头、SSE 解析、敏感信息脱敏
lib/doubao-image.mjs   豆包文生图 / 图生图
lib/doubao-video.mjs   豆包生视频（提交 → 轮询 → 下载）
lib/doubao-identity.mjs 设备指纹采集与校验
lib/doubao-device.mjs  设备参数拼装
lib/doubao-upstream.mjs 上游接口地址与版本常量
lib/doubao-diag.mjs    诊断（账号 / 会话 / 网络自检）
lib/gpt-free.mjs       ChatGPT 免费账户生图（含 PoW、TLS 指纹、参考图上传）
lib/pow.mjs            ChatGPT sentinel PoW 求解器（含纯 JS SHA-3 回退）
lib/cdp.mjs            CDP 客户端（node 内置 WebSocket，无 puppeteer）
lib/browser-login.mjs  拉起 Edge 完成登录
lib/browser-image.mjs  浏览器内取图
lib/credential-browser.mjs 浏览器侧凭据抓取
lib/credential-renew.mjs   凭据续期策略
lib/credential-sync.mjs    凭据与 DSH credentials 服务同步
lib/sessions.mjs       账号池与凭据存取封装
lib/gallery-store.mjs  画廊服务端持久化
lib/inspiration.mjs    灵感库数据集加载 + 译文覆盖层合并 + 远程图片代理（含落盘缓存）
lib/inspiration/i18n/awesome-gpt-image-2.zh.json  awesome-gpt-image-2 的中文译文覆盖层（可选增强，缺了退纯英文）
```

**`client.js` 必须保持单文件**：DSH 只加载 `exports["./client"]` 指向的那一个文件。**不要**把主 bundle 的实现拆成 `client/xxx.js`——浏览器不会去加载它，代码会静默变成死代码（画廊就踩过这个坑）。

## chunk 架构

除主 bundle 外还有 4 个懒加载 chunk。DSH 原生支持包内 chunk：

```js
window.__ModuleLoader__.load({
  id: "dsh-doubao-image-free",      // 必须是包名
  chunk: "client.gallery.js",  // 必须是文件名
  factory: (require) => { /* ... */ exports.Mount = Mount; },
});
```

服务端按 `/plugins/<包名>/<文件名>?rev=<rev>` 提供，文件必须匹配 `/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`。

**chunk 缓存坑（实测，附可用的绕法）**：`?rev=` 是 **`client.js` 的 `mtimeMs + ctimeMs + size`**（`dsh-client-modules` 的 `artifactRevision`，注释里写明「不哈希产物内容」），**改 chunk 内容不会改变 rev**。于是服务端按「含 rev 的 URL」缓存响应、浏览器也按同一 URL 缓存，改完 chunk 后直接 fetch 拿到的还是旧字节。

- 症状：改完 chunk 后页面行为不变，`GET /plugins/<包名>/client.<name>.js` 返回的长度/内容都是旧的。
- **正确绕法（不需要重启 Host）**：改完任意 `client.*.js` 后，**把 `client.js` 的 mtime 戳一下**（`(Get-Item client.js).LastWriteTime = Get-Date`），rev 就会变成新的；再 POST `/dsh-unlag/reload`，日志出现 `served <包名> (rev … → <新rev>)` 即生效。这正是官方构建脚本的做法（「The shared preset stamps `client.js` after every package output is written」）。
- 反例：只 touch chunk 自己的 mtime 没用；用 `?rev=<旧值>&t=时间戳` 也不会绕过（未知 rev 直接 404）。
- 目前确认有效的旧办法只有重启 Host（清 `this.responses` 里按 rev 的缓存），但会打断会话，应优先用上面的戳法。

chunk 之间通过 `globalThis.__dshDoubaoImageShared` 共享运行时（react / 取图 hook / 画廊持久层 / `useChunk` / `ChunkMount` / `injectCss`），不要各自复制一份。每个 chunk 自带 zh/en 字典。

## 实现要点

- **TLS 指纹**：Node 默认 TLS 栈请求 `chatgpt.com` 会被 Cloudflare 403，与请求头、出口 IP 无关，只由 ClientHello 指纹决定。给 `tls.connect` 传一份 Chrome cipher 列表即可（见 `lib/gpt-free.mjs` 的 `CHROME_CIPHERS`），不需要 uTLS 或浏览器。
- **SHA-3 回退**：ChatGPT 的 PoW 用 `sha3-512`。官方 Node 走 OpenSSL 3.x 原生支持，但 **Electron 用的是 Chromium 的 BoringSSL，不提供 SHA-3**（`createHash("sha3-512")` 直接抛 `Digest method not supported`）。`lib/pow.mjs` 因此内置了纯 JS Keccak-f[1600] 实现，加载时探测原生能力，不支持就自动回退。
- **图片渲染**：内置 image 卡只认 `read_image`（`dsh-client-ui-tool/lib/client.js` 硬判工具名）。普通工具返回 `{type:"image"}` 块**没有任何渲染器**，图会被静默丢弃；而如果 `render()` 返回了 image 块，内置的助手消息渲染器**又会画一次**，导致同一张图显示两遍。所以本插件的 `render()` **只返回文本**，图片走 `presentationMeta` → 自注册的 `tool.call.toolview` 卡片 + `conversation.chat.node` 提升节点。
- **视频引用是文件引用**：宿主 `attachments.saveFile` 只回 `attachmentId` / `name` / `bytes`，没有 `mediaType` 与宽高，和图片的 `ImageAttachmentRef` 不是同一个形状。所以视频走独立的 `/api/video` 路由（`ctx.attachments.readFileStream`），不能复用 `/api/image`（那个要 `readImage` 且校验图片类型）。

## 参考实现

本插件是协议复刻，实现过程中参考了下面这些开源项目（按能力分组）。**代码为本项目独立编写**，参考的是它们对上游私有接口的调用方式、字段形状与算法细节；各项目版权归其作者所有，遵循各自的许可证。

**ChatGPT 侧**（sentinel 两步流程、PoW 求解、turnstile 求解、会话请求体字段、参考图上传）

- [basketikun/chatgpt2api](https://github.com/basketikun/chatgpt2api) — Python 实现。PoW 与 turnstile 求解器的算法细节、`/sentinel/chat-requirements/prepare` + `/finalize` 两步流程、`/files` 三段式图片上传、conversation body 的必需字段，主要参考此项目。
- [fran0220/chatgpt2api](https://github.com/fran0220/chatgpt2api) — Go 实现。`lib/gpt-free.mjs` 的请求头与 PoW 配置槽位对齐此版本；其注释中「用 `/backend-api/conversation` 而非 `/f/conversation`，PoW 即可跑通」的判断与本项目实测一致。

**豆包侧**（会话接口、SSE 事件结构、会话清理时机）

- [Bitsea1/doubao-free-api](https://github.com/Bitsea1/doubao-free-api)（作者 Vinlic）— TypeScript 实现。豆包 SSE 事件形状与「流传输完成后立刻 `removeConversation`」的清理时机参考此项目。
- [lzA6/doubao-2api](https://github.com/lzA6/doubao-2api) — Python 实现。多账号池与请求参数拼装的写法参考此项目。

**数据集**

- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2) — 提示词案例集
- [yang0/handraw-style](https://github.com/yang0/handraw-style) — 手绘风格案例集

两份数据集已内置于 `lib/inspiration/`，插件运行时按 `repository` 字段回源取图（经 `gh-proxy` 镜像）。

如果上面的归属或链接有误，欢迎开 issue 指出，我会更正。

## 许可

MIT
