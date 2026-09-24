// src/services/garmentService.ts
//
// 成衣库写入路径（S3-A）：P3a 新建（登记用料扣减）/ P3b 编辑（退休回补差集）/
// P3c 删除（整组回补 + 级联删行）/ P11 完工登记 / 解除关联。函数签名逐字对齐
// 架构文档 v3.0 §6.4；口径（差集算法、快照 append 语义、startQty 比较对象、
// 错误文案、流水 note 模板、打脏规则、图片生命周期、事务表清单）逐字对齐
// 数据模型 v2.0 §3.2 / §4.4 / §5.2–§5.7 / §6.2–§6.3。
//
// 库存原语复用 materialService 的 applyStockDelta（DM §5.6：materials.quantity
// 变化的唯一实现，禁止手写第二份）；为此在 S2 基线上为它补了 export（本模块
// 依赖的唯一一处既有文件改动，见《S3-A 实现说明》）。
//
// 两处任务级裁定（任务原文优先于文档，均在实现说明中披露）：
//   1. 用量为 0 / 负数：任务要求「分别抛中文错误」，优先于 DM §5.3 四 /
//      §5.4 六的「静默丢弃」；materialId === '' 的空行仍按 DM 静默丢弃。
//   2. P3b 改量集：DM §5.3 七的 diff>0 分支伪代码（append quantityUsed=diff
//      且旧行不退休）与 §3.2 硬约束 2「同一 materialId 最多 1 条活跃行」冲突，
//      按 §5.3 七「关键：改量也走退休 + append」的裁定统一实现为
//      「退休旧活跃行 + append 一条 quantityUsed=新值的新活跃行」，
//      库存按有符号差值扣 / 补（diff>0 扣 diff，diff<0 回补 |diff|）。
//
// S3-FIX-A（用户决策，跟随 PRD §8.7 / §15.5 #8，优先于 DM §5.2 待修订条目）：
//   服务层放行「规划中」（planning）。createGarmentWithMaterials 接受
//   status ∈ {'planning','in_progress'}（缺省 'in_progress'，拒绝 completed）：
//   planning = 纯计划——不扣库存、不写流水，快照行仍落库但 deducted=false，
//   totalCost 照常按快照单价 × 用量计算；P3b 编辑 planning 成衣只维护快照行
//   （零库存 / 零流水，retire / append 语义保持）；P3c 删除只回补
//   deducted=true 的快照行。与 DM §3.2 硬约束 3（活跃行恒 deducted=true）、
//   §5.2 P3a / P3c、架构 §13.3 DoD 的冲突处均以本决策为准，
//   详见《S3-FIX-A 实现说明》。planning → in_progress（开始制作扣库存）
//   属 S4 工作台范围，接入点已随 S4-A 落地为本模块导出的
//   startGarmentProduction（S4-A 唯一的既有文件改动，见其处注释）。

import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import { applyStockDelta } from '@/services/materialService';
import { adoptOrphans } from '@/services/imageService';
import { todayIsoDate } from '@/lib/date';
import type {
  Garment,
  GarmentMaterialSnapshot,
  GarmentStatus,
  Material,
  NanoId12,
} from '@/db/types';

// ============================ 导出类型（架构 §6.4） ============================

/** 选择器回传的一条关联：{materialId, quantity}。 */
export interface MaterialSelection {
  materialId: NanoId12;
  quantity: number;
}

// ============================ 模块内辅助 ============================

function nowIso(): string {
  return new Date().toISOString();
}

/** 两位小数精度（DM §11.4）。 */
const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

async function markDirty(): Promise<void> {
  await db.settings.put({
    key: 'dirty_since_backup',
    value: 'true',
    updatedAt: nowIso(),
  });
}

// ============================ 服务层长度兜底（架构 §13.2 / DM §3.2） ============================
//
// 组件层 maxLength 只是体验层；绕过组件直接调服务也必须被拦住（S2 质检
// P0-3 的教训）。超限抛中文错误，文案风格与 materialService 一致。

/** DM §3.2：name trim 后 1–50 字，不得为纯空白。返回 trim 后的值。 */
function assertGarmentName(value: string | undefined): string {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('名称不能为空');
  if (name.length > 50) throw new Error('名称不能超过 50 字');
  return name;
}

/** DM §3.2 自由文本上限表：字段名 → [中文标签, trim 后最大字数]。 */
const GARMENT_TEXT_LIMITS: Partial<Record<keyof Garment, readonly [string, number]>> = {
  category: ['分类', 20],
  size: ['尺码', 20],
  recipient: ['穿着者', 30],
  notes: ['备注', 500],
};

/** trim + 长度断言：返回 trim 后的值；超限抛中文错误。 */
function assertTextField(
  value: string | undefined,
  label: string,
  max: number,
): string {
  const v = String(value ?? '').trim();
  if (v.length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return v;
}

/** 校验 data 里出现的全部受控文本字段，返回规整后的片段（未出现的字段不产出键）。 */
function assertGarmentTexts(
  data: Partial<Garment>,
): Partial<Garment> {
  const out: Partial<Garment> = {};
  for (const [key, [label, max]] of Object.entries(GARMENT_TEXT_LIMITS)) {
    const raw = (data as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    (out as Record<string, unknown>)[key] = assertTextField(
      raw as string | undefined,
      label,
      max,
    );
  }
  return out;
}

/** 数组元素长度断言（tags，元素 ≤ 20 字）。 */
function assertTextArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  for (const el of value) {
    if (String(el ?? '').trim().length > 20) {
      throw new Error('标签不能超过 20 字');
    }
  }
  return value;
}

// ============================ 用料选择规整 ============================

/** DM §5.3 四：materialId === '' 的空行静默丢弃（选择器未落地的空行）。
 * 任务裁定：quantity ≤ 0 / NaN 抛「用料数量必须大于 0」。
 * 同一 materialId 的多条选择合并为一行（§6.2 A-04：一次库存变化 = 恰好
 * 一行流水；同一物料的多个用料项在进入原语前合并）。 */
function normalizeSelections(
  selections: MaterialSelection[],
): Map<NanoId12, number> {
  const merged = new Map<NanoId12, number>();
  for (const s of selections ?? []) {
    if (!s) continue;
    const mid = s.materialId;
    if (typeof mid !== 'string' || mid === '') continue;
    const qty = Number(s.quantity);
    if (!(qty > 0)) throw new Error('用料数量必须大于 0');
    merged.set(mid, round2((merged.get(mid) ?? 0) + qty));
  }
  return merged;
}

// ============================ 派生字段（DM §5.3 二 / 三） ============================

/** materialIds = 活跃行的投影（去重、保持首次出现顺序）。 */
function recalcMaterialIds(rows: GarmentMaterialSnapshot[]): string[] {
  return [
    ...new Set(
      rows.filter((r) => !('retiredAt' in r)).map((r) => r.materialId),
    ),
  ];
}

/** totalCost = round2(Σ活跃行.subtotal + patternPrice)。只对活跃行求和。 */
function calcTotalCost(
  rows: GarmentMaterialSnapshot[],
  patternPrice: number,
): number {
  const sum = rows
    .filter((r) => !('retiredAt' in r))
    .reduce((acc, r) => acc + r.subtotal, 0);
  return round2(sum + patternPrice);
}

/** patternPrice：写入时刻纸样物料的 purchasePrice（?? 0）；未关联 / 纸样
 * 行不存在时为 0。纸样不参与用料扣减，只有价格（DM §5.3 三）。 */
async function resolvePatternPrice(patternId: string): Promise<number> {
  if (!patternId) return 0;
  const p = await db.materials.get(patternId);
  return p?.purchasePrice ?? 0;
}

/** P3a / P3b 的库存不足文案（DM §5.4 五，逐字）。 */
function stockShortMsg(mat: Material, need: number): string {
  return `「${mat.name}」库存不足：需要 ${need} ${mat.unit}，当前仅 ${mat.quantity} ${mat.unit}`;
}

// ============================ 纯函数：快照展开（架构 §6.4） ============================

/** S3-FIX-A：planning 成衣是纯计划——快照行落库但 deducted=false（未扣库存）。 */
export function buildSnapshotFromSelections(
  selections: MaterialSelection[],
  materials: Map<NanoId12, Material>,
  opts?: { deducted?: boolean },
): GarmentMaterialSnapshot[] {
  const deducted = opts?.deducted ?? true;
  const out: GarmentMaterialSnapshot[] = [];
  for (const s of selections ?? []) {
    if (!s) continue;
    if (typeof s.materialId !== 'string' || s.materialId === '') continue;
    if (!(Number(s.quantity) > 0)) continue; // 调用方已先行校验；此处兜底静默丢弃
    const mat = materials.get(s.materialId);
    if (!mat) throw new Error('物料不存在或已被删除');
    const priceSnapshot = mat.purchasePrice ?? 0;
    const quantityUsed = round2(Number(s.quantity));
    out.push({
      materialId: s.materialId,
      name: mat.name,
      unit: mat.unit,
      priceSnapshot,
      quantityUsed,
      subtotal: round2(priceSnapshot * quantityUsed),
      deducted,
      // 活跃行不写 retiredAt 这个键（DM §3.2 硬约束 3）
    });
  }
  return out;
}

// ============================ P3a：新建成衣（登记用料扣减） ============================

/** S3-FIX-A（用户决策，优先于 DM §5.2 P3a 的「强制 in_progress」）：status 入参
 * 只接受 'planning' | 'in_progress'，缺省 'in_progress'；'completed' 只能由
 * P11 完工登记写入，任何创建路径都不许写。 */
function resolveCreateStatus(raw: GarmentStatus | undefined): GarmentStatus {
  if (raw === undefined || raw === 'in_progress') return 'in_progress';
  if (raw === 'planning') return 'planning';
  throw new Error('新建成衣状态只能选「规划中」或「制作中」');
}

export async function createGarmentWithMaterials(args: {
  data: Omit<Garment, 'id' | 'createdAt' | 'updatedAt' | 'materialIds' | 'materialSnapshot'>;
  selections: MaterialSelection[];
}): Promise<NanoId12> {
  // ---- 事务外校验（架构 §6.10 规则 1：先校验后进事务）----
  const name = assertGarmentName(args.data.name);
  const texts = assertGarmentTexts(args.data);
  const tags = assertTextArray(args.data.tags);
  // S3-FIX-A：planning = 纯计划（不扣库存、不写流水，快照 deducted=false）；
  // in_progress = 维持现状（扣减 + consume 流水 + deducted=true）。
  const status = resolveCreateStatus(args.data.status);
  // 旁路防护（S5-A）：completionDate 未完工恒 ''（DM §3.2 字段表），只能由
  // P11 写入——创建路径收到非空值即拒绝。
  if (args.data.completionDate) {
    throw new Error('完工日期只能由完工登记写入');
  }
  const selectionsMap = normalizeSelections(args.selections);
  if (selectionsMap.size > 50) {
    throw new Error('用料清单已达上限（50 行），请先删除成衣或调整用料');
  }
  const imageIds = Array.isArray(args.data.images) ? [...args.data.images] : [];
  const id = nanoid(12);

  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.images, db.settings],
    async () => {
      const now = nowIso();

      // ① 一次读出全部涉及物料（startQty，DM §5.3 五：比较对象 = 事务开始时
      //    的 quantity，全程不变，不受处理顺序影响）。
      const matIds = [...selectionsMap.keys()];
      const mats = (await db.materials.bulkGet(matIds)).filter(
        (m): m is Material => m !== undefined,
      );
      if (mats.length !== matIds.length) {
        throw new Error('物料不存在或已被删除');
      }
      const matMap = new Map(mats.map((m) => [m.id, m]));

      // ② 库存上限预检（S3-FIX-A 口径保持不变：planning 同样做用量 ≤ 当前
      //    库存的上限拦截，只是不落任何库存 / 流水动作）。比较对象 = startQty。
      for (const [mid, qty] of selectionsMap) {
        const mat = matMap.get(mid);
        if (!mat) throw new Error('物料不存在或已被删除');
        if (qty > mat.quantity) throw new Error(stockShortMsg(mat, qty));
      }

      // ③ 扣减与流水：仅 in_progress。planning 跳过（零库存动作、零流水）。
      if (status === 'in_progress') {
        for (const [mid, qty] of selectionsMap) {
          const mat = matMap.get(mid);
          if (!mat) throw new Error('物料不存在或已被删除');
          if (qty > mat.quantity) throw new Error(stockShortMsg(mat, qty));
          await applyStockDelta(mid, {
            kind: 'consume',
            quantity: qty,
            source: `garment:${id}`,
            note: `${name} 新增成衣扣减`,
            garmentId: id,
            rejectMessage: stockShortMsg(mat, qty),
          });
        }
      }

      // ④ 用料快照 + 派生字段（totalCost 由服务层按快照单价 × 用量计算，
      //    不信任入参；DM §5.3 三 / 任务要求 4）。planning 的快照行同样落库
      //    （deducted=false），计划也要能看预估成本。
      const snapshot = buildSnapshotFromSelections(
        [...selectionsMap].map(([materialId, quantity]) => ({
          materialId,
          quantity,
        })),
        matMap,
        { deducted: status === 'planning' ? false : true },
      );
      const patternPrice = await resolvePatternPrice(args.data.patternId ?? '');
      const totalCost = calcTotalCost(snapshot, patternPrice);

      // ⑤ 写成衣行（S3-FIX-A：status = 入参解析值，planning / in_progress
      //    二值；绝不写 completed——completed 只属于 P11。扣减先于实体行，
      //    §6.2 顺序裁定）。
      await db.garments.add({
        ...args.data,
        ...texts,
        id,
        name,
        tags,
        images: imageIds,
        status,
        completionDate: '',
        materialIds: recalcMaterialIds(snapshot),
        materialSnapshot: snapshot,
        totalCost,
        createdAt: now,
        updatedAt: now,
      });

      // ⑥ 认领孤儿图（DM §5.7 三：实体行写成功后才回填 entityId，顺序不可换；
      //    只认领 entityId === '' 且 entityType 匹配的行）。
      if (imageIds.length) await adoptOrphans(imageIds, 'garment', id);

      // ⑦ 打脏（P3a 在打脏路径清单内，DM §5.6 六）。
      await markDirty();
    },
  );
  return id;
}

// ============================ P3b：编辑成衣（退休回补差集） ============================

export async function updateGarmentWithMaterials(args: {
  id: NanoId12;
  data: Partial<Omit<Garment, 'id' | 'createdAt'>>;
  prevSelections: MaterialSelection[];
  newSelections: MaterialSelection[];
}): Promise<void> {
  // ---- 事务外校验 ----
  const texts = assertGarmentTexts(args.data);
  const tags =
    args.data.tags !== undefined ? assertTextArray(args.data.tags) : undefined;
  // 旁路防护（S5-A，DM §5.2 补充 4 / DM §3.2 硬约束 9）：status /
  // completionDate / totalCost 只能由 P11 完工登记（或服务层核算）写入——
  // P3b 收到这些键即拒绝并给中文报错，不静默忽略。
  if (args.data.status !== undefined) {
    throw new Error('成衣状态不允许在此修改（只能走完工登记）');
  }
  if (args.data.completionDate !== undefined) {
    throw new Error('完工日期不允许在此修改（只能走完工登记）');
  }
  if (args.data.totalCost !== undefined) {
    throw new Error('总成本由服务层核算，不允许手动传入');
  }
  // 透传白名单：patternId / forWhom / startDate / plannedDate / sourceRef。
  // materialIds / materialSnapshot 亦不由入参写入（快照只走差集算法）。
  const patch: Partial<Garment> = { ...texts };
  if (args.data.patternId !== undefined) patch.patternId = args.data.patternId;
  if (args.data.forWhom !== undefined) patch.forWhom = args.data.forWhom;
  if (args.data.startDate !== undefined) patch.startDate = args.data.startDate;
  if (args.data.plannedDate !== undefined) patch.plannedDate = args.data.plannedDate;
  if (args.data.sourceRef !== undefined) patch.sourceRef = args.data.sourceRef;
  if (args.data.name !== undefined) patch.name = assertGarmentName(args.data.name);
  if (tags !== undefined) patch.tags = tags;
  const imagesProvided = args.data.images !== undefined;
  if (imagesProvided) patch.images = [...(args.data.images ?? [])];

  const newMap = normalizeSelections(args.newSelections);
  if (newMap.size > 50) {
    throw new Error('用料清单已达上限（50 行），请先删除成衣或调整用料');
  }

  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.images, db.settings],
    async () => {
      const g = await db.garments.get(args.id);
      if (!g) throw new Error('成衣不存在');
      const now = nowIso();
      // S3-FIX-A（用户决策）：planning 成衣的编辑是纯快照维护——改用料不触碰
      // 库存与流水（其快照行 deducted=false，从未扣过库存）；retire / append
      // 语义保持。in_progress 维持现状差值回补 / 补扣。
      const planning = g.status === 'planning';

      // ---- 差集（DM §5.3 七）：旧侧以库中活跃行为准（库是权威；
      //      prevSelections 仅为调用方参考，不参与计算）。----
      const oldRows = g.materialSnapshot.filter((r) => !('retiredAt' in r));
      const oldMap = new Map(oldRows.map((r) => [r.materialId, r]));

      // 涉及物料一次读出（startQty，§5.3 五）。
      const involved = new Set<NanoId12>([...oldMap.keys(), ...newMap.keys()]);
      const mats = (
        await db.materials.bulkGet([...involved])
      ).filter((m): m is Material => m !== undefined);
      const matMap = new Map(mats.map((m) => [m.id, m]));
      const startQty = new Map(mats.map((m) => [m.id, m.quantity]));

      // 新侧物料必须存在（老侧悬挂引用在移除时豁免跳过，§5.4 二.3）。
      for (const mid of newMap.keys()) {
        if (!matMap.has(mid)) throw new Error('物料不存在或已被删除');
      }

      // 库存充足性预检：比较对象 = startQty（不做「先回补再补扣」，§5.3 六）。
      // S3-FIX-A：planning 的活跃行未占用库存，比较对象 = 新值全额；
      // in_progress 沿用差值口径（新增差额部分才需要库存）。
      for (const [mid, qty] of newMap) {
        const old = oldMap.get(mid);
        const need = planning || old === undefined ? qty : round2(qty - old.quantityUsed);
        if (need <= 0.001) continue;
        const mat = matMap.get(mid);
        const start = startQty.get(mid) ?? 0;
        if (mat && need > start) throw new Error(stockShortMsg(mat, need));
      }

      // ---- 执行差集：回补先于补扣（§5.4 三），退休走「deducted: false +
      //      补 retiredAt」这唯一一次写入（§5.3 一）。----
      const retired = new Set<GarmentMaterialSnapshot>();
      for (const row of oldRows) {
        const newQty = newMap.get(row.materialId);
        if (newQty === undefined) {
          retired.add(row); // 移除集
          continue;
        }
        const diff = round2(newQty - row.quantityUsed);
        if (diff > 0.001 || diff < -0.001) retired.add(row); // 改量集
      }

      // 先执行全部回补（移除集 + 改量减向），再执行补扣。
      // S3-FIX-A：planning 全程零库存动作 / 零流水，applyStockDelta 一律跳过。
      for (const row of retired) {
        const newQty = newMap.get(row.materialId);
        if (newQty !== undefined) continue; // 改量集的回补在下方与补扣一起按差值处理
        // 移除集：整行回补（悬挂引用豁免：物料已删则只退休不回补）。
        if (!planning && matMap.has(row.materialId)) {
          await applyStockDelta(row.materialId, {
            kind: 'revert',
            quantity: row.quantityUsed,
            source: `garment:${args.id}`,
            note: `${g.name} 编辑回补`,
            garmentId: args.id,
          });
        }
      }

      // 改量集：退休旧活跃行 + append 新活跃行（quantityUsed = 新值，快照
      // 字段重新从当前物料读），库存按有符号差值扣 / 补（planning 跳过）。
      const appended: GarmentMaterialSnapshot[] = [];
      for (const row of retired) {
        const newQty = newMap.get(row.materialId);
        if (newQty === undefined) continue;
        const diff = round2(newQty - row.quantityUsed);
        if (!planning) {
          if (diff > 0.001) {
            await applyStockDelta(row.materialId, {
              kind: 'consume',
              quantity: diff,
              source: `garment:${args.id}`,
              note: `${g.name} 编辑补扣`,
              garmentId: args.id,
            });
          } else if (diff < -0.001) {
            await applyStockDelta(row.materialId, {
              kind: 'revert',
              quantity: round2(-diff),
              source: `garment:${args.id}`,
              note: `${g.name} 编辑回补`,
              garmentId: args.id,
            });
          }
        }
        const mat = matMap.get(row.materialId);
        if (mat) {
          const priceSnapshot = mat.purchasePrice ?? 0;
          appended.push({
            materialId: row.materialId,
            name: mat.name,
            unit: mat.unit,
            priceSnapshot,
            quantityUsed: newQty,
            subtotal: round2(priceSnapshot * newQty),
            deducted: !planning,
          });
        }
      }

      // 新增集：扣库存 + append 活跃行（planning 只 append，不扣）。
      for (const [mid, qty] of newMap) {
        if (oldMap.has(mid)) continue;
        const mat = matMap.get(mid);
        if (!mat) throw new Error('物料不存在或已被删除');
        if (!planning) {
          await applyStockDelta(mid, {
            kind: 'consume',
            quantity: qty,
            source: `garment:${args.id}`,
            note: `${g.name} 编辑补扣`,
            garmentId: args.id,
          });
        }
        const priceSnapshot = mat.purchasePrice ?? 0;
        appended.push({
          materialId: mid,
          name: mat.name,
          unit: mat.unit,
          priceSnapshot,
          quantityUsed: qty,
          subtotal: round2(priceSnapshot * qty),
          deducted: !planning,
        });
      }

      // 组装新快照：历史行原样保留，被退休的行补 deducted: false + retiredAt，
      // append 的新行追加分（append 语义，禁止整体替换——DM §3.2 硬约束 2）。
      const nextSnapshot: GarmentMaterialSnapshot[] = [
        ...g.materialSnapshot.map((r) =>
          retired.has(r) ? { ...r, deducted: false, retiredAt: now } : r,
        ),
        ...appended,
      ];
      if (nextSnapshot.length > 50) {
        throw new Error('用料清单已达上限（50 行），请先删除成衣或调整用料');
      }

      // 重算派生字段（materialIds / totalCost；totalCost 不信任入参）。
      const patternId = patch.patternId !== undefined ? patch.patternId : g.patternId;
      const patternPrice = await resolvePatternPrice(patternId);
      const totalCost = calcTotalCost(nextSnapshot, patternPrice);

      // 图片对账（DM §5.7 四 / 五）：data.images 提供时，旧有新无 → 删行；
      // 新列表里的孤儿 → 认领。未提供则完全不动图片。
      if (imagesProvided && patch.images) {
        const newIds = new Set(patch.images);
        const toDrop = g.images.filter((imgId) => !newIds.has(imgId));
        if (toDrop.length) {
          const own = await db.images
            .where('[entityType+entityId]')
            .equals(['garment', args.id])
            .toArray();
          const dropIds = own
            .filter((r) => toDrop.includes(r.id))
            .map((r) => r.id);
          if (dropIds.length) await db.images.bulkDelete(dropIds);
        }
        if (patch.images.length) {
          await adoptOrphans(patch.images, 'garment', args.id);
        }
      }

      await db.garments.put({
        ...g,
        ...patch,
        status: g.status, // P3b 不碰 status（DM §5.2 补充 4）
        materialIds: recalcMaterialIds(nextSnapshot),
        materialSnapshot: nextSnapshot,
        totalCost,
        updatedAt: now,
      });

      // 打脏（P3b 在打脏路径清单内，DM §5.6 六）。
      await markDirty();
    },
  );
}

// ============================ P3c：删除成衣（整组回补） ============================

export async function deleteGarmentWithRestore(args: {
  id: NanoId12;
}): Promise<void> {
  // S3-FIX-A（用户决策，优先于 DM §5.2 P3c「按活跃行整组回补」/架构 §13.3
  // 的同口径 DoD 条目）：只回补 deducted === true 的快照行——planning 成衣的
  // 活跃行 deducted=false（从未扣过库存），删除时零库存操作、零 revert 流水。
  // 其余级联不变。因 materialService.revertOnDeleteGarment（§6.3 单一实现）
  // 无法表达 deducted 过滤、且本任务约束不改 materialService.ts，此处按其
  // 伪代码在本模块内平移实现（步骤与事务表逐字一致，仅回补条件收紧）。
  //
  // 事务表：[materials, garments, usageLogs, images, tasks, settings]，
  // 全部步骤同一事务，任一步失败整体回滚：
  //   ① 活跃且 deducted=true 的快照行逐行 revert 回补（悬挂引用豁免跳过）；
  //      planning 的活跃行（deducted=false）与历史行一律不回补；
  //   ② 删本成衣全部 images 行（[entityType+entityId] 命中）；
  //   ③ 解绑任务（garmentId / garmentName 一起置 ''，不级联删任务）；
  //   ④ 删成衣行（materialSnapshot 的活跃行与历史行随之整组消失——本工程
  //      快照内嵌于 garments.materialSnapshot，schema 无独立 garmentMaterials
  //      表，DM §1.2 冻结）；
  //   ⑤ 打脏。
  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.images, db.tasks, db.settings],
    async () => {
      const g = await db.garments.get(args.id);
      if (!g) throw new Error('成衣不存在');

      // ① 只回补「活跃且确实扣过库存」的行（§3.2 HC3 判据 + S3-FIX-A
      //    deducted 过滤）。物料若已被先删（悬挂引用）→ 跳过，不抛错
      //    （§5.4 P3c 豁免）。
      const restorable = g.materialSnapshot.filter(
        (r) => !('retiredAt' in r) && r.deducted === true,
      );
      for (const row of restorable) {
        const exists = await db.materials.get(row.materialId);
        if (!exists) continue;
        await applyStockDelta(row.materialId, {
          kind: 'revert',
          quantity: row.quantityUsed,
          source: `garment:${args.id}`,
          garmentId: args.id,
          note: `${g.name} 删除还原`,
        });
      }

      // ② 删成衣的图（§2.5 / §3.6 HC6）。
      const imgIds = (
        await db.images
          .where('[entityType+entityId]')
          .equals(['garment', args.id])
          .toArray()
      ).map((r) => r.id);
      if (imgIds.length) await db.images.bulkDelete(imgIds);

      // ③ 解绑任务：garmentId / garmentName 一起置 ''（§5.5 P3c）。
      await db.tasks
        .where('garmentId')
        .equals(args.id)
        .modify({ garmentId: '', garmentName: '' });

      // ④ 删成衣行（含全部历史快照行）。
      await db.garments.delete(args.id);

      // ⑤ 打脏。
      await markDirty();
    },
  );
}

// ============================ P11：完工登记（架构 §6.4 / DM §5.5 七） ============================

export async function markGarmentCompleted(args: {
  id: NanoId12;
  /** 完工日期 YYYY-MM-DD。缺省取当天（UTC 截取）——PRD §9.6 载荷不含
   *  completionDate，由写库方统一生成。 */
  completionDate?: string;
  /** 完工总成本（PRD §9.6 载荷）。非有限数字 / 负数 / 缺省一律归一为 0。 */
  totalCost?: number;
}): Promise<void> {
  // completionDate 一律 YYYY-MM-DD；缺省取今天（UTC 截取）。收到完整 ISO 串时
  // 取日期部分再写入，不得把完整 ISO 时刻原样落库（架构 §6.4 / §13.5）。
  let date = String(args.completionDate ?? '').trim();
  if (date === '') date = todayIsoDate();
  if (date.includes('T')) date = date.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) {
    throw new Error('完工日期格式必须为 YYYY-MM-DD');
  }
  // 日历真实性兜底（S5-A）：'2026-02-30' / '2026-13-01' 这类「格式合法但
  // 不存在」的日期同样拒绝——格式校验是服务层兜底，非法即拒。
  const [yy, mm, dd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const chk = new Date(Date.UTC(yy, mm - 1, dd));
  if (
    chk.getUTCFullYear() !== yy ||
    chk.getUTCMonth() !== mm - 1 ||
    chk.getUTCDate() !== dd
  ) {
    throw new Error('完工日期必须是真实存在的日期');
  }
  // totalCost 归一（PRD §9.6 前置校验 3）：非有限数字 / 负数 → 0（不报错）；
  // 正常值 round2 落库，读出来是 number，绝不是 null / undefined / 空串。
  const rawCost = args.totalCost;
  const totalCost =
    typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
      ? round2(rawCost)
      : 0;

  await db.transaction('rw', [db.garments, db.settings], async () => {
    const g = await db.garments.get(args.id);
    if (!g) throw new Error('成衣不存在');
    if (g.status === 'completed') return; // 幂等 no-op，不写库（DM §5.5 七）
    if (g.status !== 'in_progress') {
      throw new Error('计划中的成衣不能登记完工，请先开始制作');
    }
    // PRD §9.6：严格只写 status / completionDate / totalCost / updatedAt
    // 四字段——不扣库存、不写流水、不动 materialSnapshot / materialIds /
    // images / patternId / startDate。
    await db.garments.put({
      ...g,
      status: 'completed',
      completionDate: date,
      totalCost,
      updatedAt: nowIso(),
    });
    await markDirty(); // P11 在打脏路径清单内（DM §5.6 六）
  });
}

// ============================ S4-A：开始制作（planning → in_progress） ============================
//
// S3-FIX-A 注释预留的接入点落地（S4 工作台；任务文实现要求 4）。语义：
// 把「规划中」成衣转入「制作中」，并为其**从未扣过库存**的活跃快照行
// （deducted=false）补扣库存、写 consume 流水、快照行 deducted 翻 true。
//
// 事务表 [materials, garments, usageLogs, settings]，全部步骤同一事务，
// 任一步失败（如库存不足）整体回滚，成衣停留在 planning、零流水：
//   ① 读成衣（缺 → '成衣不存在'；completed → 拒绝；in_progress 且无待扣
//      行 → 幂等 no-op，不重复扣、不写库）；
//   ② 活跃（无 retiredAt）且 deducted !== true 的快照行 = 待扣清单；
//   ③ startQty 预检（§5.3 五：比较对象 = 事务开始时的 quantity；悬挂引用
//      ——物料已被删——豁免跳过，不抛错，§5.4 二.3 同款）；
//   ④ 逐行 applyStockDelta（consume / source=`garment:${id}` / note=
//      `${成衣名} 开始制作扣减`，note 模板为 S4 新增行，沿用既有命名式）；
//   ⑤ 实际扣到的行 deducted 翻 true（悬挂引用行保持 false——从未扣减，
//      删除成衣时也不会为其回补）；status planning → in_progress；
//   ⑥ 打脏（写 materials / garments / usageLogs 的路径，§5.6 六口径）。
//
// 与 P7b（任务状态联动改写成衣 status，DM §5.5）互不重叠：本函数是唯一
// 会跨过「扣减边界」（deducted false → true）的成衣状态入口；P7b 的
// 映射表与 S3-FIX-A 扣减语义的兼容裁定见《S4-A 实现说明》，属后续任务。

export async function startGarmentProduction(args: {
  id: NanoId12;
}): Promise<void> {
  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.settings],
    async () => {
      const g = await db.garments.get(args.id);
      if (!g) throw new Error('成衣不存在');
      if (g.status === 'completed') {
        throw new Error('已完工的成衣不能开始制作');
      }

      // ② 待扣清单：活跃且从未扣过库存的快照行。
      const pending = g.materialSnapshot.filter(
        (r) => !('retiredAt' in r) && r.deducted !== true,
      );
      // ① 幂等：已 in_progress 且没有待扣行 → no-op（不重复扣）。
      if (g.status === 'in_progress' && pending.length === 0) return;
      // （in_progress 但仍有 deducted=false 的活跃行属不一致态：只补扣这些
      //  行、不改 status，让重复调用具备自愈性且绝不双扣。）
      const now = nowIso();

      // ③ startQty 预检（悬挂引用豁免）。
      const mats = (
        await db.materials.bulkGet(pending.map((r) => r.materialId))
      ).filter((m): m is Material => m !== undefined);
      const matMap = new Map(mats.map((m) => [m.id, m]));
      for (const row of pending) {
        const mat = matMap.get(row.materialId);
        if (!mat) continue;
        if (row.quantityUsed > mat.quantity) {
          throw new Error(stockShortMsg(mat, row.quantityUsed));
        }
      }

      // ④ 逐行扣库存 + 写 consume 流水。
      const deductedIds = new Set<string>();
      for (const row of pending) {
        const mat = matMap.get(row.materialId);
        if (!mat) continue; // 悬挂引用：跳过扣减
        await applyStockDelta(row.materialId, {
          kind: 'consume',
          quantity: row.quantityUsed,
          source: `garment:${args.id}`,
          note: `${g.name} 开始制作扣减`,
          garmentId: args.id,
          rejectMessage: stockShortMsg(mat, row.quantityUsed),
        });
        deductedIds.add(row.materialId);
      }

      // ⑤ 快照行 deducted 翻 true（只翻实际扣到的行）；status 推进。
      const nextSnapshot = g.materialSnapshot.map((r) =>
        !('retiredAt' in r) && r.deducted !== true && deductedIds.has(r.materialId)
          ? { ...r, deducted: true }
          : r,
      );
      await db.garments.put({
        ...g,
        status: g.status === 'planning' ? 'in_progress' : g.status,
        materialSnapshot: nextSnapshot,
        materialIds: recalcMaterialIds(nextSnapshot),
        updatedAt: now,
      });

      // ⑥ 打脏。
      await markDirty();
    },
  );
}

// ============================ 解除关联（架构 §6.4） ============================

export async function unassociateGarmentMaterials(args: {
  id: NanoId12;
  selections: MaterialSelection[];
}): Promise<void> {
  // 语义裁定：架构 §6.4 注释「不动库存，只清 materialIds 与快照」与数据模型
  // 的库存恒等式（DM §5.6 二：每条非 legacy 流水对应一次真实数量变化）冲突
  // ——清快照不回补会留下永久悬空的 consume，正是 DM §5.5 九点名不复刻的
  // demo 缺陷。数据模型是口径权威（架构 §0 自认），故按 P3b 移除集实现：
  // 命中 selections 的活跃行退休 + 回补库存 + 写 revert 流水 + 重算派生字段。
  const ids = new Set<NanoId12>();
  for (const s of args.selections ?? []) {
    if (!s) continue;
    if (typeof s.materialId === 'string' && s.materialId !== '') {
      ids.add(s.materialId);
    }
  }

  await db.transaction(
    'rw',
    [db.materials, db.garments, db.usageLogs, db.settings],
    async () => {
      const g = await db.garments.get(args.id);
      if (!g) throw new Error('成衣不存在');
      const now = nowIso();

      const hit = g.materialSnapshot.filter(
        (r) => !('retiredAt' in r) && ids.has(r.materialId),
      );
      for (const row of hit) {
        // 只回补确实扣过库存的行（S3-FIX-A：planning 的活跃行 deducted=false，
        // 从未扣减，回补会虚增库存，跳过）。悬挂引用豁免：物料已删则只退休
        // 不回补（§5.4 二.3 同款）。
        if (row.deducted !== true) continue;
        if (!(await db.materials.get(row.materialId))) continue;
        await applyStockDelta(row.materialId, {
          kind: 'revert',
          quantity: row.quantityUsed,
          source: `garment:${args.id}`,
          note: `${g.name} 编辑回补`,
          garmentId: args.id,
        });
      }
      const nextSnapshot = g.materialSnapshot.map((r) =>
        hit.includes(r) ? { ...r, deducted: false, retiredAt: now } : r,
      );
      const patternPrice = await resolvePatternPrice(g.patternId);
      await db.garments.put({
        ...g,
        materialIds: recalcMaterialIds(nextSnapshot),
        materialSnapshot: nextSnapshot,
        totalCost: calcTotalCost(nextSnapshot, patternPrice),
        updatedAt: now,
      });
      await markDirty();
    },
  );
}
