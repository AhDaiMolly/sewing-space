// MaterialPickerPage — 物料选择器独立页面（PRD 模块 S2 第 2-8 步）
// 独立路由打开、回传选中 id 数组、隐藏零库存物料；供 S3 成衣表单复用。
// UI 基线：demo/src/pages/MaterialPickerPage.jsx
// 不复刻清单（与 demo 比较）：
//   - demo 用 React.createElement，本版用 JSX（项目统一）
//   - demo 不隐藏零库存物料（显示"无库存"badge），本版按需求隐藏
//
// S3-FIX-B 调整：
//   - P1-2：编辑态打开选择器必须传入并回显当前已选 materialIds 与用量（选中态+数量）。
//     实现：overlay 模式下从 props 接收 initialSelectedIds / initialQtys 并填入 localSelected / localQtys。
//   - 支持 overlay 模式（受 GarmentForm 复用为页内浮层，避免选择器往返导致表单卸载）。

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { Material, MaterialType } from '@/db/types';
import { IconBack, IconSearch } from '@/components/Icons';
import {
  UserIconCatFabric,
  UserIconCatAccessory,
  UserIconCatTool,
} from '@/components/UserIcons';
import EmptyState from '@/components/EmptyState';
import { toast } from '@/store/toastStore';

const TYPE_LABELS: Record<string, string> = {
  fabric: '面料',
  accessory: '辅料',
  tool: '工具',
  pattern: '纸样',
};

interface MaterialPickerPageProps {
  /** overlay 模式：当前已选 id 列表（GarmentForm 复用） */
  initialSelectedIds?: string[];
  /** overlay 模式：当前已选用量映射（GarmentForm 复用） */
  initialQtys?: Record<string, string>;
  /** overlay 模式：物料类型 */
  initialType?: MaterialType;
  /** overlay 模式：关闭回调 */
  onClose?: () => void;
  /** overlay 模式：确认回调 */
  onConfirm?: (ids: string[], qtys: Record<string, string>) => void;
}

export default function MaterialPickerPage(props: MaterialPickerPageProps = {}) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const overlayMode = !!props.onClose && !!props.onConfirm;

  // 路由参数（独立路由模式）
  const urlTypeParam = (searchParams.get('type') as MaterialType) || 'fabric';
  const returnTo = searchParams.get('returnTo') || '/garments/new';
  const multi = searchParams.get('multi') !== 'false'; // 默认多选
  const urlSelectedParam = searchParams.get('selectedIds');
  const urlQtysParam = searchParams.get('qtys');

  // 类型：overlay 模式走 props，独立路由模式走 URL
  const typeParam = overlayMode ? (props.initialType ?? 'fabric') : urlTypeParam;
  // P1-2：编辑态预选回显
  const initialSelectedFromUrl: string[] = useMemo(() => {
    if (!urlSelectedParam) return [];
    try {
      const parsed = JSON.parse(urlSelectedParam);
      return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }, [urlSelectedParam]);
  const initialQtysFromUrl: Record<string, string> = useMemo(() => {
    if (!urlQtysParam) return {};
    try {
      const parsed = JSON.parse(urlQtysParam);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }, [urlQtysParam]);
  const initialSelected = overlayMode
    ? (props.initialSelectedIds ?? [])
    : initialSelectedFromUrl;
  const initialQtys = overlayMode
    ? (props.initialQtys ?? {})
    : initialQtysFromUrl;

  // 所有物料
  const allMaterials = useLiveQuery(() => db.materials.toArray(), []);

  // 按 type 过滤
  const typeMaterials = useMemo(
    () => (allMaterials ?? []).filter((m) => m.type === typeParam),
    [allMaterials, typeParam],
  );

  // 状态：P1-2 预填选中与用量
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [localSelected, setLocalSelected] = useState<string[]>(initialSelected);
  const [localQtys, setLocalQtys] = useState<Record<string, string>>({ ...initialQtys });
  // P1-3：超库存标记（标红输入框，提交时拦截）
  const [overStockIds, setOverStockIds] = useState<Record<string, boolean>>({});

  // typeParam 变化时（例如 overlay 切换面料/辅料），重置预填
  useEffect(() => {
    setLocalSelected(initialSelected);
    setLocalQtys({ ...initialQtys });
    setOverStockIds({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeParam]);

  // 300ms 防抖搜索
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 提取分类
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    typeMaterials.forEach((m) => {
      if (m.category) set.add(m.category);
    });
    return ['all', ...Array.from(set)];
  }, [typeMaterials]);

  // 筛选结果（隐藏零库存物料，除非已选中）
  const filteredMaterials = useMemo(() => {
    return typeMaterials.filter((m) => {
      // 隐藏零库存且未选中
      if (m.quantity <= 0 && !localSelected.includes(m.id)) return false;
      if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
      if (searchQuery) {
        const q = searchQuery.trim().toLowerCase();
        if (
          !m.name.trim().toLowerCase().includes(q) &&
          !(m.brand || '').trim().toLowerCase().includes(q) &&
          !(m.tags || []).some((t) => t.trim().toLowerCase().includes(q))
        )
          return false;
      }
      return true;
    });
  }, [typeMaterials, categoryFilter, searchQuery, localSelected]);

  // 排序：createdAt 降序（PRD §8.8）
  const sortedMaterials = useMemo(() => {
    return [...filteredMaterials].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [filteredMaterials]);

  const toggleMaterial = useCallback(
    (matId: string) => {
      setLocalSelected((prev) => {
        if (prev.includes(matId)) {
          return prev.filter((id) => id !== matId);
        }
        if (!multi && prev.length > 0) {
          // 单选模式：替换
          return [matId];
        }
        return [...prev, matId];
      });
      setLocalQtys((prev) => {
        if (!prev[matId]) {
          return { ...prev, [matId]: '1' };
        }
        return prev;
      });
    },
    [multi],
  );

  const updateQty = useCallback(
    (matId: string, val: string, mat: Material) => {
      const num = val === '' ? 0 : parseFloat(val) || 0;
      const stock = mat.quantity || 0;
      // P1-3：不静默封顶，保留用户原始输入，标红提示
      if (num > stock) {
        setOverStockIds((prev) => ({ ...prev, [matId]: true }));
      } else {
        setOverStockIds((prev) => {
          if (!prev[matId]) return prev;
          const next = { ...prev };
          delete next[matId];
          return next;
        });
      }
      setLocalQtys((prev) => ({
        ...prev,
        [matId]: val,
      }));
    },
    [],
  );

  const stepQty = useCallback(
    (matId: string, delta: number, mat: Material) => {
      const step = typeParam === 'fabric' ? 0.5 : 1;
      const current = parseFloat(localQtys[matId] ?? '') || 0;
      let next = Number((current + delta * step).toFixed(2));
      if (next < 0) next = 0;
      const stock = mat.quantity || 0;
      // P1-3：不静默封顶，超限时保留计算值并标红
      if (next > stock) {
        setOverStockIds((prev) => ({ ...prev, [matId]: true }));
      } else {
        setOverStockIds((prev) => {
          if (!prev[matId]) return prev;
          const nextMap = { ...prev };
          delete nextMap[matId];
          return nextMap;
        });
      }
      setLocalQtys((prev) => ({
        ...prev,
        [matId]: next === 0 ? '' : String(next),
      }));
    },
    [localQtys, typeParam],
  );

  const handleConfirm = useCallback(() => {
    // P1-3：提交时汇总校验超限项，拦截并提示
    const overStockList = localSelected.filter((id) => overStockIds[id]);
    if (overStockList.length > 0) {
      const names = overStockList
        .map((id) => {
          const m = typeMaterials.find((x) => x.id === id);
          return m ? `「${m.name}」` : '';
        })
        .filter(Boolean)
        .join('、');
      toast(`以下物料用量超过库存：${names}`);
      return;
    }
    const resultIds = localSelected.filter((id) => {
      const q = parseFloat(localQtys[id] ?? '') || 0;
      return q > 0;
    });
    if (overlayMode && props.onConfirm) {
      props.onConfirm(resultIds, localQtys);
      return;
    }
    // 通过 URL state 回传选中结果
    navigate(returnTo, {
      state: {
        materialPickerResult: {
          ids: resultIds,
          qtys: localQtys,
        },
      },
    });
  }, [localSelected, localQtys, overStockIds, typeMaterials, navigate, returnTo, overlayMode, props]);

  const handleBack = useCallback(() => {
    if (overlayMode && props.onClose) {
      props.onClose();
      return;
    }
    navigate(-1);
  }, [navigate, overlayMode, props]);

  // 成本预览（P1-4：计数只按用量>0，与价格解耦）
  const costPreview = useMemo(() => {
    let total = 0;
    let count = 0;
    localSelected.forEach((id) => {
      const mat = typeMaterials.find((m) => m.id === id);
      if (!mat) return;
      const qty = parseFloat(localQtys[id] ?? '') || 0;
      if (qty > 0) {
        count++;
        if (mat.purchasePrice != null) {
          total += qty * mat.purchasePrice;
        }
      }
    });
    return { total: Number(total.toFixed(2)), count };
  }, [localSelected, localQtys, typeMaterials]);

  const pageTitle = `选择${TYPE_LABELS[typeParam] || '物料'}`;

  const IconComp =
    typeParam === 'fabric'
      ? UserIconCatFabric
      : typeParam === 'accessory'
        ? UserIconCatAccessory
        : UserIconCatTool;

  const pageStyle = overlayMode
    ? { position: 'fixed' as const, inset: 0, zIndex: 1000, background: 'var(--background)' }
    : undefined;

  return (
    <div className="page pattern-picker-page material-picker-page" style={pageStyle}>
      {/* 顶部栏 */}
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={handleBack}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">{pageTitle}</h1>
        <div className="right-actions">
          <button
            className="picker-filter-btn"
            onClick={handleConfirm}
            style={{ color: 'var(--primary)', fontWeight: 600 }}
          >
            确定
          </button>
        </div>
      </div>

      <div className="page-content pattern-picker-content">
        {/* 搜索框 */}
        <div className="search-bar">
          <span className="search-icon" style={{ color: 'var(--muted)' }}>
            <IconSearch style={{ width: '16px', height: '16px' }} />
          </span>
          <input
            type="text"
            placeholder="搜名称、品牌、分类…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {/* 分类 chips */}
        {allCategories.length > 1 && (
          <div className="picker-filter-box">
            <div className="picker-filter-label">分类</div>
            <div className="chips-scroll-row">
              {allCategories.map((c) => (
                <button
                  key={c}
                  className={`picker-chip${categoryFilter === c ? ' active' : ''}`}
                  onClick={() => setCategoryFilter(c)}
                >
                  {c === 'all' ? '全部' : c}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 两列卡片流 */}
        {sortedMaterials.length === 0 ? (
          <EmptyState
            icon={typeParam}
            title={`没有匹配的${TYPE_LABELS[typeParam] || '物料'}`}
            description="试试调整搜索条件"
          />
        ) : (
          <div className="pattern-picker-grid">
            {sortedMaterials.map((m) => {
              const isSelected = localSelected.includes(m.id);
              const qtyVal = localQtys[m.id];
              const stock = m.quantity || 0;
              return (
                <div
                  key={m.id}
                  className={`pattern-picker-card${isSelected ? ' selected' : ''}`}
                  onClick={() => toggleMaterial(m.id)}
                >
                  <div className="pattern-picker-thumb">
                    <IconComp
                      style={{ width: '50%', height: '50%', color: 'var(--accent)' }}
                    />
                    {stock <= 0 && (
                      <span className="pattern-used-badge">无库存</span>
                    )}
                  </div>
                  <div className="pattern-picker-info">
                    <div className="pattern-picker-name">{m.name}</div>
                    <div className="pattern-picker-meta">
                      <span className="pattern-size-chip">
                        库存 {stock}
                        {m.unit || ''}
                      </span>
                      {m.purchasePrice != null && (
                        <span> · ¥{m.purchasePrice}</span>
                      )}
                    </div>
                    <div className="pattern-picker-brand">
                      {m.category || '未分类'}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="pattern-picker-check">✓</div>
                  )}
                  {/* 已选时显示数量步进器 */}
                  {isSelected && (
                    <div
                      className="picker-card-qty"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="picker-qty-btn"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          stepQty(m.id, -1, m);
                        }}
                      >
                        −
                      </button>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="picker-qty-input"
                        value={qtyVal != null ? qtyVal : ''}
                        placeholder="用量"
                        style={overStockIds[m.id] ? { borderColor: 'var(--destructive)', color: 'var(--destructive)' } : undefined}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          updateQty(m.id, e.target.value, m);
                        }}
                      />
                      <button
                        type="button"
                        className="picker-qty-btn"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          stepQty(m.id, 1, m);
                        }}
                      >
                        +
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部已选面板 */}
      {localSelected.length > 0 && (
        <div className="picker-bottom-bar">
          <div className="picker-bottom-info">
            <div className="picker-bottom-count">
              已选 {costPreview.count} 项
            </div>
            {costPreview.total > 0 && (
              <div className="picker-bottom-cost">
                预计 ¥{costPreview.total.toFixed(2)}
              </div>
            )}
          </div>
          <button
            className="btn btn-primary"
            style={{ minWidth: '100px' }}
            onClick={handleConfirm}
          >
            确认选择
          </button>
        </div>
      )}
    </div>
  );
}