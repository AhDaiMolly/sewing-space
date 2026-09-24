// src/services/materialService.ts
//
// 物料库写入路径（P1 / P2 / P4 / P6）以及由成衣库触发的库存联动原语
// (P3a 扣减 / P3b 移除回补 / P3c 删除还原)。函数签名逐字对齐
// 架构文档 v3.0 §6.3；口径（流水符号、错误文案、note 模板、打脏
// 规则、级联矩阵）逐字对齐数据模型 v2.0 §3.1 / §4.6 / §5.2 / §5.4
// / §5.6 / §5.7 / §6.2–§6.5。
//
// 模块内非导出辅助：signedDelta / round2 / normalizeTypeFields / markDirty /
// nowIso / DEFAULT_UNITS。applyStockDelta 原语自 S3-A 起导出（见函数处注释）。

import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import { adoptOrphans } from '@/services/imageService';
import type {
  Material,
  MaterialType,
  UsageKind,
  UsageSource,
  NanoId12,
} from '@/db/types';

// ============================ 模块内辅助 ============================

function nowIso(): string {
  return new Date().toISOString();
}

/** 两位小数精度（DM §11.4）。 */
const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

/** DM §4.6：流水 → 有符号 delta。consume 取负；refill / revert / adjust 取正
 *  （adjust 的 quantity 本身已带符号）。 */
function signedDelta(kind: UsageKind, quantity: number): number {
  switch (kind) {
    case 'consume':
      return -quantity;
    case 'refill':
      return +quantity;
    case 'revert':
      return +quantity;
    case 'adjust':
      return +quantity;
  }
}

/** DM §4.7 表单默认单位（按 type）。 */
const DEFAULT_UNITS: Readonly<Record<MaterialType, string>> = {
  fabric: '米',
  accessory: '个',
  tool: '个',
  pattern: '件',
};

/** DM §3.1 HC5 字段适用矩阵：切 type 时按列归位。brand 不归位。 */
function normalizeTypeFields(
  type: MaterialType,
  src: Partial<Material>,
): Partial<Material> {
  const out: Partial<Material> = { ...src };
  if (type !== 'fabric' && type !== 'accessory') {
    out.width = undefined;
  }
  if (type !== 'fabric') {
    out.weight = undefined;
    out.composition = '';
    out.sampleCard = '';
  }
  if (type !== 'pattern') {
    out.size = '';
    out.rating = 0;
    out.ratingReview = '';
    out.used = 0;
  }
  return out;
}

async function markDirty(): Promise<void> {
  await db.settings.put({
    key: 'dirty_since_backup',
    value: 'true',
    updatedAt: nowIso(),
  });
}

// ============================ 服务层长度兜底（架构 §13.2 阻塞条件 / DM §3.1）============================
//
// 组件层 maxLength 只是体验层；绕过组件直接调服务（S3/S4 写入路径、迁移
// 导入）也必须被拦住。以下断言在 createMaterial / updateMaterial 入口执行，
// 超限抛中文错误；组件层 maxLength 保留，两道防线互为兜底。

/** DM §3.1 自由文本字段上限表：字段名 → [中文标签, trim 后最大字数]。 */
const TEXT_FIELD_LIMITS: Partial<Record<keyof Material, readonly [string, number]>> = {
  category: ['分类', 20],
  color: ['颜色', 20],
  brand: ['品牌', 30],
  size: ['尺码', 20],
  composition: ['成分', 50],
  sampleCard: ['样卡', 30],
  notes: ['备注', 500],
  ratingReview: ['短评', 200],
};

/** trim + 长度断言：返回 trim 后的值；超限抛中文错误。 */
function assertTextField(value: string | undefined, label: string, max: number): string {
  const v = String(value ?? '').trim();
  if (v.length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return v;
}

/** 数组元素长度断言（tags / suitableFor，元素 1–20 字）。 */
function assertTextArray(value: string[] | undefined, label: string): string[] {
  if (!Array.isArray(value)) return [];
  for (const el of value) {
    if (String(el ?? '').trim().length > 20) {
      throw new Error(`${label}不能超过 20 字`);
    }
  }
  return value;
}

/** 名称断言（DM §3.1：trim 后 1–50 字，不得为纯空白）。返回 trim 后的值。 */
function assertName(value: string | undefined): string {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > 50) throw new Error('名称不能超过 50 字');
  return name;
}

// ============================ 内部：库存 / 流水 原语 ============================
//
// DM §5.6 第一条：applyStockDelta 是 materials.quantity 变化的唯一入口。
// 服务函数各自开事务，本原语在事务内被调用、不开新事务。固定六步：
//   ① 读物料（缺 → '物料不存在或已被删除'）
//   ② signedDelta(delta === 0 → 直接返回，两边都不写，HC7）
//   ③ round2 + next<0 → 抛错（文案由 caller 通过 rejectMessage 传入）
//   ④ materials.put（合并 materialPatch；quantity / updatedAt 由本函数写）
//   ⑤ usageLogs.add（consume / revert / refill 存正数，adjust 存带符号 delta）
//   ⑥ 打脏 dirty_since_backup
//
// 调整后负数拦截的逐字文案（DM §5.4）：
//   P2 / P8 `调整后库存不能为负（当前 {cur} {unit}，本次调整 {delta>0?'+':''}{delta} {unit}）`

interface ApplyStockDeltaArgs {
  kind: UsageKind;
  /** consume / refill / revert 给正数；adjust 给有符号 delta（§5.6 权威）。 */
  quantity: number;
  source: UsageSource;
  note: string;
  garmentId?: string;
  /** 合并进 materials.put 的非库存字段（updateMaterial 改其它列用）。 */
  materialPatch?: Partial<Material>;
  /** 调整后负数时的预拼好文案；缺省回落 P2/P8 文案。 */
  rejectMessage?: string;
}

// 库存原语 applyStockDelta（DM §5.6：materials.quantity 变化的唯一实现，
// 禁止手写第二份）——S3-A 起对 garmentService 导出复用：成衣库 P3a/P3b/P3c
// 的单事务要求不能通过 consumeOnAssociate 等各自开事务的封装实现，只能复用
// 本原语。这是 S2 基线上唯一的一处改动（加 export 关键字），函数体未动。

export async function applyStockDelta(
  materialId: NanoId12,
  args: ApplyStockDeltaArgs,
): Promise<{ logId: NanoId12 }> {
  const cur = await db.materials.get(materialId);
  if (!cur) throw new Error('物料不存在或已被删除');
  const delta = signedDelta(args.kind, args.quantity);
  if (delta === 0) {
    // HC7：零数量流水非法。直接返回，不写库、不打脏。
    return { logId: '' };
  }
  const next = round2(cur.quantity + delta);
  if (next < 0) {
    const fallback = `调整后库存不能为负（当前 ${cur.quantity} ${cur.unit}，本次调整 ${
      delta > 0 ? '+' : ''
    }${delta} ${cur.unit}）`;
    throw new Error(args.rejectMessage ?? fallback);
  }
  const now = nowIso();
  const patched: Material = {
    ...cur,
    ...(args.materialPatch ?? {}),
    quantity: next,
    updatedAt: now,
  };
  await db.materials.put(patched);
  const logId = nanoid(12);
  await db.usageLogs.add({
    id: logId,
    materialId,
    materialName: cur.name,
    unit: cur.unit,
    quantity: args.quantity,
    kind: args.kind,
    source: args.source,
    garmentId: args.garmentId ?? '',
    note: String(args.note ?? '').slice(0, 100),
    createdAt: now,
  });
  await markDirty();
  return { logId };
}

// ============================ P1：新建物料 ============================

export async function createMaterial(
  input: Omit<Material, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<NanoId12> {
  // 事务外校验：name trim 非空 1–50 字 / 各自由文本与 notes 上限 /
  // quantity ≥ 0 / unit 非空（服务层兜底，DM §3.1 / 架构 §13.2）。
  const name = assertName(input.name);
  if (!(input.quantity >= 0)) throw new Error('库存数量不能为负');
  const rawUnit = String(input.unit ?? '').trim();
  // 单位空白时按 type 填默认值（DM §4.7）。单位切换不迁移数值。
  const unit = rawUnit || DEFAULT_UNITS[input.type];
  const texts = {} as Record<string, string>;
  for (const [key, [label, max]] of Object.entries(TEXT_FIELD_LIMITS)) {
    texts[key] = assertTextField(
      (input as Record<string, unknown>)[key] as string | undefined,
      label,
      max,
    );
  }
  assertTextArray(input.tags, '标签');
  assertTextArray(input.suitableFor, '适合款式');

  // type 字段归位（HC5）。先做 trim 回填、再做归位，保证不适用的字段仍被归位清空。
  const validated: Omit<Material, 'id' | 'createdAt' | 'updatedAt'> = {
    ...input,
    name,
    unit,
    category: texts.category ?? '',
    color: texts.color ?? '',
    brand: texts.brand ?? '',
    size: texts.size ?? '',
    composition: texts.composition ?? '',
    sampleCard: texts.sampleCard ?? '',
    notes: texts.notes ?? '',
    ratingReview: texts.ratingReview ?? '',
  };
  const normalized = normalizeTypeFields(input.type, validated);
  const id = nanoid(12);
  const now = nowIso();
  const row: Material = {
    ...(normalized as Omit<Material, 'id' | 'createdAt' | 'updatedAt'>),
    id,
    name,
    unit,
    // 库存恒等式基准（§3.1 HC1 / §5.6 第五条）：initialQuantity === quantity。
    initialQuantity: input.quantity,
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction('rw', [db.materials, db.images, db.settings], async () => {
    await db.materials.add(row);
    // §5.7 三（顺序不可换）：实体行写成功后，立即把先前 entityId === '' 的
    // 孤儿图回填为新实体 id，防止 24h 孤儿清理把已保存的图片删掉（P0-2）。
    if (Array.isArray(row.images) && row.images.length > 0) {
      await adoptOrphans(row.images, 'material', id);
    }
    await markDirty();
  });
  return id;
}

// ============================ P2：编辑物料 ============================

export async function updateMaterial(
  id: NanoId12,
  patch: Partial<Omit<Material, 'id' | 'createdAt'>>,
): Promise<void> {
  if (!id) throw new Error('物料 id 不能为空');
  // initialQuantity 不可变（HC1）。
  if ('initialQuantity' in patch && patch.initialQuantity !== undefined) {
    throw new Error('initialQuantity 不可修改');
  }

  // 服务层长度兜底（P0-3，DM §3.1 / 架构 §13.2）：只断言 patch 里出现的字段，
  // trim 后超限抛中文错误，并把 trim 后的值写回 patch。
  if ('name' in patch && patch.name !== undefined) {
    patch.name = assertName(patch.name);
  }
  for (const [key, [label, max]] of Object.entries(TEXT_FIELD_LIMITS)) {
    if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = assertTextField(
        (patch as Record<string, unknown>)[key] as string | undefined,
        label,
        max,
      );
    }
  }
  if ('tags' in patch && patch.tags !== undefined) {
    assertTextArray(patch.tags, '标签');
  }
  if ('suitableFor' in patch && patch.suitableFor !== undefined) {
    assertTextArray(patch.suitableFor, '适合款式');
  }

  await db.transaction(
    'rw',
    [db.materials, db.usageLogs, db.images, db.settings],
    async () => {
      const cur = await db.materials.get(id);
      if (!cur) throw new Error('物料不存在');

      // 计算数量变化；未指定 quantity 视为不变。
      const hasQuantity = 'quantity' in patch && patch.quantity !== undefined;
      const nextQuantity = hasQuantity ? (patch.quantity as number) : cur.quantity;
      if (!(nextQuantity >= 0)) throw new Error('库存数量不能为负');
      const quantityDelta = hasQuantity ? round2(nextQuantity - cur.quantity) : 0;

      // type 归位：以新 type（如有）为准。
      const newType = (patch.type ?? cur.type) as MaterialType;
      const normalizedPatch = normalizeTypeFields(newType, patch);

      if (quantityDelta !== 0) {
        // P2 有流水：走 applyStockDelta（其内部已 put 整行 + 打脏）；
        // 此处不再单独 put，避免同事务双 put 与双重打脏。
        const rejectMessage = `调整后库存不能为负（当前 ${cur.quantity} ${cur.unit}，本次调整 ${
          quantityDelta > 0 ? '+' : ''
        }${quantityDelta} ${cur.unit}）`;
        // patch 中已含 nextQuantity；但 applyStockDelta 用 quantity: delta 触发
        // signedDelta('adjust') = +quantity，库存写入 next，故从 materialPatch
        // 中剔除 quantity 避免覆盖。
        const { quantity: _q, initialQuantity: _i, ...rest } = normalizedPatch;
        void _q;
        void _i;
        await applyStockDelta(id, {
          kind: 'adjust',
          quantity: quantityDelta,
          source: 'manual',
          note: '手动调整库存',
          garmentId: '',
          materialPatch: rest,
          rejectMessage,
        });
      } else {
        // P2 不改数量：纯字段刷新（§6.4 伪代码：只 put、不写流水、不打脏）。
        const { quantity: _q, initialQuantity: _i, ...rest } = normalizedPatch;
        void _q;
        void _i;
        await db.materials.put({
          ...cur,
          ...rest,
          updatedAt: nowIso(),
        });
      }

      // §5.7 五（P0-2 / P2-3 对账）：实体行已写入后，对 patch.images 增量做
      // adopt / drop——新增的孤儿图认领为本实体，移除的图行删除（同事务）。
      // 删图不再由表单层立即执行，取消编辑因此不产生副作用。
      if ('images' in patch && Array.isArray(patch.images)) {
        const nextImages = patch.images as string[];
        const added = nextImages.filter((x) => !cur.images.includes(x));
        const removed = cur.images.filter((x) => !nextImages.includes(x));
        if (added.length > 0) {
          await adoptOrphans(added, 'material', id);
        }
        if (removed.length > 0) {
          await db.images.bulkDelete(removed);
        }
      }
    },
  );
}

// ============================ P6：删除物料（按 DM §2.5 全量级联）========================

export async function deleteMaterial(id: NanoId12): Promise<void> {
  if (!id) throw new Error('物料 id 不能为空');
  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.images, db.settings],
    async () => {
      const m = await db.materials.get(id);
      if (!m) throw new Error('物料不存在');

      // ① 整批删除该物料的全部流水（含 legacy，DM §6.5 P6 步骤 1）。
      await db.usageLogs.where('materialId').equals(id).delete();

      // ② 受影响成衣 = materialIds 多值索引命中 ∪ patternId 索引命中。
      //    两类查询可能命中不相交集合（patternId 指向的纸样通常不进 materialIds），
      //    用 garment.id 去重后逐件处理：退休活跃快照行 + 重算 materialIds /
      //    totalCost + patternId 置 ''。
      const byMaterialIds = await db.garments
        .where('materialIds')
        .equals(id)
        .toArray();
      const byPatternId = await db.garments
        .where('patternId')
        .equals(id)
        .toArray();
      const seen = new Set<string>();
      const merged: typeof byMaterialIds = [];
      for (const g of byMaterialIds) {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          merged.push(g);
        }
      }
      for (const g of byPatternId) {
        if (!seen.has(g.id)) {
          seen.add(g.id);
          merged.push(g);
        }
      }

      const now = nowIso();
      for (const g of merged) {
        const snapshot = g.materialSnapshot.map((r) =>
          !('retiredAt' in r) && r.materialId === id
            ? { ...r, deducted: false, retiredAt: now }
            : r,
        );
        const activeRows = snapshot.filter((r) => !('retiredAt' in r));
        const recalcMaterialIds = [...new Set(activeRows.map((r) => r.materialId))];
        const activeSubtotal = activeRows.reduce(
          (s, r) => s + (Number.isFinite(r.subtotal) ? r.subtotal : 0),
          0,
        );
        const nextPatternId = g.patternId === id ? '' : g.patternId;
        let patternPrice = 0;
        if (nextPatternId !== '') {
          const pat = await db.materials.get(nextPatternId);
          patternPrice = pat?.purchasePrice ?? 0;
        }
        const newTotalCost = round2(activeSubtotal + patternPrice);
        await db.garments.put({
          ...g,
          materialSnapshot: snapshot,
          materialIds: recalcMaterialIds,
          patternId: nextPatternId,
          totalCost: newTotalCost,
          updatedAt: now,
        });
      }

      // ③ 删该物料的图（DM §3.6 HC6 / §6.5 P6 步骤 4）。
      const imgIds = (
        await db.images
          .where('[entityType+entityId]')
          .equals(['material', id])
          .toArray()
      ).map((r) => r.id);
      if (imgIds.length) await db.images.bulkDelete(imgIds);

      // ④ 删物料行本身（§6.5 P6 步骤 5）。
      await db.materials.delete(id);

      // ⑤ 打脏。
      await markDirty();
    },
  );
}

// ============================ P4：记损耗 ============================

export async function recordLoss(
  materialId: NanoId12,
  quantity: number,
  note: string,
): Promise<void> {
  if (!(quantity > 0)) throw new Error('损耗数量必须大于 0');
  const cleanNote = String(note ?? '').trim();
  await db.transaction(
    'rw',
    [db.materials, db.usageLogs, db.settings],
    async () => {
      const cur = await db.materials.get(materialId);
      if (!cur) throw new Error('物料不存在或已被删除');
      const rejectMessage = `损耗数量不能大于当前库存（${cur.name} 当前 ${cur.quantity} ${cur.unit}）`;
      await applyStockDelta(materialId, {
        kind: 'consume',
        quantity,
        source: 'manual',
        note: cleanNote || '手动损耗',
        garmentId: '',
        rejectMessage,
      });
    },
  );
}

// ============================ P2 / P8：库存直改 ============================

export async function adjustMaterialQuantity(
  materialId: NanoId12,
  newQuantity: number,
  note: string,
): Promise<{ delta: number; newQuantity: number; logId: NanoId12 }> {
  if (!(newQuantity >= 0)) throw new Error('库存数量不能为负');
  const cleanNote = String(note ?? '').trim();

  let resultLogId = '';
  let resultDelta = 0;
  let resultNew = newQuantity;

  await db.transaction(
    'rw',
    [db.materials, db.usageLogs, db.settings],
    async () => {
      const cur = await db.materials.get(materialId);
      if (!cur) throw new Error('物料不存在');
      const delta = round2(newQuantity - cur.quantity);
      if (delta === 0) {
        // HC7：不写零流水；直接返回原值 + 空 logId。
        resultDelta = 0;
        resultNew = cur.quantity;
        resultLogId = '';
        return;
      }
      const rejectMessage = `调整后库存不能为负（当前 ${cur.quantity} ${cur.unit}，本次调整 ${
        delta > 0 ? '+' : ''
      }${delta} ${cur.unit}）`;
      const { logId } = await applyStockDelta(materialId, {
        kind: 'adjust',
        quantity: delta,
        source: 'manual',
        note: cleanNote || '手动调整库存',
        garmentId: '',
        rejectMessage,
      });
      resultDelta = delta;
      resultNew = newQuantity;
      resultLogId = logId;
    },
  );

  return { delta: resultDelta, newQuantity: resultNew, logId: resultLogId };
}

// ============================ P3a：成衣关联时扣减 ============================

export async function consumeOnAssociate(
  materialId: NanoId12,
  quantity: number,
  garmentId: NanoId12,
): Promise<void> {
  if (!(quantity > 0)) throw new Error('用料数量必须大于 0');
  await db.transaction(
    'rw',
    [db.materials, db.usageLogs, db.garments, db.settings],
    async () => {
      const g = await db.garments.get(garmentId);
      if (!g) throw new Error('成衣不存在');
      const cur = await db.materials.get(materialId);
      if (!cur) throw new Error('物料不存在或已被删除');
      const rejectMessage = `「${cur.name}」库存不足：需要 ${quantity} ${cur.unit}，当前仅 ${cur.quantity} ${cur.unit}`;
      await applyStockDelta(materialId, {
        kind: 'consume',
        quantity,
        source: `garment:${garmentId}`,
        garmentId,
        note: `${g.name} 新增成衣扣减`,
        rejectMessage,
      });
    },
  );
}

// ============================ P3b / P3c 移除：还原 ============================

export async function revertOnUnassociate(
  materialId: NanoId12,
  quantity: number,
  garmentId: NanoId12,
): Promise<void> {
  if (!(quantity > 0)) throw new Error('回补数量必须大于 0');
  await db.transaction(
    'rw',
    [db.materials, db.usageLogs, db.garments, db.settings],
    async () => {
      const g = await db.garments.get(garmentId);
      if (!g) throw new Error('成衣不存在');
      await applyStockDelta(materialId, {
        kind: 'revert',
        quantity,
        source: `garment:${garmentId}`,
        garmentId,
        note: `${g.name} 编辑回补`,
      });
    },
  );
}

// ============================ P3c：删除成衣按快照整组还原 ============================

export async function revertOnDeleteGarment(
  garmentId: NanoId12,
): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.materials,
      db.garments,
      db.usageLogs,
      db.images,
      db.tasks,
      db.settings,
    ],
    async () => {
      const g = await db.garments.get(garmentId);
      if (!g) throw new Error('成衣不存在');

      // ① 活跃快照行逐行 revert（§3.2 HC3 判据：retiredAt 键不存在）。
      //    物料若已被先删（悬挂引用）→ 跳过该行，不抛错（§5.4 P3c 豁免）。
      const activeRows = g.materialSnapshot.filter((r) => !('retiredAt' in r));
      for (const row of activeRows) {
        const exists = await db.materials.get(row.materialId);
        if (!exists) continue;
        await applyStockDelta(row.materialId, {
          kind: 'revert',
          quantity: row.quantityUsed,
          source: `garment:${garmentId}`,
          garmentId,
          note: `${g.name} 删除还原`,
        });
      }

      // ② 删成衣的图（§2.5 / §3.6 HC6）。
      const imgIds = (
        await db.images
          .where('[entityType+entityId]')
          .equals(['garment', garmentId])
          .toArray()
      ).map((r) => r.id);
      if (imgIds.length) await db.images.bulkDelete(imgIds);

      // ③ 解绑任务：garmentId / garmentName 一起置 ''（§5.5 P3c）。
      await db.tasks
        .where('garmentId')
        .equals(garmentId)
        .modify({ garmentId: '', garmentName: '' });

      // ④ 删成衣行（含全部历史快照行）。
      await db.garments.delete(garmentId);

      // ⑤ 打脏。
      await markDirty();
    },
  );
}