// src/db/schemas.ts
//
// 运行时校验层（DM §11）：全库唯一的 Zod 实现点。行 schema 与
// src/db/types.ts 的编译期形状逐字对应；枚举逐字照抄 §4；可选字段
// 恰好 9 处（§8.3）。备份导入校验门（§10.5 第 8 道）逐表逐行
// safeParse 用这里的行 schema（images 用 ImageJsonRowSchema，不含
// blob）。settings 三组白名单常量（§11.6）是 §3.7 分组表与 §10.6
// 覆盖阶段共同的唯一来源。
//
// 注意（DM §11.1 三条禁令）：不用 z.preprocess / z.coerce 修坏值；
// 校验函数不写库；外来数据只用 safeParse 收集错误，不用 parse 抛。

import { z } from 'zod';
import { hasAtMost1Decimals, hasAtMost2Decimals, round2 } from '@/lib/num';

// ============================ §11.3 共享基元 ============================

export const nanoId12 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{12}$/, '必须是 12 位 nanoid（§0.3）');

export const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '必须是 ISO 8601 UTC 时刻串（§8.6）');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '必须是 YYYY-MM-DD（§8.4）');

/** `IsoDate | ''`：日期串允许空串，时刻串不允许（§8.1） */
export const isoDateOrEmpty = z.union([isoDate, z.literal('')]);

/** 三个内置任务模板的固定 id（§1.8）。它们不是 nanoid，`TaskTemplateRowSchema.id` 要合上这一支 */
export const builtinTemplateId = z.enum(['tmpl-skirt-std', 'tmpl-top-std', 'tmpl-dress-std']);

// ============================ §11.3 十三个枚举 ============================

export const MaterialTypeEnum = z.enum(['fabric', 'accessory', 'tool', 'pattern']); // §4.1
export const SeasonEnum = z.enum(['spring', 'summer', 'autumn', 'winter', 'all_season']); // §4.2
export const ForWhomEnum = z.enum(['women', 'men', 'children', 'baby', 'pet', '']); // §4.3
export const GarmentStatusEnum = z.enum(['planning', 'in_progress', 'completed']); // §4.4
export const TaskStatusEnum = z.enum(['todo', 'in_progress', 'done']); // §4.5
export const TaskPriorityEnum = z.enum(['high', 'medium', 'low']); // §4.5
export const UsageKindEnum = z.enum(['consume', 'refill', 'adjust', 'revert']); // §4.6
export const TemplateSourceEnum = z.enum(['preset', 'custom']); // §3.4
export const ImageEntityTypeEnum = z.enum(['material', 'garment', 'task']); // §3.6
export const MimeTypeEnum = z.enum(['image/jpeg', 'image/png', 'image/webp']); // §4.15
export const BackupLogKindEnum = z.enum([
  'auto_export',
  'local_export',
  'local_import',
  'github_push',
  'github_pull',
  'restore',
  'migration',
]); // §4.8
export const BackupLogStatusEnum = z.enum(['success', 'failed', 'partial']); // §4.8

// ============================ §11.6 白名单常量 ============================
// （须在 SettingsKeyEnum 之前定义：z.enum(SETTINGS_KEYS) 以它为源。）

/** 逐字照抄 §4.16 的序号 1–18。 */
export const SETTINGS_KEYS = [
  'device_id', 'onboarding_completed', 'user_name', 'sewing_years',
  'backup_last_success', 'backup_reminder_last', 'backup_interval', 'import_completed',
  'github_token', 'github_username', 'github_repo', 'pat_expires_at',
  'last_sync_at', 'last_sync_remote', 'dirty_since_sync', 'dirty_since_backup',
  'presets', 'search_history',
] as const;

export const RESTORE_PRESERVE_KEYS = [
  'github_token', 'github_username', 'github_repo', 'pat_expires_at', 'device_id',
  'user_name', 'backup_last_success', 'backup_reminder_last', 'onboarding_completed',
] as const; // 9 项

export const RESTORE_LOCAL_ONLY_KEYS = [
  'last_sync_at', 'last_sync_remote', 'dirty_since_sync', 'dirty_since_backup',
] as const; // 4 项

export const RESTORE_FROM_ZIP_KEYS = [
  'backup_interval', 'import_completed', 'presets', 'search_history', 'sewing_years',
] as const; // 5 项

// 编译期分组自检（§11.6：9+4+5=18、两两无交集）在 scripts/test-services.ts
// 的 S6A 段运行时断言一次（DM §11.6：首启或单测时跑一次，不在业务路径上跑）。

export const SettingsKeyEnum = z.enum(SETTINGS_KEYS); // §4.16

/** 18 个 settings key 的联合字面量类型；`SettingsKeyEnum` 的推导值。 */
export type SettingsKey = z.infer<typeof SettingsKeyEnum>;

/** §4.6：'manual' / 'garment:{garmentId}' / 'legacy:{oldTable}:{oldId}' */
export const UsageSourceSchema = z.string().regex(
  /^(manual|garment:[A-Za-z0-9_-]{12}|legacy:[a-z_]+:.+)$/,
  "source 只能是 'manual'、'garment:{id}' 或 'legacy:{oldTable}:{oldId}'",
);

// ============================ §11.4 数值基元（内部） ============================

const nonNeg2 = z.number()
  .finite('不能是 NaN 或 Infinity')
  .refine(hasAtMost2Decimals, '最多两位小数')
  .refine((v) => v >= 0, '不能为负数');

const positive1 = z.number()
  .finite('不能是 NaN 或 Infinity')
  .refine(hasAtMost1Decimals, '最多一位小数')
  .refine((v) => v > 0, '必须大于 0');

const positiveInt = z.number()
  .finite('不能是 NaN 或 Infinity')
  .int('必须是整数')
  .refine((v) => v > 0, '必须大于 0');

// ============================ §11.5 共享时序断言 ============================

/** `updatedAt >= createdAt`（§3 各表字段表）。ISO UTC 时刻串定长，字典序等价于时间序。 */
const requireTimeOrder = (
  row: { createdAt: string; updatedAt: string },
  ctx: z.RefinementCtx,
): void => {
  if (row.updatedAt < row.createdAt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['updatedAt'],
      message: 'updatedAt 不能早于 createdAt',
    });
  }
};

// ============================ §11.5 materials ============================

export const MaterialRowSchema = z.object({
  id: nanoId12,
  type: MaterialTypeEnum,
  name: z.string().trim().min(1, '名称必填').max(50, '名称最多 50 字'),
  category: z.string().max(20),
  quantity: nonNeg2,
  initialQuantity: nonNeg2,
  unit: z.string().trim().min(1, '单位必填').max(5),
  purchaseDate: isoDate,
  purchasePrice: nonNeg2.optional(), // 可选字段 1/9
  color: z.string().max(20),
  width: positive1.optional(), // 可选字段 2/9
  weight: positiveInt.optional(), // 可选字段 3/9
  composition: z.string().max(50),
  sampleCard: z.string().max(30),
  season: SeasonEnum,
  suitableFor: z.array(z.string().trim().min(1).max(20)),
  forWhom: ForWhomEnum,
  tags: z.array(z.string().trim().min(1).max(20)),
  notes: z.string().max(500),
  brand: z.string().max(30),
  size: z.string().max(20),
  rating: z.number().int().min(0).max(5),
  ratingReview: z.string().max(200),
  used: z.number().int().min(0).max(1),
  lowStockThreshold: nonNeg2,
  images: z.array(nanoId12).max(5, '最多 5 张图片'),
  // 【AB-A】被引用成衣（仅 pattern 有意义）。optional：旧备份/旧数据无此键
  // 时 safeParse 照常通过（存量兼容，铁律 4）；元素须为合法 nanoid(12)。
  linkedGarmentIds: z.array(nanoId12).optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  sourceRef: z.string().regex(/^[a-z_]+:.+$/, 'sourceRef 必须形如 {oldTable}:{oldId}').optional(), // 可选字段 4/9
}).strict().superRefine(requireTimeOrder);

// ============================ §11.5 garments ============================

export const GarmentMaterialSnapshotSchema = z.object({
  materialId: nanoId12,
  name: z.string().trim().min(1).max(50),
  unit: z.string().trim().min(1).max(5),
  priceSnapshot: nonNeg2,
  quantityUsed: z.number().finite('不能是 NaN 或 Infinity')
    .refine(hasAtMost2Decimals, '最多两位小数')
    .refine((v) => v > 0, '用料量必须大于 0'),
  subtotal: nonNeg2,
  deducted: z.boolean(),
  retiredAt: isoDateTime.optional(), // 可选字段 5/9
}).strict().superRefine((row, ctx) => {
  // §3.2 硬约束 3：活跃行（无 retiredAt）deducted 恒 true；历史行恒 false
  const active = row.retiredAt === undefined;
  if (active && row.deducted !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deducted'],
      message: '活跃行（无 retiredAt）的 deducted 必须是 true' });
  }
  if (!active && row.deducted !== false) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deducted'],
      message: '历史行（有 retiredAt）的 deducted 必须是 false' });
  }
  // §11.4 公式 1
  if (row.subtotal !== round2(row.priceSnapshot * row.quantityUsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subtotal'],
      message: 'subtotal 必须精确等于 round2(priceSnapshot × quantityUsed)' });
  }
});

export const GarmentRowSchema = z.object({
  id: nanoId12,
  name: z.string().trim().min(1, '名称必填').max(50),
  category: z.string().max(20),
  size: z.string().max(20),
  recipient: z.string().max(30),
  status: GarmentStatusEnum,
  materialIds: z.array(nanoId12).max(50, 'materialIds 最多 50 个'),
  patternId: z.union([nanoId12, z.literal('')]),
  materialSnapshot: z.array(GarmentMaterialSnapshotSchema).max(50, '用料清单已达上限'),
  totalCost: z.number().finite('不能是 NaN 或 Infinity')
    .refine(hasAtMost2Decimals, '最多两位小数')
    .refine((v) => v >= 0, '不能为负数')
    .nullable(),
  images: z.array(nanoId12).max(5, '最多 5 张图片'),
  completionDate: isoDateOrEmpty,
  startDate: isoDateOrEmpty,
  plannedDate: isoDateOrEmpty,
  forWhom: ForWhomEnum,
  tags: z.array(z.string().trim().min(1).max(20)),
  notes: z.string().max(500),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  sourceRef: z.string().regex(/^[a-z_]+:.+$/).optional(), // 可选字段 6/9
}).strict().superRefine((row, ctx) => {
  // ① §3.2 硬约束 1：materialIds 恒等于活跃行的 materialId 集合
  const activeIds = new Set(
    row.materialSnapshot.filter((s) => s.retiredAt === undefined).map((s) => s.materialId),
  );
  const declared = new Set(row.materialIds);
  if (activeIds.size !== declared.size || [...activeIds].some((id) => !declared.has(id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['materialIds'],
      message: 'materialIds 必须恰好等于活跃快照行的 materialId 集合（§3.2 硬约束 1）' });
  }
  // ② §3.2 硬约束 4：status 与 completionDate 的双条件
  if (row.status === 'completed' && row.completionDate === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completionDate'],
      message: 'status 为 completed 的成衣必须有 completionDate' });
  }
  if (row.status !== 'completed' && row.completionDate !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completionDate'],
      message: '未完工的成衣不许有 completionDate' });
  }
  // ③ §3.2 硬约束 4：日期先后。任一为空则跳过，不报错
  if (row.startDate !== '' && row.plannedDate !== '' && row.startDate > row.plannedDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['plannedDate'],
      message: 'plannedDate 不能早于 startDate' });
  }
  if (row.startDate !== '' && row.completionDate !== '' && row.completionDate < row.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completionDate'],
      message: 'completionDate 不能早于 startDate' });
  }
  // ④ §3.2 硬约束 5：totalCost 为 null 只允许出现在迁移导入的行上
  if (row.totalCost === null && row.sourceRef === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalCost'],
      message: 'totalCost 为 null 只允许出现在迁移导入的行上（§9.5）' });
  }
}).superRefine(requireTimeOrder);

// ============================ §11.5 usageLogs ============================

export const UsageLogRowSchema = z.object({
  id: nanoId12,
  materialId: nanoId12,
  materialName: z.string().trim().min(1).max(50),
  unit: z.string().trim().min(1).max(5),
  quantity: z.number().finite('不能是 NaN 或 Infinity')
    .refine(hasAtMost2Decimals, '最多两位小数'),
  kind: UsageKindEnum,
  source: UsageSourceSchema,
  garmentId: z.union([nanoId12, z.literal('')]),
  note: z.string().max(100, 'note 必须在写入前按 slice(0,100) 截断（§3.5 硬约束 4）'),
  createdAt: isoDateTime,
}).strict().superRefine((row, ctx) => {
  // ① §3.5 硬约束 2 与硬约束 7：quantity 的方向
  if (row.kind === 'adjust') {
    if (row.quantity === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'],
        message: 'adjust 的 delta 不能为 0（§3.5 硬约束 7）' });
    }
  } else if (row.quantity <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantity'],
      message: `${row.kind} 的 quantity 必须大于 0` });
  }
  // ② §3.5 硬约束 3：5 种合法组合，一个不许多一个不许少
  const isLegacy = row.source.startsWith('legacy:');
  const isGarment = row.source.startsWith('garment:');
  const comboOk =
    isLegacy                                                                   // 任意 kind + legacy:*
    || (row.kind === 'consume' && (row.source === 'manual' || isGarment))      // P4 / P3a / P3b
    || (row.kind === 'adjust' && row.source === 'manual')                      // P2 / P8
    || (row.kind === 'revert' && isGarment);                                   // P3b / P3c
  if (!comboOk) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'],
      message: `${row.kind} × ${row.source} 不是合法组合（§3.5 硬约束 3）` });
  }
  // ③ garmentId 与 source 的一致性
  if (isGarment) {
    if (row.garmentId !== row.source.slice('garment:'.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['garmentId'],
        message: 'garmentId 必须与 source 里 garment:{id} 的 id 完全一致' });
    }
  } else if (row.garmentId !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['garmentId'],
      message: "source 不是 garment:{id} 形态时 garmentId 必须是 ''" });
  }
});

// ============================ §11.5 tasks ============================

export const TaskStepSchema = z.object({
  // §3.3 硬约束 1：手工添加的是 nanoid(8)，模板生成的是 `${taskId}_s${order}`，没有第三种
  id: z.string().regex(
    /^(?:[A-Za-z0-9_-]{8}|[A-Za-z0-9_-]{12}_s\d+)$/,
    '步骤 id 必须是 nanoid(8) 或 `${taskId}_s${order}`',
  ),
  title: z.string().trim().min(1).max(100),
  done: z.boolean(),
  order: z.number().int().min(1),
  completedAt: isoDateTime.optional(), // 可选字段 7/9
}).strict().superRefine((step, ctx) => {
  // §3.3 硬约束 2：done === true ⟺ completedAt 存在
  if (step.done && step.completedAt === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'],
      message: 'done 为 true 的步骤必须有 completedAt' });
  }
  if (!step.done && step.completedAt !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'],
      message: 'done 为 false 的步骤不许有 completedAt（缺键，不是空串）' });
  }
});

export const TaskRowSchema = z.object({
  id: nanoId12,
  title: z.string().trim().min(1, '标题必填').max(50),
  description: z.string().max(500),
  status: TaskStatusEnum,
  priority: TaskPriorityEnum,
  garmentId: z.union([nanoId12, z.literal('')]),
  garmentName: z.string().max(50),
  templateId: z.union([nanoId12, builtinTemplateId, z.literal('')]),
  steps: z.array(TaskStepSchema).max(30, '步骤不能超过 30 条'),
  dueDate: isoDateOrEmpty,
  completedAt: isoDateTime.optional(), // 可选字段 8/9
  tags: z.array(z.string().trim().min(1).max(20)),
  notes: z.string().max(500),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((row, ctx) => {
  // §3.3 硬约束 3：status === 'done' ⟺ completedAt 存在
  if (row.status === 'done' && row.completedAt === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'],
      message: "status 为 done 的任务必须有 completedAt" });
  }
  if (row.status !== 'done' && row.completedAt !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['completedAt'],
      message: "status 不为 done 的任务不许有 completedAt（缺键，不是空串）" });
  }
  // §3.3 硬约束 2：同任务内 order 与 id 各自唯一
  const orders = row.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'],
      message: '同一个任务内步骤的 order 必须互不相同' });
  }
  const stepIds = row.steps.map((s) => s.id);
  if (new Set(stepIds).size !== stepIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'],
      message: '同一个任务内步骤的 id 必须互不相同' });
  }
}).superRefine(requireTimeOrder);

// ============================ §11.5 taskTemplates ============================

export const TaskTemplateStepSchema = z.object({
  title: z.string().trim().min(1).max(100),
  order: z.number().int().min(1),
  // 模板步骤只有这两个字段：没有 id、没有 done、没有 completedAt（§3.4 硬约束 1）
}).strict();

export const TaskTemplateRowSchema = z.object({
  id: z.union([builtinTemplateId, nanoId12]),
  name: z.string().trim().min(1, '名称必填').max(30),
  description: z.string().max(200),
  category: z.string().max(20),
  steps: z.array(TaskTemplateStepSchema).min(1, '模板至少要有一条步骤').max(30),
  tags: z.array(z.string().trim().min(1).max(20)),
  source: TemplateSourceEnum,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).strict().superRefine((row, ctx) => {
  const orders = row.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'],
      message: '同一个模板内步骤的 order 必须互不相同' });
  }
  // §3.4：内置 id 与 source='preset' 一一对应，两向都不能串
  const isBuiltin = builtinTemplateId.safeParse(row.id).success;
  if (row.source === 'preset' && !isBuiltin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'],
      message: "source 为 preset 的模板 id 必须是 §1.8 的三个固定 id" });
  }
  if (row.source === 'custom' && isBuiltin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'],
      message: "内置模板的 source 不许改成 'custom'（§3.4 硬约束 3）" });
  }
}).superRefine(requireTimeOrder);

// ============================ §11.5 images（两种形态） ============================

/** zip 侧：§10.5 第 8 道校验 images 用这个。 */
export const ImageJsonRowSchema = z.object({
  id: nanoId12,
  originalName: z.string().trim().min(1).max(255),
  mimeType: MimeTypeEnum,
  entityType: ImageEntityTypeEnum,
  entityId: z.union([nanoId12, z.literal('')]),
  syncedAt: isoDateTime.optional(), // 可选字段 9/9
  createdAt: isoDateTime,
}).strict();

/** 库侧：写入路径（§5.7）与读取路径用它。 */
export const ImageRowSchema = ImageJsonRowSchema.extend({
  blob: z.instanceof(Blob),
}).strict();

// ============================ §11.5 settings / backupLogs ============================

export const SettingsRowSchema = z.object({
  key: SettingsKeyEnum, // 18 项白名单（§11.6）
  value: z.string().max(100000),
  updatedAt: isoDateTime,
}).strict();

export const BackupLogRowSchema = z.object({
  id: nanoId12,
  kind: BackupLogKindEnum,
  status: BackupLogStatusEnum,
  message: z.string().max(200, 'message 必须在写入前按 slice(0,200) 截断（§3.8）'),
  createdAt: isoDateTime,
}).strict().superRefine((row, ctx) => {
  // §4.8 的 kind × status 合法组合表
  const allowed: Record<z.infer<typeof BackupLogKindEnum>, readonly string[]> = {
    auto_export:   ['success', 'failed'],
    local_export:  ['success', 'failed'],
    github_push:   ['success', 'failed'],
    local_import:  ['success', 'partial', 'failed'],
    github_pull:   ['success', 'partial', 'failed'],
    migration:     ['success', 'partial', 'failed'],
    restore:       ['success', 'partial'],
  };
  if (!allowed[row.kind].includes(row.status)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'],
      message: `${row.kind} 不允许 status 为 ${row.status}（§4.8）` });
  }
});

// ============================ §11.6 settings 对象 / PresetsConfig ============================

/**
 * §10.5 第 9 道用：只要求「所有值都是字符串」。
 * key 的归属不在这里判——第 9 道的两个例外（github_token、18 项之外的 key）
 * 都要落到「覆盖阶段丢弃 + 计 dropped」，不能让它变成整包拒收。
 */
export const SettingsObjectSchema = z.record(z.string(), z.string().max(100000));

const presetItem = z.string().trim().min(1);

export const PresetsConfigSchema = z.object({
  fabricBrands:     z.array(presetItem),
  patternBrands:    z.array(presetItem),
  patternStyles:    z.array(presetItem),
  accessoryTags:    z.array(presetItem),
  patternAudiences: z.array(presetItem), // W-B 口径变更：由 ForWhom 枚举放宽为自由字符串（§11.3 文档未改，见 wb-notes）
  patternSizes:     z.array(presetItem),
  fabricWidths:     z.array(presetItem),
  accessoryWidths:  z.array(presetItem),
  // AD-D 预设1/2 口径变更新增（文档 §11 未改，见 ad-d-notes）：
  // default([]) 保证旧存量 presets JSON（八键格式）与旧备份包恢复仍可过校验。
  fabricCategories:     z.array(presetItem).default([]),
  accessoryCategories:  z.array(presetItem).default([]),
}).strict();

// ============================ §11.8 错误消息辅助 ============================

/** 把 Zod 的 issue 数组压成「字段路径：中文消息」的一维列表，供 UI 与日志用。 */
export function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(顶层)'}：${i.message}`);
}

/** 取首个错误的一句话摘要，用于 §10.5 第 8 道的 `message` 与 toast。 */
export function firstIssueMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (first === undefined) return '校验失败';
  return `${first.path.join('.') || '(顶层)'}：${first.message}`;
}
