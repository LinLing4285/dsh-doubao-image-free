# dsh-doubao-image-free

把**网页版豆包**与**网页版 ChatGPT 免费账户**的生图能力接进 [DeepSeek Harness](https://github.com/deepseek-ai) 的插件。在插件设置页里扫码或粘贴凭据即可使用，带自建画廊、灵感库与 tldraw 工作台。

> **和 npm 上的 `dsh-doubao-image` 不是同一个项目。** 那个包的作者是 `xt765`，注册 `doubao_generate_image` / `doubao_image_status`，依赖 Tabbit CLI 驱动浏览器。本项目注册 `doubao_image` / `gpt_image`，走纯 HTTP，不依赖任何外部 CLI。安装时请认准包名带 `-free` 后缀。

> 面向个人自用。走的是网页端私有接口的协议复刻，**可能违反平台服务条款**，请自行评估账号风险。

## 功能

| 能力 | 豆包 | ChatGPT 免费账户 |
|---|---|---|
| 文生图 | ✅ 2048px 无水印原图 | ✅ 已实测出图 |
| 图生图 | ✅ 参考图引导重生成 | ✅ 参考图上传 + multimodal 引用 |
| 生视频 | ✅ 默认关闭（消耗付费额度） | ❌ |
| 登录方式 | 扫码（纯 HTTP，无需浏览器） | 拉起 Edge 自动抓取 / 手工粘贴 Token |

设置页提供：豆包扫码登录、Cookie 手工粘贴、GPT 拉起 Edge 登录、accessToken 粘贴、代理地址、超时与默认尺寸、视频开关、画廊开关。

### 对话页的「画廊」视图

会话页顶部的「画廊」标签（`conversation.view` 槽）里再分四个顶层 tab：

| tab | 内容 |
|---|---|
| **图库** | 图片生成历史：搜索、来源筛选（豆包 / GPT / 导入）、比例筛选、排序、工作区过滤、收藏夹、批量管理、导入本地图、灯箱 |
| **视频** | 视频生成历史：首帧缩略图 + 灯箱播放，支持批量下载（不进工作台参考图） |
| **工作台** | tldraw 无限画布，可把画廊里的图放上去，画布状态存 localStorage |
| **灵感库** | 内置 976 条提示词案例（两个上游数据集），三级筛选 + 搜索 + 详情弹层 +「用它生图」 |

这几个视图是**懒加载的独立 chunk**（见下文「chunk 架构」），首屏不加载。

## 安装

```
dsh plugin --profile <profile> add github:LinLing4285/dsh-doubao-image-free
```

`<profile>` 取 `desktop`（桌面端）或 `web`（命令行 `dsh web`）。`dsh plugin` 会自动把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`。

安装后到「设置 → 插件 → dsh-doubao-image-free」完成登录。

> **Host 半改动不会热重载**。`index.js` 与 `lib/*.mjs` 只在 app 启动时加载一次（Node ESM 按 URL 缓存模块命名空间，禁用/启用插件只切换 cordis fiber）。改完必须**完全退出 DSH 再重开**，刷新页面不够。Client 半（`client*.js`）刷新即可，但 chunk 有缓存坑，见下文。

## 工具

插件注册两个工具给 Agent 调用：

- **`doubao_image`** — `{ prompt, size?, reference_images?, mode?, ratio?, duration? }`
  `mode` 取 `auto` / `generate` / `edit` / `video`；缺省时按有无参考图自动判断。
- **`gpt_image`** — `{ prompt, reference_images? }`

> 工具名刻意**不叫** `generate_image`。DSH 的工具注册在同一层不允许重名，而 `dsh-image-gen` 已占用 `generate_image` / `edit_image`，同名会让后来的注册直接失败并拖垮插件加载。

## 凭据存放

凭据存在 DSH `credentials` 服务的 record 半（`grant` payload），落盘 `$DSH_HOME/.credentials.yaml`，带文件锁与原子写：

- `dsh-doubao-image/doubao-session` — `{ cookieHeader, device, updatedAt }`（`device` 是豆包风控需要的设备指纹，登录时自动采集）
- `dsh-doubao-image/gpt-session` — `{ accessToken, cookieHeader, oaiDeviceId, updatedAt }`

> 这两条 scope 用的是改名前的 `dsh-doubao-image`，**故意没有跟着包名改成 `-free`**：scope 是用户数据的命名空间，改了等于把老用户的登录态全部作废。画廊落盘路径 `$DSH_HOME/storages/dsh-doubao-image/gallery.json` 同理。

服务不可用时插件降级为「设置页可看、工具报错」，不会崩。

## 已知限制

- **生视频**：豆包对视频烧服务端水印，**没有免水印通路**（与图片不同）。且消耗付费额度，故默认关闭。
- **GPT 侧登录**：Chrome 136 起 `--remote-debugging-port` 对默认用户数据目录失效，所以拉起的是**独立 user-data-dir 的全新 Edge 窗口**，需要在新窗口里重新登录一次，无法复用日常浏览器的登录态。不想重登就用手工粘贴 Token（约 2 周一次）。
- **豆包比例**：只有 1:1 / 4:3 / 16:9 / 9:16 四档，输出固定 2048px 长边，`size` 不精确控制像素。
- **图生图语义**：豆包这条通路是「参考引导的重新生成」，**不保持原构图、背景与视角**；GPT 侧保留度更高但也不是像素级编辑。
- **依赖私有接口**：平台改版即失效。

## 未验证项（如实记录）

- accessToken 的精确过期周期（经验值约 2 周，未做长期跟踪）
- 豆包 4:3 / 16:9 / 9:16 三档比例（只实测过 1:1 与 16:9）
- 灵感库 976 条案例只抽查过若干张图片可达，未逐条验证

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
lib/inspiration.mjs    灵感库数据集加载 + 远程图片代理
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

**chunk 缓存坑（实测）**：`?rev=` 是 `client.js` 的 `mtime+size` 哈希（`dsh-client-modules/lib/index.js` 的 `artifactRevision`），**改 chunk 内容不会改变 rev**。于是浏览器缓存与服务端 `this.responses`（按含 rev 的 URL 缓存）都会继续用旧内容。症状：改完 chunk 后页面行为不变，直接 fetch chunk URL 拿到的是旧字节数。**改 chunk 后必须重启 Host**（清服务端缓存），浏览器侧用 DevTools 勾 Disable cache 或硬刷新。

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
