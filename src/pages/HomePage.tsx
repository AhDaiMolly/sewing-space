// src/pages/HomePage.tsx — 首页（S5-B · 任务 5-3）
// UI 基线：docs/demo/src/pages/HomePage.jsx（PRD §8.1 修订：问候语读设置值、
// 备份提醒三态、不读任何缓存计数）。
// 数据来源与派生全部按 PRD §8.1 表落实：
//   - 成衣数量 = db.garments.status === 'completed' 的行数 → statsService.getHomeStats().completedCount（现算）
//   - 库存布料 = db.materials.type === 'fabric' 的 quantity 之和 → statsService.getHomeStats().fabricTotal（两位小数，单位 m）
//   - 备份提醒阈值 = 24h（demo 是 7 天，已纠正）
//   - 问候语读 settings.user_name，缺/空 → 回落「缝纫人」（demo 写死「小满」，已纠正）
//   - 自身不缓存任何统计字段；移动数据库后刷新即重算
// S5-B 任务 5-3 增量：
//   - 派发 / 完成动作均走服务层；本页面只做实时派生与跳转
//   - 「立即备份」按钮在 S6 未实装前跳转 /settings/backup（S6 接收实际写入流程）
//   - 「最近条目」段：取最近 5 件成衣与最近 5 件物料合并按 createdAt 降序展示

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { getHomeStats } from '@/services/statsService';
import { IconPlus, IconArrowRight, IconGear, IconHeart, IconWarning } from '@/components/Icons';

const BACKUP_NEVER_DAYS = -1; // 「从未备份」专用标记

/** 计算「距 backup_last_success 已过去多少天」（向下取整）。
 *  返回 null = 未配置时间（空串）；返回 0 = 不足 1 天（按 PRD 不渲染本卡）。 */
function daysSinceBackup(lastSuccess: string): number | null {
  if (!lastSuccess) return null;
  const ms = Date.now() - new Date(lastSuccess).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / (24 * 3600 * 1000));
}

/** 把分钟数 / 时分转为友好提示；本卡里只用于「{N} 天」展示 */
function fmtDaysSince(days: number): string {
  if (days <= 0) return '不足 1 天';
  return `${days} 天`;
}

type RecentItem =
  | { kind: 'garment'; id: string; name: string; createdAt: string; status: string }
  | { kind: 'material'; id: string; name: string; createdAt: string; type: string };

function fmtRecentCreatedAt(iso: string): string {
  if (!iso) return '';
  // 截取 YYYY.MM.DD · HH:mm（用本地时区显示：与 PRD §6 备份日志展示口径一致）
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function recentItemLabel(item: RecentItem): string {
  if (item.kind === 'garment') {
    return item.status === 'completed' ? '已成衣' : item.status === 'planning' ? '规划中' : '制作中';
  }
  if (item.type === 'fabric') return '面料';
  if (item.type === 'accessory') return '辅料';
  if (item.type === 'tool') return '工具';
  return '纸样';
}

export default function HomePage() {
  const navigate = useNavigate();

  // 问候语：读 settings.user_name，缺/空 → 「缝纫人」（PRD §8.1）
  const userNameSetting = useLiveQuery(
    () => db.settings.get('user_name').then((r) => r?.value ?? ''),
    [],
  );
  const userName = userNameSetting?.trim() || '缝纫人';

  // 备份状态：读 settings.backup_last_success（S5 阶段无副作用：只读）
  const backupLastSuccess = useLiveQuery(
    () => db.settings.get('backup_last_success').then((r) => r?.value ?? ''),
    [],
  );
  // 备份提示按钮的去重基准，PRD §8.1 / §10.5 要求分离（不用 backup_last_success 兼任）
  // ——本卡内仅展示；若需改写则由 S6 处理。本轮不写入。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _backupReminderLast = useLiveQuery(
    () => db.settings.get('backup_reminder_last').then((r) => r?.value ?? ''),
    [],
  );
  void _backupReminderLast;

  // 统计：现算（PRD §8.1「不读任何缓存计数」）
  const [stats, setStats] = useState<{ completedCount: number; fabricTotal: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getHomeStats();
        if (!cancelled) setStats(s);
      } catch {
        if (!cancelled) setStats({ completedCount: 0, fabricTotal: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 最近条目（任务 5-3）：最近 5 件 garment ∪ 最近 5 件 material
  // ——「legacy:」前缀流水不进任何汇总口径（PRD §6.5 缺 5），本段只读 materials/garments
  // 表，不读 usageLogs，因此不受影响。仍保留该守卫说明在交付文档中。
  const recentGarments = useLiveQuery(
    () =>
      db.garments
        .orderBy('createdAt')
        .reverse()
        .limit(5)
        .toArray(),
    [],
  );
  const recentMaterials = useLiveQuery(
    () =>
      db.materials
        .orderBy('createdAt')
        .reverse()
        .limit(5)
        .toArray(),
    [],
  );

  const recentItems = useMemo<RecentItem[]>(() => {
    const items: RecentItem[] = [];
    (recentGarments ?? []).forEach((g) =>
      items.push({
        kind: 'garment',
        id: g.id,
        name: g.name,
        createdAt: g.createdAt,
        status: g.status,
      }),
    );
    (recentMaterials ?? []).forEach((m) =>
      items.push({
        kind: 'material',
        id: m.id,
        name: m.name,
        createdAt: m.createdAt,
        type: m.type,
      }),
    );
    items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return items.slice(0, 5);
  }, [recentGarments, recentMaterials]);

  // 备份提醒三态
  const lastSuccess = backupLastSuccess ?? '';
  const days =
    lastSuccess === ''
      ? BACKUP_NEVER_DAYS
      : (daysSinceBackup(lastSuccess) ?? 0);
  // 态 1：从未备份（空串）
  const isNeverBackedUp = lastSuccess === '';
  // 态 2：超过 24h 但非从未备份
  const isStaleBackup = !isNeverBackedUp && days >= 1;
  // 态 3：24h 内 — 不渲染

  const showBackupWarning = isNeverBackedUp || isStaleBackup;

  return (
    <div className="page home-page">
      {/* 问候行：左问候语（+ 心跳图标）+ 右设置按钮 */}
      <div className="home-hero">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="home-greeting" style={{ marginBottom: 0 }}>
            <div
              className="app-title"
              style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              你好，{userName}
              <span
                style={{
                  color: 'var(--accent)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <IconHeart style={{ width: '22px', height: '22px' }} />
              </span>
            </div>
            <div className="user-name">今天也来缝一会儿呀</div>
          </div>
          <button
            className="icon-btn home-settings-btn"
            onClick={() => navigate('/settings')}
            title="设置"
            aria-label="设置"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--card)',
              color: 'var(--accent)',
              border: '1.5px solid var(--primary)',
              cursor: 'pointer',
              flexShrink: 0,
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <IconGear style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
      </div>

      <div className="page-content with-bottom-nav" style={{ paddingTop: '16px' }}>
        {/* 总览统计卡（粉色渐变）—— 整卡可点 → 统计页 */}
        <div
          className="overview-card"
          style={{ cursor: 'pointer' }}
          onClick={() => navigate('/stats')}
          role="button"
          aria-label="查看统计详情"
        >
          <div className="overview-header">
            <div className="overview-title">总览</div>
            <div className="overview-link">
              查看详情
              <IconArrowRight style={{ width: '14px', height: '14px', marginLeft: '2px' }} />
            </div>
          </div>
          <div className="overview-metrics">
            <div className="overview-metric">
              <div className="overview-value">
                {stats?.completedCount ?? 0}
                <span className="overview-unit">件</span>
              </div>
              <div className="overview-label">成衣数量</div>
            </div>
            <div className="overview-divider" />
            <div className="overview-metric">
              <div className="overview-value">
                {(stats?.fabricTotal ?? 0).toFixed(2)}
                <span className="overview-unit">m</span>
              </div>
              <div className="overview-label">库存布料</div>
            </div>
          </div>
        </div>

        {/* 快速添加区 */}
        <div className="quick-add-section">
          <div className="quick-add-title">快速添加</div>
          <div className="quick-add-row">
            <button
              className="quick-add-btn"
              onClick={() => navigate('/materials/new')}
              aria-label="添加物料"
            >
              <span className="icon quick-add-icon-pink">
                <IconPlus style={{ width: '18px', height: '18px' }} />
              </span>
              <span>物料</span>
            </button>
            <button
              className="quick-add-btn"
              onClick={() => navigate('/garments/new')}
              aria-label="添加成衣"
            >
              <span className="icon quick-add-icon-pink">
                <IconPlus style={{ width: '18px', height: '18px' }} />
              </span>
              <span>成衣</span>
            </button>
            <button
              className="quick-add-btn"
              onClick={() => navigate('/workbench')}
              aria-label="查看工作台"
            >
              <span className="icon quick-add-icon-pink">
                <IconPlus style={{ width: '18px', height: '18px' }} />
              </span>
              <span>任务</span>
            </button>
          </div>
        </div>

        {/* 备份提醒卡（PRD §8.1 三态规则） */}
        {showBackupWarning && (
          <div className="backup-warning">
            <span className="icon" style={{ color: '#E8A13A' }}>
              <IconWarning style={{ width: '18px', height: '18px' }} />
            </span>
            <span className="text">
              {isNeverBackedUp ? (
                <>
                  <strong>还没有备份过数据</strong>
                  <br />
                  备份后换手机、清缓存都不会丢数据
                </>
              ) : (
                <>已有 {fmtDaysSince(days)}未备份</>
              )}
            </span>
            <button
              className="action"
              onClick={() => navigate('/settings/backup')}
            >
              立即备份
            </button>
          </div>
        )}

        {/* 最近条目（S5-B 任务 5-3 增量；PRD §1.5 #11 「最近物料/成衣」落地） */}
        <div className="recent-section" style={{ marginTop: '20px' }}>
          <div
            className="quick-add-title"
            style={{ marginBottom: '10px' }}
          >
            最近条目
          </div>
          {recentItems.length === 0 ? (
            <div
              className="section-empty"
              style={{
                background: 'var(--card)',
                borderRadius: '12px',
                padding: '20px',
                textAlign: 'center',
                fontSize: '13px',
                color: 'var(--secondary-foreground)',
              }}
            >
              暂无最近条目
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              {recentItems.map((item) => (
                <div
                  key={`${item.kind}-${item.id}`}
                  onClick={() =>
                    navigate(
                      item.kind === 'garment'
                        ? `/garments/${item.id}`
                        : `/materials/${item.id}`,
                    )
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '12px 14px',
                    background: 'var(--card)',
                    borderRadius: '12px',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      fontSize: '11px',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: 'var(--background)',
                      color: 'var(--secondary-foreground)',
                      flexShrink: 0,
                    }}
                  >
                    {recentItemLabel(item)}
                  </span>
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
                      {item.name}
                    </div>
                    <div
                      style={{
                        fontSize: '11px',
                        color: 'var(--secondary-foreground)',
                        marginTop: '2px',
                      }}
                    >
                      {fmtRecentCreatedAt(item.createdAt)}
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
          )}
        </div>
      </div>
    </div>
  );
}
