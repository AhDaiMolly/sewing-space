/** S5-C 跨期口径对账 · 测试数据注入脚本。
 *
 *  S5-A 交付的 seedIfFirstRun 只灌入 settings + 任务模板；物料/成衣/流水都空，
 *  所以 verify-stats-periods.ts 第一次跑虽然全绿，但是「全 0 == 全 0」的真空结果。
 *  本脚本注入少量测试数据（覆盖本月、本年、跨年边界、含 legacy: 流水），令对账
 *  能在非零数字上验证。
 *
 *  口径严格按 PRD §8.15 / statsService：
 *    - 2 块面料（含 1 块过往年） + 1 个辅料 + 1 个工具 + 1 个纸样（有/无价混杂）；
 *    - 3 件成衣：2 件当月完工（其中 1 件有价 1 件无价）+ 1 件去年完工；
 *    - 流水：consume 含 fabric、本月且 legacy: 各 1 条（验证 legacy 排除）；
 *    - refill 几条装点；
 *    - 不动 settings / 任务模板，不动 schema。
 *
 *  跑：tsx scripts/seed-stats-fixtures.ts
 *  退出：0；写完即退出。
 *
 *  注意：每次运行前先按需清掉 fixtures。本脚本不在首启路径里。
 */

import 'fake-indexeddb/auto';

import { db } from '@/db/schema';
import { seedIfFirstRun } from '@/db/seed';
import type { Material, Garment, UsageLog } from '@/db/types';

const NOW = '2026-09-24T08:00:00.000Z';

const materials: Material[] = [
  {
    id: 'mat_fab_001',
    type: 'fabric',
    name: '浅蓝棉',
    category: '棉布',
    quantity: 4,
    initialQuantity: 5,
    unit: 'm',
    purchaseDate: '2026-09-05',
    purchasePrice: 32.5,
    color: '浅蓝',
    width: 145,
    weight: 200,
    composition: '100% 棉',
    sampleCard: '',
    season: 'all_season',
    suitableFor: ['衬衫', '半身裙'],
    forWhom: 'women',
    tags: ['棉布'],
    notes: '',
    brand: '优衣库',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
  {
    id: 'mat_fab_002',
    type: 'fabric',
    name: '亚麻',
    category: '麻布',
    quantity: 6,
    initialQuantity: 8,
    unit: 'm',
    purchaseDate: '2026-01-10', // 去年，落在「本年」但不在「本月」
    purchasePrice: 60,
    color: '米色',
    width: 145,
    weight: 180,
    composition: '100% 麻',
    sampleCard: '',
    season: 'summer',
    suitableFor: ['上衣基础', '裤子'],
    forWhom: 'women',
    tags: ['麻布'],
    notes: '',
    brand: '无印良品',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
  {
    id: 'mat_acc_001',
    type: 'accessory',
    name: '白色拉链',
    category: '拉链',
    quantity: 3,
    initialQuantity: 3,
    unit: '根',
    purchaseDate: '2026-09-12',
    purchasePrice: 4.5,
    color: '白',
    width: 1,
    weight: undefined,
    composition: '',
    sampleCard: '',
    season: 'all_season',
    suitableFor: [],
    forWhom: '',
    tags: ['拉链'],
    notes: '',
    brand: '其他',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
  {
    id: 'mat_tool_001',
    type: 'tool',
    name: '剪刀',
    category: '剪刀',
    quantity: 1,
    initialQuantity: 1,
    unit: '把',
    purchaseDate: '2025-06-15', // 去年 → 落在「汇总」但不在「本年」
    purchasePrice: 58,
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
    brand: '其他',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
  {
    id: 'mat_pat_001',
    type: 'pattern',
    name: '半身裙纸样',
    category: '半身裙',
    quantity: 1,
    initialQuantity: 1,
    unit: '张',
    purchaseDate: '2026-08-20',
    purchasePrice: 12,
    color: '',
    width: undefined,
    weight: undefined,
    composition: '',
    sampleCard: '',
    season: 'all_season',
    suitableFor: ['半身裙'],
    forWhom: 'women',
    tags: [],
    notes: '',
    brand: 'Burda',
    size: 'M',
    rating: 5,
    ratingReview: '',
    used: 1,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
  {
    // 无价辅料（验证 cost 不算入）
    id: 'mat_acc_002',
    type: 'accessory',
    name: '赠品纽扣',
    category: '扣子',
    quantity: 12,
    initialQuantity: 12,
    unit: '颗',
    purchaseDate: '2026-09-18',
    purchasePrice: undefined,
    color: '',
    width: 1,
    weight: undefined,
    composition: '',
    sampleCard: '',
    season: 'all_season',
    suitableFor: [],
    forWhom: '',
    tags: [],
    notes: '朋友送的，不入价',
    brand: '',
    size: '',
    rating: 0,
    ratingReview: '',
    used: 0,
    lowStockThreshold: 0,
    images: [],
    createdAt: NOW,
    updatedAt: NOW,
    sourceRef: undefined,
  },
];

const garments: Garment[] = [
  {
    id: 'grt_001',
    name: '夏季棉布半裙',
    category: '半身裙',
    size: 'M',
    recipient: '自己',
    status: 'completed',
    materialIds: ['mat_fab_001', 'mat_acc_001'],
    patternId: 'mat_pat_001',
    materialSnapshot: [
      {
        materialId: 'mat_fab_001',
        name: '浅蓝棉',
        unit: 'm',
        priceSnapshot: 32.5,
        quantityUsed: 1.6,
        subtotal: 52,
        deducted: true,
      },
      {
        materialId: 'mat_acc_001',
        name: '白色拉链',
        unit: '根',
        priceSnapshot: 4.5,
        quantityUsed: 1,
        subtotal: 4.5,
        deducted: true,
      },
      {
        materialId: 'mat_pat_001',
        name: '半身裙纸样',
        unit: '张',
        priceSnapshot: 12,
        quantityUsed: 1,
        subtotal: 12,
        deducted: false, // 纸样不进库存
      },
    ],
    totalCost: 68.5,
    images: [],
    completionDate: '2026-09-10', // 本月
    startDate: '2026-09-01',
    plannedDate: '',
    forWhom: 'women',
    tags: ['半身裙', '棉布'],
    notes: '',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-10T08:00:00.000Z',
    sourceRef: undefined,
  },
  {
    id: 'grt_002',
    name: '亚麻上衣',
    category: '上衣基础',
    size: 'S',
    recipient: '妈妈',
    status: 'completed',
    materialIds: ['mat_fab_002'],
    patternId: '',
    materialSnapshot: [
      {
        materialId: 'mat_fab_002',
        name: '亚麻',
        unit: 'm',
        priceSnapshot: 60,
        quantityUsed: 2,
        subtotal: 120,
        deducted: true,
      },
    ],
    totalCost: null, // 无成本，应参与完工计数，但不算 costCount
    images: [],
    completionDate: '2026-09-20', // 本月
    startDate: '2026-09-12',
    plannedDate: '',
    forWhom: 'women',
    tags: ['上衣'],
    notes: '',
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-20T08:00:00.000Z',
    sourceRef: undefined,
  },
  {
    id: 'grt_003',
    name: '去年的棉麻连衣裙',
    category: '连衣裙',
    size: 'M',
    recipient: '朋友',
    status: 'completed',
    materialIds: ['mat_fab_002'],
    patternId: '',
    materialSnapshot: [
      {
        materialId: 'mat_fab_002',
        name: '亚麻',
        unit: 'm',
        priceSnapshot: 60,
        quantityUsed: 0.5, // 已退役（去年用剩）
        subtotal: 30,
        deducted: true,
        retiredAt: '2025-08-15T08:00:00.000Z',
      },
    ],
    totalCost: 30,
    images: [],
    completionDate: '2025-08-30', // 不在本年与本月，落在「汇总」
    startDate: '2025-08-01',
    plannedDate: '',
    forWhom: 'women',
    tags: [],
    notes: '',
    createdAt: '2025-08-01T08:00:00.000Z',
    updatedAt: '2025-08-30T08:00:00.000Z',
    sourceRef: undefined,
  },
];

const usageLogs: UsageLog[] = [
  // 本月 · fabric 消耗（应入「本月」/「本年」/「汇总」）
  {
    id: 'log_001',
    materialId: 'mat_fab_001',
    materialName: '浅蓝棉',
    unit: 'm',
    quantity: 1.6,
    kind: 'consume',
    source: 'garment:grt_001',
    garmentId: 'grt_001',
    note: '成衣完工自动扣减',
    createdAt: '2026-09-10T08:30:00.000Z',
  },
  // 本月 · legacy 消耗（应排除）
  {
    id: 'log_002',
    materialId: 'mat_fab_001',
    materialName: '浅蓝棉',
    unit: 'm',
    quantity: 0.4,
    kind: 'consume',
    source: 'legacy:2025:seed',
    garmentId: '',
    note: '历史导入包',
    createdAt: '2026-09-15T10:00:00.000Z',
  },
  // refill（不影响消耗聚合，仅装点）
  {
    id: 'log_003',
    materialId: 'mat_fab_002',
    materialName: '亚麻',
    unit: 'm',
    quantity: 2,
    kind: 'refill',
    source: 'manual',
    garmentId: '',
    note: '补货',
    createdAt: '2026-09-05T10:00:00.000Z',
  },
];

async function clearFixtures(): Promise<void> {
  // 删我们造的 id，其它行不动
  for (const t of [db.materials, db.garments, db.usageLogs]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await t.toArray();
    const ourIds = new Set([
      ...materials.map((m) => m.id),
      ...garments.map((g) => g.id),
      ...usageLogs.map((l) => l.id),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deleteIds = all.filter((r: any) => ourIds.has(r.id)).map((r: any) => r.id);
    if (deleteIds.length > 0) await t.bulkDelete(deleteIds);
  }
}

async function main(): Promise<void> {
  await seedIfFirstRun();

  // 检查是否有冲突 id
  const existing = {
    materials: (await db.materials.where('id').anyOf(materials.map((m) => m.id)).toArray()).length,
    garments: (await db.garments.where('id').anyOf(garments.map((g) => g.id)).toArray()).length,
    usageLogs: (await db.usageLogs.where('id').anyOf(usageLogs.map((l) => l.id)).toArray()).length,
  };
  if (existing.materials + existing.garments + existing.usageLogs > 0) {
    console.log('fixtures 已存在，先清理再写');
    await clearFixtures();
  }

  await db.transaction('rw', [db.materials, db.garments, db.usageLogs], async () => {
    await db.materials.bulkAdd(materials);
    await db.garments.bulkAdd(garments);
    await db.usageLogs.bulkAdd(usageLogs);
  });

  const counts = {
    materials: await db.materials.count(),
    garments: await db.garments.count(),
    usageLogs: await db.usageLogs.count(),
  };
  console.log('fixtures 写入完成：');
  console.log(`  materials = ${counts.materials}`);
  console.log(`  garments  = ${counts.garments}`);
  console.log(`  usageLogs = ${counts.usageLogs}`);
}

await main();
