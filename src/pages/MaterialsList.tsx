// src/pages/MaterialsList.tsx — 物料列表页（PRD §8.2）
// UI 基线：demo/src/pages/MaterialsList.jsx
// 不复刻清单：标签/季节筛选按钮、页头右侧占位、纸样排序按名称、FAB不传类型、主键时间戳

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { MaterialType, NanoId12 } from '@/db/types';
import { useFilterStore, type StockFilter, type MaterialSortBy, type PatternUsedFilter, type PatternSortBy } from '@/store/filterStore';
import { IconSearch, IconPlus } from '@/components/Icons';
import MaterialCard from '@/components/MaterialCard';
import EmptyState from '@/components/EmptyState';

const tabs: { key: MaterialType; label: string }[] = [
  { key: 'fabric', label: '面料' },
  { key: 'accessory', label: '辅料' },
  { key: 'tool', label: '工具' },
  { key: 'pattern', label: '纸样' },
];

const stockOptions: { key: StockFilter; label: string }[] = [
  { key: 'all', label: '全部库存' },
  { key: 'in', label: '有库存' },
  { key: 'out', label: '无库存' },
];

const patternUsedOptions: { key: PatternUsedFilter; label: string }[] = [
  { key: 'unused', label: '未使用' },
  { key: 'used', label: '已使用' },
];

const patternSortOptions: { key: PatternSortBy; label: string }[] = [
  { key: 'rating', label: '星级' },
];

const otherSortOptions: { key: MaterialSortBy; label: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'quantity', label: '数量' },
];

const SEARCH_HISTORY_KEY = 'search_history';
const MAX_SEARCH_HISTORY = 10; // DM §4.16 冻结：截 10 条
const MAX_SEARCH_TERM_LEN = 30; // DM §4.16 冻结：每条 ≤ 30 字

function writeSearchHistory(term: string) {
  const trimmed = term.trim().slice(0, MAX_SEARCH_TERM_LEN);
  if (!trimmed) return;
  db.settings.get(SEARCH_HISTORY_KEY).then((rec) => {
    const prev: string[] = rec ? JSON.parse(rec.value) : [];
    // DM §4.16：不区分大小写去重，保留用户最后输入的写法
    const next = [trimmed, ...prev.filter((s) => s.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_SEARCH_HISTORY);
    db.settings.put({ key: SEARCH_HISTORY_KEY, value: JSON.stringify(next), updatedAt: new Date().toISOString() });
  });
}

export default function MaterialsList() {
  const navigate = useNavigate();
  const [activeType, setActiveType] = useState<MaterialType>('fabric');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const stockFilter = useFilterStore((s) => s.stockFilter);
  const sortBy = useFilterStore((s) => s.sortBy);
  const patternUsedFilter = useFilterStore((s) => s.patternUsedFilter);
  const patternSortBy = useFilterStore((s) => s.patternSortBy);
  const setStockFilter = useFilterStore((s) => s.setStockFilter);
  const setSortBy = useFilterStore((s) => s.setSortBy);
  const setPatternUsedFilter = useFilterStore((s) => s.setPatternUsedFilter);
  const setPatternSortBy = useFilterStore((s) => s.setPatternSortBy);

  const materialsRaw = useLiveQuery(() => db.materials.toArray(), []);
  const materials = useMemo(() => materialsRaw ?? [], [materialsRaw]);

  // 300ms 防抖搜索
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchInput.trim();
      setSearchQuery(trimmed);
      if (trimmed) writeSearchHistory(trimmed);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 筛选 + 排序
  const filteredMaterials = useMemo(() => {
    let result = [...materials];

    // 类型筛选
    result = result.filter((m) => m.type === activeType);

    // 搜索
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          (m.tags && m.tags.some((t) => t.toLowerCase().includes(q))),
      );
    }

    // 库存筛选（非纸样）
    if (activeType !== 'pattern') {
      if (stockFilter === 'in') {
        result = result.filter((m) => m.quantity > 0);
      } else if (stockFilter === 'out') {
        result = result.filter((m) => m.quantity <= 0);
      }
    }

    // 纸样：已使用 / 未使用筛选（按落库字段 used）
    if (activeType === 'pattern' && patternUsedFilter) {
      result = result.filter((m) => {
        if (patternUsedFilter === 'used') return m.used === 1;
        if (patternUsedFilter === 'unused') return m.used === 0;
        return true;
      });
    }

    // 排序
    if (activeType === 'pattern') {
      // 纸样：rating 降序 → updatedAt 降序 → id 升序（PRD §8.2 不复刻#3）
      if (patternSortBy === 'rating') {
        result.sort((a, b) => {
          const ar = a.rating || 0;
          const br = b.rating || 0;
          if (br !== ar) return br - ar;
          const ua = a.updatedAt || '';
          const ub = b.updatedAt || '';
          if (ua !== ub) return ub.localeCompare(ua);
          return a.id.localeCompare(b.id);
        });
      }
    } else {
      if (sortBy === 'name') {
        result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      } else if (sortBy === 'createdAt') {
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      } else if (sortBy === 'quantity') {
        result.sort((a, b) => b.quantity - a.quantity);
      }
    }

    return result;
  }, [materials, activeType, searchQuery, stockFilter, sortBy, patternUsedFilter, patternSortBy]);

  const handleOpenForm = useCallback(() => {
    navigate(`/materials/new?type=${activeType}`);
  }, [navigate, activeType]);

  const handleOpenDetail = useCallback(
    (id: NanoId12) => {
      navigate(`/materials/${id}`);
    },
    [navigate],
  );

  return (
    <>
      {/* 页头 */}
      <div className="page-header">
        <div className="left-actions" />
        <h1 className="title">物料库</h1>
        <div className="right-actions" />
      </div>

      {/* 四个类型页签 */}
      <div className="tabs-row" style={{ paddingBottom: '4px', paddingTop: '4px' }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`tab-item ${activeType === tab.key ? 'active' : ''}`}
            onClick={() => setActiveType(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 搜索栏 */}
      <div className="search-bar">
        <span className="search-icon" style={{ color: 'var(--muted)' }}>
          <IconSearch style={{ width: '16px', height: '16px' }} />
        </span>
        <input
          type="text"
          placeholder="搜名称、标签…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      {/* 筛选行（纸样：已使用/未使用；其他：库存筛选） */}
      {activeType === 'pattern' ? (
        <div className="filter-row">
          {patternUsedOptions.map((opt) => (
            <button
              key={opt.key}
              className={`filter-chip ${patternUsedFilter === opt.key ? 'active' : ''}`}
              onClick={() => setPatternUsedFilter(opt.key)}
            >
              {patternUsedFilter === opt.key && '✓ '}
              {opt.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="filter-row">
          {stockOptions.map((opt) => (
            <button
              key={opt.key}
              className={`filter-chip ${stockFilter === opt.key ? 'active' : ''}`}
              onClick={() => setStockFilter(opt.key)}
            >
              {stockFilter === opt.key && '✓ '}
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* 排序栏 */}
      <div className="sort-bar">
        {(activeType === 'pattern' ? patternSortOptions : otherSortOptions).map((s) => {
          const currentSort = activeType === 'pattern' ? patternSortBy : sortBy;
          return (
            <button
              key={s.key}
              className={`sort-btn ${currentSort === s.key ? 'active' : ''}`}
              onClick={() =>
                activeType === 'pattern'
                  ? setPatternSortBy(s.key as PatternSortBy)
                  : setSortBy(s.key as MaterialSortBy)
              }
            >
              {s.label}
              {currentSort === s.key && ' ↓'}
            </button>
          );
        })}
      </div>

      {/* 可滚动列表区 */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
        {filteredMaterials.length > 0 ? (
          <div className="material-grid" style={{ paddingBottom: '80px' }}>
            {filteredMaterials.map((m) => (
              <MaterialCard
                key={m.id}
                material={m}
                onClick={() => handleOpenDetail(m.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={activeType}
            title="还没有匹配的物料"
            description="试试调整筛选条件，或者添加第一个物料吧"
          />
        )}
      </div>

      {/* FAB 新增按钮 */}
      <button
        className="fab"
        onClick={handleOpenForm}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <IconPlus style={{ width: '28px', height: '28px', color: '#fff' }} />
      </button>
    </>
  );
}