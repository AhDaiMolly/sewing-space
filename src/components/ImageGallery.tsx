// ImageGallery — 图片相册组件（架构 §6.8 配套）
// 供详情页/表单页复用。上传/换图/删图走 imageService；删图有确认。
// UI 基线：demo 无独立 ImageGallery 组件，取 MaterialForm 的图片上传区 +
//   MaterialDetail 的大图区为样式参考。
// 不复刻清单：无。本组件是全新组件，demo 无对应独立组件。

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { addImage } from '@/services/imageService';
import type { NanoId12, ImageRecord } from '@/db/types';
import { toast } from '@/store/toastStore';
import { IconPlus } from './Icons';

interface ImageGalleryProps {
  entityType: 'material' | 'garment';
  entityId: NanoId12 | '';
  /** 已关联的 image id 数组。组件通过此 prop 与父组件双向同步。 */
  imageIds: string[];
  /** imageIds 变更时回调。父组件负责把新数组写回实体行。 */
  onImageIdsChange: (ids: string[]) => void;
  /** 单实体图片上限。默认取 imageService 的常量（5 张）。 */
  maxImages?: number;
}

const MAX_PER_ENTITY = 5; // 与 imageService.ts 的 MAX_PER_ENTITY 对齐

export default function ImageGallery({
  entityType,
  entityId,
  imageIds,
  onImageIdsChange,
  maxImages = MAX_PER_ENTITY,
}: ImageGalleryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // blob URL → revoke 注册表（useState 触发重渲染，P1-2 修复）
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const urlsRef = useRef<Map<string, string>>(new Map());

  // P2-2：用 [entityType+entityId] 复合索引查询，避免全表扫描
  const allImages = useLiveQuery(
    () =>
      entityId
        ? db.images.where({ entityType, entityId }).toArray()
        : (imageIds.length > 0
            ? db.images.bulkGet(imageIds).then((results) =>
                results.filter((r): r is ImageRecord => r != null),
              )
            : []),
    [entityType, entityId, imageIds],
  );

  // 筛选出属于当前实体的图片，按 id 数组顺序排列
  const images = (allImages ?? []).filter(
    (r) => imageIds.includes(r.id),
  );

  // 按 imageIds 顺序排序（useMemo 避免每渲染产生新数组引用）
  const orderedImages = useMemo(
    () => imageIds
      .map((id) => images.find((r) => r.id === id))
      .filter((r): r is ImageRecord => r != null),
    [imageIds, images],
  );

  // 管理 blob URL 生命周期（useState 触发重渲染，P1-2 修复）
  useEffect(() => {
    const prev = urlsRef.current;
    const nextUrls = new Map<string, string>();
    for (const img of orderedImages) {
      const existing = prev.get(img.id);
      if (existing) {
        nextUrls.set(img.id, existing);
      } else {
        nextUrls.set(img.id, URL.createObjectURL(img.blob));
      }
    }
    // revoke 不再需要的
    for (const [id, url] of prev) {
      if (!nextUrls.has(id)) {
        URL.revokeObjectURL(url);
      }
    }
    urlsRef.current = nextUrls;
    setUrls(nextUrls);
  }, [orderedImages]);

  // 卸载时回收所有 blob URL
  useEffect(() => {
    return () => {
      for (const [, url] of urlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const getUrl = useCallback((img: ImageRecord): string => {
    return urls.get(img.id) ?? '';
  }, [urls]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // 重置 input 以允许重复选同文件
      e.target.value = '';

      // 前端上限检查
      if (imageIds.length >= maxImages) {
        toast(`最多 ${maxImages} 张图片`);
        return;
      }

      setUploading(true);
      try {
        const newId = await addImage({
          entityType,
          entityId,
          file,
        });
        onImageIdsChange([...imageIds, newId]);
        toast('图片已添加');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '上传失败';
        toast(msg);
      } finally {
        setUploading(false);
      }
    },
    [entityType, entityId, imageIds, maxImages, onImageIdsChange],
  );

  const handleDelete = useCallback(
    (imageId: string) => {
      setDeleteConfirmId(null);
      // P2-3：删图只更新表单 state，不在提交前删库行；保存时由服务层
      // updateMaterial 对 patch.images 增量统一对账 drop（DM §5.7 五，
      // 实体行先写、图行后删，同事务）。取消编辑因此不产生副作用；未保存
      // 的孤儿行由 24h 清理机制回收（DM §5.7 七）。
      onImageIdsChange(imageIds.filter((id) => id !== imageId));
      toast('图片已移除，保存后生效');
    },
    [imageIds, onImageIdsChange],
  );

  const canAdd = imageIds.length < maxImages && !uploading;

  return (
    <>
      <div className="input-row image-upload-row">
        <label className="input-label">图片</label>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          {/* 已上传图片 */}
          {orderedImages.map((img) => {
            const url = getUrl(img);
            const isConfirming = deleteConfirmId === img.id;
            return (
              <div
                key={img.id}
                className="image-preview-wrap"
                style={{
                  width: '80px',
                  height: '107px',
                  position: 'relative',
                }}
              >
                {url ? (
                  <img
                    src={url}
                    alt={img.originalName || '图片'}
                    className="image-preview"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      background: 'var(--muted)',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--secondary-foreground)',
                      fontSize: '11px',
                    }}
                  >
                    加载中
                  </div>
                )}
                {isConfirming ? (
                  <div
                    className="image-remove-btn"
                    style={{
                      display: 'flex',
                      gap: '4px',
                      alignItems: 'center',
                      background: 'rgba(0,0,0,0.6)',
                      borderRadius: '50%',
                      width: '24px',
                      height: '24px',
                      cursor: 'default',
                      fontSize: '11px',
                      color: '#fff',
                      // S2-FIX-4 N-6：确认按钮容器 z-index 高于末尾的全屏遮罩（999）。
                      zIndex: 1000,
                    }}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => handleDelete(img.id)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#fff',
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '2px 4px',
                      }}
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setDeleteConfirmId(null);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#fff',
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '2px 4px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="image-remove-btn"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setDeleteConfirmId(img.id);
                    }}
                    aria-label="删除图片"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}

          {/* 添加上传位 */}
          {canAdd && (
            <button
              type="button"
              className="image-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              style={{
                width: '80px',
                height: '107px',
                flexDirection: 'column',
                gap: '4px',
                padding: '8px',
              }}
              disabled={uploading}
            >
              <IconPlus style={{ width: '20px', height: '20px', color: 'var(--accent)' }} />
              <span style={{ fontSize: '12px' }}>上传图片</span>
              <span className="image-hint" style={{ fontSize: '9px' }}>
                3:4 竖版 · 自动压缩
              </span>
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={handleUpload}
        />
      </div>

      {/* 删图确认遮罩（点击空白取消确认） */}
      {deleteConfirmId !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999,
          }}
          onClick={() => setDeleteConfirmId(null)}
        />
      )}
    </>
  );
}