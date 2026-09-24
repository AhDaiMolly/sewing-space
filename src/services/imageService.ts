// src/services/imageService.ts
//
// 图片压缩 + 单实体上限 + 孤儿清理。签名逐字对齐架构文档 v3.0 §6.8。
// 压缩参数（最大边 1600px / jpeg q0.8 / PNG 透明通道保留 PNG）与
// 单实体上限（5 张，第 6 张拒绝）取自架构 §6.8 + 数据模型 v2.0
// §3.6 HC1 / §5.7。第二条。

import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import type { ImageRecord, NanoId12 } from '@/db/types';

// ============================ 冻结参数 ============================

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedMime = (typeof ALLOWED_MIMES)[number];

const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_EDGE = 1600; // 最大边长（等比）
const MAX_PER_ENTITY = 5; // 单实体图片上限
const JPEG_QUALITY = 0.8;

// ============================ 图像压缩（无依赖，纯 canvas）============================

function isAllowedMime(type: string): type is AllowedMime {
  return (ALLOWED_MIMES as readonly string[]).includes(type);
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('图片压缩失败'))),
      mime,
      quality,
    );
  });
}

/** 把输入图像等比缩到最大边 1600px，按需保留 PNG 透明通道。 */
async function compressImage(
  file: Blob,
): Promise<{ blob: Blob; mimeType: AllowedMime }> {
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('图片压缩失败');
  ctx.drawImage(img, 0, 0, tw, th);

  // 检测 PNG 透明通道：任一像素 alpha < 255 → 保留 PNG。
  let hasAlpha = false;
  if (file.type === 'image/png') {
    try {
      const data = ctx.getImageData(0, 0, tw, th).data;
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i] as number;
        if (a < 255) {
          hasAlpha = true;
          break;
        }
      }
    } catch {
      // 跨域污染时无法读像素：按不透明处理，转 jpeg。
      hasAlpha = false;
    }
  }

  const outMime: AllowedMime = hasAlpha ? 'image/png' : 'image/jpeg';
  const quality = outMime === 'image/jpeg' ? JPEG_QUALITY : undefined;
  const blob = await canvasToBlob(canvas, outMime, quality);
  if (!blob || blob.size === 0) throw new Error('图片过大，请换一张');
  if (blob.size > MAX_BYTES) throw new Error('图片过大，请换一张');
  return { blob, mimeType: outMime };
}

// ============================ 导出原语 ============================

/** §6.8 / §5.7 第二条：压缩并写入一张图，返回新图 id。
 *  调用方负责把 id push 进实体的 images 数组并写到实体行。 */
export async function addImage(args: {
  entityType: 'material' | 'garment';
  entityId: string;
  file: File | Blob;
}): Promise<NanoId12> {
  // ① MIME 白名单
  if (!isAllowedMime(args.file.type)) {
    throw new Error('只支持 JPG / PNG / WebP');
  }
  // ② 压缩（压后 > 2MB 直接抛）
  const { blob, mimeType } = await compressImage(args.file);
  if (blob.size > MAX_BYTES) throw new Error('图片过大，请换一张');

  // ③ 单实体上限（孤儿态 entityId === '' 跳过此检查；§3.6 HC4）。
  if (args.entityId !== '') {
    if (args.entityType === 'material') {
      const m = await db.materials.get(args.entityId);
      if (!m) throw new Error('实体不存在');
      if (m.images.length >= MAX_PER_ENTITY) {
        throw new Error(`最多 ${MAX_PER_ENTITY} 张图片`);
      }
    } else {
      const g = await db.garments.get(args.entityId);
      if (!g) throw new Error('实体不存在');
      if (g.images.length >= MAX_PER_ENTITY) {
        throw new Error(`最多 ${MAX_PER_ENTITY} 张图片`);
      }
    }
  }

  // ④ 写入 images 行（syncedAt 键整个不写，§3.6 HC3）
  const id = nanoid(12);
  const nameRaw =
    args.file instanceof File ? args.file.name : 'image';
  const originalName = nameRaw.trim().slice(0, 255) || 'image';
  await db.images.add({
    id,
    blob,
    originalName,
    mimeType,
    entityType: args.entityType,
    entityId: args.entityId,
    // syncedAt 键整个不写（§3.6 HC3，恒 undefined）；此处显式占位以满足
    // Dexie InsertType 的字段必填推导。
    syncedAt: undefined,
    createdAt: new Date().toISOString(),
  });
  return id;
}

/** §5.7 一.2 / 三.3：回填孤儿——实体行写成功后，把先前 entityId === '' 的
 *  图行的 entityId 改成新实体 id 并打脏。按 DM §5.7 一，本原语自身不开
 *  db.transaction，必须由调用方在事务内调用（与实体行同生共死）。
 *  只认领「entityId === '' 且 entityType 匹配」的孤儿行：已被其它实体
 *  持有的图行与不存在的 id 一律跳过，不误伤、不抛错。返回认领条数。 */
export async function adoptOrphans(
  imageIds: string[],
  entityType: 'material' | 'garment',
  entityId: string,
): Promise<number> {
  let adopted = 0;
  for (const imageId of imageIds) {
    if (!imageId) continue;
    const row = await db.images.get(imageId);
    if (!row) continue; // 悬空引用：跳过，交给孤儿清理/调用方
    if (row.entityId !== '') continue; // 已被认领（可能是他实体图片）：不动
    if (row.entityType !== entityType) continue; // 实体类型不符：不动
    await db.images.put({ ...row, entityId });
    adopted += 1;
  }
  if (adopted > 0) {
    // 图片归属变化属于备份面数据变更（§3.6），打脏 dirty_since_backup。
    await db.settings.put({
      key: 'dirty_since_backup',
      value: 'true',
      updatedAt: new Date().toISOString(),
    });
  }
  return adopted;
}

/** §6.8：按 createdAt 升序返回某个实体的全部图。 */
export async function getImagesFor(
  entityType: 'material' | 'garment',
  entityId: NanoId12,
): Promise<ImageRecord[]> {
  const rows = await db.images
    .where('[entityType+entityId]')
    .equals([entityType, entityId])
    .toArray();
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** §6.8：删除单张图（幂等：行不存在静默返回）。调用方负责先把 id
 *  从实体的 images 数组里摘掉（同事务）。 */
export async function removeImage(imageId: NanoId12): Promise<void> {
  if (!imageId) return;
  await db.images.delete(imageId);
}

/** §6.8：替换实体图片顺序。orderedIds 必须是当前实体数组的排列。 */
export async function reorderImages(
  entityType: string,
  entityId: NanoId12,
  orderedIds: NanoId12[],
): Promise<void> {
  if (entityType !== 'material' && entityType !== 'garment') {
    throw new Error('不支持的实体类型');
  }
  await db.transaction('rw', [db.materials, db.garments], async () => {
    if (entityType === 'material') {
      const m = await db.materials.get(entityId);
      if (!m) throw new Error('实体不存在');
      const current = m.images;
      if (
        current.length !== orderedIds.length ||
        !orderedIds.every((id) => current.includes(id))
      ) {
        throw new Error('图片顺序与现有列表不一致');
      }
      await db.materials.put({ ...m, images: orderedIds, updatedAt: new Date().toISOString() });
    } else {
      const g = await db.garments.get(entityId);
      if (!g) throw new Error('实体不存在');
      const current = g.images;
      if (
        current.length !== orderedIds.length ||
        !orderedIds.every((id) => current.includes(id))
      ) {
        throw new Error('图片顺序与现有列表不一致');
      }
      await db.garments.put({ ...g, images: orderedIds, updatedAt: new Date().toISOString() });
    }
  });
}

/** §6.8 / §5.7 第七条：清理 entityId === '' 且 createdAt < now-24h 的孤儿图。
 *  返回删除条数。 */
export async function cleanupOrphanImages(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await db.images
    .filter((r) => r.entityId === '' && r.createdAt < cutoff)
    .toArray();
  const ids = rows.map((r) => r.id);
  if (ids.length) await db.images.bulkDelete(ids);
  return ids.length;
}