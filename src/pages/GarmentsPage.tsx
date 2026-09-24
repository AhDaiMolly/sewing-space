// src/pages/GarmentsPage.tsx — 成衣库列表页（S3-B）
// PRD §8.5：四页签（全部/规划中/制作中/已完成）+ 页内搜索 + 2 列卡片网格 +
// FAB 悬浮新增按钮。UI 基线：demo/src/pages/GarmentsPage.jsx，
// 缺陷对照 PRD §8.5「参照实现缺陷」+ §15.5 不复刻清单逐条修正。

import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Garment, GarmentStatus } from '@/db/types';
import { useFilterStore } from '@/store/filterStore';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { IconSearch } from '@/components/Icons';
import { UserIconNavGarments } from '@/components/UserIcons';

// ── 常量 ──

const STATUS_OPTIONS: { key: 'all' | GarmentStatus; label: string }[] = [
  { key: 'all',          label: '全部' },
  { key: 'planning',     label: '规划中' },
  { key: 'in_progress',  label: '制作中' },
  { key: 'completed',    label: '已完成' },
];

const STATUS_LABELS: Record<GarmentStatus, string> = {
  planning: '规划中',
  in_progress: '制作中',
  completed: '已完成',
};

/** 金额格式函数：两位小数（PRD §6）。 */
function fmtCurrency(v: number): string {
  return `¥${v.toFixed(2)}`;
}

/** 图片 blob URL 解析 hook（useState 不存 useRef，S2 P1-2 教训）。 */
function useThumbnailSrc(imageId: string | undefined): string {
  const imgRec = useLiveQuery(
    () => (imageId ? db.images.get(imageId) : undefined),
    [imageId],
  );
  const [src, setSrc] = useState('');
  useEffect(() => {
    if (imgRec?.blob) {
      const url = URL.createObjectURL(imgRec.blob);
      setSrc(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setSrc('');
  }, [imgRec]);
  return src;
}

// ── 子组件：单张成衣卡片（内联，不复刻 MaterialCard） ──

function GarmentCard({
  garment,
  onClick,
}: {
  garment: Garment;
  onClick: () => void;
}) {
  const thumbSrc = useThumbnailSrc(garment.images?.[0]);

  return (
    <div className="garment-card" onClick={onClick}>
      <div className={`garment-thumb ${thumbSrc ? 'has-image' : ''}`}>
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={garment.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <UserIconNavGarments style={{ width: '55%', height: '55%' }} />
        )}
        <span className={`garment-status-badge ${garment.status}`}>
          {STATUS_LABELS[garment.status]}
        </span>
      </div>
      <div className="garment-info">
        <div className="garment-name">{garment.name}</div>
        <div className="garment-meta">
          {garment.category && (
            <span className="garment-category-tag">{garment.category}</span>
          )}
          {garment.size && <span>{garment.size}</span>}
        </div>
        {garment.totalCost != null ? (
          <div className="garment-cost">{fmtCurrency(garment.totalCost)}</div>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--secondary-foreground)' }}>
            未核算
          </div>
        )}
        {/* 不显示累计采购数字（PRD §8.5 验收点） */}
      </div>
    </div>
  );
}

// ── 主组件 ──

export default function GarmentsPage() {
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // filterStore 分片
  const statusFilter = useFilterStore((s) => s.garmentStatusFilter);
  const setStatusFilter = useFilterStore((s) => s.setGarmentStatusFilter);
  const searchOpen = useFilterStore((s) => s.garmentSearchOpen);
  const setSearchOpen = useFilterStore((s) => s.setGarmentSearchOpen);

  // 搜索输入态（本地 state，300ms 防抖后生效）
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // 款式筛选（P2-4：按 PRD §8.5 放开，与 garment.category 全等比较，「全部款式」不过滤）
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 搜索框随展开态自动聚焦
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  // 全量成衣
  const garmentsRaw = useLiveQuery(() => db.garments.toArray(), []);
  const garments = useMemo(() => garmentsRaw ?? [], [garmentsRaw]);

  // 分类 chip 候选：按 createdAt 降序首次出现顺序（PRD §8.5 缺陷 6）
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const cats: string[] = [];
    const sorted = [...garments].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const g of sorted) {
      if (g.category && !seen.has(g.category)) {
        seen.add(g.category);
        cats.push(g.category);
      }
    }
    return cats;
  }, [garments]);

  // 筛选 + 搜索
  const filtered = useMemo(() => {
    let arr = [...garments];

    // 状态筛选
    if (statusFilter !== 'all') {
      arr = arr.filter((g) => g.status === statusFilter);
    }

    // 款式筛选（PRD §8.5：与 garment.category 全等比较；「全部款式」不过滤）
    if (categoryFilter !== 'all') {
      arr = arr.filter((g) => g.category === categoryFilter);
    }

    // 搜索：trim + 小写 + 三选一命中（名称 / 标签 / 款式）
    const q = searchQuery.trim();
    if (q) {
      const ql = q.toLowerCase();
      arr = arr.filter(
        (g) =>
          g.name.toLowerCase().includes(ql) ||
          (g.tags?.some((t) => t.toLowerCase().includes(ql)) ?? false) ||
          (g.category?.toLowerCase().includes(ql) ?? false),
      );
    }

    // 排序：createdAt 降序
    arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return arr;
  }, [garments, statusFilter, categoryFilter, searchQuery]);

  // ── 空态判定 ──
  const isEmptyDb = garments.length === 0;
  const isEmptySearch = !isEmptyDb && filtered.length === 0 && statusFilter === 'all' && !searchQuery.trim();
  const isEmptyFiltered = !isEmptyDb && filtered.length === 0 && !(isEmptySearch);

  return (
    <div className="page garments-page">
      <PageHeader title="成衣库" />

      <div className="garments-scroll-body">
        {/* ===== 搜索框 ===== */}
        {/* PRD §8.5 缺陷 2：用独立布尔量控制可见性，不让输入状态参与自身可见性判断 */}
        {searchOpen && (
          <div style={{ padding: '0 16px 12px' }}>
            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                background: 'var(--card)',
                borderRadius: '10px',
                padding: '0 12px',
                height: '40px',
              }}
            >
              <IconSearch
                style={{
                  width: '16px',
                  height: '16px',
                  color: 'var(--secondary-foreground)',
                  flexShrink: 0,
                }}
              />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="搜名称、标签、款式…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{
                  flex: 1,
                  marginLeft: '8px',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: '14px',
                  color: 'var(--foreground)',
                }}
              />
              {/* 清空按钮 */}
              {searchInput && (
                <button
                  onClick={() => {
                    setSearchInput('');
                    setSearchQuery('');
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '16px',
                    color: 'var(--muted-foreground)',
                    cursor: 'pointer',
                    padding: '4px',
                    lineHeight: 1,
                  }}
                  aria-label="清空搜索"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}

        {/* ===== 筛选区 ===== */}
        <div className="garment-filters">
          {/* 状态筛选 chip */}
          <div className="status-filter-row">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                className={`status-chip${statusFilter === opt.key ? ' active' : ''}`}
                onClick={() => setStatusFilter(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* 款式 chip（PRD §8.5：放开成衣列表的款式筛选） */}
          {categoryOptions.length > 0 && (
            <div className="chip-filter-row">
              <button
                key="__all__"
                className={`chip-filter${categoryFilter === 'all' ? ' active' : ''}`}
                onClick={() => setCategoryFilter('all')}
              >
                全部款式
              </button>
              {categoryOptions.map((cat) => (
                <button
                  key={cat}
                  className={`chip-filter${categoryFilter === cat ? ' active' : ''}`}
                  onClick={() => setCategoryFilter(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ===== 列表 / 空态 ===== */}
        {isEmptyDb ? (
          // 成衣库一行都没有
          <EmptyState
            icon="garments"
            title="还没有成衣"
            desc="点右下角 + 添加第一件"
          />
        ) : isEmptySearch || isEmptyFiltered ? (
          // 有数据但筛选/搜索后为 0
          <EmptyState
            icon="garments"
            title="没有匹配的成衣"
            desc="换个筛选条件或清空搜索试试"
          />
        ) : (
          <div className="garments-grid">
            {filtered.map((garment) => (
              <GarmentCard
                key={garment.id}
                garment={garment}
                onClick={() => navigate(`/garments/${garment.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ===== 页头右：搜索图标按钮 ===== */}
      {/* PRD §8.5 缺陷 1：点击必须真正展开搜索框并聚焦，不是只弹 toast */}
      <button
        className="icon-btn"
        onClick={() => {
          if (!searchOpen) {
            setSearchOpen(true);
          } else {
            // 再次点击折叠搜索框并清空搜索
            setSearchOpen(false);
            setSearchInput('');
            setSearchQuery('');
          }
        }}
        style={{
          position: 'fixed',
          top: '14px',
          right: '16px',
          zIndex: 10,
          background: 'none',
          border: 'none',
          color: 'var(--secondary-foreground)',
          cursor: 'pointer',
          padding: '8px',
        }}
        aria-label={searchOpen ? '关闭搜索' : '打开搜索'}
      >
        <IconSearch style={{ width: '20px', height: '20px' }} />
      </button>

      {/* ===== FAB 悬浮新增按钮 ===== */}
      <button
        className="fab-btn"
        style={{
          position: 'fixed',
          right: '16px',
          bottom: '84px',
          width: '52px',
          height: '52px',
          borderRadius: '50%',
          background: 'var(--primary)',
          color: 'white',
          fontSize: '28px',
          fontWeight: 300,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px rgba(255,143,176,0.4)',
          zIndex: 20,
          border: 'none',
        }}
        onClick={() => navigate('/garments/new')}
        aria-label="新建成衣"
      >
        +
      </button>
    </div>
  );
}