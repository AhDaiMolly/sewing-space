// src/db/types.ts

/** 物料品类。取值为 demo 实际硬编码值（§4.1）。 */
export type MaterialType = 'fabric' | 'accessory' | 'tool' | 'pattern';

/** 季节。 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter' | 'all_season';

/** 适用人群。单值字符串，'' 表示「未指定」。 */
export type ForWhom = 'women' | 'men' | 'children' | 'baby' | 'pet' | '';

/** 成衣状态。三值，已退役 'on_hold'（§4.4）。 */
export type GarmentStatus = 'planning' | 'in_progress' | 'completed';

/** 任务状态。三值，已退役 'cancelled'（§4.5）。 */
export type TaskStatus = 'todo' | 'in_progress' | 'done';

/** 任务优先级。排序权重见 §4.5。 */
export type TaskPriority = 'high' | 'medium' | 'low';

/** 库存流水类型。四值，已退役 'delete-garment'（§4.6）。 */
export type UsageKind = 'consume' | 'refill' | 'adjust' | 'revert';

/** 库存流水来源。三形态，已退役 'manual:loss' / 'garment:new' / 'garment:{id}:delete' / 'revert'。 */
export type UsageSource =
  | 'manual'
  | `garment:${string}`
  | `legacy:${string}:${string}`;

/** 任务模板来源。 */
export type TemplateSource = 'preset' | 'custom';

/** 备份日志类型。七值（§4.8）。 */
export type BackupLogKind =
  | 'auto_export'
  | 'local_export'
  | 'local_import'
  | 'github_push'
  | 'github_pull'
  | 'restore'
  | 'migration';

/** 备份日志状态。 */
export type BackupLogStatus = 'success' | 'failed' | 'partial';

/** 图片所属实体类型。 */
export type ImageEntityType = 'material' | 'garment' | 'task';

/** ISO 8601 日期时间，带时区，例 `'2026-08-22T18:15:00.000Z'`。 */
export type IsoDateTime = string;

/** 纯日期，`'YYYY-MM-DD'`。 */
export type IsoDate = string;

/** 12 位 nanoid。 */
export type NanoId12 = string;

export interface Material {
  /** 主键，nanoid(12)。不可变。 */
  id: NanoId12;
  /** 物料品类。必填。 */
  type: MaterialType;
  /** 名称。必填，1–50 字。 */
  name: string;
  /** 分类。`''` = 未指定。取值来自 §4.9 的分类预设，也允许自由文本。 */
  category: string;

  /** 当前库存。必填，≥ 0，两位小数精度（§11.4）。 */
  quantity: number;
  /** 开账量。必填，≥ 0。创建时等于 quantity。**不可变**（§3.1 硬约束 1）。 */
  initialQuantity: number;
  /** 计量单位。必填，取值见 §4.7。 */
  unit: string;

  /** 购入日期，`YYYY-MM-DD`。必填（表单默认今天）。 */
  purchaseDate: IsoDate;
  /** 购入总价（元）。`undefined` = 未记录。≥ 0，两位小数。 */
  purchasePrice: number | undefined;

  /** 颜色。`''` = 未指定。 */
  color: string;
  /** 幅宽（cm）。`undefined` = 未记录。> 0。仅 fabric / accessory 有意义。 */
  width: number | undefined;
  /** 克重（g/m²）。`undefined` = 未记录。> 0。仅 fabric 有意义。 */
  weight: number | undefined;
  /** 成分。`''` = 未指定。仅 fabric 有意义。 */
  composition: string;
  /** 色卡号。`''` = 未指定。仅 fabric 有意义。 */
  sampleCard: string;

  /** 季节。必填，默认 `'all_season'`。 */
  season: Season;
  /** 适合款式。**恒为数组**，空 = `[]`，元素取值见 §4.10。 */
  suitableFor: string[];
  /** 适用人群。单值，`''` = 未指定。 */
  forWhom: ForWhom;
  /** 标签。**恒为数组**，空 = `[]`，元素取值见 §4.9。 */
  tags: string[];

  /** 备注。`''` = 空。≤ 500 字。 */
  notes: string;
  /** 品牌。`''` = 未指定。fabric 与 pattern 共享此字段（§4.11）。 */
  brand: string;
  /** 尺码。`''` = 未指定。仅 pattern 有意义。 */
  size: string;
  /** 五星评分。必填，`0` = 未评分，`1`–`5` = 分值。仅 pattern 有意义。 */
  rating: 0 | 1 | 2 | 3 | 4 | 5;
  /** 评分短评。`''` = 空。≤ 200 字。仅 pattern 有意义。 */
  ratingReview: string;
  /** 是否已用过。必填，`0` = 未用，`1` = 已用。仅 pattern 有意义。 */
  used: 0 | 1;
  /** 低库存阈值。必填，默认 `0`（= 不提醒）。≥ 0。 */
  lowStockThreshold: number;

  /** 图片引用。**恒为数组**，元素为 `images.id`。上限 5 张（§3.1 硬约束 6）。 */
  images: string[];

  /** 创建时刻 ISO 8601。不可变。 */
  createdAt: IsoDateTime;
  /** 最近更新时刻 ISO 8601。 */
  updatedAt: IsoDateTime;
  /** 迁移来源。格式 `{table}:{oldId}`，例 `'materials:mat_003'`。非迁移数据恒 `undefined`。 */
  sourceRef: string | undefined;
}

export interface GarmentMaterialSnapshot {
  /** 物料 id。指向 materials.id。物料被删除后本字段仍保留，作为历史凭证。 */
  materialId: string;
  /** 物料名快照。写入时取 material.name，**不可变**。 */
  name: string;
  /** 单位快照。必填、非空，1–5 字，写入时取 material.unit，**不可变**。 */
  unit: string;
  /** 单价快照（元）。写入时取 material.purchasePrice，缺失记 0。**不可变**，永不重读现价。 */
  priceSnapshot: number;
  /** 本次用料量。> 0，两位小数精度。 */
  quantityUsed: number;
  /** 小计 = round2(priceSnapshot × quantityUsed)。 */
  subtotal: number;
  /** 该行是否已从库存扣除。活跃行恒 true，历史行恒 false（§3.2 硬约束 3）。 */
  deducted: boolean;
  /** 退休时刻 ISO 8601。**活跃行没有这个字段**；历史行必有。 */
  retiredAt?: IsoDateTime;
}

export interface Garment {
  /** 主键，nanoid(12)。不可变。 */
  id: NanoId12;
  /** 名称。必填，1–50 字。 */
  name: string;
  /** 分类。`''` = 未指定。取值见 §4.12。 */
  category: string;
  /** 尺码。`''` = 未指定。自由文本，≤ 20 字。 */
  size: string;
  /** 穿着者。`''` = 未指定。≤ 30 字（来源 `docs/demo/src/pages/GarmentForm.jsx:248`）。 */
  recipient: string;

  /** 状态。必填，默认 `'in_progress'`（§4.4 裁定）。 */
  status: GarmentStatus;

  /** 用料物料 id 列表。**恒为数组**，空 = `[]`。去重。等于「活跃快照行的 materialId 去重集」。 */
  materialIds: string[];
  /** 关联纸样 id。`''` = 未关联。指向 materials.id 且该物料 type 必须是 pattern。 */
  patternId: string;

  /** 用料快照。**恒为数组**，append 语义，保留历史行（§5.3）。 */
  materialSnapshot: GarmentMaterialSnapshot[];

  /** 总成本（元）。`null` = 未核算；number = 已核算，≥ 0，两位小数。**唯一允许 null 的字段**（§8.2）。 */
  totalCost: number | null;

  /** 图片引用。**恒为数组**，元素为 `images.id`。上限 5 张。 */
  images: string[];
  /** 完工日期，`YYYY-MM-DD`。未完工恒 `''`。 */
  completionDate: IsoDate | '';
  /** 开始日期，`YYYY-MM-DD`。`''` = 未记录。表单不录入（§4.13）。 */
  startDate: IsoDate | '';
  /** 计划完成日期，`YYYY-MM-DD`。`''` = 未记录。表单不录入（§4.13）。 */
  plannedDate: IsoDate | '';
  /** 适用人群。单值，`''` = 未指定。 */
  forWhom: ForWhom;
  /** 标签。**恒为数组**，空 = `[]`。 */
  tags: string[];
  /** 备注。`''` = 空。≤ 500 字。 */
  notes: string;

  /** 创建时刻 ISO 8601。不可变。 */
  createdAt: IsoDateTime;
  /** 最近更新时刻 ISO 8601。 */
  updatedAt: IsoDateTime;
  /** 迁移来源。格式 `{table}:{oldId}`。非迁移数据恒 `undefined`。 */
  sourceRef: string | undefined;
}

export interface TaskStep {
  /** 步骤 id。见 §3.3 硬约束 1 的冻结规则。 */
  id: string;
  /** 步骤标题。必填，1–100 字。 */
  title: string;
  /** 是否完成。必填。 */
  done: boolean;
  /** 次序。必填，≥ 1，同一任务内唯一。 */
  order: number;
  /** 完成时刻 ISO 8601。`done === true` 时必填；`done === false` 时恒 `undefined`。 */
  completedAt?: IsoDateTime;
}

export interface Task {
  /** 主键，nanoid(12)。不可变。 */
  id: NanoId12;
  /** 标题。必填，1–50 字。 */
  title: string;
  /** 描述。必填，可为 `''`。≤ 500 字。 */
  description: string;
  /** 状态。必填，默认 `'todo'`。 */
  status: TaskStatus;
  /** 优先级。必填，默认 `'medium'`（§4.5）。排序权重 high=0 / medium=1 / low=2。 */
  priority: TaskPriority;

  /** 关联成衣 id。`''` = 未关联。指向 garments.id。 */
  garmentId: string;
  /** 关联成衣名称冗余快照。`''` = 未关联。**恒为字符串，不写 null / undefined**（§3.3 硬约束 4）。 */
  garmentName: string;
  /** 来源模板 id。`''` = 手工创建。指向 taskTemplates.id。 */
  templateId: string;

  /** 步骤清单。**恒为数组**，空 = `[]`。上限 30 条。 */
  steps: TaskStep[];
  /** 截止日期，`YYYY-MM-DD`。`''` = 未设置。 */
  dueDate: IsoDate | '';
  /** 完成时刻 ISO 8601。`status === 'done'` 时必填；否则恒 `undefined`。 */
  completedAt: IsoDateTime | undefined;
  /** 标签。**恒为数组**，空 = `[]`。 */
  tags: string[];
  /** 备注。`''` = 空。≤ 500 字。 */
  notes: string;

  /** 创建时刻 ISO 8601。不可变。 */
  createdAt: IsoDateTime;
  /** 最近更新时刻 ISO 8601。 */
  updatedAt: IsoDateTime;
}

export interface TaskTemplateStep {
  /** 步骤标题。必填，1–100 字。 */
  title: string;
  /** 次序。必填，≥ 1，同模板内唯一。 */
  order: number;
}

export interface TaskTemplate {
  /** 主键。内置模板用固定 id（如 `'tmpl-dress-std'`），用户模板用 nanoid(12)。不可变。 */
  id: string;
  /** 模板名。必填，1–30 字。 */
  name: string;
  /** 说明。必填，可为 `''`。≤ 200 字。 */
  description: string;
  /** 分类。必填，取值见 §4.14。 */
  category: string;
  /** 步骤清单。必填。1–30 条。**模板步骤不含 done / completedAt**。 */
  steps: TaskTemplateStep[];
  /** 标签。**恒为数组**，空 = `[]`。 */
  tags: string[];
  /** 来源。必填，`'preset'` = 内置，`'custom'` = 用户自建。 */
  source: TemplateSource;
  /** 创建时刻 ISO 8601。不可变。 */
  createdAt: IsoDateTime;
  /** 最近更新时刻 ISO 8601。 */
  updatedAt: IsoDateTime;
}

export interface UsageLog {
  /** 主键，nanoid(12)。不可变。 */
  id: NanoId12;
  /** 物料 id。必填，指向 materials.id。 */
  materialId: string;
  /** 物料名快照。必填，写入时取 material.name，**不可变**。 */
  materialName: string;
  /** 单位快照。必填、非空，1–5 字，写入时取 material.unit，**不可变**。 */
  unit: string;
  /** 数量。必填。方向规则见 §4.6：consume/refill/revert 恒为正数；adjust 存有符号 delta。 */
  quantity: number;
  /** 流水类型。必填。 */
  kind: UsageKind;
  /** 来源。必填。 */
  source: UsageSource;
  /** 关联成衣 id。`''` = 无关联（手工损耗 / 库存直改 / 迁移数据）。 */
  garmentId: string;
  /** 备注。必填，可为 `''`。**≤ 100 字**，写入时截断。 */
  note: string;
  /** 发生时刻 ISO 8601 带时区。必填，**不可变**（§3.5 硬约束 1）。 */
  createdAt: IsoDateTime;
}

export interface ImageRecord {
  /** 主键，nanoid(12)。同时是 GitHub 备份里的文件名（`images/{id}.{ext}`）。不可变。 */
  id: NanoId12;
  /** 压缩后的图片数据。必填。**不被索引**。 */
  blob: Blob;
  /** 原始文件名。必填，1–255 字。 */
  originalName: string;
  /** MIME 类型。必填，取值见 §4.15。 */
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** 所属实体类型。必填。 */
  entityType: ImageEntityType;
  /** 所属实体 id。**`''` 表示孤儿图片**。 */
  entityId: string;
  /** 同步时刻 ISO 8601（P1 预留）。非同步图恒 `undefined`。 */
  syncedAt: IsoDateTime | undefined;
  /** 创建时刻 ISO 8601。不可变。 */
  createdAt: IsoDateTime;
}

export interface SettingsRecord {
  /** 主键。取值集合见 §4.16 的 18 个 key，禁止写入集合外的 key。 */
  key: string;
  /** 值。**恒为字符串**。JSON 类型用 `JSON.stringify` 存，纯字符串直接存，布尔存 `'true'`/`'false'`。≤ 100000 字。 */
  value: string;
  /** 最近更新时刻 ISO 8601。 */
  updatedAt: IsoDateTime;
}

export interface PresetsConfig {
  /** 面料品牌。可增删。初值 13 项（来源 `docs/demo/src/App.jsx:17-20`）。 */
  fabricBrands: string[];
  /** 纸样品牌。可增删。初值 10 项（来源 `docs/demo/src/App.jsx:21-24`）。 */
  patternBrands: string[];
  /** 款式。可增删。初值 12 项（来源 `docs/demo/src/pages/SettingsPage.jsx:559`）。 */
  patternStyles: string[];
  /** 辅料标签。可增删。初值 12 项（来源 `docs/demo/src/pages/SettingsPage.jsx:560`）。 */
  accessoryTags: string[];
  /** 纸样人群。可增删。初值 5 项，取值为 ForWhom 的枚举键。 */
  patternAudiences: string[];
  /** 纸样尺码。可增删。初值 7 项（来源 `docs/demo/src/pages/SettingsPage.jsx:517`）。 */
  patternSizes: string[];
  /** 面料幅宽展示串。可增删。初值 4 项。 */
  fabricWidths: string[];
  /** 辅料幅宽展示串。可增删。初值 3 项。 */
  accessoryWidths: string[];
}

export interface BackupLog {
  /** 主键，nanoid(12)。不可变。 */
  id: NanoId12;
  /** 日志类型。必填。 */
  kind: BackupLogKind;
  /** 结果状态。必填。 */
  status: BackupLogStatus;
  /** 人读消息。必填，可为 `''`。≤ 200 字。例 `'从 zip 恢复（128 行数据, 3 张图片）'`。 */
  message: string;
  /** 发生时刻 ISO 8601。必填，不可变。 */
  createdAt: IsoDateTime;
}
