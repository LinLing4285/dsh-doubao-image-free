/**
 * 生视频：走桌面 GUI 协议（`/chat/completion` + 轮询 `/im/message/chain_by_block`）。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
/* -------------------------------------------------------------------- 视频 */

import { randomUUID } from "node:crypto";

import { BLOCK_CREATION_OUTPUT, DEFAULT_VIDEO_MODEL, DOUBAO_BASE, DOUBAO_RATIOS, DOUBAO_VIDEO_RATIOS, IM_CHAIN_PATH, NOWM_PATH, UA, VIDEO_BOT_ID, VIDEO_CHAT_PATH, VIDEO_DIRECTIVE, extractConversationId, normalizeVideoModel, parseCookieHeader, safeSnippet, sleep, toRatio } from "./doubao-core.mjs";
import { videoSecurityParams } from "./doubao-upstream.mjs";

/**
 * 参考图 → `attachment_block.attachments[]` 的一项。
 *
 * 与图生图（`editRequestBodyV2`）完全同构，因为服务端认的就是这个形状。
 * `image_ori` 的宽高留 0 不影响图生视频：2026-10-23 实测参考图是
 * 512x512 几何图时上传返回 `width:0`，图生视频仍正确还原了参考图内容
 * （见下方 `videoRequestBody` 的实测记录）。
 */
export function videoAttachment({ uri, meta }, index = 0) {
  const ext = (meta?.format || "png").toLowerCase();
  const name = `reference-${index + 1}.${ext}`;
  return {
    type: 1,
    identifier: randomUUID(),
    name,
    image: {
      uri,
      name,
      image_ori: {
        url: "",
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        format: ext,
        url_formats: {},
      },
    },
    parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: "",
  };
}

/**
 * 视频请求体。
 *
 * ## 参考图（图生视频）2026-10-23 实测
 *
 * 关键点：**参考图必须单独占一条 message，不能和文本块塞进同一条**。
 *
 * 两种写法都返回 HTTP 200 + 完整「1-3 分钟」话术，靠 SSE 看不出区别，
 * 但只有分开写才会真的按参考图生成：
 *   - 同一条 message 里 `[10052 附件块, 10000 文本块]`  → 忽略参考图，
 *     纯按提示词出片（实测：几何图 + 猫提示词 → 出猫）。
 *   - 两条 message（先附件、后文本）→ 参考图生效（实测：同一张几何图
 *     + 匹配提示词 → 输出的 384x384 视频完整保留洋红/青/黄/绿四色构图）。
 *
 * 这个坑很隐蔽：服务端在两种写法下都会回显 attachment_block 并生成
 * 缩略图 URL，看上去「收到了」，只有出片内容能分辨。
 *
 * ## 画幅
 *
 * 有参考图时 `ratio` 被**服务端忽略**，实际画幅跟随参考图（512x512 的
 * 参考图出 384x384 正片，644x1260 的出 384x682）。调用方不要把回显的
 * ratio 当成结果画幅，必须从下载到的字节量。
 */
export function videoRequestBody(prompt, { ratio, duration, model, references = [] }) {
  const attachmentBlock = references.length > 0
    ? {
      local_message_id: randomUUID(),
      content_block: [{
        block_type: 10052,
        content: {
          attachment_block: {
            attachments: references.map((r, i) => videoAttachment(r, i)),
            pc_event_block: "",
          },
        },
        block_id: randomUUID(), parent_id: "", meta_info: [], append_fields: [],
      }],
      message_status: 0,
    }
    : null;
  return {
    // 新会话必须用空 conversation_id + local_conversation_id 声明，缺
    // client_meta 会被回以 STREAM_ERROR 710020202「common invalid param」。
    client_meta: {
      local_conversation_id: "local_" + Date.now(),
      conversation_id: "",
      bot_id: VIDEO_BOT_ID,
      last_section_id: "",
      last_message_index: null,
      local_permissions: [
        { permission_name: "ACCESS_COARSE_LOCATION", status: 1 },
        { permission_name: "ACCESS_FINE_LOCATION", status: 1 },
        { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 1 },
      ],
    },
    messages: attachmentBlock ? [attachmentBlock, {
      local_message_id: randomUUID(),
      content_block: [
        {
          block_type: 10000,
          content: {
            text_block: {
              text: `生成视频：${prompt}，${duration}s`,
              icon_url: "", icon_url_dark: "", summary: "",
            },
            pc_event_block: "",
          },
          block_id: randomUUID(), parent_id: "", meta_info: [], append_fields: [],
        },
      ],
      message_status: 0,
    }] : [
      {
        local_message_id: randomUUID(),
        content_block: [
          {
            block_type: 10000,
            content: {
              text_block: {
                text: `生成视频：${prompt}，${duration}s`,
                icon_url: "", icon_url_dark: "", summary: "",
              },
              pc_event_block: "",
            },
            block_id: randomUUID(), parent_id: "", meta_info: [], append_fields: [],
          },
        ],
        message_status: 0,
      },
    ],
    option: {
      send_message_scene: "", create_time_ms: Date.now(),
      answer_with_suggest: false, tts_switch: false, need_deep_think: 0,
      unique_key: randomUUID(), start_seq: 0,
      need_create_conversation: true, message_from: 0,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: "0", reasoning_effort: "3", mode_id: "1" },
      conversation_mode: 1, agent_mode: 2,
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true, is_old_user: true,
      general_task_param: {
        runtime_type: 0, agent_task_param: {}, agent_task_param_change: {},
        project_id: "", need_modify_conversation: false,
      },
      recovery_option: {
        is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      message_storage_type: 0,
      model_config: { model_item_key: "0", model_extra_params: {}, reasoning_effort: 3 },
      aggregate_params: {
        mention_skill_list: "[]", mention_plugin_list: "[]", mention_ext: "[{}]",
        conversation_mode: "1", mode_id: "1", model_item_key: "0",
        agent_mode: "2", reasoning_effort: "3", provider_id: "",
      },
    },
    // ability_param 是 JSON 字符串，不是对象。
    chat_ability: {
      ability_type: 17,
      ability_param: JSON.stringify({
        ratio, model, duration,
        input_box_content: { user_input_content: prompt, reply_message_format: "生成视频：%s" },
      }),
    },
    user_context: [],
    ext: {
      agent_mode: "2", use_deep_think: "0", sub_conv_firstmet_type: "1",
      answer_with_suggest: "0",
      conversation_init_option: JSON.stringify({ need_ack_conversation: true }),
      general_task_param: JSON.stringify({
        runtime_type: 0, agent_task_param: {}, agent_task_param_change: {},
        project_id: "", need_modify_conversation: false,
      }),
      collection_id: "", is_finish: "1", commerce_credit_config_enable: "0",
    },
  };
}

/** 用桌面安全参数向新 GUI 端点发请求。 */
export async function guiPost(cookieHeader, path, body, { stream = false, timeoutMs = 120_000, identity = {} } = {}) {
  const res = await fetch(
    `${DOUBAO_BASE}${path}?${new URLSearchParams(videoSecurityParams(identity))}`,
    {
      method: "POST",
      headers: {
        "User-Agent": `${UA} SamanthaDoubao/2.31.4`,
        // 尾部 `encoding=utf-8` 是必需的：缺了它 IM 端点回 712012002 不支持编码类型。
        "Content-Type": "application/json; encoding=utf-8",
        Cookie: cookieHeader,
        Origin: DOUBAO_BASE,
        Referer: "chrome://doubao-chat/",
        "Agw-Js-Conv": "str",
        Accept: stream ? "text/event-stream" : "application/json, text/plain, */*",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  return { status: res.status, ct: res.headers.get("content-type"), text: await res.text() };
}

/** 从提交响应里捞出 STREAM_ERROR / gateway-error。 */
export function extractStreamError(sseText) {
  for (const block of sseText.split("\n\n")) {
    const isErr = /^event:\s*(STREAM_ERROR|gateway-error)/m.test(block);
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const raw = dataLine.slice(5).trim();
    if (!isErr) continue;
    try {
      const j = JSON.parse(raw);
      return `code=${j.error_code ?? j.code ?? ""} ${j.error_msg ?? j.message ?? raw}`.slice(0, 400);
    } catch {
      return raw.slice(0, 400);
    }
  }
  return null;
}

/** 从 IM 链回复里摊平所有 creation_block.creations[].video。 */
export function extractVideos(imText) {
  let msgs = [];
  try {
    msgs = JSON.parse(imText)?.downlink_body
      ?.pull_message_chain_by_block_downlink_body?.messages ?? [];
  } catch {
    return [];
  }
  const videos = [];
  for (const m of msgs) {
    let blocks = m.content;
    if (typeof blocks === "string") {
      try { blocks = JSON.parse(blocks); } catch { continue; }
    }
    for (const b of blocks ?? []) {
      for (const c of b.content?.creation_block?.creations ?? []) {
        if (c.video?.vid) videos.push(c.video);
      }
    }
  }
  return videos;
}

/**
 * 提交视频任务并返回会话 id。
 *
 * 豆包会立刻回 HTTP 200 然后异步渲染（5 秒片段约 2-3 分钟），
 * 所以必须轮询。注意端点是 `/chat/completion`，不是图片用的
 * `/samantha/chat/completion`。
 *
 * `opts.references` 是已上传的参考图（`{uri, meta}` 数组），为空时是
 * 纯文生视频，非空时是图生视频 —— 差别只在请求体里是否多一条附件消息，
 * 端点与轮询完全一致。
 */
async function doubaoSubmitVideo(cookieHeader, prompt, opts, identity = {}) {
  const text = `${prompt.replace(/[。.\s]+$/, "")}。${VIDEO_DIRECTIVE}`;
  const res = await guiPost(cookieHeader, VIDEO_CHAT_PATH, videoRequestBody(text, opts), {
    stream: true,
    timeoutMs: 120_000,
    identity,
  });
  if (res.status !== 200) {
    const err = new Error(`豆包视频提交 HTTP ${res.status}：${safeSnippet(res.text)}`);
    err.status = res.status;
    throw err;
  }
  const streamError = extractStreamError(res.text);
  if (streamError) {
    const err = new Error(`豆包视频提交被拒：${streamError}`);
    err.gateway = true;
    throw err;
  }
  const convId = extractConversationId(res.text);
  if (!convId) {
    const err = new Error(`豆包视频提交未创建会话（${res.text.length} 字节 SSE）`);
    err.noImage = true;
    throw err;
  }
  return { conversationId: convId, sseBytes: res.text.length };
}

/** 轮询 IM 链，直到出现已完成（status 3）的视频。 */
async function doubaoPollVideo(cookieHeader, conversationId, { pollMs, timeoutMs, onProgress, identity = {} }) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    attempt++;
    const res = await guiPost(cookieHeader, IM_CHAIN_PATH, {
      cmd: 3501,
      uplink_body: {
        pull_message_chain_by_block_uplink_body: {
          block_type_list: [BLOCK_CREATION_OUTPUT],
          conversation_id: conversationId,
          limit: 30,
        },
      },
      sequence_id: randomUUID(),
      channel: 2,
      version: "1",
    });
    if (res.status !== 200) {
      throw new Error(`豆包 IM chain HTTP ${res.status}：${safeSnippet(res.text)}`);
    }
    const videos = extractVideos(res.text);
    last = videos.map((v) => v.status).join(",");
    const done = videos.find((v) => v.status === 3);
    if (done) return { video: done, attempts: attempt };
    const failed = videos.find((v) => v.status === 4);
    if (failed) throw new Error(`豆包视频任务失败（vid=${failed.vid}）`);
    // 状态枚举：0 未知、1 排队、2 生成中、3 成功、4 失败。
    if (onProgress) onProgress({ attempt, elapsedMs: attempt * pollMs, statuses: last });
  }
  throw new Error(
    `豆包视频未在 ${Math.round(timeoutMs / 1000)} 秒内完成` +
    `（会话 ${conversationId}，最后状态 "${last}"）`,
  );
}

/**
 * 向豆包换取**无水印**视频地址。
 *
 * 走的是网页版「保存/下载」按钮的同一条通路：`POST
 * /creativity/resource/get_without_watermark`，body 是 `{vid: [...]}`
 * （注意**不是**图片用的 `{uri: [...]}`）。
 *
 * 2026-10-23 实测（账号 李鬼，会话 38448663437278978，vid
 * v0369cg10004dbcua827dld5rnc6r51g）：
 *   - `{uri: [vid]}` → 只回 `{"without_watermark": true}`，**没有 URL**。
 *     这是之前误判「视频不能去水印」的根因。
 *   - `{vid: [vid]}` → 回 `data.download_video[vid].download_url`，
 *     其 `lr=unwatermarked`，抽帧目视确认无水印。
 *   - query 参数全部可省（`aid` 都不需要），只靠 Cookie 鉴权。
 *
 * 失败返回 null，由调用方回退到带水印的 download_url —— 去水印是增强，
 * 不该让已经生成好的视频拿不到。
 *
 * @returns {Promise<{url: string, model: object|null, duration: number|null} | null>}
 */
export async function doubaoVideoNoWatermarkUrl(cookieHeader, vid, timeoutMs = 30_000) {
  if (typeof vid !== "string" || vid === "") return null;
  try {
    const res = await fetch(`${DOUBAO_BASE}${NOWM_PATH}`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Origin: DOUBAO_BASE,
        Referer: `${DOUBAO_BASE}/chat`,
        Cookie: cookieHeader,
        "Agw-Js-Conv": "str",
      },
      body: JSON.stringify({ vid: [vid] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json?.data?.download_video?.[vid];
    if (typeof entry?.download_url !== "string" || entry.download_url === "") return null;
    let model = null;
    try { model = JSON.parse(entry.video_model ?? "{}"); } catch { /* 缺模型信息不影响下载 */ }
    return {
      url: entry.download_url,
      model,
      duration: typeof entry.duration === "number" ? entry.duration : null,
    };
  } catch {
    return null;
  }
}

/**
 * 取可下载的 mp4 地址（**带水印**的兜底通路）。
 *
 * `video_model` 本身是 JSON 字符串，其 video_list.*.main_url 是
 * base64 编码的，download_url 缺失时用它兜底。两者都带
 * lr=video_gen_watermark_dyn。优先用 `doubaoVideoNoWatermarkUrl`
 * 换无水印地址，拿不到时才落到这里。
 */
export function videoDownloadUrl(video) {
  if (typeof video.download_url === "string" && video.download_url) return video.download_url;
  try {
    const vm = JSON.parse(video.video_model ?? "{}");
    const list = vm?.video_list ?? {};
    for (const entry of Object.values(list)) {
      for (const field of ["main_url", "backup_url_1", "backup_url_2"]) {
        if (typeof entry?.[field] === "string" && entry[field]) {
          return Buffer.from(entry[field], "base64").toString("utf8");
        }
      }
    }
  } catch { /* 落到 null */ }
  return null;
}

/**
 * 真实输出分辨率。
 *
 * creation block 上的 video.width/height 是预览档（恒为 384x216），
 * 不是你实际下载到的文件。真实数字在 video_model.video_list 里。
 */
export function videoDimensions(video) {
  try {
    const vm = typeof video.video_model === "string"
      ? JSON.parse(video.video_model ?? "{}")
      : video.video_model ?? {};
    let best = null;
    for (const entry of Object.values(vm?.video_list ?? {})) {
      const w = Number(entry?.vwidth);
      const h = Number(entry?.vheight);
      if (!w || !h) continue;
      const bitrate = Number(entry?.bitrate ?? 0);
      if (!best || bitrate > best.bitrate) best = { w, h, bitrate };
    }
    if (best) return { width: best.w, height: best.h };
  } catch { /* 回退到 block 自带值 */ }
  return { width: video.width ?? null, height: video.height ?? null };
}

async function downloadVideo(url, timeoutMs = 300_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`视频下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // mp4（以及多数 ISO-BMFF）文件在偏移 4 处有 ftyp box。
  if (buf.length < 12 || buf.toString("ascii", 4, 8) !== "ftyp") {
    throw new Error(`下载内容不是 mp4（${buf.length} 字节）`);
  }
  return { buf, mime: "video/mp4" };
}

/**
 * 决定「下哪一个文件」以及「标记成什么水印状态」。
 *
 * 抽成纯函数是为了可测：回退逻辑（去水印失败仍要出片）、用户主动关水印、
 * `watermarkFree` 的取值都是容易写错、又不容易在端到端里暴露的地方。
 *
 * @param {{url: string, model: object|null}|null} nowm  无水印通路结果
 * @param {object} video                                  带水印的 creation block
 * @returns {{url: string, watermarkFree: boolean, model: object|null}}
 */
export function chooseVideoSource(nowm, video) {
  if (nowm?.url) {
    return { url: nowm.url, watermarkFree: true, model: nowm.model ?? null };
  }
  const fallback = videoDownloadUrl(video);
  return { url: fallback, watermarkFree: false, model: null };
}

/**
 * 该不该向豆包要无水印地址。
 *
 * 单独抽出来是为了让「关掉开关就不该发这次请求」可被单测直接验证——
 * 否则只能靠端到端观察「有没有多一次请求」，而端到端里那次请求失败
 * 也会回退成功，症状完全一样，看不出来。
 *
 * 默认（含 undefined / null）视为**要**去水印：老配置文件里没有这个字段，
 * 升级后应当拿到与之前一样（其实更好）的结果，而不是突然变回带水印。
 *
 * @param {boolean|undefined} removeWatermark
 * @returns {boolean}
 */
export function shouldRequestNoWatermark(removeWatermark) {
  return removeWatermark !== false;
}

/**
 * 视频结果里那句「水印怎么样」。
 *
 * 三种情况必须分开说，否则用户无法判断该不该去设置里改开关：
 *   1. 拿到了无水印流         → 「无水印。」
 *   2. 开关关着（用户要带水印）→ 「按设置保留豆包水印。」
 *   3. 开关开着但没换到地址   → 明说回退了
 *
 * 第 3 种是真正需要用户注意的：他以为开了开关就没水印，实际没生效。
 *
 * 放 lib 而不是 index.js：这是纯展示逻辑，放在这里能被
 * video-nowm-self-test 直接覆盖（变异脚本只复制 lib + test）。
 *
 * @param {{watermarkFree?: boolean}|null} result
 * @param {boolean|undefined} removeWatermark
 * @returns {string}
 */
export function describeVideoWatermark(result, removeWatermark) {
  if (result?.watermarkFree === true) return "无水印。";
  if (removeWatermark === false) return "按设置保留豆包水印。";
  return "带豆包水印（无水印通路未取到地址，已回退到带水印文件）。";
}

/** 同一账号一次只跑一个付费视频任务（账号走计量额度）。 */
let videoLock = Promise.resolve();

/**
 * 文生视频 / 图生视频。
 *
 * @param {object} opts
 * @param {string} opts.cookieHeader
 * @param {string} opts.prompt
 * @param {string} [opts.ratio]     auto/1:1/4:3/16:9/9:16/21:9，或 OpenAI 尺寸
 * @param {number} [opts.duration]  1-10 秒，默认 5
 * @param {string} [opts.model]     默认 seedance_v2.0_mini
 * @param {Array<{uri: string, meta: object}>} [opts.references]
 *        图生视频的参考图（先用 `uploadToDoubao` 上传拿 `{uri, meta}`）。
 *        非空即走图生视频：**画幅跟随参考图，`ratio` 会被服务端忽略。**
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]
 * @param {(p: object) => void} [opts.onProgress]
 */
export async function generateVideo({
  cookieHeader, prompt, ratio, duration, model, references,
  device, msToken,
  removeWatermark = true,
  pollMs = 10_000, timeoutMs = 900_000, onProgress,
}) {
  /** 见 generateImage 里的同名说明：身份随请求走，不读模块单例。 */
  const identity = { device, msToken };
  const text = String(prompt ?? "").trim();
  if (!text) throw new Error("prompt 不能为空");
  if (!parseCookieHeader(cookieHeader).sessionid) {
    throw new Error("缺少 sessionid：请先在插件设置页完成豆包登录");
  }

  const wanted = String(ratio ?? "auto").trim();
  const finalRatio = DOUBAO_VIDEO_RATIOS.includes(wanted) ? wanted : toRatio(wanted, DOUBAO_RATIOS);
  const finalDuration = Math.min(10, Math.max(1, Number(duration) || 5));
  /*
   * 视频模型也吸附到白名单：服务端收到未知模型名会「HTTP 200 但不出片」，
   * 那种失败既没有报错也没有产物，最难排查。入口就收紧成两档之一。
   */
  const finalModel = normalizeVideoModel(String(model ?? DEFAULT_VIDEO_MODEL));
  // 只保留形状正确的参考图，避免半截对象进请求体被服务端当无效附件。
  const refs = Array.isArray(references)
    ? references.filter((r) => typeof r?.uri === "string" && r.uri !== "")
    : [];

  // 串行化：并发第二个任务会双倍消耗计量额度。
  const run = videoLock.then(async () => {
    const submit = await doubaoSubmitVideo(cookieHeader, text, {
      ratio: finalRatio, duration: finalDuration, model: finalModel, references: refs,
    }, identity);
    const { video, attempts } = await doubaoPollVideo(cookieHeader, submit.conversationId, {
      pollMs, timeoutMs, onProgress, identity,
    });

    /**
     * 优先走无水印通路（网页「保存」按钮那条）。拿不到就回退到
     * 带水印的 download_url —— 视频已经生成并计费了，不能因为去水印
     * 失败就把结果扔掉。
     *
     * `removeWatermark === false` 时**直接跳过**这次请求：用户明确要带水印
     * 的版本（例如某些平台要求标注 AI 生成来源），此时还去换无水印地址
     * 既多一次请求、也让「关掉开关」这个语义变得不可信。
     */
    const nowm = shouldRequestNoWatermark(removeWatermark)
      ? await doubaoVideoNoWatermarkUrl(cookieHeader, video.vid)
      : null;
    const picked = chooseVideoSource(nowm, video);
    if (!picked.url) throw new Error(`视频 ${video.vid} 没有下载地址`);
    const { buf, mime } = await downloadVideo(picked.url);
    return {
      buf, mime, video, conversationId: submit.conversationId, attempts,
      watermarkFree: picked.watermarkFree,
      // 无水印流的分辨率/时长以接口回显为准（video_model 里的 video_list
      // 就是这条流的元数据），比 creation block 的 384x216 预览值可靠。
      nowmModel: picked.model,
    };
  });
  videoLock = run.catch(() => {});

  const { buf, mime, video, conversationId, attempts, watermarkFree, nowmModel } = await run;
  /**
   * 分辨率取**实际下载到的这条流**：无水印通路成功时用它的 video_model，
   * 回退时用 creation block 的。两者结构相同，都取 bitrate 最高的那条。
   */
  const dimensionSource = nowmModel === null
    ? video
    : { ...video, video_model: JSON.stringify(nowmModel) };
  return {
    data: buf,
    mediaType: mime,
    ratio: finalRatio,
    duration: video.duration ?? finalDuration,
    model: finalModel,
    vid: video.vid,
    conversationId,
    attempts,
    watermarkFree,
    // 有参考图时服务端忽略 ratio，实际画幅跟随参考图。调用方要标注来源。
    fromImage: refs.length > 0,
    ...videoDimensions(dimensionSource),
  };
}

