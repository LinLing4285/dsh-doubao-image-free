/**
 * 画廊持久化 —— 把「生成过哪些图、哪些收藏了」存到 DSH home 下的 JSON。
 *
 * ## 为什么要放服务端
 *
 * 客户端的 IndexedDB 按 **origin** 隔离，而 origin 含端口。DSH web 每次启动
 * 端口可能不同（3080 / 49422 / 49787 …），换一次端口就是一个全新的空库。
 * 结果是：同一份工作区、同一批图，换个端口打开画廊就空了。清缓存、换浏览器
 * 也一样。这不是用户的错，是「把服务端概念（工作区）存在客户端」的必然代价。
 *
 * 所以权威副本放服务端，客户端 IndexedDB 降级为**本地缓存**：
 *   - 读：优先服务端；服务端不可用时回落到缓存（离线仍能看图）。
 *   - 写：先写服务端，成功后再更新缓存；服务端失败时缓存照写并标记待同步。
 *
 * ## 为什么按工作区隔离
 *
 * 每条记录带 `workspaceId` / `workspacePath` / `sessionId`（客户端
 * `isItemInWorkspace` 就按这几项判归属）。服务端只做「原样存 + 按 key 取」，
 * 归属判定留在客户端——因为只有客户端知道当前工作区的完整判据集合
 * （workspaceId + 路径 + 会话 id 列表）。
 *
 * ## 文件形态
 *
 * `~/.dsh/storages/dsh-doubao-image/gallery.json`
 *
 * 与 `cost-meter/ledger.json`、`session_projcache/*.json` 同构，沿用 DSH 惯例。
 * 写入走 staging + rename 原子替换，避免半截文件。
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** 记录格式版本。将来改结构时递增，旧数据按此判读。 */
const VERSION = 1;

/** 单条记录允许的字符串字段上限，防止异常输入撑爆文件。 */
const MAX_STRING = 8192;
/** 记录总数上限。画廊是「近期生成」列表，不是图库归档。 */
const MAX_ITEMS = 5000;

/**
 * 只保留这些字段，其余一律丢弃——避免把任意对象原样写进磁盘。
 *
 * `kind` 必须在这里：视频记录靠它区分于图片。漏掉的话客户端写进去的
 * `kind: "video"` 会在落盘时被裁掉，重载后视频跑回图库栏（画廊是
 * 服务端优先读取，内存里那条看着正常，一刷新就露馅）。
 */
const STRING_FIELDS = [
  "prompt",
  "provider",
  "model",
  "aspectRatio",
  "imageSize",
  "output",
  "savedTo",
  "workspacePath",
  "workspaceId",
  "sessionId",
  "kind",
];

/** 数字字段白名单。 */
const NUMBER_FIELDS = ["createdAt", "seed"];

/**
 * 把客户端传来的一条记录裁剪成可落盘的形状。
 *
 * 白名单而非黑名单：客户端将来新增字段时，服务端不会因为「不认识的键」
 * 就把它写进磁盘。需要新字段时在这里显式加。
 *
 * @returns 合法记录对象；id 缺失或非法时返回 null。
 */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "" || id.length > 256) return null;

  const record = { id };

  for (const key of STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") {
      record[key] = value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
    }
  }

  for (const key of NUMBER_FIELDS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) record[key] = value;
  }

  if (raw.isFavorite === true) record.isFavorite = true;

  if (Array.isArray(raw.tags)) {
    record.tags = raw.tags.filter((t) => typeof t === "string" && t !== "").slice(0, 32);
  }
  if (Array.isArray(raw.sourceAttachmentIds)) {
    record.sourceAttachmentIds = raw.sourceAttachmentIds
      .filter((t) => typeof t === "string" && t !== "")
      .slice(0, 32);
  }

  // attachment 是图片引用，形如 { attachmentId, mediaType, width, height, bytes }。
  // 只挑已知字段，不整体透传。
  //
  // **`bytes` 必须一起挑**：客户端 `parseAttachmentRef` 把它当必需字段
  // （非负整数，缺了返回 null），漏掉会让整张图在画廊里显示成
  // `invalid-attachment` —— 图其实好好存在磁盘上，只是前端拒绝渲染。
  // 2026-10-20 实测踩过：白名单只写了 width/height。
  //
  // **`kind` 同样必须挑**：视频引用带 `kind: "video"`，客户端
  // `isVideoItem` 会看 `attachment.kind`（记录级 `kind` 是另一条判据）。
  // 两条都留着，任何一条被裁掉都还能认出视频。
  const att = raw.attachment;
  if (att && typeof att === "object") {
    const ref = {};
    if (typeof att.attachmentId === "string" && att.attachmentId !== "") ref.attachmentId = att.attachmentId;
    if (typeof att.mediaType === "string" && att.mediaType !== "") ref.mediaType = att.mediaType;
    if (typeof att.name === "string" && att.name !== "") ref.name = att.name;
    if (typeof att.kind === "string" && att.kind !== "") ref.kind = att.kind;
    for (const key of ["width", "height", "bytes"]) {
      if (typeof att[key] === "number" && Number.isFinite(att[key])) ref[key] = att[key];
    }
    if (ref.attachmentId !== undefined) record.attachment = ref;
  }

  if (typeof record.createdAt !== "number") record.createdAt = Date.now();

  return record;
}

/**
 * 读整个存储文件。
 *
 * 任何异常都返回空结构而不是抛出：画廊坏了不该让插件起不来。
 * 但**会区分**「文件不存在」与「文件损坏」——前者是正常首次启动，
 * 后者要报给上层，否则用户会以为数据丢了却看不到任何提示。
 */
async function readStore(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, data: { version: VERSION, items: [], tombstones: [] } };
    }
    return { ok: false, reason: "read-failed", message: String(error?.message ?? error) };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "corrupt", message: String(error?.message ?? error) };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "corrupt", message: "根节点不是对象" };
  }

  const items = Array.isArray(parsed.items) ? parsed.items.filter((it) => it && typeof it.id === "string") : [];
  const tombstones = Array.isArray(parsed.tombstones)
    ? parsed.tombstones.filter((id) => typeof id === "string" && id !== "")
    : [];

  return { ok: true, data: { version: VERSION, items, tombstones } };
}

/** staging + rename 原子替换。半截文件永远不可见。 */
async function writeStore(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const staging = join(dirname(file), `.gallery.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(staging, JSON.stringify(data), { flag: "wx" });
    await rename(staging, file);
  } catch (error) {
    await unlink(staging).catch(() => {});
    throw error;
  }
}

/**
 * 创建一个画廊存储实例。
 *
 * 所有写操作都串行化：并发写同一个文件会互相覆盖，而画廊的写入频率
 * （生成一张图一次）远低于串行化的代价。
 *
 * @param {string} file 存储文件绝对路径
 */
export function createGalleryStore(file) {
  /** 串行队列。每次写操作排在上一次之后。 */
  let tail = Promise.resolve();

  const serialize = (task) => {
    const run = tail.then(task, task);
    // 队列本身不能因为某次失败而永久中断。
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    /** 存储文件路径，供设置页显示与排障。 */
    file,

    /**
     * 读全量。返回 { ok, items, tombstones } 或 { ok:false, reason }。
     *
     * **也走串行队列**：Windows 上 `rename` 到一个正被打开读的文件会报
     * `EPERM`（实测，errno -4048）。真实场景里 GET 与 POST 并发就会撞上
     * ——用户一边刷画廊一边存图。读放进同一个队列即可彻底避免。
     *
     * 代价是读要等前面的写完成；画廊是低频操作，这个延迟无所谓。
     */
    read() {
      return serialize(async () => {
        const result = await readStore(file);
        if (!result.ok) return result;
        return { ok: true, items: result.data.items, tombstones: result.data.tombstones };
      });
    },

    /**
     * 写入或更新一条。按 id 去重，保留原有的收藏状态与首次创建时间。
     *
     * @returns {Promise<{ok:boolean, created?:boolean, reason?:string}>}
     */
    upsert(raw) {
      return serialize(async () => {
        const record = sanitizeItem(raw);
        if (record === null) return { ok: false, reason: "invalid-item" };

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        // 墓碑命中：用户删过它，这次「复活」被静默丢弃。
        // 返回 ok 而不是失败——用户要的结果已经生效了。
        if (tombstones.includes(record.id)) return { ok: true, created: false, tombstoned: true };

        const index = items.findIndex((it) => it.id === record.id);
        let created = false;
        if (index === -1) {
          if (items.length >= MAX_ITEMS) {
            // 超出上限时丢掉最旧的一条，保证最新记录一定能写进去。
            items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            items.length = MAX_ITEMS - 1;
          }
          items.push(record);
          created = true;
        } else {
          const existing = items[index];
          // 重扫同一张图不能把用户的状态冲掉。
          if (typeof existing.createdAt === "number") record.createdAt = existing.createdAt;
          if (existing.isFavorite !== undefined) record.isFavorite = existing.isFavorite;
          if (Array.isArray(existing.tags) && !Array.isArray(record.tags)) record.tags = existing.tags;
          items[index] = record;
        }

        await writeStore(file, { version: VERSION, items, tombstones });
        return { ok: true, created };
      });
    },

    /** 批量写入（导入用）。整体一次落盘，避免 N 次重写。 */
    upsertMany(rawList) {
      return serialize(async () => {
        if (!Array.isArray(rawList)) return { ok: false, reason: "invalid-items" };

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        let written = 0;
        for (const raw of rawList) {
          const record = sanitizeItem(raw);
          if (record === null) continue;
          if (tombstones.includes(record.id)) continue;

          const index = items.findIndex((it) => it.id === record.id);
          if (index === -1) {
            if (items.length >= MAX_ITEMS) break;
            items.push(record);
          } else {
            const existing = items[index];
            if (typeof existing.createdAt === "number") record.createdAt = existing.createdAt;
            if (existing.isFavorite !== undefined) record.isFavorite = existing.isFavorite;
            items[index] = record;
          }
          written += 1;
        }

        if (written > 0) await writeStore(file, { version: VERSION, items, tombstones });
        return { ok: true, written };
      });
    },

    /** 删除并写墓碑。返回是否真的删掉了。 */
    remove(id) {
      return serialize(async () => {
        const key = typeof id === "string" ? id.trim() : "";
        if (key === "") return { ok: false, reason: "invalid-id" };

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        const before = items.length;
        const remaining = items.filter((it) => it.id !== key);
        if (!tombstones.includes(key)) tombstones.push(key);

        // 墓碑也要有上限，否则删除多了文件只增不减。
        if (tombstones.length > MAX_ITEMS * 2) tombstones.splice(0, tombstones.length - MAX_ITEMS * 2);

        await writeStore(file, { version: VERSION, items: remaining, tombstones });
        return { ok: true, removed: before !== remaining.length };
      });
    },

    /** 批量删除。 */
    removeMany(ids) {
      return serialize(async () => {
        if (!Array.isArray(ids)) return { ok: false, reason: "invalid-ids" };
        const keys = new Set(ids.filter((id) => typeof id === "string" && id !== ""));

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        const before = items.length;
        const remaining = items.filter((it) => !keys.has(it.id));
        for (const key of keys) {
          if (!tombstones.includes(key)) tombstones.push(key);
        }
        if (tombstones.length > MAX_ITEMS * 2) tombstones.splice(0, tombstones.length - MAX_ITEMS * 2);

        await writeStore(file, { version: VERSION, items: remaining, tombstones });
        return { ok: true, removed: before - remaining.length };
      });
    },

    /** 设置收藏状态。记录不存在时返回 ok:false。 */
    setFavorite(id, isFavorite) {
      return serialize(async () => {
        const key = typeof id === "string" ? id.trim() : "";
        if (key === "") return { ok: false, reason: "invalid-id" };

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        const target = items.find((it) => it.id === key);
        if (target === undefined) return { ok: false, reason: "not-found" };

        if (isFavorite === true) target.isFavorite = true;
        else delete target.isFavorite;

        await writeStore(file, { version: VERSION, items, tombstones });
        return { ok: true, isFavorite: isFavorite === true };
      });
    },

    /** 批量设置收藏。 */
    setFavoriteMany(ids, isFavorite) {
      return serialize(async () => {
        if (!Array.isArray(ids)) return { ok: false, reason: "invalid-ids" };
        const keys = new Set(ids.filter((id) => typeof id === "string" && id !== ""));

        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        let changed = 0;
        for (const item of items) {
          if (!keys.has(item.id)) continue;
          if (isFavorite === true) {
            if (item.isFavorite !== true) changed += 1;
            item.isFavorite = true;
          } else {
            if (item.isFavorite === true) changed += 1;
            delete item.isFavorite;
          }
        }

        if (changed > 0) await writeStore(file, { version: VERSION, items, tombstones });
        return { ok: true, changed };
      });
    },

    /** 清空（保留墓碑，避免旧会话回填把图又扫回来）。 */
    clear() {
      return serialize(async () => {
        const result = await readStore(file);
        if (!result.ok) return result;
        const { items, tombstones } = result.data;

        for (const item of items) {
          if (!tombstones.includes(item.id)) tombstones.push(item.id);
        }
        if (tombstones.length > MAX_ITEMS * 2) tombstones.splice(0, tombstones.length - MAX_ITEMS * 2);

        await writeStore(file, { version: VERSION, items: [], tombstones });
        return { ok: true, removed: items.length };
      });
    },
  };
}
