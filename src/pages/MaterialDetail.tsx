// src/pages/MaterialDetail.tsx — 物料详情页（PRD §8.3，S3-FIX-D 加 loading 防护）
// UI 基线：demo/src/pages/MaterialDetail.jsx
// 不复刻清单：浏览器原生确认框→应用内确认框、幅宽仅面料→面料+辅料、
//   适合人群数组兼容→仅单值、流水符号写死→signedDelta真实符号、
//   来源含「撤销回补」→三形态映射、revert做source分支→移除

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import type { MaterialType, UsageLog, NanoId12 } from '@/db/types';
import { deleteMaterial } from '@/services/materialService';
import { toast } from '@/store/toastStore';
import { signedDelta } from '@/lib/signedDelta';
import { IconBack, IconEdit, IconTrash, IconStar, IconScissors, IconWarning, IconPlus } from '@/components/Icons';
import { UserIconCatFabric, UserIconCatAccessory, UserIconCatTool, UserIconCatPattern } from '@/components/UserIcons';
import EmptyState from '@/components/EmptyState';
import ConsumptionSheet from '@/components/ConsumptionSheet';

const typeLabels: Record<MaterialType, string> = {
  fabric: '面料',
  accessory: '辅料',
  tool: '工具',
  pattern: '纸样',
};

const iconMap: Record<MaterialType, React.ComponentType<{ style?: React.CSSProperties }>> = {
  fabric: UserIconCatFabric,
  accessory: UserIconCatAccessory,
  tool: UserIconCatTool,
  pattern: UserIconCatPattern,
};

const seasonLabels: Record<string, string> = {
  spring: '春季',
  summer: '夏季',
  autumn: '秋季',
  winter: '冬季',
  all_season: '四季',
};

const forWhomLabels: Record<string, string> = {
  women: '女士',
  men: '男士',
  children: '儿童',
  baby: '婴儿',
  pet: '宠物',
};

function renderStars(rating: number) {
  if (!rating) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '1px' }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <IconStar
          key={i}
          filled={i < rating}
          style={{
            width: '16px',
            height: '16px',
            color: i < rating ? '#FFC107' : '#DDD',
            display: 'inline-block',
          }}
        />
      ))}
    </span>
  );
}

/** usage source → 来源文案（三形态映射，PRD §8.3） */
function sourceLabel(log: UsageLog): string {
  const s = log.source;
  if (s === 'manual') {
    return log.note === '手动损耗' ? '手动损耗' : '手工';
  }
  if (s.startsWith('garment:')) return '成衣关联';
  if (s.startsWith('legacy:')) return '旧数据迁移';
  return s;
}

export default function MaterialDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const materialId = id as NanoId12;

  const allMaterialsRaw = useLiveQuery(() => db.materials.toArray(), []);
  const materialsLoading = allMaterialsRaw === undefined;
  const allMaterials = useMemo(() => allMaterialsRaw ?? [], [allMaterialsRaw]);
  const material = useMemo(() => allMaterials.find((m) => m.id === materialId), [allMaterials, materialId]);

  const usageLogs = useLiveQuery(
    () =>
      materialId
        ? db.usageLogs.where('materialId').equals(materialId).reverse().sortBy('createdAt')
        : [],
    [materialId],
  ) ?? [];

  const allGarmentsRaw = useLiveQuery(() => db.garments.toArray(), []);
  const allGarments = useMemo(() => allGarmentsRaw ?? [], [allGarmentsRaw]);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [consumeOpen, setConsumeOpen] = useState(
    (location.state as Record<string, unknown> | null)?.openConsume === true,
  );

  const handleEdit = useCallback(() => {
    navigate(`/materials/${materialId}/edit`);
  }, [navigate, materialId]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteMaterial(materialId);
      toast('已删除', 'success');
      navigate('/materials');
    } catch {
      toast('删除失败', 'error');
    }
  }, [materialId, navigate]);

  const handleConsume = useCallback(() => {
    setConsumeOpen(true);
  }, []);

  // 纸样已使用状态：按落库字段 used
  const isPatternUsed = material?.type === 'pattern' ? material.used === 1 : false;

  // 图片：从 images 表取首图 blob URL（useState 触发重渲染，P1-2 修复）
  const bannerImageId = material?.images?.[0];
  const bannerImageRecord = useLiveQuery(
    () => (bannerImageId ? db.images.get(bannerImageId) : undefined),
    [bannerImageId],
  );
  const [bannerUrl, setBannerUrl] = useState('');
  useEffect(() => {
    if (bannerImageRecord?.blob) {
      const url = URL.createObjectURL(bannerImageRecord.blob);
      setBannerUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    setBannerUrl('');
  }, [bannerImageRecord]);

  // 计算被多少件成衣使用（用于删除确认）
  const usedByGarments = useMemo(() => {
    if (!material || material.type !== 'pattern') return [];
    return allGarments.filter((g) => g.patternId === material.id);
  }, [material, allGarments]);

  // 双向匹配（仅面料与纸样）
  const matches = useMemo(() => {
    if (!material) return [];
    if (material.type === 'fabric') {
      return allMaterials
        .filter(
          (m) =>
            m.type === 'pattern' &&
            (material.suitableFor?.some(
              (s) => m.name.includes(s) || m.tags?.some((t) => t.includes(s)),
            ) ||
              m.suitableFor?.some((s) => material.name.includes(s))),
        )
        .slice(0, 6);
    }
    if (material.type === 'pattern') {
      return allMaterials
        .filter(
          (m) =>
            m.type === 'fabric' &&
            (m.suitableFor?.some(
              (s) => material.name.includes(s) || material.tags?.some((t) => t.includes(s)),
            ) ||
              material.suitableFor?.some((s) => m.name.includes(s))),
        )
        .slice(0, 6);
    }
    return [];
  }, [material, allMaterials]);

  // S3-FIX-D：materialsLoading 防止 useLiveQuery 解析中误判"物料不存在"
  if (materialsLoading) {
    return null;
  }
  if (!material) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="left-actions">
            <button className="icon-btn" onClick={() => navigate('/materials')}>
              <IconBack style={{ width: '20px', height: '20px' }} />
            </button>
          </div>
          <h1 className="title">物料详情</h1>
          <div className="right-actions" />
        </div>
        <EmptyState icon="search" title="物料不存在" description="该物料可能已被删除" />
      </div>
    );
  }

  const BannerIcon = iconMap[material.type];

  // 删除确认：计算被成衣使用数
  const nUsedGarments = material.type === 'pattern' ? usedByGarments.length : 0;

  return (
    <div className="page">
      {/* 顶部栏 */}
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/materials')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">物料详情</h1>
        <div className="right-actions">
          <button className="icon-btn" onClick={handleEdit} title="编辑" style={{ color: 'var(--accent)' }}>
            <IconEdit style={{ width: '20px', height: '20px' }} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowDeleteConfirm(true)}
            title="删除"
            style={{ color: 'var(--destructive)' }}
          >
            <IconTrash style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
      </div>

      <div className="page-content" style={{ paddingBottom: '0', paddingLeft: 0, paddingRight: 0 }}>
        {/* 大图区 */}
        <div
          className={`detail-banner material-thumb ${material.type} ${material.images && material.images.length > 0 ? 'has-image' : ''}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
        >
          {material.images && material.images.length > 0 && bannerUrl ? (
            <img src={bannerUrl} alt={material.name} className="detail-banner-image" />
          ) : (
            <span style={{ color: 'rgba(255,255,255,0.95)', display: 'inline-flex' }}>
              <BannerIcon style={{ width: '80px', height: '80px' }} />
            </span>
          )}
        </div>

        {/* 名称 */}
        <div style={{ padding: '16px', paddingBottom: '4px' }}>
          <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--foreground)', marginBottom: '4px' }}>
            {material.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="badge">{typeLabels[material.type]}</span>
            {material.type === 'pattern' && material.rating > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '1px' }}>
                {renderStars(material.rating)}
              </span>
            )}
          </div>
        </div>

        {/* 基础信息 */}
        <div className="detail-section">
          <div className="detail-section-title">基础信息</div>
          <div className="detail-info-list">
            <div className="detail-info-item">
              <span className="key">库存</span>
              <span style={{ fontWeight: 500 }}>
                {material.quantity} {material.unit}
              </span>
            </div>
            {material.category && (
              <div className="detail-info-item">
                <span className="key">分类</span>
                <span>{material.category}</span>
              </div>
            )}
            {material.brand && (material.type === 'fabric' || material.type === 'pattern') && (
              <div className="detail-info-item">
                <span className="key">品牌</span>
                <span>{material.brand}</span>
              </div>
            )}
            {material.type === 'fabric' && material.weight != null && material.weight > 0 && (
              <div className="detail-info-item">
                <span className="key">克重</span>
                <span>{material.weight} g/㎡</span>
              </div>
            )}
            {(material.type === 'fabric' || material.type === 'accessory') && material.width != null && material.width > 0 && (
              <div className="detail-info-item">
                <span className="key">幅宽</span>
                <span>{material.width} cm</span>
              </div>
            )}
            {material.type === 'pattern' && material.ratingReview && (
              <div className="detail-info-item">
                <span className="key">难度</span>
                <span>{material.ratingReview}</span>
              </div>
            )}
            {material.type === 'pattern' && material.size && (
              <div className="detail-info-item">
                <span className="key">尺码</span>
                <span>{material.size}</span>
              </div>
            )}
            {material.type === 'pattern' && (
              <div className="detail-info-item">
                <span className="key">使用状态</span>
                <span className={isPatternUsed ? 'status-used' : 'status-unused'}>
                  {isPatternUsed ? '已使用' : '未使用'}
                </span>
              </div>
            )}
            {material.tags && material.tags.length > 0 && (
              <div className="detail-info-item">
                <span className="key">标签</span>
                <span style={{ textAlign: 'right', maxWidth: '60%', fontSize: '13px' }}>
                  {material.tags.join('、')}
                </span>
              </div>
            )}
            {material.season && material.type === 'pattern' && (
              <div className="detail-info-item">
                <span className="key">季节</span>
                <span>{seasonLabels[material.season] || material.season}</span>
              </div>
            )}
            {material.forWhom && material.type === 'pattern' && (
              <div className="detail-info-item">
                <span className="key">适合人群</span>
                <span>{forWhomLabels[material.forWhom] || material.forWhom}</span>
              </div>
            )}
          </div>
        </div>

        {/* 购入信息 */}
        <div className="detail-section">
          <div className="detail-section-title">购入信息</div>
          <div className="detail-info-list">
            {material.purchasePrice != null && (
              <div className="detail-info-item">
                <span className="key">价格</span>
                <span>¥{Number(material.purchasePrice).toFixed(2)}</span>
              </div>
            )}
            {material.purchaseDate && (
              <div className="detail-info-item">
                <span className="key">购入日期</span>
                <span>{material.purchaseDate}</span>
              </div>
            )}
            {material.notes && (
              <div className="detail-info-item detail-info-notes">
                <span className="key">备注</span>
                <span style={{ textAlign: 'right', maxWidth: '65%', fontSize: '13px', lineHeight: 1.5 }}>
                  {material.notes}
                </span>
              </div>
            )}
            {material.createdAt && (
              <div className="detail-info-item">
                <span className="key">录入时间</span>
                <span>{new Date(material.createdAt).toLocaleDateString('zh-CN')}</span>
              </div>
            )}
          </div>
        </div>

        {/* 双向匹配区 */}
        {(material.type === 'fabric' || material.type === 'pattern') &&
          (matches.length > 0 ? (
            <div className="detail-section">
              <div className="detail-section-title">
                {material.type === 'fabric' ? '推荐款式' : '推荐布料'}
              </div>
              <div className="match-grid">
                {matches.map((m) => {
                  const MatchIcon = iconMap[m.type];
                  return (
                    <div
                      key={m.id}
                      className="match-item"
                      onClick={() => navigate(`/materials/${m.id}`)}
                    >
                      <div
                        className={`match-thumb material-thumb ${m.type}`}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                          <MatchIcon style={{ width: '24px', height: '24px' }} />
                        </span>
                      </div>
                      <div className="match-name">{m.name}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ padding: '0 16px' }}>
              <EmptyState
                icon="search"
                title="暂无匹配"
                description="去编辑适合款式标签试试"
              />
            </div>
          ))}

        {/* 损耗流水（纸样去掉） */}
        {material.type !== 'pattern' && (
          <div className="detail-section logs-section">
            <div className="detail-section-title">
              损耗流水（最近 {Math.min(20, usageLogs.length)} 条）
            </div>
            <div className="logs-list">
              {usageLogs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--secondary-foreground)', fontSize: '13px' }}>
                  暂无流水记录
                </div>
              ) : (
                usageLogs.slice(0, 20).map((log) => {
                  const isRefill = log.kind === 'refill';
                  const isAdjust = log.kind === 'adjust';
                  const iconColor = isRefill
                    ? 'var(--success)'
                    : isAdjust
                      ? 'var(--warning)'
                      : 'var(--accent)';
                  const qtyClass = isRefill ? 'refill' : 'consume';
                  // 按 signedDelta 真实符号（PRD §8.3 不复刻#4）
                  const delta = signedDelta(log.kind, log.quantity);
                  const qtyPrefix = delta >= 0 ? '+' : '';
                  const logTitle =
                    log.kind === 'refill'
                      ? log.note || '入库'
                      : log.kind === 'revert'
                        ? '入库'
                        : log.note || '消耗';
                  const dateStr = log.createdAt?.slice(0, 10) || '';
                  return (
                    <div key={log.id} className="log-item">
                      <div className="log-icon" style={{ color: iconColor }}>
                        {isRefill || log.kind === 'revert' ? (
                          <IconPlus style={{ width: '14px', height: '14px' }} />
                        ) : isAdjust ? (
                          <IconWarning style={{ width: '14px', height: '14px' }} />
                        ) : (
                          <IconScissors style={{ width: '14px', height: '14px' }} />
                        )}
                      </div>
                      <div className="log-content">
                        <div className="log-title">{logTitle}</div>
                        <div className="log-meta">
                          {dateStr} · {sourceLabel(log)}
                        </div>
                      </div>
                      <div className={`log-qty ${qtyClass}`}>
                        {qtyPrefix}
                        {log.quantity}
                        {log.unit || ''}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* 底部操作条 */}
        <div className="detail-action-bar">
          <button
            className="btn btn-secondary"
            onClick={handleEdit}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
          >
            <IconEdit style={{ width: '16px', height: '16px' }} />
            编辑
          </button>
          {material.type !== 'pattern' && (
            <button className="btn btn-primary" onClick={handleConsume}>
              记损耗
            </button>
          )}
          <button
            className="btn"
            style={{
              background: '#FFE0E0',
              color: 'var(--destructive)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
            }}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <IconTrash style={{ width: '16px', height: '16px', color: 'var(--destructive)' }} />
            删除
          </button>
        </div>
      </div>

      {/* 删除确认框（应用内确认，PRD §8.3 不复刻#1） */}
      {showDeleteConfirm && (
        <div
          className="modal-overlay"
          onClick={() => setShowDeleteConfirm(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--card)',
              borderRadius: '16px 16px 0 0',
              width: '100%',
              maxWidth: 500,
              padding: '24px 16px 32px',
            }}
          >
            <h3 style={{ fontSize: '17px', fontWeight: 600, marginBottom: '8px' }}>
              确定删除「{material.name}」吗？
            </h3>
            <p style={{ fontSize: '14px', color: 'var(--secondary-foreground)', marginBottom: '20px', lineHeight: 1.6 }}>
              {material.type === 'pattern' && nUsedGarments > 0
                ? `该纸样正被 ${nUsedGarments} 件成衣使用，删除后这些成衣的用料清单与总成本会同步更新。`
                : material.type === 'pattern'
                  ? '暂无成衣使用该纸样。'
                  : '删除后该物料的历史流水将保留。'}
            </p>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => setShowDeleteConfirm(false)}
              >
                取消
              </button>
              <button
                className="btn"
                style={{ flex: 1, background: '#FFE0E0', color: 'var(--destructive)' }}
                onClick={() => {
                  setShowDeleteConfirm(false);
                  handleDelete();
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 记损耗浮层 */}
      {consumeOpen && material && (
        <ConsumptionSheet
          material={material}
          onCancel={() => setConsumeOpen(false)}
          onDone={() => setConsumeOpen(false)}
        />
      )}
    </div>
  );
}