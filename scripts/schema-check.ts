/** S1 自检：Dexie schema 必须与数据模型 v2.0 §1.2 逐字一致。成功打印 schema ok。 */
import { nanoid } from 'nanoid';
import { db } from '@/db/schema';

/** 数据模型 v2.0 §1.2 `this.version(1).stores({...})` 的逐字副本。改这里等于改数据模型，必须先改数据模型。 */
const EXPECTED_STORES: Record<string, string> = {
  materials:
    '&id, type, name, category, brand, season, forWhom, purchaseDate, rating, used, createdAt, updatedAt, *tags, *suitableFor',
  garments:
    '&id, status, category, forWhom, patternId, completionDate, createdAt, updatedAt, *materialIds, *tags',
  tasks: '&id, status, priority, garmentId, templateId, dueDate, completedAt, createdAt, updatedAt, *tags',
  taskTemplates: '&id, name, category, source, createdAt, updatedAt, *tags',
  usageLogs: '&id, materialId, kind, source, garmentId, createdAt',
  images: '&id, entityType, entityId, [entityType+entityId], createdAt',
  settings: '&key',
  backupLogs: '&id, kind, status, createdAt',
};

/** 备份 zip 内图片条目名的形态，逐字取数据模型 v2.0 §10.3 与本文 §12.2 的口径。 */
const IMAGE_ENTRY = /^images\/[A-Za-z0-9_-]{12}\.(jpg|png|webp)$/;

/**
 * 与 §13.1 骨架一致；`unique` / `multi` / `auto` 标 `boolean | undefined`
 * 是为了与 Dexie 真实类型 `TableSchema.primKey` 对齐（strict 模式下接受 undefined）。
 * 运行时若 undefined 时规约到 falsy 分支，由 `specText` 的三元链收敛，行为不变。
 */
type Spec = { name: string; unique: boolean | undefined; multi: boolean | undefined; auto: boolean | undefined };
type SchemaLike = { schema: { primKey: Spec; indexes: Spec[] } };

const specText = (s: Spec): string =>
  s.auto ? `++${s.name}` : s.unique ? `&${s.name}` : s.multi ? `*${s.name}` : s.name;

const storesText = (t: SchemaLike): string =>
  [t.schema.primKey, ...t.schema.indexes].map(specText).join(', ');

const failures: string[] = [];
const check = (label: string, actual: string, expected: string): void => {
  if (actual !== expected) failures.push(`${label}\n    实际 ${actual}\n    期望 ${expected}`);
};

const byName = new Map(db.tables.map((t) => [t.name, t] as const));

// ① 表名集合恰好 8 张，一张不多一张不少（数据模型 v2.0 §1.2 的 8 个实体）。
check(
  '表名集合',
  [...byName.keys()].sort().join(', '),
  Object.keys(EXPECTED_STORES).sort().join(', '),
);

// ②③ 每张表的 stores() 串逐字一致：主键、索引、唯一、多值、复合一并比。
for (const [name, expected] of Object.entries(EXPECTED_STORES)) {
  const table = byName.get(name);
  check(`${name} 的 stores() 串`, table ? storesText(table) : '（缺表）', expected);
}

// ④ settings 的主键是 key，不是自增 id（EntityTable<SettingsRecord, 'key'>）。
const settings = byName.get('settings');
if (settings) check('settings 主键名', settings.schema.primKey.name, 'key');

// ⑤ images 的主键是无前缀 12 位 nanoid；`images/{id}.{ext}` 只出现在备份 zip 的条目名里。
const images = byName.get('images');
if (images) {
  check('images 主键名', images.schema.primKey.name, 'id');
  const entry = `images/${nanoid(12)}.webp`;
  if (!IMAGE_ENTRY.test(entry)) failures.push(`条目名正则与 nanoid(12) 不匹配：${entry}`);
}

if (failures.length > 0) {
  console.error(`schema 校验失败（${failures.length} 项）：`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('schema ok');
