/**
 * HTTP 基础：安全参数、请求体构造、SSE 解析、图片字节下载。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
import { randomUUID } from "node:crypto";

import { CHROME_VERSION } from "./doubao-core.mjs";
import { currentMsToken, normalizeDevice, normalizeMsToken } from "./doubao-identity.mjs";

/**
 * 视频端点的安全参数。
 *
 * ## 为什么这里不再把设备身份全部写死
 *
 * 早期版本把 `device_id` / `web_id` / `tea_uuid` / `fp` 四个字段写死成一组
 * 常量，等于**所有用户向服务端自称同一个设备**。`doubao-identity.mjs` 的
 * 注释记着图片通道踩过这个坑（服务端判异常），视频通道只是侥幸还没被拦。
 *
 * ## 哪些字段取账号身份，哪些保持常量
 *
 * - `device_id` / `web_id` / `tea_uuid` / `fp`：**账号的设备身份**，有就用账号的。
 * - `pc_version` / `doubao_pc_version` / `channel` / `client_platform` /
 *   `version_code` / `runtime_version`：**端点协议的一部分**（把自己标识成
 *   桌面构建），不是谁的身份，保持常量。
 *
 * ## 为什么是「非空才覆盖」而不是直接取账号值
 *
 * 实测两个真实账号的 `deviceId` 与 `teaUuid` 都是**空串**（只导入了 fps 和
 * webId）。直接取账号值会把这些字段发成空串，而服务端目前接受的是常量形态
 * ——`HANDOFF-20261023.md` 记录的 `seedance_2.0_pc` 实测出片（1280x720 /
 * 1065008 B / 约 102 秒）走的就是常量。所以：账号给了非空值才覆盖，否则
 * 回落常量。这样既消除了「所有账号共享同一 fp/web_id」，又不改变已实测
 * 出片那条路径的线上形态。
 */
export function videoSecurityParams(options = {}) {
  const token = normalizeMsToken(options.msToken) || currentMsToken;
  const device = normalizeDevice(options.device);
  /** 账号给了非空值才用，否则回落协议常量。 */
  const pick = (value, fallback) => (typeof value === "string" && value !== "" ? value : fallback);
  return {
    version_code: "20800", language: "zh", device_platform: "web",
    doubao_device_platform: "desktop", aid: "582478", real_aid: "582478",
    pkg_type: "release_version",
    device_id: pick(device?.deviceId, "181842873686663"),
    pc_version: "2.31.4", doubao_pc_version: "2.31.4",
    web_id: pick(device?.webId, "7649784378898564671"),
    tea_uuid: pick(device?.teaUuid, "181842873686663"),
    region: "CN", sys_region: "CN", samantha_web: "1", web_platform: "desktop",
    "use-olympus-account": "1", runtime: "web", runtime_version: "3.39.0",
    client_platform: "pc_client", chromium_version: CHROME_VERSION, channel: "win",
    web_tab_id: randomUUID(),
    fp: pick(device?.fps, "verify_181842873686663"),
    ...(token === "" ? {} : { msToken: token }),
  };
}

export function imageRequestBody(prompt, ratio) {
  return {
    messages: [
      {
        content: JSON.stringify({ text: prompt, ratio }),
        content_type: 2009,
        attachments: [],
        references: [],
        skill: {
          skill_type: 3, skill_type_no_default: 3,
          skill_id: "3", skill_id_no_default: "3",
        },
      },
    ],
    completion_option: {
      is_regen: false, with_suggest: true, need_create_conversation: true,
      launch_stage: 1, is_replace: false, is_delete: false,
      is_ai_playground: false, memory_type: 2, message_from: 0,
      use_deep_think: false, use_auto_cot: false, resend_for_regen: false,
      enable_commerce_credit: false, action_bar_skill_id: 3,
    },
    evaluate_option: { web_ab_params: "" },
    local_conversation_id: randomUUID(),
    local_message_id: randomUUID(),
  };
}

/** 遍历 SSE 正文，取出生成图片的条目（content_type 2010）。 */
export function extractImages(sseBody) {
  const images = [];
  let gatewayError = null;
  for (const block of sseBody.split("\n\n")) {
    let data = "";
    let isGatewayError = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:") && line.slice(6).trim() === "gateway-error") isGatewayError = true;
      if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;

    // 登录失效仍返回 HTTP 200，但内容是 gateway-error（code=710012000
    // message=[user invalid]）。要把它识别成鉴权失败，而不是「没出图」。
    if (isGatewayError) {
      let code = "";
      let message = data;
      try {
        const g = JSON.parse(data);
        code = String(g?.code ?? "");
        message = String(g?.message ?? data);
      } catch { /* 保留原文 */ }
      gatewayError = `code=${code} ${message}`.slice(0, 500);
      continue;
    }

    let evt;
    try { evt = JSON.parse(data); } catch { continue; }

    if (evt.event_type === 2005) {
      gatewayError = JSON.stringify(evt.event_data ?? {}).slice(0, 500);
      continue;
    }
    if (evt.event_type !== 2001) continue;

    let ed = evt.event_data;
    if (typeof ed === "string") { try { ed = JSON.parse(ed); } catch { continue; } }
    let msg = ed?.message;
    if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch { continue; } }
    if (msg?.content_type !== 2010) continue;

    let content = msg.content;
    if (typeof content === "string") { try { content = JSON.parse(content); } catch { continue; } }
    for (const item of content?.data ?? []) {
      if (item?.key) images.push(item);
    }
  }
  return { images, gatewayError };
}

/** 从 HTTP 响应头推断图片 MIME，拿不准时用兜底值。 */
export function sniffMime(buf, fallback) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return fallback ?? null;
}

export async function downloadImage(url, timeoutMs = 180_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`图片下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = sniffMime(buf, res.headers.get("content-type") ?? "image/png");
  if (!mime || !mime.startsWith("image/")) {
    throw new Error(`下载内容不是图片（${res.headers.get("content-type")}）`);
  }
  return { buf, mime };
}

/** 判断一个失败是否看起来像「登录失效」而非真实错误。 */
export function looksLikeAuthFailure(err) {
  const m = String(err?.message ?? "");
  return Boolean(
    err?.status === 401 || err?.status === 403 ||
    err?.gateway === true ||
    /user invalid|invalid user id|710012000|not.?logged|unauthor|sessionid|forbidden|401|403|登录/i.test(m),
  );
}

