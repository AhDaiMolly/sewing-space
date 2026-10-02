// src/db/migrations/legacy.ts
//
// S8-A 迁移映射模块。DM v2.0 §9.3 冻结接口 + §9.8 初始映射表 + §9.6 日期口径。
//
// ── 集合识别策略（重要）────────────────────────────────────────────────
// 本模块**不做**旧集合的识别。§9.3 的 `LegacyRawInput` 是「按集合名组装好」的
// 入参结构（六个具名键），集合归属由**调用方**（import.ts / 导出组装层）负责：
// 旧微信云数据库导出的 JSON 文件名是随机后缀（`database_export-<随机串>.json`），
// **没有语义、不能作为集合归属依据**；调用方须按 NDJSON 内容特征或导出工具的
// 集合对照关系，把行对象分装进六个键后再交给 `mapLegacyRows`。
//
// ── 真实数据与 DM §9.8 快照的实质出入（保守口径，详见 s8a-notes.md）──────
// 1. `garment.fabricAmounts` / `accessoryAmounts` 实测是 **`{ 旧id: 数量 }` 字典**，
//    而 §9.8.5 按 `[{ materialId, amount }]` 数组描述。本模块两种形态都支持：
//    字典的键（保持插入顺序）/ 数组元素的 `materialId` 作为旧物料 id。
//    【Y-A 成衣成本修复，2026-09-29】数量值**不再丢弃**：可解析 id 且数量 > 0
//    的条目映射为 garment.materialSnapshot 活跃快照行（priceSnapshot 取
//    unitPriceOf 迁移物料单价、deducted=true、不写 retiredAt），materialIds =
//    快照行 materialId 去重集，totalCost = round2(Σ活跃 subtotal + patternPrice)
//    —— 与 garmentService V-A Q16 口径自洽（§9.5 旧裁决作废，记口径变更）。
//    仍解析不了的条目（id 翻不到 / 数量 ≤ 0 / 坏元素）进 droppedAmounts。
// 2. 【Y-A 价格口径变更，2026-09-29】purchasePrice 改存**总价**（V-A Q16 手工
//    录入口径）、initialQuantity 改存**购买量**（旧 purchased）：fabric 直取
//    totalPrice、accessory 直取 totalPrice、tools 直取 price（总价）；除法折算
//    单价统一交给 unitPriceOf（总价 ÷ 开账量），与手工行完全同口径。§9.5 旧
//    裁决「initialQuantity = quantity、purchased 丢弃」作废（记口径变更）。
// 3. 【Y-A 库存对齐，2026-09-29】购买量 ≠ 当前库存且旧程序无已迁移损耗记录的
//    物料，补一条 kind='consume' 的对齐流水（差额 = 购买量 − 当前库存 > 0，
//    source='legacy:align:{table}:{oldId}'、note='迁移时数据对齐'），使
//    购买量 − 损耗 = 当前库存 成立；差额为负不补、仅记 warning；已迁移过
//    usageRecords 的物料不补。计数进 report.alignmentLogs。
// 4. `imageAssignments.legacyImageId` 取 cloud:// URL 的**末段文件名**（任务书
//    口径，与用户图片包内文件名一致，如 `.../images/1787386979942-979340.jpg`
//    → `1787386979942-979340.jpg`）；DM §9.7 写的是「元素原文」，以任务书为准。
// 5. audience 第 2 个元素起的 tag 前缀**保留旧原文**（§9.8.4 步骤 3 规则原文
//    「值保留旧原文」；DM 示例同时出现 `audience:men` 与 `audience:宠物` 两种
//    写法、自相矛盾，按规则文本执行，见 s8a-notes.md）。
//
// ── 本模块产出的 report 是「映射阶段」口径 ──────────────────────────────
// - `materials` / `garments` / `usageLogs` 计数 = 映射产物行数；import.ts 第 3 步
//   Zod 校验后覆写为实际 bulkPut 行数（§9.2：Zod 是唯一「整行丢弃」入口）。
// - `presets` 三计数 = 旧值有效项数；import.ts 第 8 步与本机当前值合并后覆写为
//   实际新增项数（§9.8.6）。
// - `importedImages` / `missingImages` / `rejectedImages` 恒 0：图片文件的读取、
//   压缩与按文件名匹配在 import.ts 第 4 步（§9.7：mapLegacyRows 不读文件、不产
//   Blob），由 import.ts 覆写。`truncatedImages` 由本模块按「每实体 ≤ 5 张」计算。
//
// ── 纯函数与不抛异常 ──────────────────────────────────────────────────
// 不碰 Dexie、不读文件、不取系统时钟（`now` 走入参，§9.3）；单行映射异常推入
// `report.skipped` 继续下一行，顶层兜底 catch 保证整体永不抛出。

import { nanoid } from 'nanoid';
import type { ForWhom, Garment, Material, PresetsConfig, UsageLog } from '@/db/types';
import { round2 } from '@/lib/num';
import { unitPriceOf } from '@/services/garmentService';

// ============================ §9.3 冻结导出面 ============================

/** 六个旧数源名，冻结（§9.3）。处理顺序即数组顺序：garment 依赖前三张表填好 id 映射。 */
export const LEGACY_SOURCES = [
  'fabric',
  'accessory',
  'tools',
  'pattern',
  'garment',
  'preset',
] as const;

/** `LEGACY_SOURCES` 的元素类型（§9.3 派生类型）。 */
export type LegacySource = (typeof LEGACY_SOURCES)[number];

/**
 * 用户随旧数据提供的图片文件。文件名 = 旧 `cloud://` 引用的末段，即
 * `imageAssignments.legacyImageId`。`mapLegacyRows` 不读 `blob`（§9.7），
 * 文件读取与重压是 import.ts 第 4 步的事。
 */
export interface LegacyImageFile {
  /** 图片文件名，例 `1787386979942-979340.jpg`。 */
  name: string;
  /** 图片二进制内容。 */
  blob: Blob;
  /** MIME 类型，例 `image/jpeg`。 */
  mimeType: string;
}

/** 已解析成内存对象的旧数据（JSON.parse 之后、映射之前，§9.2 第 1 步）。数源缺失当空处理。 */
export interface LegacyRawInput {
  fabric: unknown[];
  accessory: unknown[];
  tools: unknown[];
  pattern: unknown[];
  garment: unknown[];
  preset: unknown;
  images: LegacyImageFile[];
}

/** 导入结果的唯一载体（§9.3）。字段口径见模块头「映射阶段」说明。 */
export interface ImportReport {
  /** 映射产物 materials 行数（import.ts 覆写为实际 bulkPut 行数）。 */
  materials: number;
  /** 映射产物 garments 行数（import.ts 覆写）。 */
  garments: number;
  /** 映射产物 usageLogs 行数（import.ts 覆写）。 */
  usageLogs: number;
  /** 旧 preset.config 三个子键各自的有效项数（import.ts 合并后覆写为实际新增项数）。 */
  presets: { patternBrands: number; fabricBrands: number; accessoryTags: number };
  /** 实际写入 images 表的行数。映射阶段恒 0，import.ts 第 4 步覆写。 */
  importedImages: number;
  /** 引用在、文件不在的张数。映射阶段恒 0，import.ts 覆写。 */
  missingImages: number;
  /** 文件在但压缩后超 2MB 或 MIME 不在白名单的张数。映射阶段恒 0，import.ts 覆写。 */
  rejectedImages: number;
  /** 因「每实体最多 5 张」被截掉的张数（§9.7），本模块计算。 */
  truncatedImages: number;
  /** 整行丢弃清单。`oldId` 取旧记录 `_id`，取不到写 `''`（§9.3）。 */
  skipped: { table: LegacySource; oldId: string; reason: string }[];
  /** 外键翻不到目标的清单。`field` 写旧字段名（§9.8.5）。 */
  danglingRefs: { table: LegacySource; oldId: string; field: string }[];
  /** 旧字段被丢弃的清单。同一 `table + field` 只出现一次（§9.3）。 */
  droppedFields: { table: LegacySource; field: string; reason: string }[];
  /** 成衣旧数量被丢弃的清单。`oldId` 是旧 `garment._id`（§9.5/§9.8.5）。 */
  droppedAmounts: { oldId: string; field: 'fabricAmounts' | 'accessoryAmounts'; count: number }[];
  /** 【Y-A】库存对齐流水的实际写入条数（映射阶段为产出条数，import.ts 覆写
   *  为随父物料行落库的条数；父行被跳过时对齐流水一并跳过）。 */
  alignmentLogs: number;
  /** 不阻断导入、但用户该看见的提醒（§9.3）。 */
  warnings: string[];
}

/**
 * 导入进度回调的载荷。DM §9.2 的 `onProgress` 只在 §9.3 点名、未定义结构，
 * 此处为最小可用定义；`mapLegacyRows` 是纯函数、不产进度，由 import.ts
 * 逐阶段回调（phase 与 §9.2 的 10 步对应，parse/validate/finalize 为框架步骤）。
 */
export interface ImportProgress {
  /** 当前执行到的阶段。 */
  phase:
    | 'parse'
    | 'map'
    | 'validate'
    | 'images'
    | 'materials'
    | 'garments'
    | 'usageLogs'
    | 'presets'
    | 'finalize';
  /** 当前阶段已完成条数。 */
  done: number;
  /** 当前阶段总条数（未知时为 0）。 */
  total: number;
}

/** `mapLegacyRows` 的返回结构（§9.3 冻结）。 */
export interface LegacyMappedRows {
  materials: Material[];
  garments: Garment[];
  usageLogs: UsageLog[];
  /** 图片引用清单，import.ts 第 4 步的输入（§9.7）。legacyImageId = 文件名。 */
  imageAssignments: {
    entityType: 'material' | 'garment';
    entityId: string;
    legacyImageId: string;
  }[];
  /** 旧 preset.config 映射出的三个子键（合并由 import.ts 第 8 步做）。 */
  presets: Partial<PresetsConfig>;
  report: ImportReport;
}

// ============================ 内部类型与工具 ============================

interface ImageAssignment {
  entityType: 'material' | 'garment';
  entityId: string;
  legacyImageId: string;
}

interface Ctx {
  now: string;
  today: string;
  materials: Material[];
  garments: Garment[];
  usageLogs: UsageLog[];
  imageAssignments: ImageAssignment[];
  fabricIdMap: Map<string, string>;
  accessoryIdMap: Map<string, string>;
  patternIdMap: Map<string, string>;
  presetsOut: Partial<PresetsConfig>;
  skipped: ImportReport['skipped'];
  danglingRefs: ImportReport['danglingRefs'];
  droppedFields: Map<string, ImportReport['droppedFields'][number]>;
  droppedAmounts: ImportReport['droppedAmounts'];
  warnings: string[];
  truncatedImages: number;
  /** 【Y-A】库存对齐流水产出条数（进 report.alignmentLogs）。 */
  alignmentLogs: number;
  /** 【AA-A 迁移1】待对齐候选（fabric/accessory 行映射时登记，garment 表映射
   *  完成后统一裁决——此时才知道物料是否被成衣关联）。 */
  pendingAlign: {
    table: 'fabric' | 'accessory';
    oldId: string;
    m: Material;
    purchased: number | undefined;
    hasUsageRecords: boolean;
    urSum: number;
  }[];
  /** 【AA-A 迁移1】被任一成衣关联（可解析）的物料新 id 集（对齐裁决用）。 */
  associatedMaterialIds: Set<string>;
  /** 【AA-A 迁移1】各物料被成衣关联的用量合计（残留诊断 warning 用）。 */
  amountByMaterial: Map<string, number>;
  /** 【AA-A 迁移1】成衣消耗流水产出条数（汇总 warning 用）。 */
  garmentConsumeLogs: number;
  /** 【Y-A】新物料 id → 迁移产物 Material 行（成衣快照取 name/unit/折算单价用）。 */
  materialById: Map<string, Material>;
  /** buyDate 缺失/无法解析、purchaseDate 落导入当天的物料行数（汇总 warning 用）。 */
  buyDateFallbackCount: number;
  /** 辅料无 tag 的行数（汇总 warning 用，§9.8.3）。 */
  noTagCount: number;
  /** 旧图片引用里非字符串的元素个数（汇总 warning 用）。 */
  badImageRefCount: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const trimSlice = (v: unknown, max: number): string => str(v).trim().slice(0, max);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const oldIdOf = (row: unknown): string => (isPlainObject(row) ? str(row._id).trim() : '');

function pushDropped(ctx: Ctx, entry: { table: LegacySource; field: string; reason: string }): void {
  const key = `${entry.table}:${entry.field}`;
  if (!ctx.droppedFields.has(key)) ctx.droppedFields.set(key, entry);
}

// ============================ §9.6 日期与时刻转换 ============================

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_SLASH_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 旧日期串 → `YYYY-MM-DD`（§9.6 表前三行）。
 * 返回 `''` = 空值（空串/null/缺键）；`null` = 有值但无法解析。
 */
function parseLegacyDate(v: unknown): string | null {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return '';
  if (DATE_ONLY_RE.test(s)) return s;
  const m = DATE_SLASH_RE.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  return null;
}

/**
 * 旧 `buyDate` → `purchaseDate`（§9.8「旧日期的三条专用规则」）。
 * 有值且能解析 → 直映；晚于导入当天 → 保留 + 逐行 warning；无值 → 导入当天；
 * 有值但无法解析 → `purchaseDate` 无 `''` 合法值（§3.1 必填），按缺失同口径落
 * 导入当天并计入汇总 warning（DM 未明说，保守口径，见 s8a-notes.md）。
 */
function buyDateToPurchaseDate(
  ctx: Ctx,
  v: unknown,
  table: LegacySource,
  oldId: string,
): string {
  const parsed = parseLegacyDate(v);
  if (parsed === null || parsed === '') {
    ctx.buyDateFallbackCount += 1;
    return ctx.today;
  }
  if (parsed > ctx.today) {
    ctx.warnings.push(
      `${table}:${oldId} 旧 buyDate（${parsed}）晚于导入当天，保留原值（§9.8 旧日期规则第 3 行）`,
    );
  }
  return parsed;
}

/** 旧时刻串 → ISO 时刻（§9.6 表第 2/3 行）；date-only 视为当日 00:00 UTC。 */
function legacyDateTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const m = DATETIME_RE.exec(s);
  if (m) return `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? '00'}.000Z`;
  if (DATE_ONLY_RE.test(s)) return `${s}T00:00:00.000Z`;
  return null;
}

/** `usageRecords.time` → 流水 `createdAt`（§9.6：取不到才用导入时刻 + warning）。 */
function usageTime(v: unknown, now: string): { iso: string; warn: string | null } {
  const iso = legacyDateTime(v);
  if (iso !== null) return { iso, warn: null };
  const label = v === null || v === undefined ? '缺失' : `「${String(v)}」无法解析`;
  return { iso: now, warn: `旧 time ${label}，流水 createdAt 落导入时刻（§9.6）` };
}

// ============================ §9.8.4 audience 翻译 ============================

const AUDIENCE_MAP: Record<string, Exclude<ForWhom, ''>> = {
  女士: 'women',
  儿童: 'children',
  男士: 'men',
  婴儿: 'baby',
  宠物: 'pet',
};

/**
 * §9.8.4 的 6 步翻译规则（pattern 与 garment 共用，§9.8.5 逐字复用）。
 * 首元素按翻译表转 `forWhom`；第 2 个元素起加 `audience:` 前缀进 `tags`，
 * **值保留旧原文**（规则文本口径；DM 示例两种写法自相矛盾，见 s8a-notes.md）；
 * `tags` 去重、单元素 ≤ 20 字（§3.1）。
 */
function mapAudience(
  ctx: Ctx,
  v: unknown,
  tags: string[],
  table: LegacySource,
  oldId: string,
): ForWhom {
  if (!Array.isArray(v) || v.length === 0) return ''; // 步骤 4：None/null/空数组/缺键
  const first = v[0];
  let forWhom: ForWhom = '';
  const mapped = typeof first === 'string' ? AUDIENCE_MAP[first.trim()] : undefined;
  if (mapped !== undefined) {
    forWhom = mapped;
  } else {
    // 步骤 5：首元素不在翻译表 → forWhom=''，记 warning，不丢行
    ctx.warnings.push(
      `${table}:${oldId} 旧 audience 首元素「${typeof first === 'string' ? first : String(first)}」不在翻译表，forWhom 落 ''（§9.8.4 步骤 5）`,
    );
  }
  for (const el of v.slice(1)) {
    if (typeof el !== 'string' || el.trim() === '') continue;
    const tag = `audience:${el}`.slice(0, 20);
    if (!tags.includes(tag)) tags.push(tag); // 步骤 6：去重
  }
  return forWhom;
}

// ============================ §9.9 兜底 droppedFields ============================

/** 各旧表里被 §9.8 映射表消费的旧字段（其余出现的字段按 §9.9 第 3 步兜底丢弃）。 */
const CONSUMED_KEYS: Record<LegacySource, Set<string>> = {
  fabric: new Set([
    '_id', 'name', 'brand', 'price', 'totalPrice', 'purchased', 'stock', 'buyDate', 'image',
    'width', 'season', 'weight', 'composition', 'sampleCard', 'usageRecords',
  ]),
  accessory: new Set([
    '_id', 'name', 'tag', 'totalPrice', 'purchased', 'quantity', 'buyDate', 'image',
    'unit', 'width', 'usageRecords',
  ]),
  tools: new Set(['_id', 'name', 'quantity', 'purchased', 'price', 'buyDate', 'image', 'unit', 'category']),
  pattern: new Set([
    '_id', 'name', 'style', 'size', 'price', 'brand', 'note', 'rating', 'audience', 'image',
  ]),
  garment: new Set([
    '_id', 'name', 'status', 'size', 'finishDate', 'image', 'style', 'audience',
    'fabricAmounts', 'accessoryAmounts', 'patternId', 'createdAt',
  ]),
  preset: new Set(['_id', 'config']),
};

/** §9.9 明确清单里写死理由的字段。 */
const DROPPED_REASONS: Record<string, string> = {
  _openid: '旧小程序用户标识，v2 无多用户概念（§9.9）',
  id: '旧库内部 id，无业务含义；sourceRef 用 _id（§9.4/§9.9）',
  createdAt: '迁移统一用导入时刻，不保留旧值（§9 通用规则；garment 例外直映）',
};

/** 按表 + 字段写死理由的（§9.8.5 / §9.8.6）。 */
const DROPPED_REASONS_BY_TABLE_FIELD: Record<string, string> = {
  'garment:materials':
    '与 fabricAmounts/accessoryAmounts/patternId 100% 一致的冗余副本（§9.8.5，附录 A-32）',
  'garment:patternPurchasePrice': 'v2 的 garments 字段总表里没有这个字段（§9.8.5）',
  'preset:config.patternStyles': 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
  'preset:config.patternAudiences': 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
  'preset:config.patternSizes': 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
  'preset:config.accessoryWidths': 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
  'preset:config.fabricWidths': 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
};

/** §9.9 第 3 步兜底扫描：行里出现、未被映射表消费的字段 → droppedFields（按 table+field 去重）。 */
function scanDroppedFields(ctx: Ctx, table: LegacySource, row: Record<string, unknown>): void {
  for (const key of Object.keys(row)) {
    if (CONSUMED_KEYS[table].has(key)) continue;
    const reason =
      DROPPED_REASONS_BY_TABLE_FIELD[`${table}:${key}`] ??
      DROPPED_REASONS[key] ??
      '旧字段在 v2 无对应字段（§9.9 兜底）';
    pushDropped(ctx, { table, field: key, reason });
  }
}

// ============================ §9.7 图片引用清单 ============================

/**
 * 旧 `image` 字段 → `imageAssignments`（§9.7）。
 * 空串/空数组/缺键/非数组 → 无引用、不报错；数组多图**全保留并截到 5 张**；
 * 同实体内同名去重（§9.7 去重规则①；跨实体不去重——复制两行是 import.ts 的事）；
 * `legacyImageId` 取 cloud:// URL 末段文件名（任务书口径，见模块头说明 3）。
 * 实体行 `images` 数组由 import.ts 第 4 步写完 images 行后回填新 id，此处恒 `[]`。
 */
function mapImageRefs(
  ctx: Ctx,
  entityType: 'material' | 'garment',
  entityId: string,
  v: unknown,
): void {
  if (!Array.isArray(v)) return;
  const seen = new Set<string>();
  let kept = 0;
  for (const el of v) {
    if (typeof el !== 'string') {
      ctx.badImageRefCount += 1;
      continue;
    }
    const name = el.slice(el.lastIndexOf('/') + 1).trim();
    if (name === '') continue;
    if (seen.has(name)) continue; // 同实体同名只留一条（§9.7 规则①）
    seen.add(name);
    if (kept >= 5) {
      ctx.truncatedImages += 1; // 每实体最多 5 张（§3.1 硬约束 6 / §9.7）
      continue;
    }
    kept += 1;
    ctx.imageAssignments.push({ entityType, entityId, legacyImageId: name });
  }
}

// ============================ §9.8.7 usageRecords → usageLogs ============================

/**
 * 旧 `usageRecords`（fabric/accessory 的数组字段）摊成 `usageLogs` 行。
 * 挂在物料行上，`materialId` = 所挂物料迁移后的新 id（永远可解析——父行在本
 * 函数之前已产出）；`kind` 推定 `'consume'`（§9.6，汇总 warning 见主函数）；
 * `amount` 非正数/缺失 → 该条不产出 + warning（§3.5 硬约束 2）。
 */
function mapUsageRecords(
  ctx: Ctx,
  table: 'fabric' | 'accessory',
  oldId: string,
  v: unknown,
  parent: Material,
): void {
  if (!Array.isArray(v) || v.length === 0) return;
  for (const el of v) {
    if (!isPlainObject(el)) {
      ctx.warnings.push(`${table}:${oldId} 的 usageRecords 条目不是对象，未迁`);
      continue;
    }
    const amount = num(el.amount);
    if (amount === undefined || amount <= 0) {
      ctx.warnings.push(
        `${table}:${oldId} 的 usageRecords 条目 amount 缺失或 ≤ 0，未迁（consume 恒 > 0，§3.5 硬约束 2）`,
      );
      continue;
    }
    const t = usageTime(el.time, ctx.now);
    if (t.warn) ctx.warnings.push(`${table}:${oldId} 的 usageRecords：${t.warn}`);
    ctx.usageLogs.push({
      id: nanoid(12),
      materialId: parent.id,
      materialName: parent.name,
      unit: parent.unit,
      quantity: round2(amount),
      kind: 'consume',
      source: `legacy:${table}:${oldId}`,
      garmentId: '',
      note: `旧数据导入：${table}`.slice(0, 100), // §9.6 定死模板，仍按 §3.5 硬约束 4 截断
      createdAt: t.iso,
    });
  }
}

/** 【AA-A 迁移1】旧 usageRecords 的 amount 合计（对齐裁决的残留诊断用）。 */
function sumUsageRecords(v: unknown): number {
  if (!Array.isArray(v)) return 0;
  let sum = 0;
  for (const el of v) {
    if (!isPlainObject(el)) continue;
    const amount = num(el.amount);
    if (amount !== undefined && amount > 0) sum += amount;
  }
  return round2(sum);
}

/**
 * 【AA-A 迁移1 口径修正】成衣关联物料的库存差异不再落「迁移时数据对齐」，
 * 改为逐 (成衣, 物料) 对写一条 kind='consume' 的「成衣消耗」流水：
 * quantity = 该成衣记录的用量、createdAt = 成衣完工时间（date-only → 当日
 * 00:00 UTC；未完工成衣无完工时间，落导入时刻）、source/garmentId 与正常
 * 流程 consumeOnAssociate 同形态（`garment:{garmentId}`，过 UsageSourceSchema
 * 与 §3.5 硬约束 3 组合校验）。已验证（真实数据 56/56 关联物料）：
 * 库存差额 = Σ关联成衣用量 + Σ旧损耗记录，因此三类流水（成衣消耗 + 旧损耗
 * + 未关联对齐）合计恰好等于库存差额，不造数、不留残差。
 */
function pushGarmentConsumeLog(ctx: Ctx, g: Garment, mat: Material, amount: number): void {
  ctx.usageLogs.push({
    id: nanoid(12),
    materialId: mat.id,
    materialName: mat.name,
    unit: mat.unit,
    quantity: round2(amount),
    kind: 'consume',
    source: `garment:${g.id}`,
    garmentId: g.id,
    note: `旧数据导入：${g.name} 成衣消耗`.slice(0, 100),
    createdAt: g.completionDate !== '' ? `${g.completionDate}T00:00:00.000Z` : ctx.now,
  });
  ctx.garmentConsumeLogs += 1;
}

/**
 * 【AA-A 迁移1】fabric/accessory 对齐候选的延迟裁决（garment 表映射完成后调）。
 * 只有三条件同时成立才补对齐流水（见 pushAlignmentLog 口径）；关联/有旧损耗
 * 的物料做残留诊断：真实数据关联物料 56/56 恒等、未关联有损耗物料 12/13 恒等
 * （唯一不平的是波点绵绸：旧库自身超扣，见 aa-notes 迁移3 证据），不平即 warning。
 */
function resolvePendingAlignments(ctx: Ctx): void {
  for (const p of ctx.pendingAlign) {
    if (ctx.associatedMaterialIds.has(p.m.id)) {
      if (p.purchased !== undefined && p.purchased > 0) {
        const diff = round2(p.purchased - p.m.quantity);
        const amounts = ctx.amountByMaterial.get(p.m.id) ?? 0;
        const covered = round2(p.urSum + amounts);
        if (Math.abs(diff - covered) > 0.005) {
          ctx.warnings.push(
            `${p.table}:${p.oldId} 关联成衣用量+旧损耗（${covered}）与库存差额（${diff}）不一致，残留 ${round2(diff - covered)} 未补流水（AA-A）`,
          );
        }
      }
      continue; // 关联成衣：差异由成衣消耗流水（+旧损耗流水）承载，不补对齐
    }
    if (p.hasUsageRecords) {
      if (p.purchased !== undefined && p.purchased > 0) {
        const diff = round2(p.purchased - p.m.quantity);
        if (Math.abs(diff - p.urSum) > 0.005) {
          ctx.warnings.push(
            `${p.table}:${p.oldId} 旧损耗合计（${p.urSum}）与库存差额（${diff}）不一致，差 ${round2(diff - p.urSum)}（旧库记录自身不平，AA-A）`,
          );
        }
      }
      continue; // 未关联但有旧损耗记录：损耗已在旧流水里（Y-A 口径不变）
    }
    pushAlignmentLog(ctx, p.table, p.oldId, p.m, p.purchased);
  }
}

/**
 * 【AA-A 迁移2 复核后的统一口径】「迁移时数据对齐」流水只补给同时满足三条件
 * 的物料：
 * ① 未被任何成衣关联（garment 表 fabricAmounts/accessoryAmounts 翻不到该物料）；
 * ② 旧程序无已迁移损耗记录（usageRecords 为空）；
 * ③ 购买量 − 当前库存 > 0。
 * 三者同时成立才补，使 购买量 − 损耗 = 当前库存 成立。挂在 ctx.usageLogs 上，
 * 随父物料行继承 import.ts 的 sourceRef 判重幂等（§2.3 规则 3 派生跳过）。
 * 边界（任务书口径）：
 * - 差额 ≤ 0（含当前库存 > 购买量的负差）不补；负差仅记 warning 入导入报告；
 * - 已迁移过 usageRecords 的物料不补（损耗已在旧流水里体现）；
 * - 被成衣关联的物料不补（差异由「成衣消耗」流水 + 旧损耗流水承载，AA-A 迁移1）；
 * - purchased 缺失 / ≤ 0 不补（无从计算差额）。
 */
function pushAlignmentLog(
  ctx: Ctx,
  table: 'fabric' | 'accessory' | 'tools',
  oldId: string,
  m: Material,
  purchased: number | undefined,
): void {
  if (purchased === undefined || purchased <= 0) return;
  const diff = round2(purchased - m.quantity);
  if (diff < 0) {
    ctx.warnings.push(
      `${table}:${oldId} 当前库存（${m.quantity}）大于购买量（${purchased}），不补负数对齐流水（Y-A 口径）`,
    );
    return;
  }
  if (diff === 0) return;
  ctx.usageLogs.push({
    id: nanoid(12),
    materialId: m.id,
    materialName: m.name,
    unit: m.unit,
    quantity: diff,
    kind: 'consume',
    source: `legacy:align:${table}:${oldId}`,
    garmentId: '',
    note: '迁移时数据对齐',
    createdAt: ctx.now,
  });
  ctx.alignmentLogs += 1;
}

// ============================ 物料基座与各表映射 ============================

function baseMaterial(type: Material['type'], id: string, now: string): Material {
  return {
    id,
    type,
    name: '',
    category: '',
    quantity: 0,
    initialQuantity: 0,
    unit: '',
    purchaseDate: '',
    purchasePrice: undefined,
    color: '',
    width: undefined,
    weight: undefined,
    composition: '',
    sampleCard: '',
    season: 'all_season',
    suitableFor: [],
    forWhom: '',
    tags: [],
    notes: '',
    brand: '',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [], // import.ts 第 4 步回填新 images.id（§9.7「实体侧的回写」）
    createdAt: now,
    updatedAt: now,
    sourceRef: undefined,
  };
}

/** §9.8.1 fabric → materials（type='fabric'）。 */
function mapFabricRow(ctx: Ctx, row: Record<string, unknown>): void {
  const oldId = str(row._id).trim();
  const m = baseMaterial('fabric', nanoid(12), ctx.now);
  m.name = trimSlice(row.name, 50);
  m.brand = trimSlice(row.brand, 30);
  m.sourceRef = `fabric:${oldId}`;
  // 【Y-A 总价口径】totalPrice 直取为 purchasePrice（V-A Q16 手工行同口径）；
  // 缺失时降级 price（单价）× purchased 估算总价；再不行 price 直用并 warning。
  // （实测 71/71 行 totalPrice/purchased 与旧 price 单价一致，总价换算安全。）
  const tp = num(row.totalPrice);
  const price = num(row.price);
  const p = num(row.purchased);
  if (tp !== undefined) {
    m.purchasePrice = round2(tp);
  } else if (price !== undefined && price > 0 && p !== undefined && p > 0) {
    m.purchasePrice = round2(price * p); // 单价 × 购买量 估算总价
  } else if (price !== undefined && price > 0) {
    ctx.warnings.push(
      `fabric:${oldId} totalPrice 缺失且无法用 price×purchased 折算（purchased=${p ?? '缺失'}），purchasePrice 未记录`,
    );
  } else {
    ctx.warnings.push(
      `fabric:${oldId} totalPrice 与 price 均缺失或为 0，purchasePrice 未记录`,
    );
  }
  m.quantity = round2(num(row.stock) ?? 0);
  // 【Y-A】initialQuantity = 购买量（purchased>0 才用；缺失/0 回落当前库存）
  m.initialQuantity = p !== undefined && p > 0 ? round2(p) : m.quantity;
  m.unit = '米'; // §4.7 fabric 默认单位（旧 fabric 无 unit 字段）
  m.purchaseDate = buyDateToPurchaseDate(ctx, row.buyDate, 'fabric', oldId);
  // width：旧值是米字符串（"1.45"）→ cm 整数（§9.8.1）；NaN/≤0/空串 → 键缺失
  const wRaw = row.width;
  const wNum = typeof wRaw === 'number' ? wRaw : typeof wRaw === 'string' && wRaw.trim() !== '' ? Number(wRaw) : NaN;
  if (Number.isFinite(wNum) && wNum > 0) {
    const cm = Math.round(wNum * 100);
    if (cm > 0) m.width = cm;
  }
  // season/weight/composition/sampleCard：真实数据 71/71 均无这些键 → 落 §3.1 默认值
  ctx.materials.push(m);
  ctx.materialById.set(m.id, m);
  ctx.fabricIdMap.set(oldId, m.id);
  mapImageRefs(ctx, 'material', m.id, row.image);
  const hasUsageRecords = Array.isArray(row.usageRecords) && row.usageRecords.length > 0;
  mapUsageRecords(ctx, 'fabric', oldId, row.usageRecords, m);
  // 【AA-A 迁移1】对齐裁决延迟到 garment 表映射后（此时才知该布是否被成衣关联）
  ctx.pendingAlign.push({
    table: 'fabric',
    oldId,
    m,
    purchased: p,
    hasUsageRecords,
    urSum: sumUsageRecords(row.usageRecords),
  });
  scanDroppedFields(ctx, 'fabric', row);
}

/** §9.8.3 accessory → materials（type='accessory'）。 */
function mapAccessoryRow(ctx: Ctx, row: Record<string, unknown>): void {
  const oldId = str(row._id).trim();
  const m = baseMaterial('accessory', nanoid(12), ctx.now);
  m.name = trimSlice(row.name, 50);
  m.sourceRef = `accessory:${oldId}`;
  // tag → category；缺失/空 → ''（计入汇总 warning，§9.8.3）
  m.category = trimSlice(row.tag, 20);
  if (str(row.tag).trim() === '') ctx.noTagCount += 1;
  // 【Y-A 总价口径】totalPrice 直取为 purchasePrice（不再除以 purchased）
  const tp = num(row.totalPrice);
  if (tp !== undefined) {
    m.purchasePrice = round2(tp); // 实测 3 行 totalPrice=0：0 合法
  } else {
    ctx.warnings.push(`accessory:${oldId} totalPrice 缺失，purchasePrice 未记录`);
  }
  m.quantity = round2(num(row.quantity) ?? 0);
  const p = num(row.purchased);
  // 【Y-A】initialQuantity = 购买量（purchased>0 才用；缺失/0 回落当前库存）
  m.initialQuantity = p !== undefined && p > 0 ? round2(p) : m.quantity;
  // unit 直映（实测 65/65 有值：米/个）；空则回落 §4.7 默认 '个'
  m.unit = str(row.unit).trim().slice(0, 5) || '个';
  m.purchaseDate = buyDateToPurchaseDate(ctx, row.buyDate, 'accessory', oldId);
  // width 形如 "1cm" → parseFloat 取数字（§9.8.3，附录 A-31：本版迁移）
  const wv = parseFloat(str(row.width));
  if (Number.isFinite(wv) && wv > 0) m.width = Math.round(wv * 10) / 10; // positive1：≤1 位小数
  ctx.materials.push(m);
  ctx.materialById.set(m.id, m);
  ctx.accessoryIdMap.set(oldId, m.id);
  mapImageRefs(ctx, 'material', m.id, row.image);
  const hasUsageRecords = Array.isArray(row.usageRecords) && row.usageRecords.length > 0;
  mapUsageRecords(ctx, 'accessory', oldId, row.usageRecords, m);
  // 【AA-A 迁移1】对齐裁决延迟到 garment 表映射后（此时才知该辅料是否被成衣关联）
  ctx.pendingAlign.push({
    table: 'accessory',
    oldId,
    m,
    purchased: p,
    hasUsageRecords,
    urSum: sumUsageRecords(row.usageRecords),
  });
  scanDroppedFields(ctx, 'accessory', row);
}

/** §9.8.2 tools → materials（type='tool'）。 */
function mapToolsRow(ctx: Ctx, row: Record<string, unknown>): void {
  const oldId = str(row._id).trim();
  const m = baseMaterial('tool', nanoid(12), ctx.now);
  m.name = trimSlice(row.name, 50);
  m.sourceRef = `tools:${oldId}`;
  m.quantity = round2(num(row.quantity) ?? 0);
  const price = num(row.price);
  const p = num(row.purchased);
  // 【Y-A 总价口径】price 是总价 → 直取 purchasePrice，不再除以 purchased。
  // purchasePrice 缺失/为 0 时仅 warning，不写 notes（Y-A：去除自动备注）。
  if (price !== undefined) {
    m.purchasePrice = round2(price);
    if (price <= 0) {
      ctx.warnings.push(`tools:${oldId} price=${price} ≤ 0，purchasePrice 记 0`);
    }
  } else {
    ctx.warnings.push(`tools:${oldId} price 缺失，purchasePrice 未记录`);
  }
  // 【Y-A】initialQuantity = 购买量；purchased=0/缺失回落当前库存（D-WH5 实测
  // A4文件袋 2 行 purchased=0，仅 warning 提示，不再自动写备注）
  if (p !== undefined && p > 0) {
    m.initialQuantity = round2(p);
  } else {
    m.initialQuantity = m.quantity;
    if (p === 0) {
      ctx.warnings.push(`tools:${oldId} purchased=0，initialQuantity 落当前库存（D-WH5）`);
    }
  }
  m.unit = '个'; // §4.7 tool 默认单位（实测 40/40 无 unit 键）
  m.category = ''; // 实测 40/40 无 category 键
  m.purchaseDate = buyDateToPurchaseDate(ctx, row.buyDate, 'tools', oldId);
  ctx.materials.push(m);
  ctx.materialById.set(m.id, m);
  const hasUsageRecords = Array.isArray(row.usageRecords) && row.usageRecords.length > 0;
  if (!hasUsageRecords) pushAlignmentLog(ctx, 'tools', oldId, m, p);
  mapImageRefs(ctx, 'material', m.id, row.image);
  scanDroppedFields(ctx, 'tools', row);
}

/** §9.8.4 pattern → materials（type='pattern'）。 */
function mapPatternRow(ctx: Ctx, row: Record<string, unknown>): void {
  const oldId = str(row._id).trim();
  const m = baseMaterial('pattern', nanoid(12), ctx.now);
  m.name = trimSlice(row.name, 50);
  m.category = trimSlice(row.style, 20); // style → category
  m.size = trimSlice(row.size, 20);
  m.sourceRef = `pattern:${oldId}`;
  // price 直映（旧库无 purchased，做不了除法；实测 43/45 为 0.0 → purchasePrice=0 合法）
  const price = num(row.price);
  if (price !== undefined) m.purchasePrice = round2(price);
  m.brand = trimSlice(row.brand, 30);
  m.notes = str(row.note).slice(0, 500);
  // rating：实测 17 行 0.0（DM 快照写 43/45，有误）、其余 1.0–5.0 整数；0 = 未评分（附录 A-35）
  const r = num(row.rating);
  const rating = r === undefined ? 0 : Math.min(5, Math.max(0, Math.round(r)));
  m.rating = rating as Material['rating'];
  // AA-D 物料6：迁移不再把旧 audience 第 2 元素起写入物料 tags（口径变更：
  // 物料标签字段退役）。forWhom 首元素映射保留；多余元素丢弃——传临时数组
  // 承接后弃用，m.tags 恒 []。成衣（garment）迁移的 tags 行为不变。
  const discardedTags: string[] = [];
  m.forWhom = mapAudience(ctx, row.audience, discardedTags, 'pattern', oldId);
  // H7 推定值（真实数据核对通过：45/45 行均无 quantity/stock/unit/used 键）
  m.quantity = 1;
  m.initialQuantity = 1;
  m.unit = '件';
  // 【Y-A 是否使用口径】旧库无 used 字段；rating ≠ 0（用户评过分）= 已使用，
  // rating 0/缺失 = 未使用。真实数据：28 已使用 / 17 未使用（rating 分布
  // {0:17, 1:4, 2:1, 3:2, 4:6, 5:15}），见 ya-notes.md 口径变更记录。
  m.used = rating !== 0 ? 1 : 0;
  m.purchaseDate = buyDateToPurchaseDate(ctx, row.buyDate, 'pattern', oldId); // 旧无 buyDate → 导入当天
  ctx.materials.push(m);
  ctx.materialById.set(m.id, m);
  ctx.patternIdMap.set(oldId, m.id);
  mapImageRefs(ctx, 'material', m.id, row.image);
  scanDroppedFields(ctx, 'pattern', row);
}

// ============================ §9.8.5 garment → garments ============================

/** collectAmounts 的可解析产物：newId = 迁移后新物料 id，amount = 用料量（> 0）。 */
interface ResolvedAmount {
  newId: string;
  amount: number;
}

/**
 * fabricAmounts / accessoryAmounts 的公共处理。
 * 真实数据是 `{ 旧id: 数量 }` 字典（§9.8.5 假定 `[{materialId, amount}]` 数组，
 * 实测出入见模块头说明 1）——两种形态都支持。
 * 【Y-A 成衣成本修复，2026-09-29】可解析条目（id 翻得到 + 数量 > 0）返回给
 * 调用方构造 materialSnapshot 活跃快照行；解析不了的条目（id 翻不到 / 数量
 * ≤ 0 / 坏元素）进 droppedAmounts（语义变更：从「全部数量丢弃」改为「未迁成
 * 快照的条目」）；id 翻不到目标的另行进 danglingRefs（§9.8.5 外键重映射表）。
 */
function collectAmounts(
  ctx: Ctx,
  field: 'fabricAmounts' | 'accessoryAmounts',
  table: 'fabric' | 'accessory',
  idMap: Map<string, string>,
  v: unknown,
  garmentOldId: string,
): ResolvedAmount[] {
  const entries: { refId: string; amount: number | undefined }[] = [];
  if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) entries.push({ refId: k.trim(), amount: num(val) }); // 字典形态
  } else if (Array.isArray(v)) {
    for (const el of v) {
      if (isPlainObject(el)) entries.push({ refId: str(el.materialId).trim(), amount: num(el.amount) }); // §9.8.5 假定的数组形态
    }
  }
  if (entries.length === 0) return [];
  const resolved: ResolvedAmount[] = [];
  let dropped = 0;
  for (const { refId, amount } of entries) {
    if (refId === '') {
      dropped += 1; // 坏元素（空 id）：无从翻，也无从记
      continue;
    }
    const newId = idMap.get(refId);
    if (newId === undefined) {
      dropped += 1;
      ctx.danglingRefs.push({ table, oldId: refId, field });
      continue;
    }
    if (amount === undefined || amount <= 0) {
      dropped += 1; // 数量 ≤ 0 / 缺失：构不成合法快照行（quantityUsed 恒 > 0）
      continue;
    }
    resolved.push({ newId, amount });
  }
  if (dropped > 0) ctx.droppedAmounts.push({ oldId: garmentOldId, field, count: dropped });
  return resolved;
}

/** §9.8.5 garment → garments（一对一，不产 usageLogs）。 */
function mapGarmentRow(ctx: Ctx, row: Record<string, unknown>): void {
  const oldId = str(row._id).trim();
  const g: Garment = {
    id: nanoid(12),
    name: trimSlice(row.name, 50),
    category: trimSlice(row.style, 20),
    size: trimSlice(row.size, 20),
    recipient: '', // H8 推定值：旧库无收件人字段
    status: 'in_progress',
    materialIds: [], // 【Y-A】由活跃快照行 materialId 去重集填充（§5.3 superRefine 恒等）
    patternId: '',
    materialSnapshot: [], // 【Y-A】由 fabricAmounts/accessoryAmounts 构造活跃快照行
    totalCost: null, // 【Y-A】round2(Σ活跃 subtotal + patternPrice)；无快照且无纸样才保持 null
    images: [], // import.ts 第 4 步回填
    completionDate: '',
    startDate: '', // H8 推定值
    plannedDate: '', // H8 推定值
    forWhom: '',
    tags: [], // audience 多余元素的副产物（H8）
    notes: '',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    sourceRef: `garment:${oldId}`,
  };
  // status + finishDate 双条件（§9.6 冲突表：一律以「不确定完成」为安全侧）
  const status = str(row.status).trim();
  const finish = parseLegacyDate(row.finishDate);
  if (status === 'done' && finish !== null && finish !== '') {
    g.status = 'completed';
    g.completionDate = finish;
  } else if (status === 'done') {
    ctx.warnings.push(
      `garment:${oldId} 旧记录不一致：status=done 但 finishDate 缺失或无法解析，落 in_progress + ''（§9.6）`,
    );
  } else if (status === 'doing' && finish !== null && finish !== '') {
    ctx.warnings.push(
      `garment:${oldId} 旧记录不一致：status=doing 但有 finishDate（${finish}），completionDate 落 ''（§9.6）`,
    );
  }
  // 其余任何 status 值（doing/空/缺键/未知）→ in_progress（§3.2 默认值）
  g.forWhom = mapAudience(ctx, row.audience, g.tags, 'garment', oldId);
  // patternId 外键重映射（§9.8.5：翻不到落 ''，不写 undefined）
  // 【AB-A】重映射成功时同步反建 纸样→成衣 反向索引：把成衣新 id 追加进
  // 对应纸样 Material 行的 linkedGarmentIds（去重；读侧弱引用容错）。
  // 幂等：import.ts 第 3 步 sourceRef 判重在写库前完成，二跑时纸样/成衣
  // 全部跳过、keptMaterials 为空，不会重复追加。
  const oldPat = str(row.patternId).trim();
  if (oldPat !== '') {
    const mapped = ctx.patternIdMap.get(oldPat);
    if (mapped) {
      g.patternId = mapped;
      const pat = ctx.materialById.get(mapped);
      if (pat !== undefined) {
        const ids = pat.linkedGarmentIds ?? [];
        if (!ids.includes(g.id)) pat.linkedGarmentIds = [...ids, g.id];
      }
    } else {
      ctx.danglingRefs.push({ table: 'pattern', oldId: oldPat, field: 'patternId' });
      ctx.warnings.push(
        `garment:${oldId} patternId 指向不存在的纸样（${oldPat}），未写入纸样「被引用成衣」关联`,
      );
    }
  } else {
    // 无 patternId（缺键/空串）：不反建，记 warning（AB-A 需求 1 口径）
    ctx.warnings.push(`garment:${oldId} 无 patternId，未写入纸样「被引用成衣」关联`);
  }
  // 【Y-A 成衣成本修复】fabricAmounts / accessoryAmounts → 活跃快照行。
  // 同一物料多条引用先按 newId 合并数量（materialIds 要求去重，§5.3）；
  // priceSnapshot = unitPriceOf(迁移物料)（V-A Q16 总价 ÷ 开账量，与手工行
  // 完全同源）；deducted=true、不写 retiredAt（活跃行，§3.2 硬约束 3）。
  const fabricAmts = collectAmounts(ctx, 'fabricAmounts', 'fabric', ctx.fabricIdMap, row.fabricAmounts, oldId);
  const accAmts = collectAmounts(ctx, 'accessoryAmounts', 'accessory', ctx.accessoryIdMap, row.accessoryAmounts, oldId);
  const amountById = new Map<string, number>();
  for (const { newId, amount } of [...fabricAmts, ...accAmts]) {
    amountById.set(newId, round2((amountById.get(newId) ?? 0) + amount));
  }
  for (const [newId, amount] of amountById) {
    const mat = ctx.materialById.get(newId);
    if (mat === undefined) continue; // 理论不可达（idMap 与 materialById 同源注册）
    const priceSnapshot = unitPriceOf(mat);
    const quantityUsed = round2(amount);
    g.materialSnapshot.push({
      materialId: newId,
      name: mat.name,
      unit: mat.unit,
      priceSnapshot,
      quantityUsed,
      subtotal: round2(priceSnapshot * quantityUsed),
      deducted: true, // 活跃行恒 true（§3.2 硬约束 3）
    });
    g.materialIds.push(newId);
    // 【AA-A 迁移1】关联物料的库存差异按成衣消耗记账（quantity=记录用量、
    // createdAt=完工时间）；登记关联关系供对齐裁决（resolvePendingAlignments）。
    ctx.associatedMaterialIds.add(newId);
    ctx.amountByMaterial.set(newId, round2((ctx.amountByMaterial.get(newId) ?? 0) + quantityUsed));
    pushGarmentConsumeLog(ctx, g, mat, quantityUsed);
  }
  // totalCost = round2(Σ活跃行 subtotal + patternPrice)（garmentService.calcTotalCost
  // 同式）；patternPrice = 关联纸样迁移行 purchasePrice（resolvePatternPrice 同源，
  // 纯函数侧从 ctx.materialById 取；悬空引用翻不到价格记 0）。核算条件 = 有快照
  // 行或旧 patternId 非空（含悬空）——真实数据 35 件全部满足（0 元 1 件为无物料
  // 引用且纸样悬空的背带裙）；两者皆无才保持 null（未核算）。
  if (g.materialSnapshot.length > 0 || oldPat !== '') {
    const patternPrice =
      g.patternId !== '' ? (ctx.materialById.get(g.patternId)?.purchasePrice ?? 0) : 0;
    const sum = g.materialSnapshot.reduce((acc, r) => acc + r.subtotal, 0);
    g.totalCost = round2(sum + patternPrice);
  }
  // createdAt 直映（五张源表唯一例外，§9.8.5）：date-only → 当日 00:00 UTC；
  // 缺失/空 → 导入时刻；无法解析 → 导入时刻 + warning（§9.6）
  const ct = legacyDateTime(row.createdAt);
  if (ct !== null) {
    g.createdAt = ct;
    if (ct > ctx.now) {
      ctx.warnings.push(
        `garment:${oldId} 旧 createdAt（${ct}）晚于导入时刻，保留原值（§9.6 类比 buyDate 规则）`,
      );
    }
  } else if (row.createdAt !== null && row.createdAt !== undefined && str(row.createdAt).trim() !== '') {
    g.createdAt = ctx.now;
    ctx.warnings.push(
      `garment:${oldId} 旧 createdAt（${String(row.createdAt)}）无法解析，落导入时刻（§9.6）`,
    );
  } else {
    g.createdAt = ctx.now;
  }
  ctx.garments.push(g);
  mapImageRefs(ctx, 'garment', g.id, row.image);
  scanDroppedFields(ctx, 'garment', row);
}

// ============================ §9.8.6 preset → presets ============================

/**
 * 旧 preset（单条）→ 三个子键的映射产物。**合并**进本机当前值是 import.ts 第 8 步
 * 的事（mapLegacyRows 是纯函数、看不到本机 presets）；`report.presets` 计数此处为
 * 旧值有效项数，import.ts 合并后覆写为实际新增项数（§9.8.6）。
 */
function mapPreset(ctx: Ctx, v: unknown): void {
  let row: unknown = v;
  if (row === null || row === undefined) return; // 缺失 → 三子键不动，不报错（§9.8.6 边界）
  if (Array.isArray(row)) {
    if (row.length === 0) return;
    if (row.length > 1) {
      ctx.warnings.push(`旧库 preset 表有 ${row.length} 条，只用了第一条（§9.8.6）`);
    }
    row = row[0];
  }
  if (!isPlainObject(row)) {
    ctx.warnings.push('旧 preset 记录不是对象，预设未迁移（§9.8.6）');
    return;
  }
  scanDroppedFields(ctx, 'preset', row); // _openid 等行级字段
  const config = row.config;
  if (!isPlainObject(config)) {
    ctx.warnings.push('旧 preset.config 缺失或不是对象，预设未迁移（§9.8.6）');
    return;
  }
  const out: Partial<PresetsConfig> = {};
  for (const key of ['patternBrands', 'fabricBrands', 'accessoryTags'] as const) {
    const raw = config[key];
    if (!Array.isArray(raw)) continue; // 子键缺失/非数组 → 不动
    const items: string[] = [];
    for (const el of raw) {
      if (typeof el !== 'string' || el.trim() === '') continue; // 坏元素丢弃，不连坐整个子键
      if (!items.includes(el)) items.push(el);
    }
    out[key] = items;
  }
  ctx.presetsOut = out;
  // 其余五个子键丢弃 → droppedFields（field 带 config. 前缀，§9.8.6）
  for (const key of ['patternStyles', 'patternAudiences', 'patternSizes', 'accessoryWidths', 'fabricWidths']) {
    if (key in config) {
      pushDropped(ctx, {
        table: 'preset',
        field: `config.${key}`,
        reason: 'v2 该子键清单以 §4.9.6 为唯一权威（§9.8.6）',
      });
    }
  }
}

// ============================ §9.3 主函数 ============================

/** 单表批量映射：逐行 try/catch，失败推 skipped 继续（§9.3 不抛异常）。 */
function mapTable<T extends LegacySource>(
  ctx: Ctx,
  table: T,
  rows: unknown[],
  mapOne: (ctx: Ctx, row: Record<string, unknown>) => void,
): void {
  for (const row of rows) {
    if (!isPlainObject(row)) {
      ctx.skipped.push({ table, oldId: '', reason: '行不是对象，无法映射' });
      continue;
    }
    try {
      mapOne(ctx, row);
    } catch (e) {
      ctx.skipped.push({
        table,
        oldId: oldIdOf(row),
        reason: `映射异常：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

/**
 * 旧数据 → v2.0 行结构（§9.3 冻结签名）。纯函数、不抛异常。
 * 处理顺序固定 fabric → accessory → tools → pattern → garment → preset：
 * garment 的外键重映射依赖前三张表填好的 id 映射表（§9.8.5，顺序不可调换）。
 */
export function mapLegacyRows(input: LegacyRawInput, now: string): LegacyMappedRows {
  const ctx: Ctx = {
    now,
    today: now.slice(0, 10),
    materials: [],
    garments: [],
    usageLogs: [],
    imageAssignments: [],
    fabricIdMap: new Map(),
    accessoryIdMap: new Map(),
    patternIdMap: new Map(),
    presetsOut: {},
    skipped: [],
    danglingRefs: [],
    droppedFields: new Map(),
    droppedAmounts: [],
    warnings: [],
    truncatedImages: 0,
    alignmentLogs: 0,
    pendingAlign: [],
    associatedMaterialIds: new Set(),
    amountByMaterial: new Map(),
    garmentConsumeLogs: 0,
    materialById: new Map(),
    buyDateFallbackCount: 0,
    noTagCount: 0,
    badImageRefCount: 0,
  };
  try {
    mapTable(ctx, 'fabric', arr(input?.fabric), mapFabricRow);
    mapTable(ctx, 'accessory', arr(input?.accessory), mapAccessoryRow);
    mapTable(ctx, 'tools', arr(input?.tools), mapToolsRow);
    mapTable(ctx, 'pattern', arr(input?.pattern), mapPatternRow);
    mapTable(ctx, 'garment', arr(input?.garment), mapGarmentRow);
    // 【AA-A 迁移1】garment 表映射完成后，统一裁决 fabric/accessory 的对齐/成衣消耗归类
    resolvePendingAlignments(ctx);
    mapPreset(ctx, input?.preset);
    // 汇总 warnings（§9.6 kind 推定；§9.8.3 tag 缺口；§9.8 旧日期规则第 2 行）
    if (ctx.usageLogs.length > 0) {
      ctx.warnings.push('旧 usageRecords 无流水类型，全部推定为 consume（§9.6）');
    }
    if (ctx.noTagCount > 0) {
      ctx.warnings.push(`${ctx.noTagCount} 条辅料无 tag，需手工补（§9.8.3）`);
    }
    if (ctx.buyDateFallbackCount > 0) {
      ctx.warnings.push(
        `${ctx.buyDateFallbackCount} 条物料 purchaseDate 落导入当天（旧 buyDate 缺失或无法解析，§9.8）`,
      );
    }
    if (ctx.badImageRefCount > 0) {
      ctx.warnings.push(`${ctx.badImageRefCount} 个旧图片引用不是字符串，已跳过`);
    }
    if (ctx.alignmentLogs > 0) {
      ctx.warnings.push(
        `补写 ${ctx.alignmentLogs} 条库存对齐流水（未关联成衣、旧程序无损耗记录且购买量−库存>0，AA-A）`,
      );
    }
    if (ctx.garmentConsumeLogs > 0) {
      ctx.warnings.push(
        `补写 ${ctx.garmentConsumeLogs} 条成衣消耗流水（旧成衣物料关联、按完工时间记账，AA-A 迁移1）`,
      );
    }
  } catch {
    // 顶层兜底（§9.3 不抛异常）：异常时返回已收集的部分，不向上抛
  }
  return {
    materials: ctx.materials,
    garments: ctx.garments,
    usageLogs: ctx.usageLogs,
    imageAssignments: ctx.imageAssignments,
    presets: ctx.presetsOut,
    report: {
      materials: ctx.materials.length,
      garments: ctx.garments.length,
      usageLogs: ctx.usageLogs.length,
      presets: {
        patternBrands: ctx.presetsOut.patternBrands?.length ?? 0,
        fabricBrands: ctx.presetsOut.fabricBrands?.length ?? 0,
        accessoryTags: ctx.presetsOut.accessoryTags?.length ?? 0,
      },
      importedImages: 0, // import.ts 第 4 步覆写（见模块头「映射阶段口径」）
      missingImages: 0, // 同上
      rejectedImages: 0, // 同上
      truncatedImages: ctx.truncatedImages,
      skipped: ctx.skipped,
      danglingRefs: ctx.danglingRefs,
      droppedFields: [...ctx.droppedFields.values()],
      droppedAmounts: ctx.droppedAmounts,
      alignmentLogs: ctx.alignmentLogs, // import.ts 覆写为随父物料行实际落库的条数
      warnings: ctx.warnings,
    },
  };
}
