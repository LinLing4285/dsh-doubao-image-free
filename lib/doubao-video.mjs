/**
 * 生视频：走桌面 GUI 协议（`/chat/completion` + 轮询 `/im/message/chain_by_block`）。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
/* -------------------------------------------------------------------- 视频 */

import { randomUUID } from "node:crypto";

import { BLOCK_CREATION_OUTPUT, DEFAULT_VIDEO_MODEL, DOUBAO_BASE, DOUBAO_RATIOS, DOUBAO_VIDEO_RATIOS, IM_CHAIN_PATH, UA, VIDEO_BOT_ID, VIDEO_CHAT_PATH, VIDEO_DIRECTIVE, extractConversationId, parseCookieHeader, safeSnippet, sleep, toRatio } from "./doubao-core.mjs";
import { videoSecurityParams } from "./doubao-upstream.mjs";

export function videoRequestBody(prompt, { ratio, duration, model }) {
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
    messages: [
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
 * 取可下载的 mp4 地址。
 *
 * `video_model` 本身是 JSON 字符串，其 video_list.*.main_url 是
 * base64 编码的，download_url 缺失时用它兜底。两者都带
 * lr=video_gen_watermark_dyn —— 与图片不同，视频没有无水印变体
 * （get_without_watermark 对 vid 回 710010202）。
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
    const vm = JSON.parse(video.video_model ?? "{}");
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

/** 同一账号一次只跑一个付费视频任务（账号走计量额度）。 */
let videoLock = Promise.resolve();

/**
 * 文生视频。
 *
 * @param {object} opts
 * @param {string} opts.cookieHeader
 * @param {string} opts.prompt
 * @param {string} [opts.ratio]     auto/1:1/4:3/16:9/9:16/21:9，或 OpenAI 尺寸
 * @param {number} [opts.duration]  1-10 秒，默认 5
 * @param {string} [opts.model]     默认 seedance_v2.0_mini
 * @param {number} [opts.pollMs]
 * @param {number} [opts.timeoutMs]
 * @param {(p: object) => void} [opts.onProgress]
 */
export async function generateVideo({
  cookieHeader, prompt, ratio, duration, model,
  device, msToken,
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
  const finalModel = String(model ?? DEFAULT_VIDEO_MODEL);

  // 串行化：并发第二个任务会双倍消耗计量额度。
  const run = videoLock.then(async () => {
    const submit = await doubaoSubmitVideo(cookieHeader, text, {
      ratio: finalRatio, duration: finalDuration, model: finalModel,
    }, identity);
    const { video, attempts } = await doubaoPollVideo(cookieHeader, submit.conversationId, {
      pollMs, timeoutMs, onProgress, identity,
    });
    const url = videoDownloadUrl(video);
    if (!url) throw new Error(`视频 ${video.vid} 没有下载地址`);
    const { buf, mime } = await downloadVideo(url);
    return { buf, mime, video, conversationId: submit.conversationId, attempts };
  });
  videoLock = run.catch(() => {});

  const { buf, mime, video, conversationId, attempts } = await run;
  return {
    data: buf,
    mediaType: mime,
    ratio: finalRatio,
    duration: video.duration ?? finalDuration,
    model: finalModel,
    vid: video.vid,
    conversationId,
    attempts,
    // 图片可用 get_without_watermark 去水印；视频没有这条通路，
    // 如实标记为带水印，不要假装。
    watermarkFree: false,
    ...videoDimensions(video),
  };
}

