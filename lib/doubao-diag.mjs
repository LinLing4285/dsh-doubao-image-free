/**
 * 只读会话诊断：抓一条会话的 SSE，把失败原因结构化成可读字段。
 * 
 * 用于图生图排障 —— 出图失败时，服务端的真实原因常常只藏在 SSE 的
 * 某个非图片块里，靠「未返回图片」这句话是查不出来的。
 *
 * 本文件由 `scripts/split-doubao.mjs` 从原 `lib/doubao.mjs` 切出（2026-10-19）。
 * 拆分依据是**依赖方向**（core → identity → upstream → image → video → diag），
 * 不是按行数均分 —— 那样会切出互相 import 的碎片。
 */
/* --------------------------------------------------- 只读会话诊断（图生图排障） */

/** 诊断输出的字符串上限：超过就只报长度，绝不回填内容。 */
import { randomUUID } from "node:crypto";

import { BLOCK_CREATION_OUTPUT, CHAT_PATH, DOUBAO_BASE, IM_CHAIN_PATH, NOWM_PATH, readSetCookies, scrubSensitiveLines } from "./doubao-core.mjs";
import { NO_DEFAULT_DEVICE, editSecurityParams, securityParams } from "./doubao-identity.mjs";
import { downloadImage, extractImages, imageRequestBody, sniffMime, videoSecurityParams } from "./doubao-upstream.mjs";
import { doubaoEdit, doubaoEditV2, doubaoGenerate, doubaoNoWatermarkUrl, editRequestBodyV2, extractImagesV2, ratioLabel, resolveAllImageBytes, resolveImageBytes, uploadToDoubao } from "./doubao-image.mjs";
import { extractConversationId } from "./doubao-core.mjs";
import { extractStreamError, extractVideos, guiPost, videoDownloadUrl, videoRequestBody } from "./doubao-video.mjs";

const DIAG_MAX_STRING = 200;
const DIAG_MAX_TEXT = 200;

/**
 * 诊断输出里**允许原样返回**的字段名白名单。
 *
 * ## 为什么改成按字段名而不是按长度（H5，2026-10-18）
 *
 * 旧实现只看长度：`value.length > 200 ? "<N chars>" : value`。于是任何
 * ≤200 字符的字符串**原样返回**——而诊断响应里的 `msg` / `imageTips` /
 * `creationFailMsg` / `genParams` 全是上游自由文本，可能含用户提示词、
 * 会话标题、上游内部 id。长度和敏感性没有关系。
 *
 * 现在的判据是「这个值是不是**服务端生成的诊断信息**」：
 *
 *   - **是**（错误码、错误文案、状态、计数、比例参数）→ 保留。
 *     诊断路由的全部价值就在这些字段上：`fail_msg: "upstream timeout"`
 *     是排障的关键，脱敏成 `<16 chars>` 等于把功能删了。
 *   - **不是**（用户提示词、豆包回复正文）→ 一律 `<N chars>`。
 *     那才是「用户内容」，默认路径不该出现。
 *
 * 保留的字段仍然过一遍 `scrubSensitiveLines()`：某些网关会把请求头回显进
 * 错误文案，含 `Authorization` / `Cookie` / `accessToken` / `sessionid` 的
 * 整行会被剔掉（与 M3 共用同一套判据）。
 */
const DIAG_SAFE_KEYS = new Set([
  // 状态与错误码：数值/枚举，服务端自己生成的诊断信息
  "status", "statusCode", "status_code", "code", "errorCode", "error_code",
  "errorType", "error_type", "failCode", "fail_code", "end_type", "endType",
  "blockType", "block_type", "contentType", "content_type", "patchObject", "patch_object",
  // 服务端错误文案：诊断的核心，排障时必须能读到
  "msg", "message", "fail_msg", "failMsg", "tips", "error", "reason", "detail",
  // 比例/生成参数：不含用户内容
  "ratio", "genParams", "gen_params", "model", "duration", "width", "height",
  // 计数与类型：结构信息，不含内容
  "count", "total", "length", "size", "bytes", "httpStatus",
  "type", "kind", "mode", "shape", "keys",
]);


/**
 * 消毒：**按字段名白名单**决定是否原样返回，其余一律压成 `<N chars>`。
 *
 * @param {unknown} value
 * @param {string} [key] 该值所属的字段名；顶层调用可不传
 * @returns {unknown}
 */
export function diagRedact(value, key) {
  if (typeof value === "string") {
    /*
     * 白名单字段：原样返回，但先剔掉凭据行。
     * 非白名单字段：**不管多长**都只报长度——长度不是敏感性判据。
     */
    if (typeof key === "string" && DIAG_SAFE_KEYS.has(key) && value.length <= DIAG_MAX_STRING) {
      return scrubSensitiveLines(value);
    }
    return `<${value.length} chars>`;
  }
  if (Array.isArray(value)) return value.map((item) => diagRedact(item, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, item] of Object.entries(value)) out[k] = diagRedact(item, k);
    return out;
  }
  // 数字/布尔/null 本身不携带用户内容，原样返回。
  return value;
}

/** 从块的 content 里榨出可读文字：字符串直接用，对象则取常见文字字段。 */
function blockText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  for (const key of ["text", "content", "value", "message", "answer", "desc"]) {
    const value = content[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") {
      const nested = blockText(value);
      if (nested) return nested;
    }
  }
  return "";
}

/**
 * 展开消息里的块数组。
 *
 * ⚠️ 实测纠正（2026-10-16，用 `?shape=1` 看骨架定位）：
 * `chain_by_block` 返回的 message 里，**块数组在 `content_block` 字段**，
 * 而 `content` 是**字符串**（消息文本，不是块数组）。此前只读 `content`
 * 导致 `messageCount:1` 却 `blockCount:0`——一直读的是错的字段。
 *
 * 两个字段都试（`content_block` 优先），并容忍任一被序列化成 JSON 字符串，
 * 这样不至于因为服务端换字段名就整体失效。
 */
function messageBlocks(message) {
  for (const key of ["content_block", "content"]) {
    let blocks = message?.[key];
    if (typeof blocks === "string") {
      try {
        blocks = JSON.parse(blocks);
      } catch {
        continue;
      }
    }
    if (Array.isArray(blocks)) return blocks;
  }
  return [];
}

/**
 * 解析 `chain_by_block`（cmd 3501）响应，抽出**失败原因**。
 *
 * `extractImagesV2` 只读 2074 创造块的 `image.tips` / `image.fail_code` /
 * `creation.fail_code`，会漏掉服务端的 `creation.fail_msg` 与豆包那句
 * 「出了点问题，请稍后重试。」所在的文字回复块（block_type 10000）。
 * 本函数把这三类如实摊平。
 *
 * 纯函数、不联网——离线自检直接喂合成响应。
 */
export function parseConversationDiagnosis(rawText, { includeShape = false, includeText = false } = {}) {
  const empty = {
    code: null, msg: null, messageCount: 0, blockCount: 0, blocks: [], creations: [], textBlocks: [],
  };
  if (typeof rawText !== "string" || !rawText.trim()) return empty;

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // 非 JSON：只报体量，不回显原文（可能是 HTML 错误页或含签名的报文）。
    return { ...empty, parseError: true, rawLength: rawText.length };
  }

  const out = { ...empty };
  out.code = parsed?.code ?? parsed?.status_code ?? null;
  out.msg = diagRedact(parsed?.msg ?? parsed?.message ?? null, "msg");

  const downlink = parsed?.downlink_body ?? parsed?.data?.downlink_body ?? {};
  const chain = downlink?.pull_message_chain_by_block_downlink_body
    ?? parsed?.data?.pull_message_chain_by_block_downlink_body
    ?? {};
  const messages = Array.isArray(chain?.messages) ? chain.messages : [];
  out.messageCount = messages.length;

  /*
   * `includeShape`：报出**结构骨架**（键名 + 值的类型/长度），不回显任何值。
   *
   * 实测需要：某些会话 `messageCount` > 0 但抽出 0 个块——说明块藏在预期
   * 之外的位置（消息结构比以为的深，或字段名不同）。这时只能看骨架才能
   * 定位，而值可能含图片签名，一律不报。
   */
  if (includeShape) {
    const shape = (value, depth) => {
      /*
       * 上限 8 层：消息块在 `top.downlink_body.pull_...messages[0].content_block`
       * 已是第 5 层，原先设 4 层会把最该看的 messages 内部整片挡成
       * `<max-depth>`，让骨架在唯一有用的地方失效。
       */
      if (depth > 8) return "<max-depth>";
      if (value === null) return "null";
      if (Array.isArray(value)) return value.length === 0 ? "[]" : [shape(value[0], depth + 1)];
      if (typeof value === "object") {
        const bag = {};
        for (const [key, item] of Object.entries(value)) bag[key] = shape(item, depth + 1);
        return bag;
      }
      if (typeof value === "string") return `<string ${value.length}>`;
      return typeof value;
    };
    out.shape = { top: shape(parsed, 0) };
  }

  messages.forEach((message, messageIndex) => {
    messageBlocks(message).forEach((block, blockIndex) => {
      const blockType = block?.block_type ?? block?.type ?? null;
      out.blockCount++;

      const creations = block?.content?.creation_block?.creations;
      if (Array.isArray(creations)) {
        out.blocks.push({ messageIndex, blockIndex, blockType, creationCount: creations.length });
        creations.forEach((creation, creationIndex) => {
          const image = creation?.image ?? null;
          out.creations.push({
            messageIndex,
            blockIndex,
            creationIndex,
            blockType,
            kind: image ? "image" : creation?.video ? "video" : "other",
            imageStatus: image?.status ?? null,
            imageFailCode: image?.fail_code ?? null,
            imageTips: diagRedact(image?.tips ?? null, "tips"),
            imageKey: diagRedact(image?.key ?? null, "key"),
            creationFailCode: creation?.fail_code ?? null,
            creationFailMsg: diagRedact(creation?.fail_msg ?? null, "fail_msg"),
            genParams: diagRedact(creation?.gen_params ?? null, "gen_params"),
          });
        });
        return;
      }

      // 非创造块：文字回复（10000）落在这里。原样报类型 + 脱敏文字。
      const text = blockText(block?.content);
      out.blocks.push({ messageIndex, blockIndex, blockType, creationCount: 0 });
      out.textBlocks.push({
        messageIndex,
        blockIndex,
        blockType,
        length: text.length,
        /*
         * 默认**脱敏**，只报长度（H5）。
         *
         * 旧实现是「截断」：`text.slice(0, 200)…` —— 前 200 字符完整保留。
         * 那段文字就是用户的提示词或豆包的回复，属于会话内容。诊断路由的
         * 定位是排查「为什么没出图」，那看 `length` 与 `blockType` 就够，
         * 不需要读到用户说了什么。
         *
         * 真要读原文的场景（用户自己排障、他本来就知道自己写了什么）用
         * `?text=full` 显式打开——**默认关闭**，因为默认路径上不该出现
         * 用户内容。
         */
        text: includeText ? (text.length > DIAG_MAX_TEXT ? `${text.slice(0, DIAG_MAX_TEXT)}…` : text) : diagRedact(text),
      });
    });
  });

  return out;
}

/**
 * 只读拉取某条会话的原始块并给出失败原因。
 *
 * 只调 `chain_by_block` 拉历史，**不发起任何生成**。
 * 返回值里绝不含 cookie；任何超长字符串只报长度。
 *
 * `blockTypes` 默认只查创造输出块（2074）。排查时实测发现：当豆包在
 * 出图前就失败（只回一句「出了点问题，请稍后重试。」）时，该 filter
 * 会返回**空 messages**——失败信息不在创造块里。所以诊断入口必须能
 * 换块类型（传 `[]` 表示不筛），否则查不出这类失败。
 */
export async function fetchConversationDiagnosis(
  cookieHeader,
  conversationId,
  { timeoutMs = 60_000, blockTypes, includeShape = false, includeText = false, device, msToken } = {},
) {
  const types = Array.isArray(blockTypes) ? blockTypes : [BLOCK_CREATION_OUTPUT];
  const res = await guiPost(cookieHeader, IM_CHAIN_PATH, {
    cmd: 3501,
    uplink_body: {
      pull_message_chain_by_block_uplink_body: {
        block_type_list: types,
        conversation_id: conversationId,
        limit: 30,
      },
    },
    sequence_id: randomUUID(),
    channel: 2,
    version: "1",
  }, { timeoutMs, identity: { device, msToken } });

  return {
    httpStatus: res.status,
    blockTypes: types,
    ...parseConversationDiagnosis(res.text, { includeShape, includeText }),
  };
}

/** 供测试使用的内部函数。 */
export const __internals = {
  securityParams, editSecurityParams, videoSecurityParams, imageRequestBody, videoRequestBody,
  NO_DEFAULT_DEVICE, ratioLabel,
  editRequestBodyV2, extractImagesV2, uploadToDoubao, doubaoEditV2,
  extractImages, extractConversationId, extractStreamError, extractVideos,
  videoDownloadUrl, doubaoNoWatermarkUrl, sniffMime, readSetCookies,
  resolveAllImageBytes, resolveImageBytes, doubaoGenerate, doubaoEdit,
  downloadImage, DOUBAO_BASE, CHAT_PATH, NOWM_PATH,
  IM_CHAIN_PATH, BLOCK_CREATION_OUTPUT,
};

