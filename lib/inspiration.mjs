/**
 * 灵感库：内置提示词数据集 + 远程图片代理。
 *
 * 数据集是从官方插件 `dsh-image-gen` 的内联 bundle 里抽出来的（两个 JSON，
 * 共 1.72 MB / 976 个案例）。抽出来而不是抄官方代码，是因为官方那份是打包
 * 产物、不可直接复用；而数据集本身是**上游仓库的快照**，属于数据不是逻辑。
 *
 * 图片不走浏览器直连：CSP 与隐私都不允许，而且本机实测
 * `cdn.jsdelivr.net` / `raw.githubusercontent.com` 全部 ECONNRESET
 * （2026-10-14 实测），只有 `gpt-image2.canghe.ai` 与 `gh-proxy.com` 可达。所以：
 *   - 候选顺序把**可达的镜像排在最前**（官方那份把 jsdelivr 排第一，本机必失败）
 *   - 逐个回退，全失败才报错
 *
 * 注意：`gpt-image2.canghe.ai` 只镜像了 `awesome-gpt-image-2`，
 * 没有 `handraw-style` 的图片（2026-10-14 实测 404）。
 *
 * 全部只依赖 `node:` 内置模块。
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 单个数据集最大 3 MiB；超了就说明文件被换掉了。 */
const MAX_INDEX_BYTES = 3 * 1024 * 1024;
/** 单张灵感图最大 12 MiB。 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** 上游取图超时。 */
const IMAGE_TIMEOUT_MS = 12_000;

/** 允许的图片来源主机白名单。 */
const ALLOWED_IMAGE_HOSTS = new Set([
  "gpt-image2.canghe.ai",
  "gh-proxy.com",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
]);

/** gh-proxy 镜像前缀（把 GitHub raw URL 代理到国内可达 CDN）。 */
const GH_PROXY = "https://gh-proxy.com";

/**
 * 两个数据集的元信息。
 *
 * `version` 是上游仓库的 commit，用来拼 jsdelivr 的不可变 URL；
 * `mirrorFirst` 为 true 时把 canghe 镜像排在最前（本机唯一可达的那条）。
 */
const SOURCES = [
  {
    id: "awesome-gpt-image-2",
    label: "GPT Image 2 案例库",
    repository: "https://github.com/freestylefly/awesome-gpt-image-2",
    version: "c7d293963b21c60bf338003915438cc5c39dd3ca",
    updatedAt: "2026-08-28T10:24:55Z",
    /** 镜像路径前缀（数据集里的 image 是 /images/xxx.jpg）。 */
    jsdelivrPath: (imagePath, version) => `https://cdn.jsdelivr.net/gh/freestylefly/awesome-gpt-image-2@${version}/data${imagePath}`,
    rawPath: (imagePath, version) => `https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/${version}/data${imagePath}`,
  },
  {
    id: "handraw-style",
    label: "手绘风格图鉴",
    repository: "https://github.com/yang0/handraw-style",
    version: "50998b094866e22007001161bca12c892a3796b1",
    updatedAt: "2026-09-27T14:24:28+08:00",
    imageRevision: "3",
    jsdelivrPath: (imagePath, version) => `https://cdn.jsdelivr.net/gh/yang0/handraw-style@${version}${imagePath}`,
    rawPath: (imagePath, version) => `https://raw.githubusercontent.com/yang0/handraw-style/${version}${imagePath}`,
  },
];

const MIRROR = "https://gpt-image2.canghe.ai";

const here = fileURLToPath(new URL(".", import.meta.url));

/* ------------------------------------------------------------------ 校验 */

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value, maxLength) => (typeof value === "string" ? value.trim().slice(0, maxLength) : "");

const optionalText = (value, maxLength) => {
  const result = text(value, maxLength);
  return result.length > 0 ? result : undefined;
};

/**
 * 只接受相对图片路径。
 *
 * 这是**安全边界**：客户端会把路径发回来让 Host 去取，若不校验，一个
 * `../../` 就能让 Host 去请求任意同主机的路径。规则与官方同构。
 */
export function safeImagePath(value) {
  if (typeof value !== "string") return undefined;
  const path = value.trim();
  if (!/^\/images\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:png|jpe?g|webp)$/i.test(path)) return undefined;
  if (path.includes("..")) return undefined;
  return path;
}

/** 只接受 http/https 绝对 URL（外链展示用）。 */
export function safeHttpUrl(value) {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value, maxItems, maxLength) => {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = text(item, maxLength);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length === maxItems) break;
  }
  return out;
};

/**
 * 解析一个数据集。
 *
 * 逐字段裁剪长度、丢弃不可用案例——数据集来自上游仓库，不能当可信输入。
 * 一条都解析不出来就抛错（静默返回空数组会让前端显示「灵感库为空」，
 * 把数据损坏伪装成正常状态）。
 */
export function parseSource(value, meta) {
  const doc = isRecord(value) ? value : {};
  const rawCases = Array.isArray(doc.cases) ? doc.cases : [];
  if (rawCases.length === 0 || rawCases.length > 2_000) throw new Error(`素材索引案例数量无效: ${meta.id}`);

  const seen = new Set();
  const cases = [];
  for (const candidate of rawCases) {
    const entry = isRecord(candidate) ? candidate : {};
    const id = String(entry.id ?? "").trim();
    const title = text(entry.title, 240);
    const prompt = text(entry.prompt, 8_000);
    const imagePath = safeImagePath(entry.image);
    if (id === "" || title === "" || prompt === "" || imagePath === undefined || seen.has(id)) continue;
    seen.add(id);
    const sourceUrl = safeHttpUrl(entry.sourceUrl);
    const githubUrl = safeHttpUrl(entry.githubUrl);
    const sourceLabel = optionalText(entry.sourceLabel, 240);
    cases.push({
      id,
      title,
      image: imagePath,
      imageAlt: text(entry.imageAlt, 320) || title,
      ...(sourceLabel === undefined ? {} : { sourceLabel }),
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(githubUrl === undefined ? {} : { githubUrl }),
      prompt,
      promptPreview: text(entry.promptPreview, 600) || prompt.slice(0, 280),
      category: text(entry.category, 120) || "Other Use Cases",
      styles: strings(entry.styles, 64, 60),
      scenes: strings(entry.scenes, 64, 60),
      featured: entry.featured === true,
    });
  }
  if (cases.length === 0) throw new Error(`素材索引不包含可用案例: ${meta.id}`);

  return {
    id: meta.id,
    label: meta.label,
    repository: safeHttpUrl(doc.repository) ?? meta.repository,
    version: meta.version,
    updatedAt: optionalText(doc.updatedAt, 60) ?? meta.updatedAt,
    ...(meta.imageRevision === undefined ? {} : { imageRevision: meta.imageRevision }),
    categories: strings(doc.categories, 80, 120),
    styles: strings(doc.styles, 80, 120),
    scenes: strings(doc.scenes, 80, 120),
    cases,
    /*
     * URL 构造函数**必须带过去**。
     *
     * 它们定义在 SOURCES 元信息里，而这个对象是要被返回给调用方的——
     * 漏掉就会让 `imageUrls` 拿到一个没有构造函数的 source（实测抛
     * `source.jsdelivrPath is not a function`）。它们不是给客户端的字段，
     * 但 Host 内部要用，所以一并带出；`publicCatalog()` 负责对外剥掉。
     */
    jsdelivrPath: meta.jsdelivrPath,
    rawPath: meta.rawPath,
  };
}

/**
 * 对外（HTTP）形状：剥掉内部字段。
 *
 * 函数无法 JSON 序列化——直接 `sendJson` 会把它们静默丢掉，客户端拿到的
 * 形状看起来「对」但实际上取决于序列化行为。显式剥离才是有意的契约。
 */
export function publicCatalog(catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    sources: catalog.sources.map((source) => ({
      id: source.id,
      label: source.label,
      repository: source.repository,
      version: source.version,
      updatedAt: source.updatedAt,
      ...(source.imageRevision === undefined ? {} : { imageRevision: source.imageRevision }),
      totalCases: source.cases.length,
      categories: source.categories,
      styles: source.styles,
      scenes: source.scenes,
      cases: source.cases,
    })),
  };
}

/* ------------------------------------------------------------------ 加载 */

let catalogPromise = null;

/**
 * 读取内置数据集（进程内只读一次）。
 *
 * 失败时抛错而不是返回空目录——调用方要把失败原因透给客户端。
 */
export function loadCatalog() {
  if (catalogPromise === null) {
    catalogPromise = (async () => {
      const sources = [];
      for (const meta of SOURCES) {
        const file = `${here}inspiration/${meta.id}.json`;
        const buf = await readFile(file);
        if (buf.byteLength > MAX_INDEX_BYTES) throw new Error(`素材索引体积无效: ${meta.id}`);
        sources.push(parseSource(JSON.parse(buf.toString("utf8")), meta));
      }
      return { schemaVersion: 1, sources };
    })().catch((error) => {
      // 失败不缓存：下次请求可以重试（例如文件暂时被占用）。
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

/** 按 id 找数据集；找不到返回 undefined。 */
export async function findSource(sourceId) {
  const catalog = await loadCatalog();
  return catalog.sources.find((source) => source.id === sourceId);
}

/**
 * 一张灵感图的候选 URL，**可达的镜像排最前**。
 *
 * 官方那份把 jsdelivr 排第一，本机实测它和 raw.githubusercontent 都
 * ECONNRESET，只有 canghe 镜像通——所以顺序必须反过来，否则每次取图都要
 * 白等两个 12 秒超时。
 */
export function imageUrls(source, imagePath) {
  if (source === undefined || imagePath === undefined) return [];
  const version = typeof source.version === "string" && /^[a-f0-9]{40}$/i.test(source.version)
    ? source.version
    : "";
  const urls = [`${MIRROR}${imagePath}`];
  if (version !== "") {
    // handraw-style 在 canghe 镜像上没有（404），gh-proxy 兜底。
    urls.push(`${GH_PROXY}/https://raw.githubusercontent.com/${source.repository.split("/").slice(-2).join("/")}/${version}${imagePath}`);
    urls.push(source.jsdelivrPath(imagePath, version));
    urls.push(source.rawPath(imagePath, version));
  }
  return urls.filter((url) => {
    try {
      return ALLOWED_IMAGE_HOSTS.has(new URL(url).host);
    } catch {
      return false;
    }
  });
}

/**
 * 逐个候选 URL 取图，返回 `{data, mediaType}`。
 *
 * 只接受白名单 MIME（拒绝 svg：它能在同源下执行脚本），并限制体积。
 * 全部候选失败时抛错。
 */
export async function fetchInspirationImage(source, imagePath, fetchImpl = fetch) {
  const urls = imageUrls(source, imagePath);
  if (urls.length === 0) throw new Error("invalid-image-path");

  let lastReason = "no-candidate";
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
        redirect: "error",
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      });
      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
        continue;
      }
      const mediaType = String(response.headers.get("content-type") ?? "").toLowerCase().split(";")[0];
      if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
        lastReason = `bad-content-type:${mediaType}`;
        continue;
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        lastReason = "too-large";
        continue;
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
        lastReason = "bad-size";
        continue;
      }
      return { data, mediaType };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`source-image-unavailable: ${lastReason}`);
}

/* ────────────────────────── Host 内存缓存 ────────────────────────── */

const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const IMAGE_CACHE_MAX = 100;
const imageCache = new Map(); // key -> {data, mediaType, expiresAt}；Map 迭代序即插入序，用于 LRU。

/**
 * `fetchInspirationImage` 的缓存包装：key = source.id + imagePath。
 *
 * 命中且未过期时直接返回缓存的 Buffer，不再打外网；过期条目顺手清掉。
 * 超过 100 条时淘汰最老的（Map 第一个 key）。失败结果不缓存——下次重试。
 */
export async function fetchInspirationImageCached(source, imagePath, fetchImpl = fetch) {
  const sourceId = source && typeof source.id === "string" ? source.id : "";
  const key = `${sourceId}|${imagePath}`;
  const now = Date.now();

  const hit = imageCache.get(key);
  if (hit !== undefined) {
    if (hit.expiresAt > now) {
      // LRU：命中即移到最新位。
      imageCache.delete(key);
      imageCache.set(key, hit);
      return { data: hit.data, mediaType: hit.mediaType };
    }
    imageCache.delete(key);
  }

  const result = await fetchInspirationImage(source, imagePath, fetchImpl);
  imageCache.set(key, { data: result.data, mediaType: result.mediaType, expiresAt: now + IMAGE_CACHE_TTL_MS });
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  return result;
}

/** 仅供测试：清掉内存缓存。 */
export function __clearInspirationImageCache() {
  imageCache.clear();
}
