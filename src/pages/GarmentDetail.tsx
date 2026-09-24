// src/pages/GarmentDetail.tsx — 成衣详情页（S3-D + S5-B）
// S3-FIX-D：修复 loading 竞态（S3-QC3 D1）。useLiveQuery 首渲染恒返回 undefined，
// 原代码 useRef loading 在首帧即被置 false，!loading && !garment 误判跳转。
// 修复：改为 .then(g => g ?? null)，undefined=未解析(null=不存在)，消除误判。
// PRD §8.6：用料快照展示（只渲染活跃行，历史行不渲染）、纸样反查、
// 总成本求值顺序、状态底部操作栏三态。UI 基线：demo/src/pages/GarmentDetail.jsx，
// 缺陷对照 PRD §8.6「参照实现缺陷」+ §15.5 不复刻清单逐条修正。
// S5-B 增量：
//   - 任务 5-1 UI：去完工登记按钮改由本地 state 控制 CompletionWizard 浮层，
//     走 markGarmentCompleted（S5-A）写入，不再 dispatch garment:complete 事件。
//   - 任务 5-6 UI：status === 'completed' 时不再渲染编辑按钮（隐藏，不置灰）；
//     浮层本身与底部操作均不提供「改回未完工」入口。

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type {
  GarmentMaterialSnapshot,
  GarmentStatus,
  Material,
  Task,
} from '@/db/types';
import { toast } from '@/store/toastStore';
import { IconEdit, IconTrash, IconBack, IconTask } from '@/components/Icons';
import { UserIconNavGarments, UserIconCatPattern } from '@/components/UserIcons';
import DeleteGarmentConfirm from '@/components/DeleteGarmentConfirm';
import CompletionWizard from '@/components/CompletionWizard';
import { markGarmentCompleted } from '@/services/garmentService';

// ── 常量 ──

const STATUS_LABELS: Record<GarmentStatus, string> = {
  planning: '规划中',
  in_progress: '制作中',
  completed: '已完成',
};

/** 金额格式函数：两位小数（PRD §6）。 */
function fmtCurrency(v: number): string {
  return `¥${v.toFixed(2)}`;
}

/** 日期格式化：YYYY-MM-DD → YYYY.MM.DD。 */
function fmtDate(d: string): string {
  if (!d) return '';
  // completionDate 为 YYYY-MM-DD，不是 ISO 8601
  const parts = d.split('-');
  const p0 = parts[0] ?? '';
  const p1 = parts[1] ?? '';
  const p2 = parts[2] ?? '';
  if (p0 && p1 && p2 && parts.length === 3) {
    return `${p0}.${p1.padStart(2, '0')}.${p2.padStart(2, '0')}`;
  }
  // 回退：兼容可能的 ISO 格式
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
}

/** 图片 blob URL 解析（useState 不存 useRef，S2 P1-2 教训）。 */
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

// ── 非空段拼接（纸样副行） ──
function joinNonEmpty(parts: string[], sep = ' · '): string {
  return parts.filter(Boolean).join(sep);
}

// ── 主组件 ──

export default function GarmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // S3-FIX-D：.then(g => g ?? null) — undefined=未解析(加载态)，null=记录不存在
  const garment = useLiveQuery(() => db.garments.get(id ?? '').then(g => g ?? null), [id]);
  const materials = useLiveQuery(() => db.materials.toArray(), []) ?? [];

  // S4-C：关联任务（双向联动 UI 的一侧）
  // 任务. garmentId 是强引用，本页删除成衣时由 deleteGarmentWithRestore
  // 将任务的 garmentId / garmentName 一起置空（S3 已实现），这里仅消费。
  const linkedTasks = useLiveQuery(
    () =>
      id
        ? db.tasks
            .where('garmentId')
            .equals(id)
            .toArray()
            .then((arr) => arr ?? [])
        : Promise.resolve([] as Task[]),
    [id],
  );

  // 图片 blob URL（必须在 early return 之前调用，Hooks 规则）
  const coverBlobUrl = useBlobUrl(garment?.images?.[0]);

  // garment === null 表示记录确实不存在 → 回列表 + toast
  useEffect(() => {
    if (garment === null) {
      toast('记录不存在或已被删除', 'error');
      navigate('/garments', { replace: true });
    }
  }, [garment, navigate]);

  // ── 删除确认弹窗 ──
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // ── 完工登记浮层（S5-B · 任务 5-1 UI + 5-6 UI 只读完工态） ──
  const [showCompleteWizard, setShowCompleteWizard] = useState(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    const handler = () => setShowDeleteConfirm(true);
    window.addEventListener('garment:delete', handler);
    return () => window.removeEventListener('garment:delete', handler);
  }, []);

  // ── 完工登记回调：经 S5-A 服务层 markGarmentCompleted 唯一写入路径 ──
  const handleCompleteConfirm = async (payload: {
    garmentId: string;
    totalCost: number;
  }) => {
    if (completing) return;
    setCompleting(true);
    try {
      // 服务层校验 completionDate 默认值（YYYY-MM-DD, UTC 截取）与 totalCost
      // 归一；非法的 YYYY-MM-DD 会在此处抛错并以 toast 展示（PRD §15.3）。
      // 不静默改、不在 UI 层补补补。
      await markGarmentCompleted({
        id: payload.garmentId,
        totalCost: payload.totalCost,
      });
      toast('已确认完工', 'success');
      setShowCompleteWizard(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '完工登记失败';
      toast(msg, 'error');
      // 不关闭浮层，让用户看到原值，可重试
    } finally {
      setCompleting(false);
    }
  };

  if (garment === undefined || garment === null) {
    return null; // 加载中或即将跳转，不渲染空白页
  }

  // ── 数据派生 ──
  const pattern = garment.patternId
    ? materials.find((m) => m.id === garment.patternId && m.type === 'pattern')
    : undefined;

  // 关联物料辅料：materialIds 反查，仅 fabric + accessory（工具不进成衣成本）
  const linkedMaterials = (garment.materialIds ?? [])
    .map((mid) => materials.find((m) => m.id === mid))
    .filter((m): m is Material => m !== undefined)
    .filter((m) => m.type === 'fabric' || m.type === 'accessory');

  // ── 用料明细（三种情况） ──
  const snapshot = garment.materialSnapshot ?? [];
  const hasSnapshot = snapshot.length > 0;

  // A. 有快照：只渲染未退役行（不存在 retiredAt 键）
  const activeSnapshotRows: (GarmentMaterialSnapshot & { unit: string; priceSnapshot: number; subtotal: number })[] =
    hasSnapshot
      ? snapshot.filter((r) => !('retiredAt' in r))
      : [];

  // B. 无快照但有引用
  const hasRefsButNoSnapshot = !hasSnapshot && linkedMaterials.length > 0;

  // ── 总成本求值顺序 ──
  let totalCost: number | null = null;
  let totalCostLabel: string | null = null;
  if (garment.totalCost != null) {
    totalCost = garment.totalCost;
    totalCostLabel = fmtCurrency(totalCost);
  } else if (activeSnapshotRows.length > 0) {
    const sum = activeSnapshotRows.reduce((acc, r) => acc + r.subtotal, 0);
    if (sum > 0) {
      totalCost = sum;
      totalCostLabel = fmtCurrency(sum);
    }
  }
  // 都不满足 → totalCostLabel 保持 null → 显示「未核算」

  // ── 底部操作栏（PRD §8.6 三态） ──
  const isCompleted = garment.status === 'completed';
  const isPlanning = garment.status === 'planning';
  const isInProgress = garment.status === 'in_progress';

  // ── 流水分页信息（详情页不展示流水列表，但 signedDelta 的展示口径已由 DM §4.6 定义） ──

  return (
    <div className="page garment-detail v2-layout">
      {/* 顶部操作栏：返回 + 编辑 + 删除 */}
      <div className="page-header">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
          }}
        >
          <button
            onClick={() => navigate('/garments')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--foreground)',
              cursor: 'pointer',
              padding: '8px',
              display: 'flex',
              alignItems: 'center',
            }}
            aria-label="返回"
          >
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
          <div style={{ display: 'flex', gap: '16px' }}>
            {/* S5-B 任务 5-6 UI：已完工成衣不渲染编辑入口（隐藏，不置灰）。
                PRD §4.3「『已完成』状态时仅显示状态文字、不允许改回未完工」语义。 */}
            {!isCompleted && (
              <button
                onClick={() => navigate(`/garments/${garment.id}/edit`)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  padding: '8px',
                  display: 'flex',
                  alignItems: 'center',
                }}
                aria-label="编辑"
              >
                <IconEdit style={{ width: '20px', height: '20px' }} />
              </button>
            )}
            <button
              onClick={() => {
                const event = new CustomEvent('garment:delete', { detail: garment });
                window.dispatchEvent(event);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--destructive)',
                cursor: 'pointer',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
              }}
              aria-label="删除"
            >
              <IconTrash style={{ width: '20px', height: '20px' }} />
            </button>
          </div>
        </div>
      </div>

      <div className="garment-detail-body">
        {/* ===== ① 图片 + 名称 ===== */}
        <div className="garment-detail-hero-v2">
          <div className={`garment-img-frame${coverBlobUrl ? ' has-image' : ''}`}>
            {coverBlobUrl ? (
              <img
                src={coverBlobUrl}
                alt={garment.name}
                className="garment-img"
              />
            ) : (
              <UserIconNavGarments style={{ width: '50%', height: '50%' }} />
            )}
            <span className={`garment-status-badge ${garment.status}`}>
              {STATUS_LABELS[garment.status]}
            </span>
          </div>
          <div className="garment-name-under-img">{garment.name}</div>

          {/* 基本信息 */}
          <div className="garment-title-section">
            {garment.recipient && (
              <div className="garment-recipient-line">
                <span className="recipient-prefix">给 </span>
                <span className="recipient-name">{garment.recipient}</span>
                <span className="recipient-suffix"> 的新衣</span>
              </div>
            )}
            {garment.completionDate ? (
              <div className="garment-completion-line">
                <span className="completion-label">完工日期</span>
                <span className="completion-date">{fmtDate(garment.completionDate)}</span>
              </div>
            ) : !isCompleted ? (
              <div className="garment-completion-line">
                <span className="completion-label">完工日期</span>
                <span className="completion-pending">尚未完工</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* ===== ② 纸样 ===== */}
        <div className="detail-section">
          <div className="detail-section-title">纸样</div>
          {pattern ? (
            <div
              className="linked-material-item"
              onClick={() => navigate(`/materials/${pattern.id}`)}
              style={{ cursor: 'pointer' }}
            >
              <div className="linked-material-icon">
                <UserIconCatPattern style={{ width: '20px', height: '20px' }} />
              </div>
              <div className="linked-material-info">
                <div className="linked-material-name">{pattern.name}</div>
                <div className="linked-material-qty">
                  {joinNonEmpty([pattern.size, pattern.brand])}
                </div>
              </div>
              <span className="linked-material-arrow">›</span>
            </div>
          ) : (
            <div className="section-empty">暂无关联纸样</div>
          )}
        </div>

        {/* ===== ③ 关联物料辅料 ===== */}
        <div className="detail-section">
          <div className="detail-section-title">关联物料辅料</div>
          {hasSnapshot && activeSnapshotRows.length > 0 ? (
            // 情况 A：有快照 → 渲染活跃行
            <div className="material-cost-list">
              {activeSnapshotRows.map((item, i) => (
                <div key={item.materialId || i} className="material-cost-row">
                  <div className="material-cost-info">
                    <div className="material-cost-name">
                      {item.name}
                      {item.deducted && (
                        <span className="deducted-badge">✓ 已扣</span>
                      )}
                    </div>
                    <div className="material-cost-spec">
                      {item.quantityUsed}
                      {item.unit} × {fmtCurrency(item.priceSnapshot)}
                    </div>
                  </div>
                  <div className="material-cost-value">
                    {fmtCurrency(item.subtotal)}
                  </div>
                </div>
              ))}
            </div>
          ) : hasRefsButNoSnapshot ? (
            // 情况 B：无快照但有引用 → 标记「未核算」
            <div className="material-cost-list">
              {linkedMaterials.map((m) => (
                <div key={m.id} className="material-cost-row">
                  <div className="material-cost-info">
                    <div className="material-cost-name">
                      {m.name}
                      <span className="deducted-badge" style={{ color: 'var(--secondary-foreground)' }}>
                        未核算
                      </span>
                    </div>
                    <div className="material-cost-spec">{m.unit}</div>
                  </div>
                  <div className="material-cost-value">
                    {m.purchasePrice != null
                      ? `${fmtCurrency(m.purchasePrice)}/${m.unit}`
                      : '—'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // 情况 C：都没有
            <div className="section-empty">暂无关联物料</div>
          )}
        </div>

        {/* ===== ④ 关联任务（S4-C：双向联动 UI） ===== */}
        <div className="detail-section">
          <div className="detail-section-title">关联任务</div>
          {linkedTasks && linkedTasks.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {linkedTasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => navigate('/workbench')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 14px',
                    background: 'var(--card)',
                    borderRadius: '10px',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <IconTask
                    style={{
                      width: '18px',
                      height: '18px',
                      color: 'var(--accent)',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '14px',
                        fontWeight: 500,
                        color: 'var(--foreground)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {task.title}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: 'var(--secondary-foreground)',
                        marginTop: '2px',
                      }}
                    >
                      {task.status === 'todo'
                        ? '待办'
                        : task.status === 'in_progress'
                          ? '进行中'
                          : '已完成'}
                      {' · '}
                      {task.priority === 'high'
                        ? '高优先级'
                        : task.priority === 'medium'
                          ? '中优先级'
                          : '低优先级'}
                    </div>
                  </div>
                  <span
                    style={{
                      color: 'var(--secondary-foreground)',
                      fontSize: '18px',
                    }}
                  >
                    ›
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="section-empty">暂无关联任务</div>
          )}
        </div>

        {/* ===== ⑤ 总成本 ===== */}
        <div className="total-cost-section">
          <span className="total-cost-label">总成本</span>
          <span className="total-cost-value">
            {totalCostLabel ?? '未核算'}
          </span>
        </div>

        {/* ===== ⑤ 底部操作区 ===== */}
        {isPlanning && (
          <div className="garment-detail-actions-bottom">
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={async () => {
                try {
                  await db.garments.update(garment.id, {
                    status: 'in_progress' as GarmentStatus,
                    updatedAt: new Date().toISOString(),
                  });
                  toast('已开始制作', 'success');
                } catch {
                  toast('操作失败，请重试', 'error');
                }
              }}
            >
              开始制作
            </button>
          </div>
        )}
        {isInProgress && (
          <div className="garment-detail-actions-bottom">
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={() => setShowCompleteWizard(true)}
            >
              去完工登记
            </button>
          </div>
        )}
        {/* completed 态不显示任何操作按钮 */}
      </div>

      {/* ── 删除确认弹窗 ── */}
      {showDeleteConfirm && (
        <DeleteGarmentConfirm
          garment={garment}
          onCancel={() => setShowDeleteConfirm(false)}
          onDeleted={() => {
            setShowDeleteConfirm(false);
            navigate('/garments', { replace: true });
          }}
        />
      )}

      {/* ── 完工登记浮层（S5-B · 任务 5-1 UI + 5-6 UI） ──
       *   - 通过本地 state 控制开/关，避免依赖 garment:complete 全局事件
       *   - 父级 onConfirm 走 S5-A 服务层 markGarmentCompleted 唯一写入路径
       *   - onCancel 不写任何数据；点遮罩等价于取消（浮层容器 stopPropagation） */}
      {showCompleteWizard && (
        <CompletionWizard
          garment={garment}
          materials={materials}
          onCancel={() => {
            if (!completing) setShowCompleteWizard(false);
          }}
          onConfirm={handleCompleteConfirm}
        />
      )}
    </div>
  );
}