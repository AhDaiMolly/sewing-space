// src/db/migrations/import.ts
//
// S8-B 迁移入库入口。DM v2.0 §9.2 十步流程 + §9.4 来源格式 + §9.7 图片迁移
// + §9.10 幂等（sourceRef 判重）+ §11 Zod 入库边界。
//
// ── 冻结签名（§9.2）───────────────────────────────────────────────────
//   importLegacyDatabase(input, onProgress?) : Promise<ImportReport>
// 本函数不做文件读取：`LegacyRawInput` 是「已解析成内存对象」的旧数据（§9.2
// 第 1 步的解析发生在调用方/UI 层）。数源缺失一律当空处理，不报错。
//
// ── 十步顺序（§9.2，不可调换）─────────────────────────────────────────
//   1 解析规整 → 2 mapLegacyRows → 3 Zod 逐行校验（唯一「整行丢弃」入口，
//   失败行进 report.skipped）→ 4 先写 images 再写实体（§3.6 硬约束 5）→
//   5 materials.bulkPut → 6 garments.bulkPut → 7 usageLogs.bulkPut（三表
//   各自独立隐式事务，不套大事务）→ 8 presets 三子键合并（§9.8.6）→
//   9 唯一显式事务（backupLogs 一条 kind:'migration' + settings 两行
//   import_completed / dirty_since_backup）→ 10 返回 ImportReport。
//
// ── 幂等（§9.10）与强引用（§2.3 规则 3）的裁合 ────────────────────────
//   §9.10 定死：materials / garments 按 `sourceRef` 全表扫判重（无索引，
//   建 Set），已存在 → 跳过并推 `{ table, oldId, reason: 'sourceRef 已存在，跳过' }`，
//   不删、不覆盖。usageLogs 表本身不建判重机制（同一 source 合法多行）；
//   但 `usageLogs.materialId` 是**强引用**（§2.3 规则 3：本版不存在悬挂的
//   usageLogs.materialId）——父物料行因判重或 Zod 校验被丢弃时，其派生流水
//   与图片引用**一并跳过**，否则会写出指向不存在物料的悬挂强引用。由此
//   「同包连导两次」全库不翻倍（任务书幂等口径）；§9.10 中「重复导入会让
//   库存流水翻倍」的 UI 提示文案（S8-C）按 DM 保留，作为对中断重跑等场景
//   的保守提醒。
//
// ── 图片压缩的环境切分（§9.7）────────────────────────────────────────
//   压缩参数（最大边 1600px / image/jpeg / quality 0.8 / 压后 ≤ 2MB /
//   PNG 透明通道保留 PNG）与 imageService 同一份实现（导出复用，不复制第
//   二份以免漂移）。压缩依赖浏览器 canvas；在无 DOM 的运行环境（Node 自
//   测）下原样透传，仍执行「≤ 2MB + MIME 白名单」判定——即 Node 下超大
//   原图计入 rejectedImages，而浏览器下会压到 2MB 内正常入库（§9.7 的拒
//   收口径本来就是「压缩后」超限，两个环境执行的是同一条规则）。

import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import { imageRowToStored } from '@/db/imageStorage';
import { DEFAULT_PRESETS } from '@/db/seed';
import {
  GarmentRowSchema,
  MaterialRowSchema,
  UsageLogRowSchema,
  firstIssueMessage,
} from '@/db/schemas';
import { setSetting, getSettingValue } from '@/services/settingsService';
import { compressImage } from '@/services/imageService';
import type { Garment, ImageRecord, Material, PresetsConfig, UsageLog } from '@/db/types';
import {
  mapLegacyRows,
  type ImportProgress,
  type ImportReport,
  type LegacyRawInput,
  type LegacySource,
} from './legacy';

// ============================ §9.7 冻结参数 ============================

const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 压缩后 ≤ 2MB（§9.7）
const IMAGE_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'] as const; // §4.15

/** 合并进 settings.presets 的三个子键（§9.8.6；其余五键本机不动）。 */
const MERGE_PRESET_KEYS = ['patternBrands', 'fabricBrands', 'accessoryTags'] as const;

// ============================ 内部工具 ============================

/** §9.4：sourceRef / source 的 {oldTable} 五名（preset 不产行）。 */
const SOURCE_TABLES: readonly LegacySource[] = ['fabric', 'accessory', 'tools', 'pattern', 'garment'];

function tableOfSourceRef(ref: string): LegacySource {
  const head = ref.slice(0, ref.indexOf(':'));
  return (SOURCE_TABLES as readonly string[]).includes(head) ? (head as LegacySource) : 'fabric';
}

function oldIdOfSourceRef(ref: string): string {
  const i = ref.indexOf(':');
  return i >= 0 ? ref.slice(i + 1) : ref;
}

/** §9.10 示例：全表读出 sourceRef 建 Set。非迁移行的 sourceRef 是键缺失，
 *  `.filter` 掉 undefined——漏了这步判重恒真（§9.10 原文警告）。 */
async function existingSourceRefs(table: 'materials' | 'garments'): Promise<Set<string>> {
  const rows = await db[table].toArray();
  return new Set(
    rows
      .map((r) => r.sourceRef)
      .filter((r): r is string => typeof r === 'string' && r !== ''),
  );
}

/** 两段 Blob 是否字节级相同（§9.7 去重规则②：同实体内不同文件名、字节全同 → 只写一行）。 */
async function blobsEqual(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  const [ba, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
  const ua = new Uint8Array(ba);
  const ub = new Uint8Array(bb);
  for (let i = 0; i < ua.length; i += 1) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

/** §9.7：压缩（浏览器 canvas / 无 DOM 环境透传）。返回 null = 拒收
 *  （压缩后超 2MB 或 MIME 不在白名单），由调用方计入 rejectedImages。 */
async function compressForMigration(
  file: Blob,
  cache: Map<string, { blob: Blob; mimeType: string } | null>,
  cacheKey: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
  let out: { blob: Blob; mimeType: string } | null;
  if (typeof document === 'undefined') {
    // 无 DOM（Node 自测）：canvas 不可用，原样透传；白名单与 ≤2MB 仍判。
    out = { blob: file, mimeType: file.type };
  } else {
    try {
      out = await compressImage(file); // 压后 > 2MB 时内部抛错 → 拒收
    } catch {
      out = null;
    }
  }
  if (out !== null) {
    const mimeOk = (IMAGE_MIME_WHITELIST as readonly string[]).includes(out.mimeType) &&
      out.mimeType === out.blob.type;
    if (!mimeOk || out.blob.size > IMAGE_MAX_BYTES || out.blob.size === 0) out = null;
  }
  cache.set(cacheKey, out);
  return out;
}

/** §9.8.6 合并：三子键取并集（本机现值在前保序，旧值新增项按旧数组顺序追加），
 *  其余五键保持本机当前值。返回合并结果与各子键新增项数。 */
function mergePresets(
  legacy: Partial<PresetsConfig>,
  current: PresetsConfig,
): { merged: PresetsConfig; added: Record<(typeof MERGE_PRESET_KEYS)[number], number> } {
  const merged: PresetsConfig = { ...current };
  const added = { patternBrands: 0, fabricBrands: 0, accessoryTags: 0 };
  for (const key of MERGE_PRESET_KEYS) {
    const legacyItems = legacy[key];
    if (!Array.isArray(legacyItems)) continue; // 子键缺失 → 不动（§9.8.6 边界）
    let list = merged[key];
    for (const item of legacyItems) {
      if (!list.includes(item)) {
        list = [...list, item]; // 本机没有的旧值项追加在后
        added[key] += 1;
      }
    }
    merged[key] = list;
  }
  return { merged, added };
}

// ============================ §9.2 冻结入口 ============================

export async function importLegacyDatabase(
  input: LegacyRawInput,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportReport> {
  // `now` 在入口取一次，全程复用（§9.6：同一次导入所有兜底值共用同一时刻）。
  const now = new Date().toISOString();
  const emit = (phase: ImportProgress['phase'], done: number, total: number): void => {
    if (onProgress) onProgress({ phase, done, total });
  };

  // —— 第 1 步：解析规整（数源缺失当空，不报错；本函数不读文件）——
  emit('parse', 0, 0);
  const raw: LegacyRawInput = {
    fabric: Array.isArray(input?.fabric) ? input.fabric : [],
    accessory: Array.isArray(input?.accessory) ? input.accessory : [],
    tools: Array.isArray(input?.tools) ? input.tools : [],
    pattern: Array.isArray(input?.pattern) ? input.pattern : [],
    garment: Array.isArray(input?.garment) ? input.garment : [],
    preset: input?.preset ?? null,
    images: Array.isArray(input?.images) ? input.images : [],
  };
  emit('parse', 1, 1);

  // —— 第 2 步：映射（纯函数，§9.3）——
  emit('map', 0, 1);
  const mapped = mapLegacyRows(raw, now);
  const report: ImportReport = mapped.report;
  emit('map', 1, 1);

  // —— 第 3 步：Zod 逐行校验（唯一「整行丢弃」入口）+ §9.10 sourceRef 判重 ——
  // 判重必须在第 4 步写图片**之前**完成：被跳过实体的图片引用与派生流水一并
  // 丢弃（§2.3 规则 3 强引用；见模块头「幂等与强引用的裁合」）。
  const materialRefs = await existingSourceRefs('materials');
  const garmentRefs = await existingSourceRefs('garments');
  const keptMaterials: Material[] = [];
  const keptGarments: Garment[] = [];
  const keptUsageLogs: UsageLog[] = [];
  const droppedEntityIds = new Set<string>(); // 判重或 Zod 失败而被丢弃的实体新 id
  const validateTotal =
    mapped.materials.length + mapped.garments.length + mapped.usageLogs.length;
  let validateDone = 0;
  emit('validate', 0, validateTotal); // 空输入也发一次阶段起始（done=total=0）

  for (const m of mapped.materials) {
    validateDone += 1;
    emit('validate', validateDone, validateTotal);
    const ref = m.sourceRef ?? '';
    if (ref !== '' && materialRefs.has(ref)) {
      report.skipped.push({ table: tableOfSourceRef(ref), oldId: oldIdOfSourceRef(ref), reason: 'sourceRef 已存在，跳过' });
      droppedEntityIds.add(m.id);
      continue;
    }
    const r = MaterialRowSchema.safeParse(m);
    if (!r.success) {
      report.skipped.push({
        table: tableOfSourceRef(ref),
        oldId: oldIdOfSourceRef(ref),
        reason: `Zod 校验失败：${firstIssueMessage(r.error)}`,
      });
      droppedEntityIds.add(m.id);
      continue;
    }
    keptMaterials.push(m);
  }
  for (const g of mapped.garments) {
    validateDone += 1;
    emit('validate', validateDone, validateTotal);
    const ref = g.sourceRef ?? '';
    if (ref !== '' && garmentRefs.has(ref)) {
      report.skipped.push({ table: tableOfSourceRef(ref), oldId: oldIdOfSourceRef(ref), reason: 'sourceRef 已存在，跳过' });
      droppedEntityIds.add(g.id);
      continue;
    }
    const r = GarmentRowSchema.safeParse(g);
    if (!r.success) {
      report.skipped.push({
        table: tableOfSourceRef(ref),
        oldId: oldIdOfSourceRef(ref),
        reason: `Zod 校验失败：${firstIssueMessage(r.error)}`,
      });
      droppedEntityIds.add(g.id);
      continue;
    }
    keptGarments.push(g);
  }
  let usageDroppedWithParent = 0;
  for (const u of mapped.usageLogs) {
    validateDone += 1;
    emit('validate', validateDone, validateTotal);
    if (droppedEntityIds.has(u.materialId)) {
      usageDroppedWithParent += 1; // 父物料行已丢弃：不写悬挂强引用（§2.3 规则 3）
      continue;
    }
    const r = UsageLogRowSchema.safeParse(u);
    if (!r.success) {
      const src = u.source.startsWith('legacy:') ? u.source.slice('legacy:'.length) : u.source;
      report.skipped.push({
        table: tableOfSourceRef(src),
        oldId: oldIdOfSourceRef(src),
        reason: `Zod 校验失败：${firstIssueMessage(r.error)}`,
      });
      continue;
    }
    keptUsageLogs.push(u);
  }
  if (usageDroppedWithParent > 0) {
    report.warnings.push(
      `${usageDroppedWithParent} 条旧流水因父物料行被跳过（sourceRef 已存在或 Zod 校验失败）未写入（§2.3 规则 3：usageLogs.materialId 为强引用）`,
    );
  }
  const keptAssignments = mapped.imageAssignments.filter((a) => !droppedEntityIds.has(a.entityId));
  if (keptAssignments.length < mapped.imageAssignments.length) {
    report.warnings.push(
      `${mapped.imageAssignments.length - keptAssignments.length} 条图片引用因所属实体行被跳过而未写入`,
    );
  }

  // —— 第 4 步：先写 images 行（§3.6 硬约束 5 / §9.7）——
  // 文件名 → LegacyImageFile（同名取第一个）；压缩结果按文件名缓存（跨实体
  // 同一文件只压一次；跨实体**不去重**，各写一行新 id，§9.7）。
  const filesByName = new Map<string, LegacyRawInput['images'][number]>();
  for (const f of raw.images) {
    if (f && typeof f.name === 'string' && f.name.trim() !== '' && !filesByName.has(f.name)) {
      filesByName.set(f.name, f);
    }
  }
  const compressCache = new Map<string, { blob: Blob; mimeType: string } | null>();
  const imageRows: ImageRecord[] = [];
  const entityImageIds = new Map<string, string[]>(); // 实体新 id → 新 images.id（按旧数组顺序）
  const totalAssignments = keptAssignments.length;
  let imagesDone = 0;
  emit('images', 0, totalAssignments); // 空输入也发一次阶段起始（done=total=0）
  for (const a of keptAssignments) {
    imagesDone += 1;
    emit('images', imagesDone, totalAssignments);
    const file = filesByName.get(a.legacyImageId);
    if (!file) {
      report.missingImages += 1; // 引用在、文件不在（§9.7）
      continue;
    }
    const compressed = await compressForMigration(file.blob, compressCache, a.legacyImageId);
    if (compressed === null) {
      report.rejectedImages += 1; // 压缩后超 2MB 或 MIME 不在白名单（§9.7）
      continue;
    }
    // §9.7 去重规则②：同实体内不同文件名、字节全同 → 只写一行，复用 id。
    const ids = entityImageIds.get(a.entityId) ?? [];
    let reused = false;
    for (let i = 0; i < ids.length; i += 1) {
      const prevRow = imageRows.find((r) => r.id === ids[i]);
      if (prevRow && (await blobsEqual(prevRow.blob, compressed.blob))) {
        reused = true;
        break;
      }
    }
    if (reused) continue;
    const row: ImageRecord = {
      id: nanoid(12),
      blob: compressed.blob,
      originalName: a.legacyImageId.trim().slice(0, 255) || 'image', // §9.7 / §3.6
      mimeType: compressed.mimeType as ImageRecord['mimeType'],
      entityType: a.entityType,
      entityId: a.entityId,
      syncedAt: undefined, // §3.6 硬约束 3：这个键一行都不许写（占位满足 Dexie 推导）
      createdAt: now,
    };
    imageRows.push(row);
    ids.push(row.id);
    entityImageIds.set(a.entityId, ids);
  }
  // AE-A Q2 同类修复：bulkPut 前在事务外预转换 Blob → Uint8Array（根因与
  // putImageRowsResilient 相同：中间件事务内 await arrayBuffer() 在 iOS WebKit
  // 上触发 TransactionInactiveError，见 ae-a-notes.md 证据链）。
  if (imageRows.length > 0) {
    const storedImageRows = await Promise.all(imageRows.map((r) => imageRowToStored(r)));
    await db.images.bulkPut(storedImageRows);
  }
  report.importedImages = imageRows.length;

  // —— 实体侧回写（§9.7）：material.images / garment.images 放新 images.id ——
  for (const m of keptMaterials) m.images = entityImageIds.get(m.id) ?? [];
  for (const g of keptGarments) g.images = entityImageIds.get(g.id) ?? [];

  // —— 第 5–7 步：三表各自独立 bulkPut（不套大事务，§9.2 事务口径）——
  emit('materials', 0, keptMaterials.length);
  if (keptMaterials.length > 0) await db.materials.bulkPut(keptMaterials);
  emit('materials', keptMaterials.length, keptMaterials.length);
  report.materials = keptMaterials.length;

  emit('garments', 0, keptGarments.length);
  if (keptGarments.length > 0) await db.garments.bulkPut(keptGarments);
  emit('garments', keptGarments.length, keptGarments.length);
  report.garments = keptGarments.length;

  emit('usageLogs', 0, keptUsageLogs.length);
  if (keptUsageLogs.length > 0) await db.usageLogs.bulkPut(keptUsageLogs);
  emit('usageLogs', keptUsageLogs.length, keptUsageLogs.length);
  report.usageLogs = keptUsageLogs.length;
  // 【Y-A】对齐流水实际落库条数（父物料行被跳过时对齐流水一并跳过，§2.3 规则 3）
  report.alignmentLogs = keptUsageLogs.filter((u) => u.source.startsWith('legacy:align:')).length;

  // —— 第 8 步：presets 三子键合并（§9.8.6：并集，非替换）——
  emit('presets', 0, 1);
  let current: PresetsConfig;
  try {
    current = JSON.parse(await getSettingValue('presets')) as PresetsConfig;
  } catch {
    current = { ...DEFAULT_PRESETS }; // 读侧解析失败回落默认值（§4.9.6 规则 7）
  }
  const { merged, added } = mergePresets(mapped.presets, current);
  await setSetting('presets', JSON.stringify(merged)); // 一次整值写（§9.8.6）
  report.presets = { patternBrands: added.patternBrands, fabricBrands: added.fabricBrands, accessoryTags: added.accessoryTags };
  emit('presets', 1, 1);

  // —— 第 9 步：唯一显式事务（backupLogs 一条 + settings 两行，同生共死）——
  emit('finalize', 0, 1);
  const message = `导入旧数据：物料 ${report.materials}, 成衣 ${report.garments}, 跳过 ${report.skipped.length}`.slice(0, 200);
  await db.transaction('rw', [db.settings, db.backupLogs], async () => {
    await db.backupLogs.add({
      id: nanoid(12),
      kind: 'migration',
      status: 'success',
      message, // §1.3 ≤ 200 字
      createdAt: now,
    });
    await db.settings.put({ key: 'import_completed', value: 'true', updatedAt: now });
    await db.settings.put({ key: 'dirty_since_backup', value: 'true', updatedAt: now }); // 导入后打脏（§9.2 第 9 步）
  });
  emit('finalize', 1, 1);

  // —— 第 10 步：返回 ImportReport ——
  return report;
}
