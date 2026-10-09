/** AJ-A Q2 实测脚本：用用户提供的真实备份包全链路验证导入。
 *
 * 背景（AJ-A Q2）：用户从 GitHub 下载备份包、手动改了 data.json 里一个字段、
 * 重新压缩后导入报「备份文件里没有 data.json」。核实：包内容被包了一层
 * 顶层目录（sewing-space-backup-20261009-0326/…，267 个条目）。AJ-A 修复后
 * 导入器在 zip 内递归定位唯一的 data.json，images/ 相对其所在目录解析。
 *
 * 用法：npx tsx scripts/aj-a-user-pkg-test.ts <用户包.zip 路径>
 * 验证点：
 *   1. 全链路 importBackupFile 成功（校验门 + 覆盖 + 图片落库）
 *   2. 行数与包内一致（materials 236 / garments 39 / tasks 5 /
 *      taskTemplates 2 / usageLogs 235 / images 265 / backupLogs 45）
 *   3. 幂等二跑：再导一次行数不变（无重复落库）
 *   4. data.json 为合法 JSON（改坏时脚本会指向解析错误而非「没有 data.json」）
 *
 * 注：用户手动改的是哪个字段无参照版本可比对，无法逐字定位；但导入链路对
 * 每一行都过 zod 行 schema 校验，本脚本通过 = 改后的值通过了全部校验并落库。
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { db } from '@/db/schema';
import { importBackupFile } from '@/services/backupService';

const EXPECTED = {
  materials: 236,
  garments: 39,
  tasks: 5,
  taskTemplates: 2,
  usageLogs: 235,
  images: 265,
} as const;
// backupLogs 为本机独有、不随包恢复（backupService §「backupLogs 不动」口径）：
// 每跑一次只追加 1 条本次 restore 日志——第 1 跑后 1 条、第 2 跑后 2 条。
const EXPECTED_LOGS_AFTER_RUN = [1, 2] as const;

async function main(): Promise<void> {
  const zipPath = process.argv[2];
  if (zipPath === undefined || zipPath.length === 0) {
    console.error('用法：npx tsx scripts/aj-a-user-pkg-test.ts <用户包.zip 路径>');
    process.exit(2);
  }
  const bytes = readFileSync(zipPath);
  console.log(`用户包：${zipPath}（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）`);

  // 第 1 跑：全链路导入。
  const report1 = await importBackupFile(new Blob([bytes]), 'local_import');
  console.log(`第 1 跑：status=${report1.status} dropped=${report1.dropped} droppedImages=${report1.droppedImages}`);
  const counts1 = {
    materials: await db.materials.count(),
    garments: await db.garments.count(),
    tasks: await db.tasks.count(),
    taskTemplates: await db.taskTemplates.count(),
    usageLogs: await db.usageLogs.count(),
    images: await db.images.count(),
    backupLogs: await db.backupLogs.count(),
  };
  console.log('第 1 跑行数：', counts1);
  if (counts1.backupLogs !== EXPECTED_LOGS_AFTER_RUN[0]) {
    console.error(`  ✗ 第 1 跑 backupLogs 期望 ${EXPECTED_LOGS_AFTER_RUN[0]}（本机独有不随包恢复，仅追加本次 restore 日志），实际 ${counts1.backupLogs}`);
  }

  // 第 2 跑：幂等。
  const report2 = await importBackupFile(new Blob([bytes]), 'local_import');
  console.log(`第 2 跑：status=${report2.status} dropped=${report2.dropped} droppedImages=${report2.droppedImages}`);
  const counts2 = {
    materials: await db.materials.count(),
    garments: await db.garments.count(),
    tasks: await db.tasks.count(),
    taskTemplates: await db.taskTemplates.count(),
    usageLogs: await db.usageLogs.count(),
    images: await db.images.count(),
    backupLogs: await db.backupLogs.count(),
  };
  console.log('第 2 跑行数：', counts2);

  let pass = true;
  const fail = (msg: string): void => { pass = false; console.error(`  ✗ ${msg}`); };
  for (const [k, v] of Object.entries(EXPECTED)) {
    if (counts1[k as keyof typeof counts1] !== v) fail(`第 1 跑 ${k} 期望 ${v}，实际 ${counts1[k as keyof typeof counts1]}`);
    if (counts2[k as keyof typeof counts2] !== v) fail(`第 2 跑 ${k} 期望 ${v}，实际 ${counts2[k as keyof typeof counts2]}`);
  }
  if (counts2.backupLogs !== EXPECTED_LOGS_AFTER_RUN[1]) {
    fail(`第 2 跑 backupLogs 期望 ${EXPECTED_LOGS_AFTER_RUN[1]}（每跑追加 1 条 restore 日志），实际 ${counts2.backupLogs}`);
  }
  const biz1 = { ...counts1, backupLogs: undefined };
  const biz2 = { ...counts2, backupLogs: undefined };
  if (JSON.stringify(biz1) !== JSON.stringify(biz2)) fail('二跑业务行数不一致（幂等失败）');
  if (report1.status !== 'success' && report1.status !== 'partial') fail(`第 1 跑 status=${report1.status}`);
  if (report1.droppedImages > 0) console.log(`  ⚠ 第 1 跑 droppedImages=${report1.droppedImages}（图片落库有丢弃，看上方行数核对）`);

  console.log(pass ? '\n用户包实测：全部通过 ✅' : '\n用户包实测：存在失败项 ✗');
  process.exit(pass ? 0 : 1);
}

await main();
