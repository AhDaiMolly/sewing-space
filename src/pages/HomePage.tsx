// src/pages/HomePage.tsx — 首页（S5-B · 任务 5-3；V-D 修订）
// UI 基线：docs/demo/src/pages/HomePage.jsx（PRD §8.1 修订：问候语读设置值、
// 备份提醒三态、不读任何缓存计数）。
// 数据来源与派生全部按 PRD §8.1 表落实：
//   - 成衣数量 = db.garments.status === 'completed' 的行数 → statsService.getHomeStats().completedCount（现算）
//   - 库存布料 = db.materials.type === 'fabric' 的 quantity 之和 → statsService.getHomeStats().fabricTotal（两位小数，单位 m）
//   - 备份提醒阈值 = 7 天（AD-D 备份1 口径变更：原 24h 改为一周，文档未改，
//     见 ad-d-notes 口径变更记录）
//   - 问候语读 settings.user_name，缺/空 → 回落「泥头李」（AA-B 设置1：预置昵称改「泥头李」，demo 写死「小满」已纠正）
//   - 自身不缓存任何统计字段；移动数据库后刷新即重算
// S5-B 任务 5-3 增量：
//   - 派发 / 完成动作均走服务层；本页面只做实时派生与跳转
//   - 「立即备份」按钮在 S6 未实装前跳转 /settings/backup（S6 接收实际写入流程）
// V-D 修订（用户验收第四棒 首页Q1/Q2/Q3）：
//   - 首页Q1：移除「最近条目」栏位（S5-B 任务 5-3 增量按验收口径回退）；
//     其余控件沿用 demo 同款间距节奏（overview margin-bottom 20 /
//     quick-add margin-bottom 18 / 内容区 paddingTop 16）
//   - 首页Q2：移除问候语下方小字「今天也来缝一会儿呀」（demo 问候行本就无此行）
//   - 首页Q3：快速添加「任务」不再整页跳转 /workbench，改为就地打开
//     TaskFormSheet 浮层（与物料/成衣快速添加的 form-overlay 浮层交互一致；
//     保存后由 TaskFormSheet 显式落 /workbench，对齐物料表单保存后落 /materials 的既有模式）

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { getHomeStats } from '@/services/statsService';
import TaskFormSheet from '@/components/TaskFormSheet';
import type { Task } from '@/db/types';
import { IconPlus, IconArrowRight, IconGear, IconHeart, IconWarning } from '@/components/Icons';

/** 备份提醒阈值：超过一周（7 天）未备份出黄色提醒。
 *  AD-D 备份1 口径变更：原阈值 24h（days >= 1）改为一周（days >= 7）。 */
const BACKUP_STALE_DAYS = 7;

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

export default function HomePage() {
  const navigate = useNavigate();

  // 问候语：读 settings.user_name，缺/空 → 「泥头李」（PRD §8.1；AA-B 设置1 预置昵称改「泥头李」）
  const userNameSetting = useLiveQuery(
    () => db.settings.get('user_name').then((r) => r?.value ?? ''),
    [],
  );
  const userName = userNameSetting?.trim() || '泥头李';

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

  // 任务表单浮层（V-D 首页Q3）：formOpen=true 时渲染 TaskFormSheet；
  // formTask=null 为新建模式（首页入口只有新建，与工作台编辑入口区分）
  const [formOpen, setFormOpen] = useState(false);
  const [formTask, setFormTask] = useState<Task | null>(null);
  const openTaskForm = () => {
    setFormTask(null);
    setFormOpen(true);
  };
  const closeTaskForm = () => {
    setFormOpen(false);
    setFormTask(null);
  };

  // 备份提醒三态
  const lastSuccess = backupLastSuccess ?? '';
  const days =
    lastSuccess === ''
      ? -1 // 「从未备份」专用标记
      : (daysSinceBackup(lastSuccess) ?? 0);
  // 态 1：从未备份（空串）
  const isNeverBackedUp = lastSuccess === '';
  // 态 2：超过一周（7 天）但非从未备份（AD-D 备份1：原 24h 阈值改为一周）
  const isStaleBackup = !isNeverBackedUp && days >= BACKUP_STALE_DAYS;
  // 态 3：7 天内 — 不渲染

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
              onClick={openTaskForm}
              aria-label="添加任务"
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
      </div>

      {/* 任务新建浮层（V-D 首页Q3）：与物料/成衣快速添加同构的浮层交互 */}
      {formOpen && (
        <TaskFormSheet task={formTask} onClose={closeTaskForm} />
      )}
    </div>
  );
}
