// src/services/backupService.ts
//
// 备份与恢复服务层（S6-A）：DM §10 备份文件格式 + §5.9/§5.10 写入路径
// + §6.8/§6.9 事务边界 + 架构 §9.3/§9.8 接口分工的唯一拼装点。
//   - exportBackup()   6-1：五步流水（清孤儿 → 序列化 → zip → 写出 → 日志+清脏）
//   - parseBackup()    6-2：§10.5 九道导入校验门（任一不过整包拒收、数据零变更）
//   - applyRestore()   6-3：§10.6 三组白名单覆盖 + 六表整表替换 + restore 日志
//   - pushToGithub()   6-4：调 githubService 的 §9.3 序列，收尾写 settings 与日志
//   - recordBackupResult()/listBackupLogs()  6-7：备份日志写入（§6.9 骨架 + 200 条容量）与查询
//   - markBackupDirty()/clearBackupDirty()   6-8：脏标记置位/清除
// githubService 不碰数据库；本模块不发起任何真实网络调用（fetch 可注入）。
// PAT 只从 settings.github_token 读，绝不写进日志、zip 或错误对象。

import JSZip from 'jszip';
import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import { imageRowToStored } from '@/db/imageStorage';
import { cleanupOrphanImages } from '@/services/imageService';
import {
  GithubServiceError,
  bytesToBase64,
  pushBackupZip,
  listRemoteBackups,
  downloadBackupZip,
  type FetchLike,
  type SleepLike,
  type RemoteFile,
} from '@/services/githubService';
import {
  BackupLogRowSchema,
  RESTORE_FROM_ZIP_KEYS,
  RESTORE_LOCAL_ONLY_KEYS,
  RESTORE_PRESERVE_KEYS,
  SETTINGS_KEYS,
  SettingsObjectSchema,
  firstIssueMessage,
  MaterialRowSchema,
  GarmentRowSchema,
  TaskRowSchema,
  TaskTemplateRowSchema,
  UsageLogRowSchema,
  ImageJsonRowSchema,
} from '@/db/schemas';
import type {
  BackupLog,
  BackupLogKind,
  BackupLogStatus,
  Garment,
  ImageRecord,
  Material,
  NanoId12,
  Task,
  TaskTemplate,
  UsageLog,
} from '@/db/types';
import type { z } from 'zod';

// ============================ 类型（架构 §9.8） ============================

export interface ParsedBackup {
  formatVersion: number;
  materials: Material[];
  garments: Garment[];
  tasks: Task[];
  taskTemplates: TaskTemplate[];
  usageLogs: UsageLog[];
  images: ImageJsonRow[];
  imagesBlobs: Map<NanoId12, Blob>;
  settings: Record<string, string>;
  dropped: number;
  droppedImages: number;
}

export interface RestoreReport {
  restored: Record<string, number>;
  dropped: number;
  droppedImages: number;
  /** AC-A：恢复覆盖阶段图片逐条写入仍失败的张数（已跳过、未拖垮整体导入）。 */
  failedImages: number;
  /**
   * AE-A Q2：图片保存失败的原因聚合（中文、按「配额不足 / 单图过大 /
   * iOS Safari 已知行为 / 其他写入失败」分级；全量成功时为 undefined）。
   * 供 UI toast 与 restore 日志给用户可操作指引。
   */
  failedImagesReason?: string;
  status: 'success' | 'partial';
}

export interface BackupExportResult {
  blob: Blob;
  filename: string;
}

export interface PushResult {
  branch: string;
  commitSha: string;
  filename: string;
}

export interface PushOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: SleepLike;
  now?: () => Date;
}

// ============================ 常量与内部辅助 ============================

/** DM §10.1：`format` 标识与本版 `formatVersion`（恒写 4）。 */
export const BACKUP_FORMAT = 'sewing-space-backup';
export const BACKUP_FORMAT_VERSION = 4;

/** §10.4：导入侧 images/ 条目的唯一合法正则。 */
const IMAGE_ENTRY_RE = /^images\/([A-Za-z0-9_-]{12})\.(jpg|png|webp)$/;

/** §3.8 硬约束 4：backupLogs 容量上限 200 条。 */
const BACKUP_LOGS_CAPACITY = 200;

function nowIso(): string {
  return new Date().toISOString();
}

async function getSettingValue(key: string): Promise<string> {
  const row = await db.settings.get(key);
  return row?.value ?? '';
}

/**
 * §4.15：mime → 扩展名。png→png、webp→webp，其余（含非法值）一律回落 jpg。
 */
export function mimeToExt(mimeType: string): 'jpg' | 'png' | 'webp' {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * §10.1：备份文件名（基础格式，无 -n 后缀）。`YYYYMMDD-HHmm` 取导出时刻
 * now 的 UTC 部分（`toISOString()` 直接截取），不用本地时区（冻结值）。
 */
export function backupFilename(now: Date): string {
  const iso = now.toISOString(); // 2025-04-07T09:30:11.000Z
  const ymd = iso.slice(0, 10).replace(/-/g, ''); // 20250407
  const hm = iso.slice(11, 16).replace(':', ''); // 0930
  return `sewing-space-backup-${ymd}-${hm}.zip`;
}

/** §10.2 第四条：settings 行 → 对象（跳过 github_token，PAT 绝不进备份包）。 */
function rowsToSettingsObject(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const row of rows) {
    if (row.key === 'github_token') continue;
    obj[row.key] = row.value;
  }
  return obj;
}

/** §5.9 第二步：images 行序列化——blob 整键删除，syncedAt 键整个跳过。 */
export type ImageJsonRow = Omit<ImageRecord, 'blob' | 'syncedAt'>;

function serializeImageRow(row: ImageRecord): ImageJsonRow {
  return {
    id: row.id,
    originalName: row.originalName,
    mimeType: row.mimeType,
    entityType: row.entityType,
    entityId: row.entityId,
    createdAt: row.createdAt,
  };
}

// ============================ 6-1 导出 zip ============================

interface BuiltBackupZip {
  blob: Blob;
  filename: string;
  /** 非图片数据行数（六个非图片数组的行数合计；图片单列，避免双重计数）。 */
  rowCount: number;
  imageCount: number;
}

/**
 * §5.9 五步流水的前三步（清孤儿 → 序列化 → 生成 zip）。不发请求、不写日志。
 * data.json 用 DEFLATE，images/ 下每个文件用 STORE（§10.3 压缩方法）。
 */
async function buildBackupZip(now: Date): Promise<BuiltBackupZip> {
  // 1) 清孤儿图（任何导出前都跑，幂等）。
  await cleanupOrphanImages();

  // 2) 序列化 data.json。
  const [materials, garments, tasks, taskTemplates, usageLogs, imageRows, settingsRows, backupLogs] =
    await Promise.all([
      db.materials.toArray(),
      db.garments.toArray(),
      db.tasks.toArray(),
      db.taskTemplates.toArray(),
      db.usageLogs.toArray(),
      db.images.toArray(),
      db.settings.toArray(),
      db.backupLogs.toArray(),
    ]);

  const settings = rowsToSettingsObject(settingsRows);
  const deviceId = settings['device_id'] ?? '';
  const data = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    deviceId,
    materials,
    garments,
    tasks,
    taskTemplates,
    usageLogs,
    images: imageRows.map(serializeImageRow),
    settings,
    backupLogs,
  };
  const jsonText = JSON.stringify(data);

  // 3) 生成 zip（扁平结构：顶层 data.json + images/，不套目录）。
  const zip = new JSZip();
  zip.file('data.json', jsonText, { compression: 'DEFLATE' });
  for (const row of imageRows) {
    const ext = mimeToExt(row.mimeType);
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    zip.file(`images/${row.id}.${ext}`, bytes, { compression: 'STORE' });
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

  return {
    blob,
    filename: backupFilename(now),
    rowCount: materials.length + garments.length + tasks.length
      + taskTemplates.length + usageLogs.length + backupLogs.length,
    imageCount: imageRows.length,
  };
}

/**
 * 6-1 导出 zip（local_export / auto_export）。生成包并写成功日志 + 清脏
 * （与日志同事务，§6.9）；浏览器下载动作归 UI（下游任务）。
 */
export async function exportBackup(
  kind: 'local_export' | 'auto_export' = 'local_export',
): Promise<BackupExportResult> {
  const now = new Date();
  const built = await buildBackupZip(now);
  const message = kind === 'auto_export'
    ? '自动导出到浏览器下载目录'
    : `导出 ${built.rowCount} 行数据, ${built.imageCount} 张图片`;
  await recordBackupResult(kind, 'success', message, { updateReminder: kind === 'auto_export' });
  return { blob: built.blob, filename: built.filename };
}

// ============================ 6-2 parseBackup + 九道校验门 ============================

/** §10.5 第 8 道：逐表行 schema（images 用 zip 侧形态，不含 blob）。 */
const TABLE_ROW_SCHEMAS: Record<string, z.ZodTypeAny> = {
  materials: MaterialRowSchema,
  garments: GarmentRowSchema,
  tasks: TaskRowSchema,
  taskTemplates: TaskTemplateRowSchema,
  usageLogs: UsageLogRowSchema,
  images: ImageJsonRowSchema,
  backupLogs: BackupLogRowSchema,
};

/** §10.5 第 7 道检查的七个数组键（八张表里除 settings 外的全部）。 */
const DATA_ARRAY_KEYS = [
  'materials', 'garments', 'tasks', 'taskTemplates', 'usageLogs', 'images', 'backupLogs',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 6-2 解包 + 校验（§10.5 九道门，顺序不可换，全部在写入之前）。
 * 任一道不过抛 Error（中文、指明哪一项），调用方负责写 failed 日志——
 * 本函数与 applyRestore 都不写失败日志，数据零变更。
 * 先 `arrayBuffer()` 一次性读完字节，覆盖阶段不再碰原文件句柄。
 */
export async function parseBackup(input: ArrayBuffer | Blob): Promise<ParsedBackup> {
  // 先把整个 zip 读完（§10.5）。
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();

  // 第 1 道：zip 可解。
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('文件已损坏或不是 zip 文件');
  }

  // 第 2 道：含 data.json。
  const dataFile = zip.file('data.json');
  if (dataFile === null) {
    throw new Error('备份文件里没有 data.json');
  }

  // 第 3 道：JSON.parse 成功。
  let text: string;
  try {
    text = await dataFile.async('string');
  } catch {
    throw new Error('文件已损坏或不是 zip 文件');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('data.json 不是合法的 JSON');
  }

  // 第 4 道：顶层是非 null 普通对象。
  if (!isPlainObject(parsed)) {
    throw new Error('备份文件顶层不是对象');
  }

  // 第 5 道：format 标识。
  if (parsed['format'] !== BACKUP_FORMAT) {
    throw new Error('这不是 sewing-space 备份文件');
  }

  // 第 6 道：formatVersion 过 §10.1 的 5 条判定（顺序不可换）。
  const rawVersion = parsed['formatVersion'];
  let formatVersion: number;
  if (rawVersion === undefined) {
    formatVersion = 1; // 键不存在 → 按 1 处理（推定值）
  } else if (typeof rawVersion !== 'number') {
    throw new Error('备份文件格式版本不合法');
  } else if (!Number.isInteger(rawVersion)) {
    throw new Error('备份文件格式版本不合法');
  } else if (rawVersion < 1) {
    throw new Error('备份文件格式版本不合法');
  } else if (rawVersion > BACKUP_FORMAT_VERSION) {
    throw new Error('备份文件来自更新的版本，请先升级应用');
  } else {
    formatVersion = rawVersion;
  }

  // 第 7 道：数据键齐全 + 类型（v4 必须齐全；<4 缺键按空集 + dropped++）。
  let dropped = 0;
  const arrays: Record<string, unknown[]> = {};
  for (const key of DATA_ARRAY_KEYS) {
    const v = parsed[key];
    if (v === undefined) {
      if (formatVersion === BACKUP_FORMAT_VERSION) {
        throw new Error(`备份文件缺少 ${key} 数组`);
      }
      arrays[key] = [];
      dropped++;
    } else if (Array.isArray(v)) {
      arrays[key] = v;
    } else {
      throw new Error(`备份文件缺少 ${key} 数组`);
    }
  }
  const rawSettings = parsed['settings'];
  let settingsObj: Record<string, unknown>;
  if (rawSettings === undefined) {
    if (formatVersion === BACKUP_FORMAT_VERSION) {
      throw new Error('备份文件缺少 settings 对象');
    }
    settingsObj = {};
    dropped++;
  } else if (isPlainObject(rawSettings)) {
    settingsObj = rawSettings;
  } else {
    throw new Error('备份文件缺少 settings 对象');
  }

  // 第 8 道：逐表逐行 safeParse（收集错误不抛，整包拒收）。
  for (const key of DATA_ARRAY_KEYS) {
    const schema = TABLE_ROW_SCHEMAS[key];
    const rows = arrays[key];
    if (schema === undefined || rows === undefined) continue;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const result = schema.safeParse(row);
      if (!result.success) {
        throw new Error(`备份文件第 ${i} 行 ${key} 校验失败：${firstIssueMessage(result.error)}`);
      }
    }
  }

  // 第 9 道：settings 每值是字符串（github_token 与 18 项外的 key 不算失败，
  // 留到覆盖阶段丢弃 + 计 dropped——§10.5 第 9 道的两个例外）。
  const settingsCheck = SettingsObjectSchema.safeParse(settingsObj);
  if (!settingsCheck.success) {
    throw new Error('备份文件的 settings 不合法');
  }
  const settings: Record<string, string> = settingsCheck.data;

  // 校验通过后的丢弃计数（覆盖阶段要落实的两个例外 + 18 项外 key）。
  const knownKeys = new Set<string>(SETTINGS_KEYS);
  for (const key of Object.keys(settings)) {
    if (key === 'github_token' || !knownKeys.has(key)) dropped++;
  }

  // ---------- §10.4 导入建行：读 images/ 目录、按 ext 取文件重建 Blob ----------
  let droppedImages = 0;
  const imagesBlobs = new Map<NanoId12, Blob>();
  const keptImages: Array<ImageJsonRow> = [];
  const rowIds = new Set<string>();
  const imageArray = arrays['images'] ?? [];
  for (const row of imageArray) {
    const img = row as unknown as ImageJsonRow;
    rowIds.add(img.id);
    const ext = mimeToExt(img.mimeType);
    const file = zip.file(`images/${img.id}.${ext}`);
    if (file === null) {
      droppedImages++; // data.json 有行、zip 无文件 → 跳过该行
      continue;
    }
    const bytes = await file.async('uint8array');
    // mimeType 白名单防御：第 8 道已保证三值白名单，此处兜底重写与回落方向一致。
    const mimeType = (img.mimeType === 'image/png' || img.mimeType === 'image/webp')
      ? img.mimeType
      : 'image/jpeg';
    if (mimeType !== img.mimeType) dropped++;
    // Uint8Array<ArrayBufferLike> 与 lib.dom BlobPart 的已知类型摩擦，字节内容不变。
    imagesBlobs.set(img.id, new Blob([bytes as unknown as BlobPart], { type: mimeType }));
    keptImages.push({ ...img, mimeType });
  }
  // zip 有文件、data.json 无行 → 丢弃该文件（§3.6 生命周期 6）。未知条目忽略不计。
  const zipImageIds = new Set<string>();
  for (const name of Object.keys(zip.files)) {
    const m = IMAGE_ENTRY_RE.exec(name);
    if (m !== null) zipImageIds.add(m[1] as string);
  }
  for (const id of zipImageIds) {
    if (!rowIds.has(id)) droppedImages++;
  }

  return {
    formatVersion,
    materials: arrays['materials'] as unknown as Material[],
    garments: arrays['garments'] as unknown as Garment[],
    tasks: arrays['tasks'] as unknown as Task[],
    taskTemplates: arrays['taskTemplates'] as unknown as TaskTemplate[],
    usageLogs: arrays['usageLogs'] as unknown as UsageLog[],
    images: keptImages,
    imagesBlobs,
    settings,
    dropped,
    droppedImages,
  };
}

// ============================ 6-3 applyRestore：三组白名单覆盖 ============================

/**
 * §10.6 覆盖阶段：先 settings 三组合并（绝不 clear()），后六张表整表替换
 * （逐表各自隐式事务），收尾同事务写 restore 日志 + 显式清脏（§6.8）。
 * backupLogs 不动；dirty_since_sync 不动；恢复不是备份，不写 backup_last_success。
 * AD-D 备份3：opts.filename 带 zip 包名时 restore 日志写入「从 zip 恢复：<名>」，
 * 缺名保持旧格式（存量日志与既有调用零影响）。
 */
export interface ApplyRestoreOptions {
  /** 恢复的 zip 包名（github_pull = 远端文件名 / local_import = 本地文件名）。 */
  filename?: string;
}

export async function applyRestore(
  parsed: ParsedBackup,
  opts: ApplyRestoreOptions = {},
): Promise<RestoreReport> {
  const now = nowIso();
  let dropped = parsed.dropped;

  // 0) AE-A Q2：配额预检——在动任何一张表之前判断可用空间是否装得下图片。
  // 不足 → 抛 RestorePreflightError（数据零变更，importBackupFile 转成
  // 「存储空间不足 / 单张图片过大」的中文分级提示）。环境不支持
  // navigator.storage.estimate（旧浏览器 / Node 测试环境）时跳过，不阻塞恢复。
  {
    let incomingBytes = 0;
    let largestSingle = 0;
    for (const blob of parsed.imagesBlobs.values()) {
      incomingBytes += blob.size;
      if (blob.size > largestSingle) largestSingle = blob.size;
    }
    // 恢复会整表替换 images：现有图片字节将被释放，计入可用量
    const existingRows = await db.images.toArray();
    const existingBytes = existingRows.reduce((sum, r) => sum + (r.blob?.size ?? 0), 0);
    await precheckImageStorageQuota(incomingBytes, largestSingle, existingBytes);
  }

  // 1) settings：三组白名单逐 key 处置（§10.6 逐 key 处置表）。
  for (const key of RESTORE_FROM_ZIP_KEYS) {
    const value = parsed.settings[key];
    if (typeof value === 'string') {
      await db.settings.put({ key, value, updatedAt: now });
    } else {
      dropped++; // zip 缺席 → 跳过（保留本机值）+ 计一次 dropped
    }
  }
  // RESTORE_PRESERVE_KEYS（9）与 RESTORE_LOCAL_ONLY_KEYS（4）：一行都不 put、
  // 保留本机值、不计 dropped。github_token 与 18 项外的 key 已在 parse 阶段计数，
  // 这里不 put 即丢弃。
  void RESTORE_PRESERVE_KEYS;
  void RESTORE_LOCAL_ONLY_KEYS;

  // 2) 六张表整表替换（顺序照 §10.6：materials → garments → tasks →
  //    taskTemplates → usageLogs → images，各自隐式事务）。
  await db.materials.clear();
  await db.materials.bulkPut(parsed.materials);
  await db.garments.clear();
  await db.garments.bulkPut(parsed.garments);
  await db.tasks.clear();
  await db.tasks.bulkPut(parsed.tasks);
  await db.taskTemplates.clear();
  await db.taskTemplates.bulkPut(parsed.taskTemplates);
  await db.usageLogs.clear();
  await db.usageLogs.bulkPut(parsed.usageLogs);

  let restoredImages = 0;
  const imageRows: ImageRecord[] = [];
  let droppedImages = parsed.droppedImages;
  for (const row of parsed.images) {
    const blob = parsed.imagesBlobs.get(row.id);
    if (blob === undefined) {
      droppedImages++; // 防御：行在而 Blob 映射缺失（正常流程 parse 已过滤）
      continue;
    }
    // 恢复的图片未经过同步，syncedAt 显式置 undefined（§5.9 序列化跳过该键的镜像）。
    imageRows.push({ ...row, blob, syncedAt: undefined });
  }
  await db.images.clear();
  // AC-A：图片写入改为「分片 bulkPut + 整批失败逐条降级」——个别图片失败
  // 只跳过并计数（计入 failedImages / restore 日志警告），不拖垮整个导入；
  // 分片同时避免单事务过大。整体仍失败（clear 抛错等基础设施故障）才上抛。
  const imagePut = await putImageRowsResilient(imageRows);
  restoredImages = imagePut.restored;
  const failedImages = imagePut.failedIds.length;
  // AE-A Q2：失败原因分级聚合（配额不足 / 单图过大 / iOS 已知行为 / 其他）
  const failedImagesReason = summarizeImagePutFailures(imagePut.failures);

  // 3) 收尾（§6.8 事务）：restore 日志 + 显式清脏（不写 backup_last_success）。
  const rows = parsed.materials.length + parsed.garments.length + parsed.tasks.length
    + parsed.taskTemplates.length + parsed.usageLogs.length;
  const restored: Record<string, number> = {
    materials: parsed.materials.length,
    garments: parsed.garments.length,
    tasks: parsed.tasks.length,
    taskTemplates: parsed.taskTemplates.length,
    usageLogs: parsed.usageLogs.length,
    images: restoredImages,
  };
  const status: 'success' | 'partial' =
    dropped > 0 || droppedImages > 0 || failedImages > 0 ? 'partial' : 'success';
  // AD-D 备份3：restore 日志带上恢复的 zip 包名（github_pull = 远端文件名 /
  // local_import = 本地文件名；缺名时保持旧格式，存量历史日志不受影响）。
  const namePrefix = opts?.filename ? `从 zip 恢复：${opts?.filename}` : '从 zip 恢复';
  const message = failedImages > 0
    ? `${namePrefix}（${rows} 行数据, ${restoredImages}/${parsed.images.length} 张图片，` +
      `${failedImages} 张图片保存失败，已跳过${failedImagesReason ? `。失败原因：${failedImagesReason}` : ''}，可重新导入）`
    : `${namePrefix}（${rows} 行数据, ${restoredImages} 张图片）`;

  const logRow: BackupLog = {
    id: nanoid(12),
    kind: 'restore',
    status,
    message: message.slice(0, 200),
    createdAt: now,
  };
  BackupLogRowSchema.parse(logRow); // R3：写入前 parse（事务外）
  await db.transaction('rw', [db.backupLogs, db.settings], async () => {
    await db.backupLogs.add(logRow);
    await trimBackupLogsLocked();
    await db.settings.put({ key: 'dirty_since_backup', value: 'false', updatedAt: now });
  });

  return { restored, dropped, droppedImages, failedImages, failedImagesReason, status };
}

// ============================ 导入入口（local_import / github_pull） ============================

/** AC-A：恢复时图片分片 bulkPut 的片大小（每片 ≤25 行，控制单事务体量）。 */
export const IMAGE_PUT_CHUNK_SIZE = 25;

/** putImageRowsResilient 返回的逐条失败记录（AE-A Q2：带原始错误供分级）。 */
export interface ImagePutFailure {
  id: string;
  error: unknown;
}

/**
 * AC-A：图片行分片写入——分片 bulkPut，整批失败降级为逐条 put，逐条仍失败
 * 的行跳过并记录 id（不抛错、不拖垮其余行）。返回成功条数、失败 id 列表与
 * 逐条失败原因（AE-A Q2：供「配额不足 / iOS 已知行为 / 其他」分级文案）。
 * 仅 clear/分片之外的意外异常（如索引损坏导致整库不可写）会向上传播。
 *
 * AE-A Q2 根因修复：**进入 db 调用前先在事务外预转换 Blob → Uint8Array**。
 * 此前 AC-A 中间件在 Dexie 事务作用域内 `await blob.arrayBuffer()`——
 * IndexedDB 事务在没有 pending 请求的间隙自动提交（Dexie 官方文档明确
 * 警告事务内不得等待其他异步 API，否则 TransactionInactiveError），iOS
 * WebKit 严格执行：事务失活后 bulkPut 整批与逐条降级 put 全部失败，即
 * 用户真机「255/255 张图片保存失败」而数据表全部成功的直接根因；沙箱
 * fake-indexeddb 事务实现宽松、不触发，故旧实证未暴露（见 ae-a-notes）。
 * 预转换后中间件 isImageMutateWithBlob 不再命中，写路径零 await。
 */
export async function putImageRowsResilient(
  rows: ImageRecord[],
): Promise<{ restored: number; failedIds: string[]; failures: ImagePutFailure[] }> {
  let restored = 0;
  const failedIds: string[] = [];
  const failures: ImagePutFailure[] = [];
  // 事务外预转换（漏网的非 Blob 行原样透传，行为不变）
  const storedRows = await Promise.all(rows.map((row) => imageRowToStored(row)));
  for (let i = 0; i < storedRows.length; i += IMAGE_PUT_CHUNK_SIZE) {
    const chunk = storedRows.slice(i, i + IMAGE_PUT_CHUNK_SIZE);
    try {
      await db.images.bulkPut(chunk);
      restored += chunk.length;
    } catch {
      for (const row of chunk) {
        try {
          await db.images.put(row);
          restored += 1;
        } catch (err) {
          failedIds.push(row.id);
          failures.push({ id: row.id, error: err });
        }
      }
    }
  }
  return { restored, failedIds, failures };
}

// ============================ AE-A Q2：配额预检 + 失败分级 ============================

/** 恢复前置校验失败（配额不足 / 单图过大）。message 为中文可操作文案。 */
export class RestorePreflightError extends Error {
  readonly kind: 'quota' | 'single-image';

  constructor(kind: 'quota' | 'single-image', message: string) {
    super(message);
    this.name = 'RestorePreflightError';
    this.kind = kind;
  }
}

/** navigator.storage.estimate 的最小形态（可注入，供测试模拟配额场景）。 */
export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function defaultStorageEstimate(): (() => Promise<StorageEstimateLike | undefined>) | null {
  if (typeof navigator === 'undefined') return null;
  const storage = (navigator as { storage?: { estimate?: () => Promise<StorageEstimateLike> } }).storage;
  if (storage?.estimate == null) return null;
  return () => storage.estimate!();
}

/**
 * AE-A Q2：恢复前配额预检。可用空间 = quota − usage + 现有 images 字节
 * （恢复会整表替换 images，旧图先释放）。判断口径（保守、不误伤）：
 *  - 单张图片 > 可用空间 → RestorePreflightError('single-image')；
 *  - 图片总量 > 可用空间 → RestorePreflightError('quota')。
 * 环境不支持 navigator.storage.estimate（旧浏览器 / Node 测试环境）或返回
 * 缺失字段时直接放行（不因预检本身阻塞恢复）。
 * 注意：estimate 的 usage 含 Service Worker 缓存等全源数据，可用量为
 * 低估值——预检只用于提前给出明确提示，不作为精确容量保证。
 */
export async function precheckImageStorageQuota(
  incomingBytes: number,
  largestSingle: number,
  existingBytes: number,
  estimateImpl?: (() => Promise<StorageEstimateLike | undefined>) | null,
): Promise<void> {
  const estimate = estimateImpl !== undefined ? estimateImpl : defaultStorageEstimate();
  if (estimate == null) return;
  const est = await estimate();
  if (est == null || est.quota == null || est.usage == null) return;
  const available = Math.max(0, est.quota - est.usage) + existingBytes;
  if (largestSingle > available) {
    throw new RestorePreflightError(
      'single-image',
      `单张图片大小（约 ${formatMb(largestSingle)}）超过当前可用存储空间（约 ${formatMb(available)}），无法保存。`
        + '请清理浏览器网站数据（iOS：设置 > 应用 > Safari > 高级 > 网站数据）后重试，或改用电脑导入',
    );
  }
  if (incomingBytes > available) {
    throw new RestorePreflightError(
      'quota',
      `存储空间不足：本次恢复需写入约 ${formatMb(incomingBytes)} 图片，当前可用约 ${formatMb(available)}。`
        + '请清理浏览器网站数据（iOS：设置 > 应用 > Safari > 高级 > 网站数据）或删掉不需要的数据后重试',
    );
  }
}

/** 恢复期写入失败的分类（AE-A Q2 分级口径）。 */
export type RestoreFailureKind =
  | 'blob-prepare'
  | 'quota'
  | 'transaction-inactive'
  | 'other';

/** 按错误文本归类（供 describeRestoreFailure 与失败原因聚合同一口径）。 */
export function classifyRestoreFailure(e: unknown): RestoreFailureKind {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/Error preparing Blob\/File data/i.test(message)) return 'blob-prepare';
  if (/QuotaExceededError|quota/i.test(message)) return 'quota';
  if (/TransactionInactiveError/i.test(message)
      || /transaction is no longer active/i.test(message)
      || /transaction has aborted/i.test(message)) {
    return 'transaction-inactive';
  }
  return 'other';
}

/**
 * AE-A Q2：把 putImageRowsResilient 的逐条失败聚合为一句中文分级说明
 * （配额不足 / 单图过大经由预检在写库前拦截；此处覆盖写入期发现的
 * 配额、事务失活、WebKit Blob 与其他错误）。空清单返回空串。
 */
export function summarizeImagePutFailures(failures: ImagePutFailure[]): string {
  if (failures.length === 0) return '';
  const counts = new Map<RestoreFailureKind, number>();
  for (const f of failures) {
    const kind = classifyRestoreFailure(f.error);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  const quota = counts.get('quota') ?? 0;
  if (quota > 0) {
    parts.push(`存储空间不足，请清理浏览器网站数据后重试（${quota} 张）`);
  }
  const tx = counts.get('transaction-inactive') ?? 0;
  if (tx > 0) {
    parts.push(`浏览器中断了数据库写入（iOS Safari 已知行为），请完全关闭标签页并重开 Safari 后重试（${tx} 张）`);
  }
  const bp = counts.get('blob-prepare') ?? 0;
  if (bp > 0) {
    parts.push(`iOS Safari 无法写入图片（已知兼容问题），请完全重启浏览器后重试（${bp} 张）`);
  }
  const other = counts.get('other') ?? 0;
  if (other > 0) {
    const first = failures.find((f) => classifyRestoreFailure(f.error) === 'other');
    const msg = first === undefined
      ? ''
      : (first.error instanceof Error ? first.error.message : String(first.error)).slice(0, 60);
    parts.push(`其他写入错误（${other} 张${msg === '' ? '' : `：${msg}`}）`);
  }
  return parts.join('；');
}

/**
 * AC-A：恢复失败原因的中文可操作转述。覆盖已知引擎错误：
 *  - WebKit「Error preparing Blob/File data」（iOS Safari 已知缺陷）；
 *  - 存储配额不足；
 *  - AE-A Q2 新增：TransactionInactiveError（iOS 事务失活，见
 *    putImageRowsResilient 注释的证据链）；
 *  - AE-A Q2 新增：RestorePreflightError（预检拦截的配额不足 / 单图过大）。
 * 其余错误保留原始 message（截断 120 字），不吞原始信息。
 */
export function describeRestoreFailure(e: unknown): string {
  if (e instanceof RestorePreflightError) return e.message;
  const message = e instanceof Error ? e.message : String(e);
  if (/Error preparing Blob\/File data/i.test(message)) {
    return '当前浏览器无法把图片写入本地数据库（iOS Safari 的已知兼容问题），'
      + '请退出无痕模式或完全重启浏览器后重试；仍失败时请改用电脑导入';
  }
  if (/TransactionInactiveError/i.test(message)
      || /transaction is no longer active/i.test(message)) {
    return '浏览器在写入图片时中断了本地数据库事务（iOS Safari 的已知行为），'
      + '请完全关闭该标签页并重开 Safari 后重试；反复失败请改用电脑导入';
  }
  if (/QuotaExceededError|quota/i.test(message)) {
    return '存储空间不足，请清理浏览器网站数据后重试';
  }
  return message.slice(0, 120);
}

/**
 * S6-fix P1-2：带失败日志的校验门（§5.10 第 2–4 步的统一入口）。
 * parseBackup 任一道不过 → 写一条 `kind` 对应、status: 'failed' 的日志
 * （message 形如「导入失败：<原因>」，DM §10.5 / §5.10 三），然后原样
 * 重新抛出供 UI toast。数据零变更。本地文件与 github_pull 两条导入路径
 * 共用本函数，保证校验与日志口径一致。
 */
export async function parseBackupLogged(
  file: Blob,
  kind: 'local_import' | 'github_pull' = 'local_import',
): Promise<ParsedBackup> {
  try {
    return await parseBackup(file);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await recordBackupResult(kind, 'failed', `导入失败：${reason}`);
    throw e;
  }
}

/**
 * §5.10 导入流程的本地入口（zip 从哪来由调用方决定；github_pull 走
 * fetchLatestGithubBackup / pullFromGithub）。失败在第 2–4 步（校验门）→
 * 写 kind 的 failed、数据零变更、重新抛出原始错误供 UI toast；覆盖阶段
 * 中途异常 → 写 restore partial（'恢复未完成，请重新导入'）。
 * AD-D 备份3：opts.filename 显式传 zip 名（github_pull 的远端文件名）；
 * 未传时若入参是 File（本地导入）自动取 file.name；两者皆无 → 旧格式日志。
 */
export async function importBackupFile(
  file: Blob,
  kind: 'local_import' | 'github_pull' = 'local_import',
  opts: ApplyRestoreOptions = {},
): Promise<RestoreReport> {
  const parsed = await parseBackupLogged(file, kind);
  const filename =
    opts.filename
    ?? (typeof File !== 'undefined' && file instanceof File ? file.name : undefined);
  try {
    return await applyRestore(parsed, filename ? { filename } : {});
  } catch (e) {
    // AC-A：失败原因转成中文可操作说明再写日志与上抛（原始英文底层错误
    // 只进 message 片段，不再直接暴露给用户）。
    const desc = describeRestoreFailure(e);
    await recordBackupResult('restore', 'partial', `恢复未完成，请重新导入（${desc.slice(0, 80)}）`);
    throw new Error(desc);
  }
}

// ============================ 6-7 backupLogs 写入与查询 ============================

/** §3.8 硬约束 4：容量清理（保留恰好 200 条，同事务内；须在 backupLogs 事务里调用）。 */
async function trimBackupLogsLocked(): Promise<void> {
  const total = await db.backupLogs.count();
  if (total > BACKUP_LOGS_CAPACITY) {
    const old = await db.backupLogs.orderBy('createdAt').limit(total - BACKUP_LOGS_CAPACITY).toArray();
    await db.backupLogs.bulkDelete(old.map((r) => r.id));
  }
}

export interface RecordBackupResultOptions {
  /** 自动导出 / 推送成功时同步更新 backup_reminder_last（§5.9 五 / 架构 §9.3 ⑤）。 */
  updateReminder?: boolean;
}

/**
 * 6-7 备份日志写入（§6.9 骨架）：add + 容量清理 + （成功且非 restore 时）
 * backup_last_success 与清脏，全部在 [backupLogs, settings] 一个事务里。
 * message 写入前 `String(...).slice(0, 200)`（§3.8 硬约束 2：按 UTF-16 码元
 * 截断，与文档逐字一致）。失败路径不更新 backup_last_success、不清脏。
 * kind × status 非法组合在写入前被 BackupLogRowSchema.parse 拒绝（中文报错）。
 */
export async function recordBackupResult(
  kind: BackupLogKind,
  status: BackupLogStatus,
  message: string,
  opts: RecordBackupResultOptions = {},
): Promise<void> {
  const now = nowIso();
  const row: BackupLog = {
    id: nanoid(12),
    kind,
    status,
    message: String(message).slice(0, 200),
    createdAt: now,
  };
  BackupLogRowSchema.parse(row); // R3：校验在事务外，失败事务根本不开始
  await db.transaction('rw', [db.backupLogs, db.settings], async () => {
    await db.backupLogs.add(row);
    await trimBackupLogsLocked();
    if (status === 'success' && kind !== 'restore') {
      await db.settings.put({ key: 'backup_last_success', value: now, updatedAt: now });
      await db.settings.put({ key: 'dirty_since_backup', value: 'false', updatedAt: now });
      if (opts.updateReminder) {
        await db.settings.put({ key: 'backup_reminder_last', value: now, updatedAt: now });
      }
    }
  });
}

/** 6-7 查询：倒序取最近 limit 条（默认 20）。分页不需要——容量上限 200（§7.15 六）。 */
export async function listBackupLogs(limit = 20): Promise<BackupLog[]> {
  return db.backupLogs.orderBy('createdAt').reverse().limit(limit).toArray();
}

// ============================ 6-4 pushToGithub：序列 + 收尾 ============================

/**
 * 6-4 推送备份到 GitHub（§9.3 完整序列 + §9.4 冲突重试）。
 * 配置从 settings 读（github_token / github_username / github_repo）；
 * 成功 → 同事务写 github_push success 日志 + backup_last_success +
 * backup_reminder_last + 清脏（架构 §9.3 ⑤）；失败 → 写 failed 日志（含
 * 状态码与人话原因）、保持脏、不更新 backup_last_success，然后重新抛出
 * 供 UI toast。本函数通过 opts 注入 mock fetch 自测，默认实现不做真实
 * 网络调用以外的事——真实联调在下游任务。
 */
export async function pushToGithub(blob: Blob, opts: PushOptions = {}): Promise<PushResult> {
  const token = await getSettingValue('github_token');
  const owner = await getSettingValue('github_username');
  const repo = await getSettingValue('github_repo');
  const zipBytes = new Uint8Array(await blob.arrayBuffer());
  const filename = backupFilename(opts.now?.() ?? new Date());

  try {
    const result = await pushBackupZip({
      token,
      owner,
      repo: repo === '' ? 'sewing-space-backup' : repo,
      filename,
      zipBytes,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      now: opts.now,
    });
    await recordBackupResult(
      'github_push',
      'success',
      // AD-D 备份2：日志带上推送的 zip 包名（原「已推送到 main（commit xxx）」）
      `已推送到 ${result.branch}：${filename}（commit ${result.commitSha.slice(0, 6)}）`,
      { updateReminder: true },
    );
    return result;
  } catch (e) {
    const logMessage = e instanceof GithubServiceError
      ? e.logMessage
      : `Github 推送失败（未知）：${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
    await recordBackupResult('github_push', 'failed', logMessage);
    throw e;
  }
}

// ============================ S6-fix P1-1：推送编排（push 成功才落本地账） ============================

/**
 * S6-fix P1-1：备份页「推送到 GitHub」按钮的服务层编排。
 * 顺序（DM §5.6：清脏路径 = 导出成功 / 推送成功 / 恢复完成）：
 *   1. buildBackupZip：只生成 zip（清孤儿图 + 序列化 + 打包），
 *      **不写日志、不动 backup_last_success、不清脏**——任何本地账都
 *      不落，推送失败时零回滚需求；
 *   2. pushToGithub：§9.3 推送序列。成功 → 同事务写 github_push success
 *      日志 + backup_last_success + backup_reminder_last + 清脏；
 *      失败 → 只写 github_push failed 日志，backup_last_success 与脏标记
 *      都不动（推送失败 = 本次备份未完成）。
 * 旧编排（exportBackup('auto_export') 先落本地账再推送）已废弃：那条路径
 * 推送失败时本地已处于「已备份」状态，与 DM §5.6 相悖。推送按钮只写
 * github_push 一种日志（PRD §10.1 动作表；auto_export 归启动时的自动
 * 备份触发器，UI 按钮不再借用）。
 */
export async function pushBackupToGithub(opts: PushOptions = {}): Promise<PushResult> {
  const now = opts.now?.() ?? new Date();
  const built = await buildBackupZip(now);
  return await pushToGithub(built.blob, opts);
}

// ============================ S6-fix P0-1：§9.6 拉取与恢复（github_pull） ============================

/** 拉取到的远端备份包（§9.6 ①② 的产物，供 UI 确认浮层展示元数据）。 */
export interface PulledBackup {
  blob: Blob;
  /** 远端文件名（列表第一条的 name，最新一次备份）。 */
  filename: string;
  /** 远端文件字节数（列表第一条的 size）。 */
  size: number;
}

/**
 * S6-fix P0-1（§9.6 ①②）：拉取远端最新一个备份包。
 * 配置从 settings 读（github_token / github_username / github_repo）；
 * listRemoteBackups 取前 20 条里最新的一个，downloadBackupZip 以
 * `Accept: application/vnd.github.raw` 一次性读完字节。
 * 拉取失败（网络 / 401 / 404 / 超限）→ 写一条 github_pull failed 日志
 * （DM §5.10 一：网络失败写一条 failed），然后重新抛出供 UI toast。
 * 本函数只取 zip，不 parse、不覆盖——校验门（parseBackupLogged）与
 * 确认后的 importBackupFile('github_pull') 由调用方串成完整 §9.6 序列，
 * 保证「拉取 → 解析校验门 → 确认 → 覆盖 → restore 日志」的 UI 主流程。
 */
export async function fetchLatestGithubBackup(opts: PushOptions = {}): Promise<PulledBackup> {
  const token = await getSettingValue('github_token');
  const owner = await getSettingValue('github_username');
  const repo = await getSettingValue('github_repo');
  try {
    const files = await listRemoteBackups({
      token,
      owner,
      repo,
      fetchImpl: opts.fetchImpl,
    });
    if (files.length === 0) {
      throw new GithubServiceError(
        '仓库里还没有备份文件',
        false,
        'Github 拉取失败（404）：仓库里还没有备份文件',
      );
    }
    const latest = files[0] as RemoteFile;
    const blob = await downloadBackupZip({
      token,
      owner,
      repo,
      path: latest.path,
      size: latest.size,
      fetchImpl: opts.fetchImpl,
    });
    return { blob, filename: latest.name, size: latest.size };
  } catch (e) {
    const logMessage = e instanceof GithubServiceError
      ? e.logMessage
      : `Github 拉取失败（未知）：${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
    await recordBackupResult('github_pull', 'failed', logMessage);
    throw e;
  }
}

/**
 * S6-fix P0-1（§9.6 ③④，架构 §9.8 签名）：拉取远端最新备份并立即走
 * importBackupFile('github_pull') 完成校验门 + 覆盖 + restore 日志 +
 * 清脏。无 UI 确认环节，供脚本 / 测试 / 「信任远端」的程序化调用；
 * 备份页按钮走 fetchLatestGithubBackup → 确认 → importBackupFile 的
 * 分步序列（同一套校验与日志口径）。
 */
export async function pullFromGithub(opts: PushOptions = {}): Promise<RestoreReport> {
  const { blob, filename } = await fetchLatestGithubBackup(opts);
  // AD-D 备份3：程序化拉取恢复同样把远端 zip 名写进 restore 日志
  return await importBackupFile(blob, 'github_pull', { filename });
}

// ============================ 6-8 脏标记置位 / 清除 ============================

/** 6-8 置位：`dirty_since_backup = 'true'`。业务写路径的打脏已在各自服务内
 * 逐一落实（本函数供备份面新路径与测试使用，不推翻既有调用）。 */
export async function markBackupDirty(): Promise<void> {
  await db.settings.put({ key: 'dirty_since_backup', value: 'true', updatedAt: nowIso() });
}

/** 6-8 清除：`dirty_since_backup = 'false'`。正常清脏入口是导出/推送成功
 * 与恢复完成（§5.6 六），它们在各自事务里写；本函数是独立清除原语。 */
export async function clearBackupDirty(): Promise<void> {
  await db.settings.put({ key: 'dirty_since_backup', value: 'false', updatedAt: nowIso() });
}

/** 读当前脏标记（'true' 即脏）。 */
export async function isBackupDirty(): Promise<boolean> {
  return (await getSettingValue('dirty_since_backup')) === 'true';
}

// ============================ 导出常量再导出（测试与下游用） ============================

export { bytesToBase64, BACKUP_LOGS_CAPACITY };
