// src/db/migrations/legacyFiles.ts
//
// S8-C 迁移导入的 UI 层文件解析与集合识别（供向导第 2 步与自测共用）。
//
// ── 职责边界 ──────────────────────────────────────────────────────────
// legacy.ts（S8-A 冻结）不做集合识别：旧微信云数据库导出的 JSON 文件名是
// 随机后缀（`database_export-<随机串>.json`），**没有语义、不能作为集合
// 归属依据**。本模块是 legacy.ts 模块头说的「调用方」：把用户多选的
// NDJSON / JSON 文件按**内容特征**识别归入六个集合，再组装成
// `LegacyRawInput` 交给 `importLegacyDatabase`。
//
// ── 内容特征（S8-A 定下、S8-C 在真实数据上核对）──────────────────────
//   fabric       `stock`（71/71 独有）；辅以 price+width+purchased 组合
//   accessory    `unit`+`quantity`（65/65）；辅以 `tag`（45/65）
//   tools        `price`+`quantity` 且无 `unit`/`totalPrice`/`stock`（40/40）
//   pattern      `style`+`audience`/`rating` 且无 `status`（45/45）
//   garment      `status`/`fabricAmounts`/`accessoryAmounts`/`materials`（35/35）
//   preset       `config` 对象（1/1，单行文件）
//   task_archive `steps`/`currentStep`/`done`（3/3；读到不解析，只计数提醒）
// 识别按**文件**聚合打分（一个导出文件 = 一个集合，逐行特征求和后取唯一
// 最高分）；并列最高或全零分 → 无法识别，该文件计入 unrecognizedFiles，
// 不报错、不阻断其它文件。
//
// ── 图片压缩包 ────────────────────────────────────────────────────────
// 图片以 zip 提供（PRD §11.7 允许「把图片打平放在根目录的压缩包」；真实
// 数据即五个按集合分包的 zip）。提取时收全部非目录条目：条目路径取**末段
// 文件名**为 `LegacyImageFile.name`（§9.7 匹配键是文件名、不匹配目录路径）；
// 是否被引用、MIME 白名单、≤2MB 压缩由 importLegacyDatabase 按 §9.7 判定，
// 本层不预过滤（GIF 等被引用时由报告计 rejected，与 §9.7 口径一致）。
//
// 纯函数部分（parseLegacyText / recognizeCollections / buildImportInput /
// buildLegacyPreview）不碰 Dexie、不读文件系统，Node 自测可直接覆盖。

import JSZip from 'jszip';
import type { LegacyImageFile, LegacyRawInput, LegacySource } from './legacy';

// ============================ 类型 ============================

/** 已从文本解析出的单个旧库导出文件（行数组）。 */
export interface ParsedLegacyFile {
  /** 原始文件名（仅用于错误提示，不参与集合识别）。 */
  fileName: string;
  /** 文件字节数（仅用于预览展示）。 */
  sizeBytes: number;
  /** 解析出的行（对象或任意 JSON 值；非对象行由识别阶段判为无效）。 */
  rows: unknown[];
}

/** 文件级识别结果：六个集合之一，或归档任务，或无法识别。 */
export type DetectedFileCollection = LegacySource | 'task_archive' | 'unrecognized';

/** 内容特征识别的汇总产物（六个集合分装 + 归档计数 + 未识别清单）。 */
export interface RecognizedCollections {
  fabric: unknown[];
  accessory: unknown[];
  tools: unknown[];
  pattern: unknown[];
  garment: unknown[];
  /** preset 文件的行数组（可能多行；mapPreset 自取第一条并按 §9.8.6 提示）。 */
  preset: unknown[];
  /** 旧 task_archive 行数（读到不解析，只计数供报告提醒，§11.1）。 */
  taskArchiveCount: number;
  /** 无法识别的文件名清单（不报错、不阻断）。 */
  unrecognizedFiles: string[];
  /** 每个文件的识别明细（供调试与 notes 取证）。 */
  fileMap: { fileName: string; collection: DetectedFileCollection; rows: number }[];
}

/** 只读预览的计数（PRD §13.5 预览表；数字来自已解析文件与图片包条目数）。 */
export interface LegacyPreview {
  /** 物料 = fabric + accessory + tools + pattern 四集合行数之和。 */
  materials: number;
  garments: number;
  /** 旧 usageRecords 条数（fabric/accessory 行上数组长度之和）。 */
  usageRecords: number;
  /** 归档任务行数（0 时界面不渲染该行）。 */
  archivedTasks: number;
  /** 图片包内文件数（非目录条目数）。 */
  images: number;
  /** 全部 JSON 文件体积合计（人读格式）。 */
  fileSize: string;
}

// ============================ 文本解析 ============================

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 解析单个旧库导出文本：JSON 数组 / 单个 JSON 对象 / NDJSON（每行一个对象）。
 * 任一行无法解析 → 抛中文错误（§11.2「文件不是合法 JSON」层面的失败：不写
 * 任何数据，由界面提示用户重新选择）。
 */
export function parseLegacyText(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('内容不是 JSON 数组');
    return parsed;
  }
  if (trimmed.startsWith('{')) {
    // 可能是单对象导出（含多行 pretty-print），也可能每行一个对象的 NDJSON——
    // 先按整体单对象解析，失败再落到逐行 NDJSON 出口统一判错。
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      // 落入下方 NDJSON 分支
    }
  }
  // NDJSON：逐行解析，空行跳过；任一行坏 → 整个文件判失败
  const rows: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    rows.push(JSON.parse(s) as unknown);
  }
  return rows;
}

/** 浏览器侧：读 File → ParsedLegacyFile（编码 UTF-8）。 */
export async function parseLegacyFile(file: File): Promise<ParsedLegacyFile> {
  const text = await file.text();
  return { fileName: file.name, sizeBytes: file.size, rows: parseLegacyText(text) };
}

// ============================ 内容特征识别 ============================

/** 单行打分：各候选集合按独有特征累加（分数仅在本模块内部使用）。 */
function scoreRow(row: Record<string, unknown>): Map<DetectedFileCollection, number> {
  const s = new Map<DetectedFileCollection, number>();
  const add = (c: DetectedFileCollection, n: number): void => {
    s.set(c, (s.get(c) ?? 0) + n);
  };
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(row, k);
  // fabric：stock 是全量独有键（真实数据 71/71）
  if (has('stock')) add('fabric', 3);
  if (has('price') && has('width') && has('purchased') && !has('quantity')) add('fabric', 1);
  // accessory：unit+quantity 全量（65/65）；tag 45/65 作弱特征
  if (has('unit') && has('quantity') && !has('stock')) add('accessory', 3);
  if (has('tag') && has('quantity')) add('accessory', 1);
  // tools：price+quantity 且无 unit/totalPrice/stock（40/40）
  if (has('price') && has('quantity') && !has('unit') && !has('totalPrice') && !has('stock')) {
    add('tools', 3);
  }
  // pattern：style + audience/rating 且无 status（45/45）
  if (has('style') && (has('audience') || has('rating')) && !has('status')) add('pattern', 3);
  // garment：用料字典 / 状态键（35/35；materials 是 garment 独有冗余副本）
  if (has('fabricAmounts') || has('accessoryAmounts')) add('garment', 3);
  if (has('status') && (has('finishDate') || has('materials') || has('patternId'))) add('garment', 2);
  // preset：config 对象
  if (has('config') && isPlainObject(row.config)) add('preset', 3);
  // task_archive：任务步骤键（3/3）
  if (has('steps') || has('currentStep') || has('done')) add('task_archive', 3);
  return s;
}

/**
 * 按内容特征把已解析文件分装入六个集合。**不依赖文件名**（随机后缀无语义）。
 * 每文件逐行打分求和，取唯一最高分的集合；并列或全零 → unrecognized。
 * 缺集合（用户没选某类文件）→ 对应键为空数组，不报错（§11.1 边界 3）。
 */
export function recognizeCollections(files: ParsedLegacyFile[]): RecognizedCollections {
  const out: RecognizedCollections = {
    fabric: [], accessory: [], tools: [], pattern: [], garment: [], preset: [],
    taskArchiveCount: 0, unrecognizedFiles: [], fileMap: [],
  };
  for (const f of files) {
    const totals = new Map<DetectedFileCollection, number>();
    let objectRows = 0;
    for (const row of f.rows) {
      if (!isPlainObject(row)) continue; // 非对象行不参与识别（映射层会按「行不是对象」记 skipped）
      objectRows += 1;
      for (const [c, n] of scoreRow(row)) {
        totals.set(c, (totals.get(c) ?? 0) + n);
      }
    }
    let best: DetectedFileCollection = 'unrecognized';
    let bestScore = 0;
    let tie = false;
    for (const [c, n] of totals) {
      if (n > bestScore) {
        best = c;
        bestScore = n;
        tie = false;
      } else if (n === bestScore && n > 0) {
        tie = true;
      }
    }
    if (best === 'unrecognized' || tie || bestScore <= 0 || objectRows === 0) {
      out.unrecognizedFiles.push(f.fileName);
      out.fileMap.push({ fileName: f.fileName, collection: 'unrecognized', rows: f.rows.length });
      continue;
    }
    out.fileMap.push({ fileName: f.fileName, collection: best, rows: f.rows.length });
    if (best === 'task_archive') {
      out.taskArchiveCount += f.rows.length; // 读到不解析，只计数（§11.1）
    } else {
      out[best].push(...f.rows);
    }
  }
  return out;
}

// ============================ 图片压缩包 ============================

/** zip 条目路径 → 末段文件名（§9.7 匹配键是文件名，不匹配目录路径）。
 *  同时切分 `/` 与 `\`：Windows 工具打的 zip 条目路径用反斜杠分隔
 *  （实测用户真实图片包均为该形态），只按 `/` 切会拿到整段路径、匹配全失败。 */
function basenameOf(entryPath: string): string {
  const parts = entryPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? entryPath;
}

/** 扩展名 → MIME（不在三种白名单内的仍照收，拒收由 §9.7 统一判定并计数）。 */
function mimeOfExt(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'application/octet-stream';
}

/** 统计 zip（列表）内非目录条目数（仅预览计数用，不解压内容）。 */
export async function countImagesInZips(zips: Blob[]): Promise<number> {
  let n = 0;
  for (const zipFile of zips) {
    const zip = await JSZip.loadAsync(zipFile);
    zip.forEach((_path, entry) => {
      if (!entry.dir) n += 1;
    });
  }
  return n;
}

/**
 * 从 zip（列表）提取图片文件：全部非目录条目收为 LegacyImageFile，
 * name 取条目路径末段，MIME 按扩展名推断。同名条目取第一个（§9.7 文件名
 * 匹配「同名取第一个」）。目录条目跳过；zip 结构问题 → 抛中文错误。
 */
export async function extractImagesFromZips(zips: Blob[]): Promise<LegacyImageFile[]> {
  const byName = new Map<string, LegacyImageFile>();
  for (const zipFile of zips) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipFile);
    } catch {
      throw new Error('图片压缩包无法读取，请确认选择的是有效的 .zip 文件');
    }
    for (const path of Object.keys(zip.files)) {
      const entry = zip.files[path]!;
      if (entry.dir) continue;
      const name = basenameOf(path);
      if (name === '' || byName.has(name)) continue; // 同名取第一个（§9.7）
      // JSZip 产出的 Blob type 恒为空，而 importLegacyDatabase（Node 透传分支）
      // 以 blob.type 判 MIME 白名单——这里按扩展名重包，保证 type 携带正确 MIME。
      const mimeType = mimeOfExt(name);
      byName.set(name, { name, blob: new Blob([await entry.async('arraybuffer')], { type: mimeType }), mimeType });
    }
  }
  return [...byName.values()];
}

// ============================ 组装与预览 ============================

/** 识别产物 + 图片文件 → importLegacyDatabase 入参（preset 传数组，mapPreset 自取第一条）。 */
export function buildImportInput(rec: RecognizedCollections, images: LegacyImageFile[]): LegacyRawInput {
  return {
    fabric: rec.fabric,
    accessory: rec.accessory,
    tools: rec.tools,
    pattern: rec.pattern,
    garment: rec.garment,
    preset: rec.preset.length > 0 ? rec.preset : null,
    images,
  };
}

/** 只读预览计数（PRD §13.5：预览读真实文件，不写库）。 */
export function buildLegacyPreview(
  rec: RecognizedCollections,
  imageCount: number,
  jsonBytes: number,
): LegacyPreview {
  let usageRecords = 0;
  for (const row of [...rec.fabric, ...rec.accessory]) {
    if (isPlainObject(row) && Array.isArray(row.usageRecords)) {
      usageRecords += row.usageRecords.length;
    }
  }
  return {
    materials: rec.fabric.length + rec.accessory.length + rec.tools.length + rec.pattern.length,
    garments: rec.garment.length,
    usageRecords,
    archivedTasks: rec.taskArchiveCount,
    images: imageCount,
    fileSize: fmtBytes(jsonBytes),
  };
}
