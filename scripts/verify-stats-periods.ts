/** S5-C 跨期口径对账脚本（任务 5-4 / 5-5 自测门槛）。
 *
 *  对每一周期（汇总/本月/本年）从 statsService 取出关键数字，再用独立的查表函数
 *  （不调用 statsService）从 db 直接走一次原始流水（含 legacy:）并按 PRD §8.15 过滤
 *  口径现算。两路结果同源同窗口，结果应一致——这是「图表数字 vs 手工点数」的
 *  对账。
 *
 *  跑：tsx scripts/verify-stats-periods.ts
 *  退出：全等 0；不等 1。
 *
 *  与 S5-A 的 S5A-3 / S5A-5 的区别：本脚本额外按 period（而非任意 from/to）
 *  跑一遍，验证三周期边界一致；并把热力图 / 囤布指数的 summary 一并对账。
 */

import 'fake-indexeddb/auto';

import { db } from '@/db/schema';
import { seedIfFirstRun } from '@/db/seed';
import { todayIsoDate } from '@/lib/date';
import {
  getStatsForPeriod,
  getCompletionHeatmap,
  getStockpileIndex,
  getPeriodRange,
  type PeriodKey,
} from '@/services/statsService';
import type { Garment, Material, UsageLog } from '@/db/types';

const today = todayIsoDate();

async function manualCount(from: string, to: string): Promise<{
  completed: number;
  costed: number;
  totalCost: number;
  fabricInbound: number;
  fabricConsumed: number;
  purchaseByCategory: Record<string, number>;
}> {
  // 手工对账：从 db 直接拉数（不调 statsService）
  const garments = (await db.garments.toArray()).filter(
    (g: Garment) =>
      g.status === 'completed' &&
      g.completionDate !== '' &&
      g.completionDate >= from &&
      g.completionDate <= to,
  );

  const materials = await db.materials.toArray();
  const fabricIds = new Set(
    materials.filter((m: Material) => m.type === 'fabric').map((m) => m.id),
  );

  // 完工快照消耗
  let snap = 0;
  for (const g of garments) {
    for (const r of g.materialSnapshot) {
      if ('retiredAt' in r) continue;
      if (fabricIds.has(r.materialId)) snap += r.quantityUsed;
    }
  }

  // 流水消耗（左闭右开；同日补 +1 天）
  const fromIso = new Date(`${from}T00:00:00.000Z`).toISOString();
  const toDate = new Date(`${to}T00:00:00.000Z`);
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toIso = toDate.toISOString();

  const logs = (await db.usageLogs.toArray()).filter(
    (l: UsageLog) =>
      l.kind === 'consume' &&
      !l.source.startsWith('legacy:') &&
      fabricIds.has(l.materialId) &&
      l.createdAt >= fromIso &&
      l.createdAt < toIso,
  );
  const logConsumed = logs.reduce((s, l) => s + l.quantity, 0);

  // 入布
  const fabrics = materials.filter(
    (m: Material) =>
      m.type === 'fabric' && m.purchaseDate >= from && m.purchaseDate <= to,
  );
  const inbound = fabrics.reduce((s, m) => {
    const base =
      typeof m.initialQuantity === 'number' ? m.initialQuantity : m.quantity;
    return s + base;
  }, 0);

  // 采购占比
  const byType: Record<string, number> = {
    fabric: 0,
    accessory: 0,
    tool: 0,
    pattern: 0,
  };
  for (const m of materials) {
    if (
      m.purchasePrice == null ||
      m.purchaseDate < from ||
      m.purchaseDate > to
    )
      continue;
    const base =
      typeof m.initialQuantity === 'number' ? m.initialQuantity : m.quantity;
    byType[m.type] = (byType[m.type] ?? 0) + m.purchasePrice * base;
  }

  const costed = garments.filter((g) => g.totalCost != null);
  const totalCost = costed.reduce(
    (s, g) => s + (g.totalCost as number),
    0,
  );

  return {
    completed: garments.length,
    costed: costed.length,
    totalCost: Math.round(totalCost * 100) / 100,
    fabricInbound: Math.round(inbound * 100) / 100,
    fabricConsumed: Math.round((snap + logConsumed) * 100) / 100,
    purchaseByCategory: {
      fabric: Math.round((byType.fabric ?? 0) * 100) / 100,
      accessory: Math.round((byType.accessory ?? 0) * 100) / 100,
      tool: Math.round((byType.tool ?? 0) * 100) / 100,
      pattern: Math.round((byType.pattern ?? 0) * 100) / 100,
    },
  };
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

async function runOne(period: PeriodKey): Promise<boolean> {
  const range = getPeriodRange(period);
  const svc = await getStatsForPeriod(range.from, range.to);
  const manual = await manualCount(range.from, range.to);

  const lines: string[] = [];
  let localOk = true;

  const checks: { name: string; ok: boolean; a: number; b: number }[] = [
    { name: 'completedCount', ok: svc.completedCount === manual.completed, a: svc.completedCount, b: manual.completed },
    { name: 'costCount', ok: svc.costCount === manual.costed, a: svc.costCount, b: manual.costed },
    { name: 'totalCost', ok: near(svc.totalCost, manual.totalCost), a: svc.totalCost, b: manual.totalCost },
    { name: 'fabricInbound', ok: near(svc.fabricInbound, manual.fabricInbound), a: svc.fabricInbound, b: manual.fabricInbound },
    { name: 'fabricConsumed', ok: near(svc.fabricConsumed, manual.fabricConsumed), a: svc.fabricConsumed, b: manual.fabricConsumed },
  ];

  for (const c of checks) {
    if (!c.ok) localOk = false;
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}: svc=${c.a}  manual=${c.b}`);
  }
  for (const cat of ['fabric', 'accessory', 'tool', 'pattern'] as const) {
    const svcVal = svc.purchaseByCategory.find((c) => c.type === cat)?.value ?? 0;
    const manualVal = manual.purchaseByCategory[cat] ?? 0;
    const ok = near(svcVal, manualVal);
    if (!ok) localOk = false;
    lines.push(`  ${ok ? '✓' : '✗'} purchase.${cat}: svc=${svcVal}  manual=${manualVal}`);
  }

  // 热力图 + 囤布指数对账
  const heat = await getCompletionHeatmap(period);
  const heatSum = heat.cells.reduce((s, c) => s + c.count, 0);
  const heatOk = heatSum === svc.completedCount;
  if (!heatOk) localOk = false;
  lines.push(`  ${heatOk ? '✓' : '✗'} heatmap.Σcount=${heatSum} == stats.completedCount=${svc.completedCount}`);

  const stock = await getStockpileIndex(period);
  const stockInbound = stock.cells.reduce((s, c) => s + c.inbound, 0);
  const stockConsumed = stock.cells.reduce((s, c) => s + c.consumed, 0);
  const inbOk = near(stockInbound, svc.fabricInbound);
  const conOk = near(stockConsumed, svc.fabricConsumed);
  if (!inbOk || !conOk) localOk = false;
  lines.push(`  ${inbOk ? '✓' : '✗'} stockpile.Σinbound=${stockInbound} == stats.fabricInbound=${svc.fabricInbound}`);
  lines.push(`  ${conOk ? '✓' : '✗'} stockpile.Σconsumed=${stockConsumed} == stats.fabricConsumed=${svc.fabricConsumed}`);

  console.log(`[${period}] ${range.from} ~ ${range.to}`);
  for (const l of lines) console.log(l);
  return localOk;
}

async function ensureStatsFixtures(): Promise<void> {
  // 仅在测试 statsService 时灌入 fixtures；第一次跑过后再跑这脚本，
  // 物料/成衣/流水都已存在，无需重写。
  const has = await db.materials.where('id').equals('mat_fab_001').first();
  if (has) return;

  const NOW = '2026-09-24T08:00:00.000Z';
  const materials: Material[] = [
    {
      id: 'mat_fab_001', type: 'fabric', name: '浅蓝棉', category: '棉布',
      quantity: 4, initialQuantity: 5, unit: 'm',
      purchaseDate: '2026-09-05', purchasePrice: 32.5,
      color: '浅蓝', width: 145, weight: 200, composition: '100% 棉', sampleCard: '',
      season: 'all_season', suitableFor: ['衬衫', '半身裙'], forWhom: 'women',
      tags: ['棉布'], notes: '', brand: '优衣库', size: '', rating: 0,
      ratingReview: '', used: 0, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
    {
      id: 'mat_fab_002', type: 'fabric', name: '亚麻', category: '麻布',
      quantity: 6, initialQuantity: 8, unit: 'm',
      purchaseDate: '2026-01-10', purchasePrice: 60,
      color: '米色', width: 145, weight: 180, composition: '100% 麻', sampleCard: '',
      season: 'summer', suitableFor: ['上衣基础', '裤子'], forWhom: 'women',
      tags: ['麻布'], notes: '', brand: '无印良品', size: '', rating: 0,
      ratingReview: '', used: 0, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
    {
      id: 'mat_acc_001', type: 'accessory', name: '白色拉链', category: '拉链',
      quantity: 3, initialQuantity: 3, unit: '根',
      purchaseDate: '2026-09-12', purchasePrice: 4.5,
      color: '白', width: 1, weight: undefined, composition: '', sampleCard: '',
      season: 'all_season', suitableFor: [], forWhom: '',
      tags: ['拉链'], notes: '', brand: '其他', size: '', rating: 0,
      ratingReview: '', used: 0, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
    {
      id: 'mat_tool_001', type: 'tool', name: '剪刀', category: '剪刀',
      quantity: 1, initialQuantity: 1, unit: '把',
      purchaseDate: '2025-06-15', purchasePrice: 58,
      color: '', width: undefined, weight: undefined, composition: '', sampleCard: '',
      season: 'all_season', suitableFor: [], forWhom: '',
      tags: [], notes: '', brand: '其他', size: '', rating: 0,
      ratingReview: '', used: 0, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
    {
      id: 'mat_pat_001', type: 'pattern', name: '半身裙纸样', category: '半身裙',
      quantity: 1, initialQuantity: 1, unit: '张',
      purchaseDate: '2026-08-20', purchasePrice: 12,
      color: '', width: undefined, weight: undefined, composition: '', sampleCard: '',
      season: 'all_season', suitableFor: ['半身裙'], forWhom: 'women',
      tags: [], notes: '', brand: 'Burda', size: 'M', rating: 5,
      ratingReview: '', used: 1, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
    {
      id: 'mat_acc_002', type: 'accessory', name: '赠品纽扣', category: '扣子',
      quantity: 12, initialQuantity: 12, unit: '颗',
      purchaseDate: '2026-09-18', purchasePrice: undefined,
      color: '', width: 1, weight: undefined, composition: '', sampleCard: '',
      season: 'all_season', suitableFor: [], forWhom: '',
      tags: [], notes: '朋友送的，不入价', brand: '', size: '', rating: 0,
      ratingReview: '', used: 0, lowStockThreshold: 0, images: [],
      createdAt: NOW, updatedAt: NOW, sourceRef: undefined,
    },
  ];
  const garments: Garment[] = [
    {
      id: 'grt_001', name: '夏季棉布半裙', category: '半身裙',
      size: 'M', recipient: '自己', status: 'completed',
      materialIds: ['mat_fab_001', 'mat_acc_001'], patternId: 'mat_pat_001',
      materialSnapshot: [
        { materialId: 'mat_fab_001', name: '浅蓝棉', unit: 'm', priceSnapshot: 32.5,
          quantityUsed: 1.6, subtotal: 52, deducted: true },
        { materialId: 'mat_acc_001', name: '白色拉链', unit: '根', priceSnapshot: 4.5,
          quantityUsed: 1, subtotal: 4.5, deducted: true },
        { materialId: 'mat_pat_001', name: '半身裙纸样', unit: '张', priceSnapshot: 12,
          quantityUsed: 1, subtotal: 12, deducted: false },
      ],
      totalCost: 68.5, images: [], completionDate: '2026-09-10',
      startDate: '2026-09-01', plannedDate: '', forWhom: 'women',
      tags: ['半身裙', '棉布'], notes: '',
      createdAt: '2026-09-01T08:00:00.000Z', updatedAt: '2026-09-10T08:00:00.000Z',
      sourceRef: undefined,
    },
    {
      id: 'grt_002', name: '亚麻上衣', category: '上衣基础',
      size: 'S', recipient: '妈妈', status: 'completed',
      materialIds: ['mat_fab_002'], patternId: '',
      materialSnapshot: [
        { materialId: 'mat_fab_002', name: '亚麻', unit: 'm', priceSnapshot: 60,
          quantityUsed: 2, subtotal: 120, deducted: true },
      ],
      totalCost: null, images: [], completionDate: '2026-09-20',
      startDate: '2026-09-12', plannedDate: '', forWhom: 'women',
      tags: ['上衣'], notes: '',
      createdAt: '2026-09-12T08:00:00.000Z', updatedAt: '2026-09-20T08:00:00.000Z',
      sourceRef: undefined,
    },
    {
      id: 'grt_003', name: '去年的棉麻连衣裙', category: '连衣裙',
      size: 'M', recipient: '朋友', status: 'completed',
      materialIds: ['mat_fab_002'], patternId: '',
      materialSnapshot: [
        { materialId: 'mat_fab_002', name: '亚麻', unit: 'm', priceSnapshot: 60,
          quantityUsed: 0.5, subtotal: 30, deducted: true,
          retiredAt: '2025-08-15T08:00:00.000Z' },
      ],
      totalCost: 30, images: [], completionDate: '2025-08-30',
      startDate: '2025-08-01', plannedDate: '', forWhom: 'women',
      tags: [], notes: '',
      createdAt: '2025-08-01T08:00:00.000Z', updatedAt: '2025-08-30T08:00:00.000Z',
      sourceRef: undefined,
    },
  ];
  const usageLogs: UsageLog[] = [
    {
      id: 'log_001', materialId: 'mat_fab_001', materialName: '浅蓝棉', unit: 'm',
      quantity: 1.6, kind: 'consume', source: 'garment:grt_001',
      garmentId: 'grt_001', note: '成衣完工自动扣减',
      createdAt: '2026-09-10T08:30:00.000Z',
    },
    {
      id: 'log_002', materialId: 'mat_fab_001', materialName: '浅蓝棉', unit: 'm',
      quantity: 0.4, kind: 'consume', source: 'legacy:2025:seed',
      garmentId: '', note: '历史导入包',
      createdAt: '2026-09-15T10:00:00.000Z',
    },
    {
      id: 'log_003', materialId: 'mat_fab_002', materialName: '亚麻', unit: 'm',
      quantity: 2, kind: 'refill', source: 'manual',
      garmentId: '', note: '补货',
      createdAt: '2026-09-05T10:00:00.000Z',
    },
  ];

  await db.transaction('rw', [db.materials, db.garments, db.usageLogs], async () => {
    await db.materials.bulkAdd(materials);
    await db.garments.bulkAdd(garments);
    await db.usageLogs.bulkAdd(usageLogs);
  });
}

async function main(): Promise<void> {
  await seedIfFirstRun();
  await ensureStatsFixtures();
  console.log(`基准日期：${today}`);
  let allOk = true;
  for (const p of ['month', 'year', 'all'] as PeriodKey[]) {
    const ok = await runOne(p);
    if (!ok) allOk = false;
    console.log('');
  }
  if (!allOk) {
    console.error('❌ 三周期对账失败');
    process.exit(1);
  }
  console.log('✅ 三周期对账全部通过');
  process.exit(0);
}

await main();