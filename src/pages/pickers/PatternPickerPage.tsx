// src/pages/pickers/PatternPickerPage.tsx — 纸样选择器
// PRD §8.9；任务 3-5 + S3-FIX-B。
// UI 基线：demo/src/pages/PatternPickerPage.jsx
// 不复刻清单（PRD §8.9 缺陷表）：
//   #1 适用人群双口径兼容 → 本版只比较单值 forWhom
//   #2 搜索图标用未定义 var(--muted) → 用次级文字色
//   #3 搜索不做首尾空白 → 匹配前 trim
//   #4 品牌/分类 chips 由 Set 插入序 → 按列表首次出现序
//   #5 筛选条件同一 useMemo → 拆两段分别验证取交集
//
// 任务要求：
//   列表仅显示纸样类物料
//   已使用纸样可见、带「已使用」角标、使用状态筛选可筛「已使用」
//     （PRD §8.9：demo 允许第二件成衣复用同一纸样）
//   点击卡片即选中并返回
//   搜索 trim、排序 createdAt 降序
//
// S3-FIX-B 调整：
//   - P2-1：去掉整表隐藏已使用纸样的过滤，按 PRD §8.9 保留「已使用」角标 + 使用状态筛选
//   - P2-2：接收当前已选 patternId 入参，卡片右上角 ✓ 选中标记
//   - P2-3：images[0] 是 images 表主键 id，需经 images 表解析 blob URL
//   - P2-6：星级行收敛复用冻结 CSS 的 .pattern-picker-stars 类
//   - 支持 overlay 模式（受 GarmentForm 复用为页内浮层用，避免选择器往返导致表单卸载）

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Material } from '@/db/types';
import { IconBack, IconSearch } from '@/components/Icons';
import { UserIconCatPattern } from '@/components/UserIcons';
import EmptyState from '@/components/EmptyState';

interface PatternPickerPageProps {
  /** overlay 模式：当前已选 id（GarmentForm 复用） */
  initialSelectedId?: string;
  /** overlay 模式：关闭回调 */
  onClose?: () => void;
  /** overlay 模式：选中回调（点击卡片立即触发） */
  onSelect?: (pattern: Material) => void;
}

// 适用人群文案
const FOR_WHOM_LABELS: Record<string, string> = {
  women: '女性',
  men: '男性',
  children: '儿童',
  baby: '婴儿',
  pet: '宠物',
};

/** P2-3：图片 blob URL 解析（与 GarmentDetail/GarmentsPage 同构）。 */
function useBlobUrl(imageId: string | undefined): string {
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

/** 单张缩略图：images[0] 是主键 id，必须经 images 表解析。 */
function PatternThumb({ pattern }: { pattern: Material }) {
  const firstImageId = pattern.images?.[0];
  const blobUrl = useBlobUrl(firstImageId);
  if (blobUrl) {
    return <img src={blobUrl} alt={pattern.name} />;
  }
  return (
    <UserIconCatPattern style={{ width: '50%', height: '50%', color: 'var(--accent)' }} />
  );
}

export default function PatternPickerPage(props: PatternPickerPageProps = {}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const overlayMode = !!props.onClose && !!props.onSelect;

  // 入参：overlay 模式走 props，独立路由模式走 URL state
  const returnTo = searchParams.get('returnTo') || '/garments/new';
  const urlSelectedId = searchParams.get('selectedId') ?? undefined;
  const selectedId = overlayMode ? props.initialSelectedId : urlSelectedId;

  // 所有物料与成衣
  const rawMaterials = useLiveQuery(() => db.materials.toArray(), []);
  const allMaterials = useMemo(() => rawMaterials ?? [], [rawMaterials]);
  const rawGarments = useLiveQuery(() => db.garments.toArray(), []);
  const allGarments = useMemo(() => rawGarments ?? [], [rawGarments]);

  const patterns = useMemo(
    () => allMaterials.filter((m) => m.type === 'pattern'),
    [allMaterials],
  );

  // P2-1：不再整表隐藏已使用纸样，改为保留所有纸样，
  // 已使用状态由 isPatternUsed 判定、UI 上渲染「已使用」角标、并提供面板筛选
  const isPatternUsed = useCallback(
    (patternId: string) => allGarments.some((g) => g.patternId === patternId),
    [allGarments],
  );

  // ---- 状态 ----
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [brandFilter, setBrandFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [panelTags, setPanelTags] = useState<string[]>([]);
  const [panelForWhom, setPanelForWhom] = useState('');
  const [panelSize, setPanelSize] = useState('');
  const [panelUsedStatus, setPanelUsedStatus] = useState('all');

  // 300ms 防抖
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // ---- 派生（按列表返回顺序首次出现，PRD §8.9 缺陷 4） ----
  const allBrands = useMemo(() => {
    const seen = new Set<string>();
    const sorted = [...patterns].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const brands: string[] = ['all'];
    for (const p of sorted) {
      if (p.brand && !seen.has(p.brand)) { seen.add(p.brand); brands.push(p.brand); }
    }
    return brands;
  }, [patterns]);

  const allCategories = useMemo(() => {
    const seen = new Set<string>();
    const sorted = [...patterns].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const cats: string[] = ['all'];
    for (const p of sorted) {
      if (p.category && !seen.has(p.category)) { seen.add(p.category); cats.push(p.category); }
    }
    return cats;
  }, [patterns]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const p of patterns) {
      for (const t of p.tags ?? []) { if (t) tags.add(t); }
    }
    return [...tags];
  }, [patterns]);

  const allSizes = useMemo(() => {
    const sizes = new Set<string>();
    for (const p of patterns) { if (p.size) sizes.add(p.size); }
    return [...sizes];
  }, [patterns]);

  // ---- 筛选（P2-1：基于全量 patterns，不再受 availablePatterns 影响） ----
  const filteredPatterns = useMemo(() => {
    let result = patterns;

    if (brandFilter !== 'all') result = result.filter((p) => p.brand === brandFilter);
    if (categoryFilter !== 'all') result = result.filter((p) => p.category === categoryFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (p) =>
          p.name.trim().toLowerCase().includes(q) ||
          (p.brand ?? '').trim().toLowerCase().includes(q) ||
          (p.tags ?? []).some((t) => t.trim().toLowerCase().includes(q)),
      );
    }

    if (panelTags.length > 0) {
      result = result.filter((p) => panelTags.every((tag) => (p.tags ?? []).includes(tag)));
    }
    if (panelForWhom) result = result.filter((p) => p.forWhom === panelForWhom);
    if (panelSize) result = result.filter((p) => p.size === panelSize);
    if (panelUsedStatus !== 'all') {
      result = result.filter((p) => {
        const used = isPatternUsed(p.id);
        return panelUsedStatus === 'used' ? used : !used;
      });
    }

    return [...result].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [patterns, brandFilter, categoryFilter, searchQuery, panelTags, panelForWhom, panelSize, panelUsedStatus, isPatternUsed]);

  // ---- 操作 ----
  const handleSelect = useCallback(
    (pattern: Material) => {
      if (overlayMode && props.onSelect) {
        props.onSelect(pattern);
        return;
      }
      navigate(returnTo, { state: { patternPickerResult: { patternId: pattern.id } } });
    },
    [navigate, returnTo, overlayMode, props],
  );

  const handleBack = useCallback(() => {
    if (overlayMode && props.onClose) {
      props.onClose();
      return;
    }
    navigate(-1);
  }, [navigate, overlayMode, props]);

  const toggleTag = useCallback(
    (tag: string) => setPanelTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])),
    [],
  );

  const resetPanel = useCallback(() => {
    setPanelTags([]);
    setPanelForWhom('');
    setPanelSize('');
    setPanelUsedStatus('all');
  }, []);

  // P2-6：星级行复用 .pattern-picker-stars（冻结 CSS 仅字号 10px；高亮/灰由内联色控制）
  const renderStars = useCallback((rating: number | undefined) => {
    if (!rating || rating <= 0) return null;
    return (
      <span className="pattern-picker-stars">
        {Array.from({ length: 5 }, (_, i) => (
          <span
            key={i}
            style={{ color: i < rating ? '#FFC107' : '#E0E0E0' }}
          >★</span>
        ))}
      </span>
    );
  }, []);

  // ---- 渲染 ----
  const pageStyle = overlayMode
    ? { position: 'fixed' as const, inset: 0, zIndex: 1000, background: 'var(--background)' }
    : undefined;

  return (
    <div className="page pattern-picker-page" style={pageStyle}>
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={handleBack}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">选择纸样</h1>
        <div className="right-actions">
          <button className="picker-filter-btn" onClick={() => setShowFilterPanel(true)}>筛选</button>
        </div>
      </div>

      <div className="page-content pattern-picker-content">
        <div className="picker-tip">点击卡片完成选择</div>

        <div className="search-bar">
          <span className="search-icon" style={{ color: 'var(--secondary-foreground)' }}>
            <IconSearch style={{ width: '16px', height: '16px' }} />
          </span>
          <input type="text" placeholder="搜名称、品牌、标签…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>

        {/* 品牌 */}
        <div className="picker-filter-box">
          <div className="picker-filter-label">品牌</div>
          <div className="chips-scroll-row">
            {allBrands.map((b) => (
              <button key={b} className={'picker-chip' + (brandFilter === b ? ' active' : '')} onClick={() => setBrandFilter(b)} type="button">
                {b === 'all' ? '全部' : b}
              </button>
            ))}
          </div>
        </div>

        {/* 分类 */}
        <div className="picker-filter-box">
          <div className="picker-filter-label">分类</div>
          <div className="chips-scroll-row">
            {allCategories.map((c) => (
              <button key={c} className={'picker-chip' + (categoryFilter === c ? ' active' : '')} onClick={() => setCategoryFilter(c)} type="button">
                {c === 'all' ? '全部' : c}
              </button>
            ))}
          </div>
        </div>

        {/* 卡片 */}
        {filteredPatterns.length === 0 ? (
          <EmptyState icon="pattern" title="没有匹配的纸样" description="试试调整筛选条件" />
        ) : (
          <div className="pattern-picker-grid">
            {filteredPatterns.map((p) => {
              const used = isPatternUsed(p.id);
              const isSelected = selectedId === p.id;
              return (
                <button
                  key={p.id}
                  className={'pattern-picker-card' + (isSelected ? ' selected' : '')}
                  onClick={() => handleSelect(p)}
                  type="button"
                >
                  <div className="pattern-picker-thumb">
                    <PatternThumb pattern={p} />
                    {used && <span className="pattern-used-badge">已使用</span>}
                  </div>
                  <div className="pattern-picker-info">
                    <div className="pattern-picker-name">{p.name}</div>
                    <div className="pattern-picker-meta">
                      {p.size && <span className="pattern-size-chip">{p.size}</span>}
                      {renderStars(p.rating)}
                    </div>
                    <div className="pattern-picker-brand">{p.brand || '未知品牌'}</div>
                  </div>
                  {/* P2-2：当前已选 patternId 的卡片右上角 ✓ 选中标记 */}
                  {isSelected && <div className="pattern-picker-check">✓</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 筛选面板 */}
      {showFilterPanel && (
        <div className="filter-panel-overlay" onClick={() => setShowFilterPanel(false)}>
          <div className="filter-panel-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="filter-panel-header">
              <span style={{ fontWeight: 600, fontSize: '16px' }}>筛选</span>
              <button className="filter-panel-reset" onClick={resetPanel}>重置</button>
            </div>
            <div className="filter-panel-body">
              {allTags.length > 0 && (
                <div className="filter-panel-section">
                  <div className="filter-panel-label">标签</div>
                  <div className="filter-panel-chips">
                    {allTags.map((tag) => (
                      <button key={tag} className={'panel-chip' + (panelTags.includes(tag) ? ' active' : '')} onClick={() => toggleTag(tag)} type="button">{tag}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="filter-panel-section">
                <div className="filter-panel-label">适用人群</div>
                <div className="filter-panel-chips">
                  {[{ key: '', label: '全部' }, ...Object.entries(FOR_WHOM_LABELS).map(([k, v]) => ({ key: k, label: v }))].map((opt) => (
                    <button key={opt.key} className={'panel-chip' + (panelForWhom === opt.key ? ' active' : '')} onClick={() => setPanelForWhom(opt.key)} type="button">{opt.label}</button>
                  ))}
                </div>
              </div>
              {allSizes.length > 0 && (
                <div className="filter-panel-section">
                  <div className="filter-panel-label">尺码</div>
                  <div className="filter-panel-chips">
                    {['', ...allSizes].map((s) => (
                      <button key={s || 'all'} className={'panel-chip' + (panelSize === s ? ' active' : '')} onClick={() => setPanelSize(s)} type="button">{s || '全部'}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="filter-panel-section">
                <div className="filter-panel-label">使用状态</div>
                <div className="filter-panel-chips">
                  {[{ key: 'all', label: '全部' }, { key: 'unused', label: '未使用' }, { key: 'used', label: '已使用' }].map((opt) => (
                    <button key={opt.key} className={'panel-chip' + (panelUsedStatus === opt.key ? ' active' : '')} onClick={() => setPanelUsedStatus(opt.key)} type="button">{opt.label}</button>
                  ))}
                </div>
              </div>
            </div>
            <div className="filter-panel-footer">
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setShowFilterPanel(false)}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}