/** 开发期降级通道：空库时灌入样例数据（§7.1）。不得在用户可见的产品路径里自动调用。 */
import 'fake-indexeddb/auto'; // Node 无原生 IndexedDB，与 test-services.ts 同款前置（缺它则 DatabaseClosedError 退出码 1）
import { db } from '@/db/schema';
import { seedIfFirstRun } from '@/db/seed';

await seedIfFirstRun();

const counts: Record<string, number> = {
  materials: await db.materials.count(),
  garments: await db.garments.count(),
  tasks: await db.tasks.count(),
  taskTemplates: await db.taskTemplates.count(),
  usageLogs: await db.usageLogs.count(),
  images: await db.images.count(),
  settings: await db.settings.count(),
  backupLogs: await db.backupLogs.count(),
};

for (const [name, n] of Object.entries(counts)) console.log(`${name.padEnd(14)}${n}`);
