// src/services/statsService.ts —— 统计派生只读查询（架构 §6.6 / DM §7 / PRD §8.15）
//
// 本模块全部是**派生只读查询**：不落任何缓存表、不写任何数据（架构 §6.6 冻结；
// PRD §8.15「不读任何缓存计数」）。统计页 / 首页的每个数字都能从流水明细与
// 基表行现算复现——聚合核心写成不接 db 的纯函数（DM §7 规则：聚合归纯函数），
// 查询函数负责取数后调用它们，便于对账与单测。
//
// 全模块口径锚点（细节见函数注释）：
//   - `source` 以 `legacy:` 开头的 usageLogs 不进任何汇总（DM §7.1 五 / H6 裁定）；
//   - 花费只在「购买当时」计入（purchasePrice × initialQuantity，DM §7.7 四 / 架构 §6.6）；
//   - 日期串区间（purchaseDate / completionDate）含首尾；时刻区间（usageLogs.createdAt）
//     左闭右开，端点一律 `new Date(dateOnly + 'T00:00:00.000Z')` 拼、to 端 +1 天（DM §7.10 二）；
//   - 浮点累加后 round2，空集返回 0 / [] / null，绝不返回 NaN / undefined（DM §7.1）。

import { db } from '@/db/schema';
import type {
  Garment,
  IsoDate,
  Material,
  MaterialType,
  UsageLog,
} from '@/db/types';
import { signedDelta } from '@/lib/signedDelta';
import { todayIsoDate } from '@/lib/date';

// ============================ 模块内辅助 ============================

/** 两位小数舍入（DM §5.2；与 materialService / garmentService 同式）。 */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** 浮点比较阈值（DM §7.1 三）。 */
export const EPS = 0.001;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 四类物料的中文名（采购占比图例用，顺序 = PRD §8.15 色序）。 */
const TYPE_NAMES: Record<MaterialType, string> = {
  fabric: '面料',
  accessory: '辅料',
  tool: '工具',
  pattern: '纸样',
};

/** 校验日期串区间：两侧必须 YYYY-MM-DD 且 from ≤ to（含首尾），否则中文报错。 */
function assertDateRange(from: string, to: string): void {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error('统计区间日期必须为 YYYY-MM-DD 格式');
  }
  if (from > to) {
    throw new Error('统计区间起点不能晚于终点');
  }
}

/** 日期串 → 当天 UTC 零点的完整时刻串（DM §7.10 二：端点一律 UTC 零点拼）。 */
function dayStartIso(dateOnly: IsoDate): string {
  return new Date(dateOnly + 'T00:00:00.000Z').toISOString();
}

/** 日期串 → [年, 月, 日] 数值（noUncheckedIndexedAccess 安全写法）。 */
function splitYmd(dateOnly: IsoDate): [number, number, number] {
  const parts = dateOnly.split('-');
  return [
    Number(parts[0] ?? '0'),
    Number(parts[1] ?? '1'),
    Number(parts[2] ?? '1'),
  ];
}

/** 日期串整日偏移（跨月跨年安全）。 */
function addDaysIso(dateOnly: IsoDate, n: number): IsoDate {
  const [y, m, d] = splitYmd(dateOnly);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** legacy 流水判定（DM §7.1 五 / H6：legacy 一律排除出统计）。 */
const isLegacy = (l: UsageLog): boolean => l.source.startsWith('legacy:');

// ============================ 聚合核心（纯函数，可对账） ============================

/** 入布（PRD §8.15）：fabric 且 purchaseDate ∈ [from, to]（含首尾）的 Σ initialQuantity。
 *  历史导入包缺 initialQuantity 键时按 quantity 反推（DM §9.5）。 */
export function sumFabricInbound(
  materials: Material[],
  from: IsoDate,
  to: IsoDate,
): number {
  let sum = 0;
  for (const m of materials) {
    if (m.type !== 'fabric') continue;
    if (m.purchaseDate < from || m.purchaseDate > to) continue;
    const base =
      typeof m.initialQuantity === 'number' ? m.initialQuantity : m.quantity;
    sum += base;
  }
  return round2(sum);
}

/** 消耗 · 完工快照轴（PRD §8.15 消耗①）：completed 且 completionDate ∈ [from, to] 的
 *  成衣，其**活跃**快照行（无 retiredAt）中指向当前 fabric 物料的 Σ quantityUsed。
 *  悬挂引用（物料已删、type 不可知）不计入。 */
export function sumSnapshotFabricUsed(
  garments: Garment[],
  fabricIds: Set<string>,
  from: IsoDate,
  to: IsoDate,
): number {
  let sum = 0;
  for (const g of garments) {
    if (g.status !== 'completed' || g.completionDate === '') continue;
    if (g.completionDate < from || g.completionDate > to) continue;
    for (const r of g.materialSnapshot) {
      if ('retiredAt' in r) continue;
      if (fabricIds.has(r.materialId)) sum += r.quantityUsed;
    }
  }
  return round2(sum);
}

/** 消耗 · 流水轴（PRD §8.15 消耗② / DM §7.10 三）：kind=consume、指向 fabric、
 *  非 legacy、createdAt ∈ [fromIso, toIso)（左闭右开）的 Σ quantity。 */
export function sumConsumeLogs(
  logs: UsageLog[],
  fabricIds: Set<string>,
  fromIso: string,
  toIso: string,
): number {
  let sum = 0;
  for (const l of logs) {
    if (l.kind !== 'consume') continue;
    if (isLegacy(l)) continue;
    if (!fabricIds.has(l.materialId)) continue;
    if (l.createdAt < fromIso || l.createdAt >= toIso) continue;
    sum += l.quantity;
  }
  return round2(sum);
}

/** 热力图格子着色的连续插值公式（PRD §8.15）：`0.15 + (count / max(maxCount,1)) × 0.85`。
 *  **没有四档分位阈值**——图例四档只是示意色阶，格子深浅由本式线性决定；
 *  分母取 1 与区间最大数量的较大者，全 0 时不出除零。 */
export function heatmapAlpha(count: number, maxCount: number): number {
  return 0.15 + (count / Math.max(maxCount, 1)) * 0.85;
}

/** 囤布指数柱高分母（PRD §8.15）：全区间最大绝对净值，下界 0.1，避免全 0 除零。 */
export function stockpileMaxAbs(deltas: number[]): number {
  let max = 0.1;
  for (const d of deltas) {
    const abs = Math.abs(d);
    if (abs > max) max = abs;
  }
  return max;
}

/** 单个物料的采购花费（购买当时口径）：purchasePrice 有值才有花费，
 *  金额 = purchasePrice × initialQuantity（数量按开账量，缺键按 quantity 反推）。 */
function materialSpend(m: Material): number {
  if (m.purchasePrice == null) return 0;
  const base =
    typeof m.initialQuantity === 'number' ? m.initialQuantity : m.quantity;
  return m.purchasePrice * base;
}

// ============================ 导出类型 ============================

/** 统计周期键（PRD §8.15 三张时间卡）。 */
export type PeriodKey = 'month' | 'year' | 'all';

/** 采购占比单类条目（value 为 0 的类别是否展示由 UI 决定，服务层全量返回）。 */
export interface CategorySpend {
  type: MaterialType;
  name: string;
  value: number;
}

/** 统计页主对象（架构 §6.6 getStatsForPeriod）。 */
export interface StatsForPeriod {
  from: IsoDate;
  to: IsoDate;
  /** 完工数：completed 且 completionDate 落区间（PRD §8.15）。 */
  completedCount: number;
  /** 区间内完工成衣（completionDate 降序，同日按 createdAt 降序）。 */
  completedGarments: Garment[];
  /** 参与核算的完工数：completed 且 totalCost != null 且落区间（DM §7.7 H17）。 */
  costCount: number;
  /** 区间内完工成衣的 totalCost 之和（null 按 0 贡献，仅此处合法）。 */
  totalCost: number;
  /** 平均单件成本：totalCost / costCount；costCount === 0 时为 null（UI 显示「—」）。 */
  avgCost: number | null;
  /** 入布（PRD §8.15）。 */
  fabricInbound: number;
  /** 消耗（完工快照轴 + consume 流水轴，legacy 排除）。 */
  fabricConsumed: number;
  /** 净囤布 = 入布 − 消耗（唯一口径，正数净囤 / 负数净消耗）。 */
  netFabric: number;
  /** 四类采购花费（面料/辅料/工具/纸样，PRD §8.15 色序）。 */
  purchaseByCategory: CategorySpend[];
  purchaseTotal: number;
}

/** 各品类当前库存汇总（DM §7.4：总量必须按单位分组，不许跨单位相加）。 */
export interface CategoryStockSnapshot {
  type: MaterialType;
  /** 该品类物料行数（「多少种」）。 */
  count: number;
  /** 按单位分组的当前库存 Σ quantity。 */
  totalByUnit: Record<string, number>;
  /** 低库存行数（DM §7.4 三：threshold > 0 且 quantity ≤ threshold）。 */
  lowStockCount: number;
}

/** 面料花费按日/周聚合（架构 §6.6）。 */
export interface FabricPurchaseAggregation {
  from: IsoDate;
  to: IsoDate;
  days: number;
  /** 逐日桶：覆盖区间内每一天（无采购的日子为 0），日期升序。 */
  daily: { date: IsoDate; total: number }[];
  /** 周桶：自 from 起每 7 天一桶（末桶可能不足 7 天），按桶首日升序。 */
  weekly: { weekStart: IsoDate; total: number }[];
  total: number;
}

/** 热力图格子。key：month=YYYY-MM-DD / year=YYYY-MM / all=YYYY。 */
export interface HeatmapCell {
  key: string;
  label: string;
  subLabel: string;
  count: number;
  /** 未来格（PRD §8.15：不着力、不可点）。 */
  isFuture: boolean;
}

/** 完工热力图（PRD §8.15）。 */
export interface CompletionHeatmap {
  mode: PeriodKey;
  layout: 'calendar' | 'row';
  /** 扁平格子序列：month=当月每日（1 日起顺序）/ year=12 个月 / all=年份区间。 */
  cells: HeatmapCell[];
  /** 仅 month：日历周排布，前置空位与末行补空位均为 null。其余模式为 []。 */
  weeks: (HeatmapCell | null)[][];
  /** 仅 month：星期表头（「日」起）。其余模式为 []。 */
  dayLabels: string[];
  /** 连续插值分母（恒 ≥ 1，PRD §8.15 除零下界）。 */
  maxCount: number;
  /** 数据覆盖区间（含首尾）。 */
  from: IsoDate;
  to: IsoDate;
}

/** 囤布指数单格（PRD §8.15）。 */
export interface StockpileCell {
  key: string;
  label: string;
  /** 该格入布。 */
  inbound: number;
  /** 该格消耗（快照轴 + 流水轴，legacy 排除）。 */
  consumed: number;
  /** 净值 = inbound − consumed（正净囤 / 负净消耗）。 */
  delta: number;
}

/** 囤布指数（PRD §8.15）。 */
export interface StockpileIndex {
  period: PeriodKey;
  /** 横轴粒度与热力图一致：month 逐日 / year 逐月 / all 逐年。 */
  cells: StockpileCell[];
  /** 全区间汇总（点评句数据源）。 */
  summary: { inbound: number; consumed: number; delta: number };
  /** 柱高分母 = max(全区间 |delta|, 0.1)（PRD §8.15 除零下界）。 */
  maxAbs: number;
}

// ============================ 查询函数（架构 §6.6） ============================

/** 首页总览卡数字（PRD §8.1）：成衣数量 = completed 行数（非全表）；
 *  库存布料 = fabric 的 Σ quantity（PRD 明示首页单位恒 m）。
 *  按单位分组的严谨口径由 getCurrentStockSnapshot 承担（DM §7.4）。 */
export async function getHomeStats(): Promise<{
  completedCount: number;
  fabricTotal: number;
}> {
  const completedCount = await db.garments
    .where('status')
    .equals('completed')
    .count();
  const fabrics = await db.materials.where('type').equals('fabric').toArray();
  const fabricTotal = round2(
    fabrics.reduce((s, m) => s + m.quantity, 0),
  );
  return { completedCount, fabricTotal };
}

/** 三张时间卡的区间（PRD §8.15）：本月 = 当月 1 日 → 今天；本年 = 当年 1/1 → 今天；
 *  汇总 = 不限起点（以 '0000-01-01' 下界表达「覆盖全部历史」）→ 今天。
 *  「今天」一律 UTC 截取（todayIsoDate，全应用唯一实现）。 */
export function getPeriodRange(period: PeriodKey): {
  from: IsoDate;
  to: IsoDate;
  label: string;
} {
  const to = todayIsoDate();
  if (period === 'month') return { from: `${to.slice(0, 7)}-01`, to, label: '本月' };
  if (period === 'year') return { from: `${to.slice(0, 4)}-01-01`, to, label: '本年' };
  if (period === 'all') return { from: '0000-01-01', to, label: '汇总' };
  throw new Error('统计周期只能是 month / year / all');
}

/** 统计页主对象（架构 §6.6 / PRD §8.15「数据来源与派生」表全部口径）。 */
export async function getStatsForPeriod(
  from: IsoDate,
  to: IsoDate,
): Promise<StatsForPeriod> {
  assertDateRange(from, to);

  const completedGarments = await listCompletedGarmentsInRange(from, to);
  const materials = await db.materials.toArray();

  // 完工快照消耗轴 + consume 流水消耗轴（PRD §8.15 消耗①②）。
  const fabricIds = new Set(
    materials.filter((m) => m.type === 'fabric').map((m) => m.id),
  );
  const snapshotUsed = sumSnapshotFabricUsed(completedGarments, fabricIds, from, to);
  const logs = await db.usageLogs
    .where('createdAt')
    .between(dayStartIso(from), dayStartIso(addDaysIso(to, 1)), true, false)
    .toArray();
  const logUsed = sumConsumeLogs(
    logs,
    fabricIds,
    dayStartIso(from),
    dayStartIso(addDaysIso(to, 1)),
  );

  // 平均单件成本：分母 = 参与核算的完工数（DM §7.7 H17，totalCost == null 不进分母）。
  const costed = completedGarments.filter((g) => g.totalCost != null);
  const totalCost = round2(
    costed.reduce((s, g) => s + (g.totalCost as number), 0),
  );
  const avgCost = costed.length === 0 ? null : round2(totalCost / costed.length);

  // 采购花费：四类统一「purchasePrice 有值且 purchaseDate 落区间」的
  // purchasePrice × initialQuantity（见模块头口径 4：DM M15「purchasePrice 是唯一
  // 采购价来源」，纸样不再走 demo 已丢弃的 patternPurchasePrice 近似）。
  const purchaseByCategory: CategorySpend[] = (
    ['fabric', 'accessory', 'tool', 'pattern'] as MaterialType[]
  ).map((type) => ({
    type,
    name: TYPE_NAMES[type],
    value: round2(
      materials
        .filter(
          (m) =>
            m.type === type &&
            m.purchasePrice != null &&
            m.purchaseDate >= from &&
            m.purchaseDate <= to,
        )
        .reduce((s, m) => s + materialSpend(m), 0),
    ),
  }));
  const purchaseTotal = round2(
    purchaseByCategory.reduce((s, c) => s + c.value, 0),
  );

  const fabricInbound = sumFabricInbound(materials, from, to);
  const fabricConsumed = round2(snapshotUsed + logUsed);
  return {
    from,
    to,
    completedCount: completedGarments.length,
    completedGarments,
    costCount: costed.length,
    totalCost,
    avgCost,
    fabricInbound,
    fabricConsumed,
    netFabric: round2(fabricInbound - fabricConsumed),
    purchaseByCategory,
    purchaseTotal,
  };
}

/** 各品类当前库存汇总（架构 §6.6 / DM §7.4）。返回按固定顺序的四类，
 *  即使某类行数为 0。 */
export async function getCurrentStockSnapshot(): Promise<
  CategoryStockSnapshot[]
> {
  const materials = await db.materials.toArray();
  return (['fabric', 'accessory', 'tool', 'pattern'] as MaterialType[]).map(
    (type) => {
      const rows = materials.filter((m) => m.type === type);
      const totalByUnit = rows.reduce<Record<string, number>>((acc, m) => {
        acc[m.unit] = round2((acc[m.unit] ?? 0) + m.quantity);
        return acc;
      }, {});
      const lowStockCount = rows.filter(
        (m) => m.lowStockThreshold > 0 && m.quantity <= m.lowStockThreshold,
      ).length;
      return { type, count: rows.length, totalByUnit, lowStockCount };
    },
  );
}

/** 面料花费按日/周聚合（架构 §6.6）：最近 days 天（含今天），逐日桶覆盖每一天、
 *  周桶自 from 起每 7 天一桶。花费 = 购买当时的 purchasePrice × initialQuantity。 */
export async function aggregateFabricPurchases(
  days: number,
): Promise<FabricPurchaseAggregation> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('聚合天数必须是正整数');
  }
  const to = todayIsoDate();
  const from = addDaysIso(to, -(days - 1));
  const fabrics = (
    await db.materials.where('type').equals('fabric').toArray()
  ).filter(
    (m) => m.purchasePrice != null && m.purchaseDate >= from && m.purchaseDate <= to,
  );

  const byDay = new Map<IsoDate, number>();
  let total = 0;
  for (const m of fabrics) {
    const spend = materialSpend(m);
    byDay.set(m.purchaseDate, round2((byDay.get(m.purchaseDate) ?? 0) + spend));
    total += spend;
  }

  const daily: { date: IsoDate; total: number }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(from, i);
    daily.push({ date, total: byDay.get(date) ?? 0 });
  }

  const weekly: { weekStart: IsoDate; total: number }[] = [];
  for (let start = 0; start < days; start += 7) {
    const weekStart = addDaysIso(from, start);
    const end = Math.min(start + 7, days);
    const weekTotal = round2(
      daily.slice(start, end).reduce((s, d) => s + d.total, 0),
    );
    weekly.push({ weekStart, total: weekTotal });
  }

  return { from, to, days, daily, weekly, total: round2(total) };
}

/** 分类花费占比（架构 §6.6）：最近 days 天（含今天）四类采购花费。
 *  items 恒为四类全量（含 0 值），「金额为 0 的类别不进图例」由 UI 过滤（PRD §8.15）。 */
export async function getPurchaseByCategory(days: number): Promise<{
  from: IsoDate;
  to: IsoDate;
  total: number;
  items: CategorySpend[];
}> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('统计天数必须是正整数');
  }
  const to = todayIsoDate();
  const from = addDaysIso(to, -(days - 1));
  const stats = await getStatsForPeriod(from, to);
  return { from, to, total: stats.purchaseTotal, items: stats.purchaseByCategory };
}

/** 面料净消耗 Top N（架构 §6.6）：净消耗 = −净用量（signedDelta 口径，
 *  DM §5.6 / §7.5——consume 计消耗、refill/revert 计回补、adjust 带符号），
 *  非 legacy、createdAt 落最近 days 天（左闭右开）。只取净消耗 > EPS 的物料，
 *  降序排列，平局按 materialId 字典序（结果确定性）；名称取当前 materials.name
 *  （DM §7.10 四：聚合统计显示当前名）。空集返回 []。 */
export async function getNetConsumptionTopFabric(
  days: number,
  limit = 5,
): Promise<{ materialId: string; name: string; netConsumed: number }[]> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('统计天数必须是正整数');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Top N 数量必须是正整数');
  }
  const to = todayIsoDate();
  const from = addDaysIso(to, -(days - 1));
  const fromIso = dayStartIso(from);
  const toIso = dayStartIso(addDaysIso(to, 1));

  const materials = await db.materials.where('type').equals('fabric').toArray();
  const fabricIds = new Set(materials.map((m) => m.id));
  const nameOf = new Map(materials.map((m) => [m.id, m.name]));
  const logs = await db.usageLogs
    .where('createdAt')
    .between(fromIso, toIso, true, false)
    .toArray();

  const acc = new Map<string, number>();
  for (const l of logs) {
    if (isLegacy(l)) continue;
    if (!fabricIds.has(l.materialId)) continue;
    // netUsed = Σ signedDelta（对库存的贡献，消耗为负）；净消耗 = −netUsed。
    acc.set(
      l.materialId,
      round2((acc.get(l.materialId) ?? 0) - signedDelta(l.kind, l.quantity)),
    );
  }

  return [...acc.entries()]
    .filter(([, v]) => v > EPS)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([materialId, netConsumed]) => ({
      materialId,
      name: nameOf.get(materialId) ?? '',
      netConsumed,
    }));
}

/** 未记价格条目数（架构 §6.6）：materials 中 purchasePrice == null 的行数
 *  （宽松不等，同时排除 null 与 undefined；purchasePrice 无索引，内存过滤）。 */
export async function countMissingPrice(): Promise<number> {
  const materials = await db.materials.toArray();
  return materials.filter((m) => m.purchasePrice == null).length;
}

/** 期间完工成衣列表（架构 §6.6 / PRD §8.15 完工明细）：
 *  completed 且 completionDate ∈ [from, to]（含首尾），completionDate 降序、
 *  同日按 createdAt 降序（新的在前）。 */
export async function listCompletedGarmentsInRange(
  from: IsoDate,
  to: IsoDate,
): Promise<Garment[]> {
  assertDateRange(from, to);
  const rows = await db.garments
    .where('completionDate')
    .between(from, to, true, true)
    .toArray();
  return rows
    .filter((g) => g.status === 'completed' && g.completionDate !== '')
    .sort((a, b) => {
      if (a.completionDate !== b.completionDate) {
        return a.completionDate < b.completionDate ? 1 : -1;
      }
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

// ============================ 热力图与囤布指数（PRD §8.15） ============================

/** 完工热力图（PRD §8.15）：本月逐日（日历周排布）/ 本年逐月（单行 12 格）/
 *  汇总逐年（最早不早于 2024）。未来格标 isFuture；maxCount 恒 ≥ 1；
 *  格子着色用 heatmapAlpha 连续插值，无四档分位阈值。 */
export async function getCompletionHeatmap(
  period: PeriodKey,
): Promise<CompletionHeatmap> {
  const today = todayIsoDate();

  if (period === 'month') {
    const [y, m] = splitYmd(today);
    const first = `${today.slice(0, 7)}-01`;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const last = addDaysIso(first, daysInMonth - 1);
    const rows = await db.garments
      .where('completionDate')
      .between(first, last, true, true)
      .toArray();
    const countOf = new Map<string, number>();
    for (const g of rows) {
      if (g.status !== 'completed' || g.completionDate === '') continue;
      countOf.set(g.completionDate, (countOf.get(g.completionDate) ?? 0) + 1);
    }
    const cells: HeatmapCell[] = [];
    let maxCount = 0;
    for (let i = 1; i <= daysInMonth; i++) {
      const key = `${today.slice(0, 7)}-${String(i).padStart(2, '0')}`;
      const count = countOf.get(key) ?? 0;
      if (count > maxCount) maxCount = count;
      cells.push({
        key,
        label: `${i}日`,
        subLabel: '',
        count,
        isFuture: key > today,
      });
    }
    // 日历周排布：首行按当月 1 日是星期几补空位（周日为一周之首，demo 同款）。
    const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const weeks: (HeatmapCell | null)[][] = [];
    let week: (HeatmapCell | null)[] = new Array(firstWeekday).fill(null);
    for (const c of cells) {
      week.push(c);
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }
    return {
      mode: 'month',
      layout: 'calendar',
      cells,
      weeks,
      dayLabels: ['日', '一', '二', '三', '四', '五', '六'],
      maxCount: Math.max(maxCount, 1),
      from: first,
      to: last,
    };
  }

  if (period === 'year') {
    const y = today.slice(0, 4);
    const rows = await db.garments
      .where('completionDate')
      .between(`${y}-01-01`, `${y}-12-31`, true, true)
      .toArray();
    const countOf = new Map<string, number>();
    for (const g of rows) {
      if (g.status !== 'completed' || g.completionDate === '') continue;
      const key = g.completionDate.slice(0, 7);
      countOf.set(key, (countOf.get(key) ?? 0) + 1);
    }
    const cells: HeatmapCell[] = [];
    let maxCount = 0;
    for (let i = 1; i <= 12; i++) {
      const key = `${y}-${String(i).padStart(2, '0')}`;
      const count = countOf.get(key) ?? 0;
      if (count > maxCount) maxCount = count;
      cells.push({
        key,
        label: `${i}月`,
        subLabel: '',
        count,
        isFuture: key > today.slice(0, 7),
      });
    }
    return {
      mode: 'year',
      layout: 'row',
      cells,
      weeks: [],
      dayLabels: [],
      maxCount: Math.max(maxCount, 1),
      from: `${y}-01-01`,
      to: `${y}-12-31`,
    };
  }

  if (period === 'all') {
    // 汇总：每年一格；年份范围 = min(数据年 ∪ {2024}) → max(数据年 ∪ {今年})。
    const rows = await db.garments
      .where('status')
      .equals('completed')
      .toArray();
    const countOf = new Map<string, number>();
    for (const g of rows) {
      if (g.completionDate === '') continue;
      const key = g.completionDate.slice(0, 4);
      countOf.set(key, (countOf.get(key) ?? 0) + 1);
    }
    const thisYear = Number(today.slice(0, 4));
    const dataYears = [...countOf.keys()].map(Number);
    const minYear = Math.min(2024, ...(dataYears.length ? dataYears : [thisYear]));
    const maxYear = Math.max(thisYear, ...(dataYears.length ? dataYears : [thisYear]));
    const cells: HeatmapCell[] = [];
    let maxCount = 0;
    for (let yy = minYear; yy <= maxYear; yy++) {
      const key = String(yy);
      const count = countOf.get(key) ?? 0;
      if (count > maxCount) maxCount = count;
      cells.push({
        key,
        label: key,
        subLabel: '年',
        count,
        isFuture: yy > thisYear,
      });
    }
    return {
      mode: 'all',
      layout: 'row',
      cells,
      weeks: [],
      dayLabels: [],
      maxCount: Math.max(maxCount, 1),
      from: `${minYear}-01-01`,
      to: `${maxYear}-12-31`,
    };
  }

  throw new Error('统计周期只能是 month / year / all');
}

/** 囤布指数（PRD §8.15）：横轴粒度与热力图一致（本月逐日 / 本年逐月 / 汇总逐年）。
 *  每格 inbound = 该格入布；consumed = 该格完工快照消耗 + 该格面料 consume 流水
 *  （legacy 排除）；delta = inbound − consumed。汇总 = 全区间求和；
 *  maxAbs 下界 0.1（stockpileMaxAbs）。 */
export async function getStockpileIndex(
  period: PeriodKey,
): Promise<StockpileIndex> {
  const today = todayIsoDate();
  const materials = await db.materials.toArray();
  const fabricIds = new Set(
    materials.filter((m) => m.type === 'fabric').map((m) => m.id),
  );

  /** 一个日期串格子的入布 / 快照消耗 / 流水消耗。 */
  const inboundOf = (from: IsoDate, to: IsoDate): number =>
    sumFabricInbound(materials, from, to);

  const build = async (
    keys: { key: string; label: string; from: IsoDate; to: IsoDate }[],
  ): Promise<StockpileIndex> => {
    const overallFrom = keys[0]?.from ?? today;
    const overallTo = keys[keys.length - 1]?.to ?? today;
    const garments = (
      await db.garments
        .where('completionDate')
        .between(overallFrom, overallTo, true, true)
        .toArray()
    ).filter((g) => g.status === 'completed' && g.completionDate !== '');
    const logs = await db.usageLogs
      .where('createdAt')
      .between(
        dayStartIso(overallFrom),
        dayStartIso(addDaysIso(overallTo, 1)),
        true,
        false,
      )
      .toArray();

    const cells: StockpileCell[] = keys.map((k) => {
      const inbound = inboundOf(k.from, k.to);
      const snap = sumSnapshotFabricUsed(garments, fabricIds, k.from, k.to);
      const log = sumConsumeLogs(
        logs,
        fabricIds,
        dayStartIso(k.from),
        dayStartIso(addDaysIso(k.to, 1)),
      );
      const consumed = round2(snap + log);
      return {
        key: k.key,
        label: k.label,
        inbound,
        consumed,
        delta: round2(inbound - consumed),
      };
    });

    const inbound = round2(cells.reduce((s, c) => s + c.inbound, 0));
    const consumed = round2(cells.reduce((s, c) => s + c.consumed, 0));
    return {
      period,
      cells,
      summary: {
        inbound,
        consumed,
        delta: round2(inbound - consumed),
      },
      maxAbs: stockpileMaxAbs(cells.map((c) => c.delta)),
    };
  };

  if (period === 'month') {
    const [y, m] = splitYmd(today);
    const first = `${today.slice(0, 7)}-01`;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const keys = Array.from({ length: daysInMonth }, (_, i) => {
      const date = addDaysIso(first, i);
      return { key: date, label: `${i + 1}日`, from: date, to: date };
    });
    return build(keys);
  }

  if (period === 'year') {
    const y = today.slice(0, 4);
    const keys = Array.from({ length: 12 }, (_, i) => {
      const mm = String(i + 1).padStart(2, '0');
      const from = `${y}-${mm}-01`;
      const to = addDaysIso(
        i === 11 ? `${Number(y) + 1}-01-01` : `${y}-${String(i + 2).padStart(2, '0')}-01`,
        -1,
      );
      return { key: `${y}-${mm}`, label: `${i + 1}月`, from, to };
    });
    return build(keys);
  }

  if (period === 'all') {
    // 年份范围与热力图汇总同式：min(数据年 ∪ {2024}) → max(数据年 ∪ {今年})。
    const completedAll = await db.garments
      .where('status')
      .equals('completed')
      .toArray();
    const yearSet = new Set<string>(
      completedAll
        .filter((g) => g.completionDate !== '')
        .map((g) => g.completionDate.slice(0, 4)),
    );
    for (const m of materials) yearSet.add(m.purchaseDate.slice(0, 4));
    const thisYear = today.slice(0, 4);
    yearSet.add(thisYear);
    yearSet.add('2024');
    const years = [...yearSet].sort();
    const maxYear = years[years.length - 1] ?? thisYear;
    // '2024' 恒在集合内，排序后首元素 <= '2024'——即「最早不早于 2024 年」。
    const minYear = years[0] ?? '2024';
    const keys: { key: string; label: string; from: IsoDate; to: IsoDate }[] = [];
    for (let yy = Number(minYear); yy <= Number(maxYear); yy++) {
      keys.push({
        key: String(yy),
        label: `${yy}年`,
        from: `${yy}-01-01`,
        to: `${yy}-12-31`,
      });
    }
    return build(keys);
  }

  throw new Error('统计周期只能是 month / year / all');
}
