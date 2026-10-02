// src/pages/MaterialsList.tsx — 物料列表页（PRD §8.2）
// UI 基线：demo/src/pages/MaterialsList.jsx
// 不复刻清单：标签/季节筛选按钮、页头右侧占位、纸样排序按名称、FAB不传类型、主键时间戳

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { MaterialType, NanoId12 } from '@/db/types';
import { useFilterStore, patternSortByForUsed, type StockFilter, type MaterialSortBy, type PatternUsedFilter, type PatternSortBy } from '@/store/filterStore';
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

// AD-B 物料14：纸样排序选项随使用状态区分——
// 「未使用」仅提供购入时间（由近及远，默认），不提供星级；
// 「已使用」仅提供星级（默认），不提供购入时间。
const patternSortOptionsFor = (used: PatternUsedFilter): { key: PatternSortBy; label: string }[] =>
  used === 'used' ? [{ key: 'rating', label: '星级' }] : [{ key: 'purchaseDate', label: '购入时间' }];

const otherSortOptions: { key: MaterialSortBy; label: string }[] = [
  // AA-C 物料2：新增「购入时间」排序（面料/工具的默认排序，由近及远）
  // AD-B 物料10：去掉「创建时间」排序项，所有排序统一购入时间（默认由近及远）
  { key: 'purchaseDate', label: '购入时间' },
  { key: 'name', label: '名称' },
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
  // AA-C 物料1：页签/搜索词迁入 filterStore（内存态），详情返回后恢复；
  // searchQuery 仍为组件内防抖派生态，初始值直接取恢复的搜索词（返回时不闪全量列表）。
  const activeType = useFilterStore((s) => s.materialTab);
  const setActiveType = useFilterStore((s) => s.setMaterialTab);
  const searchInput = useFilterStore((s) => s.materialSearch);
  const setSearchInput = useFilterStore((s) => s.setMaterialSearch);
  const [searchQuery, setSearchQuery] = useState(searchInput);

  const stockFilter = useFilterStore((s) => s.stockFilter);
  // AA-C 物料2：排序按品类独立记忆（面料/工具默认购入时间，辅料维持创建时间）
  const sortByMap = useFilterStore((s) => s.sortByMap);
  const setSortByFor = useFilterStore((s) => s.setSortByFor);
  const patternUsedFilter = useFilterStore((s) => s.patternUsedFilter);
  const patternSortBy = useFilterStore((s) => s.patternSortBy);
  const setStockFilter = useFilterStore((s) => s.setStockFilter);
  const setPatternUsedFilter = useFilterStore((s) => s.setPatternUsedFilter);
  const setPatternSortBy = useFilterStore((s) => s.setPatternSortBy);

  const materialsRaw = useLiveQuery(() => db.materials.toArray(), []);
  const materials = useMemo(() => materialsRaw ?? [], [materialsRaw]);

  // 列表滚动容器（AA-C 物料1：离开时记录 scrollTop，返回时回填）
  // 注意：卸载时 React 已把 scrollRef 置 null，passive cleanup 里读不到 DOM 节点——
  // 用 onScroll 持续镜像 scrollTop 到 scrollTopRef，卸载时读镜像值。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (scrollRestoredRef.current || materialsRaw === undefined) return;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = useFilterStore.getState().materialScrollTop;
      scrollTopRef.current = scrollRef.current.scrollTop;
      scrollRestoredRef.current = true;
    }
  }, [materialsRaw]);
  useEffect(
    () => () => {
      useFilterStore.getState().setMaterialScrollTop(scrollTopRef.current);
    },
    [],
  );

  // 300ms 防抖搜索（AA-C 物料1：首帧为恢复值，不重复写搜索历史）
  const searchHistoryReadyRef = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchInput.trim();
      setSearchQuery(trimmed);
      if (searchHistoryReadyRef.current && trimmed) writeSearchHistory(trimmed);
      searchHistoryReadyRef.current = true;
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 筛选 + 排序
  const filteredMaterials = useMemo(() => {
    let result = [...materials];

    // 类型筛选
    result = result.filter((m) => m.type === activeType);

    // 搜索（AA-D 物料10：不匹配标签；纸样按 名称+品牌+尺码，其余按 名称+品牌+分类）
    // AD-B 物料13/15：与 AA-D 口径对齐——面料/辅料 名称+品牌+分类；
    // 工具去掉分类维度（物料15 分类字段不展示），仅 名称+品牌。
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((m) => {
        const nameHit = m.name.toLowerCase().includes(q);
        const brandHit = !!m.brand && m.brand.toLowerCase().includes(q);
        if (activeType === 'pattern') {
          const sizeHit = !!m.size && m.size.toLowerCase().includes(q);
          return nameHit || brandHit || sizeHit;
        }
        if (activeType === 'tool') return nameHit || brandHit;
        const categoryHit = !!m.category && m.category.toLowerCase().includes(q);
        return nameHit || brandHit || categoryHit;
      });
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

    // 排序（AA-C 物料2：非纸样按品类独立记忆的排序键）
    // AD-B 物料10：遗留 'createdAt' 偏好兜底归一为「购入时间」（下拉已无创建时间项）
    const rawSortBy = activeType === 'pattern' ? patternSortBy : sortByMap[activeType];
    const sortBy = rawSortBy === 'createdAt' ? 'purchaseDate' : rawSortBy;
    if (activeType === 'pattern') {
      // AD-B 物料14：纸样排序随使用状态联动（未使用=购入时间由近及远；已使用=星级降序）。
      // patternSortBy 由 setPatternUsedFilter 联动维护，此处按使用状态归一兜底，双保险。
      const effectivePatternSort = patternSortByForUsed(patternUsedFilter);
      if (effectivePatternSort === 'rating') {
        // 纸样：rating 降序 → updatedAt 降序 → id 升序（PRD §8.2 不复刻#3）
        result.sort((a, b) => {
          const ar = a.rating || 0;
          const br = b.rating || 0;
          if (br !== ar) return br - ar;
          const ua = a.updatedAt || '';
          const ub = b.updatedAt || '';
          if (ua !== ub) return ub.localeCompare(ua);
          return a.id.localeCompare(b.id);
        });
      } else {
        // 纸样：购入时间由近及远（口径同非纸样：purchaseDate 降序 → createdAt 降序 → id 升序）
        result.sort((a, b) => {
          const d = (b.purchaseDate || '').localeCompare(a.purchaseDate || '');
          if (d !== 0) return d;
          const c = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (c !== 0) return c;
          return a.id.localeCompare(b.id);
        });
      }
    } else {
      if (sortBy === 'name') {
        result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      } else if (sortBy === 'purchaseDate') {
        // AA-C 物料2：购入时间由近及远（YYYY-MM-DD 字典序=时间序）；同日再按创建时间、id 稳定排序
        result.sort((a, b) => {
          const d = (b.purchaseDate || '').localeCompare(a.purchaseDate || '');
          if (d !== 0) return d;
          const c = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (c !== 0) return c;
          return a.id.localeCompare(b.id);
        });
      } else if (sortBy === 'quantity') {
        result.sort((a, b) => b.quantity - a.quantity);
      }
    }

    return result;
  }, [materials, activeType, searchQuery, stockFilter, sortByMap, patternUsedFilter, patternSortBy]);

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

      {/* 四个类型页签（AD-B 物料9：切换页签时 store 同步清空搜索词，进入干净搜索态） */}
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
          placeholder={
            activeType === 'pattern'
              ? '搜名称、品牌、尺码…'
              : activeType === 'tool'
                ? '搜名称、品牌…'
                : '搜名称、品牌、分类…'
          }
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

      {/* 排序栏（AD-B 物料14：纸样排序选项随使用状态派生） */}
      <div className="sort-bar">
        {(activeType === 'pattern' ? patternSortOptionsFor(patternUsedFilter) : otherSortOptions).map((s) => {
          const currentSort =
            activeType === 'pattern'
              ? patternSortByForUsed(patternUsedFilter)
              : sortByMap[activeType] === 'createdAt'
                ? 'purchaseDate'
                : sortByMap[activeType];
          return (
            <button
              key={s.key}
              className={`sort-btn ${currentSort === s.key ? 'active' : ''}`}
              onClick={() =>
                activeType === 'pattern'
                  ? setPatternSortBy(s.key as PatternSortBy)
                  : setSortByFor(activeType, s.key as MaterialSortBy)
              }
            >
              {s.label}
              {currentSort === s.key && ' ↓'}
            </button>
          );
        })}
      </div>

      {/* AA-C 物料3：当前筛选条件下的种类数（页签 + 搜索 + 筛选全部生效，随条件实时变化） */}
      <div
        className="list-count-row"
        style={{
          padding: '6px 16px 8px',
          fontSize: '13px',
          color: 'var(--secondary-foreground)',
          textAlign: 'right',
        }}
      >
        共 {filteredMaterials.length} 种
      </div>

      {/* 可滚动列表区（AA-C 物料1：挂 ref 记录/恢复滚动位置） */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
        }}
        className={activeType === 'pattern' ? 'pattern-list-pink' : undefined}
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
      >
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