// src/pages/pickers/GarmentPickerPage.tsx — AD-A 物料4：成衣选择器（页内浮层）
//
// 供 MaterialForm（纸样表单「关联成衣」）复用，形态与 GarmentForm 的
// 面料/辅料/纸样选择器同构：fixed 全屏覆盖层 + 搜索 + 列表多选 + 底部确认。
// 样式复用 .search-bar / .linked-material-item / .pattern-picker-* 冻结 CSS，
// 仅新增少量 .garment-picker-* 规则（styles.css AD-A 段）。

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Garment } from '@/db/types';
import { IconBack, IconSearch, IconCheck } from '@/components/Icons';
import { UserIconNavGarments } from '@/components/UserIcons';
import EmptyState from '@/components/EmptyState';

export interface GarmentPickerPageProps {
  /** 当前已选成衣 id 列表 */
  initialSelectedIds?: string[];
  /** 关闭回调（不确认） */
  onClose: () => void;
  /** 确认回调：回传勾选的全部成衣 id */
  onConfirm: (ids: string[]) => void;
}

const statusLabels: Record<string, string> = {
  planning: '计划中',
  in_progress: '制作中',
  completed: '已完成',
};

export default function GarmentPickerPage(props: GarmentPickerPageProps) {
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [localSelected, setLocalSelected] = useState<string[]>(props.initialSelectedIds ?? []);

  const rawGarments = useLiveQuery(() => db.garments.toArray(), []);
  const allGarments = useMemo(() => rawGarments ?? [], [rawGarments]);

  // 300ms 防抖（与既有 picker 同口径）
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filtered = useMemo(() => {
    let result = allGarments;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((g) => g.name.trim().toLowerCase().includes(q));
    }
    return [...result].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [allGarments, searchQuery]);

  const toggle = useCallback((id: string) => {
    setLocalSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const handleConfirm = useCallback(() => {
    props.onConfirm(localSelected);
  }, [props, localSelected]);

  const subLine = (g: Garment): string =>
    [g.category, g.size, statusLabels[g.status]].filter(Boolean).join(' · ');

  return (
    <div
      className="page garment-picker-page"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--background)' }}
    >
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={props.onClose}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">选择成衣</h1>
        <div className="right-actions" />
      </div>

      <div className="page-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="picker-tip">勾选成衣后点确认，可多选、可不选</div>

        <div className="search-bar">
          <span className="search-icon" style={{ color: 'var(--secondary-foreground)' }}>
            <IconSearch style={{ width: '16px', height: '16px' }} />
          </span>
          <input
            type="text"
            placeholder="搜成衣名称…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon="garments"
            title="没有匹配的成衣"
            description="可先去成衣库添加，再回来关联"
          />
        ) : (
          <div className="garment-picker-list">
            {filtered.map((g) => {
              const selected = localSelected.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  className={`linked-material-item garment-picker-row${selected ? ' selected' : ''}`}
                  onClick={() => toggle(g.id)}
                >
                  <div className="linked-material-icon">
                    <UserIconNavGarments style={{ width: '20px', height: '20px' }} />
                  </div>
                  <div className="linked-material-info">
                    <div className="linked-material-name">{g.name}</div>
                    {subLine(g) && <div className="linked-material-qty">{subLine(g)}</div>}
                  </div>
                  {selected && (
                    <span className="garment-picker-check">
                      <IconCheck style={{ width: '16px', height: '16px' }} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="garment-picker-footer">
        <button className="btn btn-secondary" onClick={props.onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={handleConfirm}>
          确定（{localSelected.length}）
        </button>
      </div>
    </div>
  );
}
