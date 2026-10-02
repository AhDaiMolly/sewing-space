// src/pages/SettingsPage.tsx —— 设置页（S6-B 完整实现）
//
// UI 基线：docs/demo/src/pages/SettingsPage.jsx
// 路由：/settings → 主列表 / /settings/backup → 备份 / /settings/github → GitHub 配置
// /settings/templates → 任务模板（路由到 TemplateSettings 组件）
//
// 硬约束：
//   - 所有数据与网络动作只调服务层，UI 不得直写 db 或直发 GitHub 请求
//   - PAT 在界面只做掩码展示（•••• + 后 4 位），绝不回显完整 PAT
//   - 确认弹窗只用已存在于冻结 CSS 的类，禁用 window.prompt/alert/confirm
//   - useLiveQuery 三态判定（undefined=未解析 / null=不存在）
//   - 浮层 stopPropagation、表单 useLiveQuery 返回后重同步
//   - blob URL 存 useState、搜索 trim、不静默封顶输入

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import {
  exportBackup,
  parseBackupLogged,
  importBackupFile,
  listBackupLogs,
  pushBackupToGithub,
  fetchLatestGithubBackup,
} from '@/services/backupService';
import {
  setSetting,
  updatePresets,
} from '@/services/settingsService';
import type { PresetsConfig } from '@/db/types';
import {
  PRESET_TABS,
  PRESET_TAB_HINTS,
  PRESET_DUPLICATE_TEXT,
  AUDIENCE_LABELS,
  presetDeleteConfirmText,
  type PresetTabKey,
} from '@/lib/presetTabs';
import { patExpiryInfo } from '@/lib/patExpiry';
import { APP_VERSION } from '@/lib/version';
import { GithubServiceError, testGithubConnection } from '@/services/githubService';
import { toast } from '@/store/toastStore';
import type { BackupLog } from '@/db/types';
import { DEFAULT_PRESETS } from '@/db/seed';
import {
  IconBack,
  IconArrowRight,
  IconGear,
  IconTask,
  IconTag,
  IconNote,
  IconHeart,
  IconWarning,
  IconCheck,
  IconTrash,
} from '@/components/Icons';

// ============================ 辅助函数 ============================

/** PAT 掩码：仅显示末 4 位，其余用 •••• 替代。 */
function maskPat(token: string): string {
  if (!token) return '';
  if (token.length <= 4) return '••••';
  return '••••' + token.slice(-4);
}

/** 格式化 ISO 日期时间为本地可读格式。 */
function formatDateTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/** 判断 GitHub 配置是否完整。 */
function isGithubConfigured(
  token: string | undefined,
  username: string | undefined,
  repo: string | undefined,
): boolean {
  return !!(token && username && repo);
}

// ============================ SettingsPage（入口页） ============================

interface SettingsSubItem {
  key: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
  badgeType?: 'warn';
  onClick: () => void;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const { sub } = useParams<{ sub?: string }>();

  // 读取用户信息与备份状态（Dexie 直接查询，供主列表用）
  const userName = useLiveQuery(() =>
    db.settings.get('user_name'),
  );
  const backupLastSuccess = useLiveQuery(() =>
    db.settings.get('backup_last_success'),
  );
  const githubToken = useLiveQuery(() =>
    db.settings.get('github_token'),
  );
  const githubUsername = useLiveQuery(() =>
    db.settings.get('github_username'),
  );
  const githubRepo = useLiveQuery(() =>
    db.settings.get('github_repo'),
  );
  const dirtySinceBackup = useLiveQuery(() =>
    db.settings.get('dirty_since_backup'),
  );

  const configured = isGithubConfigured(
    githubToken?.value,
    githubUsername?.value,
    githubRepo?.value,
  );

  // ========== 子页面路由 ==========
  if (sub === 'backup') return <BackupSettings />;
  if (sub === 'github') return <GithubSettings />;
  if (sub === 'profile') return <ProfileSettings />;
  if (sub === 'presets') return <PresetsSettings />;
  if (sub === 'about') return <AboutSettings />;

  // ========== 设置主列表 ==========
  const settingsItems: SettingsSubItem[] = [
    {
      key: 'backup',
      icon: <IconGear style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />,
      title: '备份',
      subtitle: backupLastSuccess?.value
        ? `上次备份：${formatDateTime(backupLastSuccess.value)}`
        : '立即备份、导出/导入',
      badge: dirtySinceBackup?.value === 'true' ? '有未备份修改' : undefined,
      badgeType: 'warn',
      onClick: () => navigate('/settings/backup'),
    },
    {
      key: 'github',
      icon: <IconGear style={{ width: '22px', height: '22px', color: '#333' }} />,
      title: 'GitHub 配置',
      subtitle: configured ? '已配置' : '未配置',
      onClick: () => navigate('/settings/github'),
    },
    {
      key: 'templates',
      icon: <IconTask style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />,
      title: '任务模板管理',
      subtitle: '新建、编辑、删除任务模板',
      onClick: () => navigate('/settings/templates'),
    },
    {
      key: 'presets',
      icon: <IconTag style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />,
      title: '预设管理',
      subtitle: '款式、人群、尺码、面料与辅料分类、品牌',
      onClick: () => navigate('/settings/presets'),
    },
    {
      key: 'data',
      icon: <IconNote style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />,
      title: '数据管理',
      subtitle: '重新运行初始化向导',
      onClick: () => navigate('/wizard'),
    },
    {
      key: 'about',
      icon: <IconHeart style={{ width: '22px', height: '22px', color: 'var(--accent)' }} />,
      title: '关于',
      subtitle: `版本 ${APP_VERSION} · 存储用量`,
      onClick: () => navigate('/settings/about'),
    },
  ];

  return (
    <div className="page">
      {/* W-B 设置6：设置主页加「返回主页」按钮，形态与各子页返回按钮完全一致（同图标/位置/交互），
          点击回首页。/settings 非底部导航一级路由（无 BottomNav），无导航交互冲突。 */}
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">设置</h1>
        <div className="right-actions">
          <div style={{ width: '36px' }} />
        </div>
      </div>
      <div className="page-content with-bottom-nav settings-page" style={{ paddingBottom: '24px' }}>
        {/* 用户信息头 */}
        <div className="settings-user-header" onClick={() => navigate('/settings/profile')}>
          <div className="settings-avatar">
            <IconTask style={{ width: '28px', height: '28px', color: 'var(--accent)' }} />
          </div>
          <div className="settings-user-info">
            <div className="settings-user-name">
              {userName?.value || '泥头李'}
            </div>
            <div className="settings-user-sub">
              {/* W-B 设置3：缝纫年限字段已从 UI 移除，不再展示（sewing_years 数据保留） */}
              点击编辑个人信息
            </div>
          </div>
          <IconArrowRight style={{ width: '16px', height: '16px', color: '#ccc' }} />
        </div>

        {/* 设置项列表 */}
        <div className="settings-list">
          {settingsItems.map((item) => (
            <div
              key={item.key}
              className="settings-item"
              onClick={item.onClick}
            >
              <div className="settings-item-icon">
                {item.icon}
              </div>
              <div className="settings-item-content">
                <div className="settings-item-title">{item.title}</div>
                <div className="settings-item-subtitle">{item.subtitle}</div>
              </div>
              <div className="settings-item-right">
                {item.badge && (
                  <span className={`settings-badge ${item.badgeType || ''}`}>{item.badge}</span>
                )}
                <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
              </div>
            </div>
          ))}
        </div>

        {/* 底部版本号 */}
        <div className="settings-footer">
          <div className="settings-version">v {APP_VERSION}</div>
          <div className="settings-made">用 ♥ 为缝纫爱好者打造</div>
        </div>
      </div>
    </div>
  );
}

// ============================ BackupSettings（备份子页） ============================

function BackupSettings() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pushing, setPushing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  /** 待确认恢复的 zip（本地 File 或 GitHub 拉取的 Blob），确认后走 importBackupFile。 */
  const [pendingFile, setPendingFile] = useState<Blob | null>(null);
  /** 导入路径：本地文件 / GitHub 拉取（S6-fix P0-1/P1-2 统一确认浮层）。 */
  const [pendingKind, setPendingKind] = useState<'local_import' | 'github_pull'>('local_import');
  /** 待恢复的 zip 文件名（github_pull = 远端文件名；local_import = 本地文件名；
   *  确认浮层展示 + AD-D 备份3 的 restore 日志 zip 名共用）。 */
  const [pendingFilename, setPendingFilename] = useState('');
  const [pendingParsedRows, setPendingParsedRows] = useState(0);

  // 读取备份状态（AD-D 备份1：backup_interval 查询已随「自动备份」模块移除）
  const backupLastSuccess = useLiveQuery(() =>
    db.settings.get('backup_last_success'),
  );
  const dirtySinceBackup = useLiveQuery(() =>
    db.settings.get('dirty_since_backup'),
  );
  // GitHub 凭据（「从 GitHub 恢复」入口的可用性判定，PRD §10.2 按钮 B）
  const githubToken = useLiveQuery(() => db.settings.get('github_token'));
  const githubUsername = useLiveQuery(() => db.settings.get('github_username'));
  const githubRepo = useLiveQuery(() => db.settings.get('github_repo'));
  const [backupLogs, setBackupLogs] = useState<BackupLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);

  const githubReady = !!(
    githubToken?.value
    && githubUsername?.value
    && githubRepo?.value
  );

  // 加载备份日志
  useEffect(() => {
    let cancelled = false;
    listBackupLogs(20).then((logs) => {
      if (!cancelled) {
        setBackupLogs(logs);
        setLogsLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLogsLoading(false);
    });
    return () => { cancelled = true; };
  }, [exporting, importing, pushing, pulling]);

  // （AD-D 备份1：自动备份频率切换逻辑已随「自动备份」模块一并移除——
  //  backup_interval 键与 setSetting 校验保留在数据层，UI 不再有消费者）

  // 导出备份
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await exportBackup('local_export');
      // 触发浏览器下载
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('备份已导出', 'success');
      setExporting(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导出失败';
      toast(msg, 'error');
      setExporting(false);
    }
  }, []);

  // 导入备份（文件选择 → 校验门 → 确认浮层 → importBackupFile）
  // S6-fix P1-2：校验门走 parseBackupLogged 包装层，失败写 local_import failed 日志；
  // 确认后走 importBackupFile('local_import')，与 github_pull 共用校验与日志口径。
  const handleImportSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 重置 input 以便同一文件可重复选择
    e.target.value = '';

    setImporting(true);
    try {
      // 第①步：校验门（parseBackupLogged 仅校验，失败写 local_import failed 日志）
      const parsed = await parseBackupLogged(file, 'local_import');
      const totalRows =
        (parsed.materials?.length || 0) +
        (parsed.garments?.length || 0) +
        (parsed.tasks?.length || 0) +
        (parsed.taskTemplates?.length || 0) +
        (parsed.usageLogs?.length || 0) +
        (parsed.images?.length || 0);
      setPendingFile(file);
      setPendingKind('local_import');
      // AD-D 备份3：本地导入也记 zip 名（File.name），供 restore 日志展示
      setPendingFilename(file instanceof File ? file.name : '');
      setPendingParsedRows(totalRows);
      setShowRestoreConfirm(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '校验未通过';
      toast(`导入失败：${msg}`, 'error');
    } finally {
      setImporting(false);
    }
  }, []);

  // 从 GitHub 恢复（S6-fix P0-1，架构 §9.6 ①② + PRD §10.2 按钮 B）：
  // 拉取最新备份 → 解析校验门（失败写 github_pull failed 日志）→ 确认浮层 →
  // 确认后走 importBackupFile('github_pull') 完成白名单覆盖与 restore 日志。
  const handlePullFromGithub = useCallback(async () => {
    if (!githubReady) {
      toast('请先在 GitHub 设置里填写令牌与仓库名', 'default');
      return;
    }
    setPulling(true);
    try {
      const pulled = await fetchLatestGithubBackup();
      const parsed = await parseBackupLogged(pulled.blob, 'github_pull');
      const totalRows =
        (parsed.materials?.length || 0) +
        (parsed.garments?.length || 0) +
        (parsed.tasks?.length || 0) +
        (parsed.taskTemplates?.length || 0) +
        (parsed.usageLogs?.length || 0) +
        (parsed.images?.length || 0);
      setPendingFile(pulled.blob);
      setPendingKind('github_pull');
      setPendingFilename(pulled.filename);
      setPendingParsedRows(totalRows);
      setShowRestoreConfirm(true);
    } catch (err) {
      if (err instanceof GithubServiceError) {
        toast(err.message, err.retryable ? 'default' : 'error');
      } else {
        const msg = err instanceof Error ? err.message : '拉取失败';
        toast(`导入失败：${msg}`, 'error');
      }
    } finally {
      setPulling(false);
    }
  }, [githubReady]);

  // 确认恢复：两条导入路径（local_import / github_pull）统一走 importBackupFile
  // 包装层（S6-fix P1-2）——同一套校验、restore 日志与失败留痕口径。
  const handleConfirmRestore = useCallback(async () => {
    if (!pendingFile) return;
    setShowRestoreConfirm(false);
    setImporting(true);
    try {
      // AD-D 备份3：restore 日志带上 zip 包名（github_pull = 远端文件名，
      // local_import = 本地文件名；缺名为空时服务层回落旧格式）
      const report = await importBackupFile(pendingFile, pendingKind, {
        filename: pendingFilename || undefined,
      });
      const rows = (report.restored.materials ?? 0)
        + (report.restored.garments ?? 0)
        + (report.restored.tasks ?? 0)
        + (report.restored.taskTemplates ?? 0)
        + (report.restored.usageLogs ?? 0);
      // AC-A：图片个别保存失败时给出可操作的中文警告（其余数据已完成恢复）。
      const failedImages = report.failedImages ?? 0;
      // AE-A Q2：失败原因分级（配额不足 / 单图过大经预检前置拦截；写入期的
      // iOS 已知行为 / 其他错误经 summarizeImagePutFailures 聚合）。
      const failedReason = report.failedImagesReason ?? '';
      toast(
        failedImages > 0
          ? `已恢复 ${rows} 行数据, ${report.restored.images ?? 0} 张图片（${failedImages} 张图片保存失败，已跳过，可重新导入${failedReason ? `。失败原因：${failedReason}` : ''}）`
          : `已恢复 ${rows} 行数据, ${report.restored.images ?? 0} 张图片`,
        report.status === 'partial' ? 'default' : 'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '恢复失败';
      toast(`导入失败：${msg}`, 'error');
    } finally {
      setImporting(false);
      setPendingFile(null);
      setPendingKind('local_import');
      setPendingFilename('');
      setPendingParsedRows(0);
    }
  }, [pendingFile, pendingKind, pendingFilename]);

  const handleCancelRestore = useCallback(() => {
    setShowRestoreConfirm(false);
    setPendingFile(null);
    setPendingKind('local_import');
    setPendingFilename('');
    setPendingParsedRows(0);
  }, []);

  // 推送备份到 GitHub（S6-fix P1-1：pushBackupToGithub 服务层编排——
  // 构建包不落本地账，push 成功才写 github_push 日志 + backup_last_success + 清脏）
  const handlePushToGithub = useCallback(async () => {
    setPushing(true);
    try {
      const pushResult = await pushBackupToGithub();
      // AA-B 设置3-1：成功提示改为「推送成功」；完整 commit 信息仍由服务层写入备份日志（github_push），不在 toast 中展示
      toast('推送成功', 'success');
      void pushResult;
      setPushing(false);
    } catch (e) {
      if (e instanceof GithubServiceError) {
        toast(e.message, e.retryable ? 'default' : 'error');
      } else {
        const msg = e instanceof Error ? e.message : '推送失败';
        toast(`推送失败：${msg}`, 'error');
      }
      setPushing(false);
    }
  }, []);

  // 状态标签
  const statusLabel = (status: string): string => {
    if (status === 'success') return '成功';
    if (status === 'failed') return '失败';
    if (status === 'partial') return '部分完成';
    return status;
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">备份</h1>
        <div className="right-actions">
          <div style={{ width: '36px' }} />
        </div>
      </div>

      <div className="page-content with-bottom-nav">
        {/* 当前状态卡 */}
        <div className="backup-status-card">
          <div className="backup-status-icon">
            <IconGear style={{ width: '32px', height: '32px', color: 'var(--accent)' }} />
          </div>
          <div className="backup-status-info">
            <div className="backup-status-label">上次备份</div>
            <div className="backup-status-value">
              {backupLastSuccess?.value
                ? formatDateTime(backupLastSuccess.value)
                : '还没备份过'}
            </div>
            <div className="backup-status-sub">
              {dirtySinceBackup?.value === 'true' ? '有未备份修改' : '数据已是最新'}
            </div>
          </div>
        </div>

        {/* 立即备份按钮 */}
        <button
          className="btn btn-primary btn-block"
          disabled={exporting}
          onClick={handleExport}
          style={{ marginTop: '12px' }}
        >
          {exporting ? '导出中…' : '立即备份'}
        </button>

        {/* 推送到 GitHub（S6-fix：凭据缺失置灰 + 按钮下方提示，PRD §10.2 按钮 B） */}
        <button
          className="btn btn-secondary btn-block"
          disabled={pushing || !githubReady}
          onClick={handlePushToGithub}
          style={{ marginTop: '8px' }}
        >
          {pushing ? '推送中…' : '推送到 GitHub'}
        </button>
        {!githubReady && (
          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--secondary-foreground)', textAlign: 'center' }}>
            请先在 GitHub 设置里填写令牌与仓库名
          </div>
        )}

        {/* 恢复 & 导入导出（demo 逐字复刻：从 GitHub 恢复 / 从本地文件导入）
            （AD-D 备份1：原此处的「自动备份」模块已移除——该功能从未实装，
            选项无消费者，见 ad-d-notes 口径变更记录） */}
        <div className="settings-section-card">
          <div className="settings-section-title">恢复与迁移</div>
          <div
            className="settings-row-link"
            onClick={handlePullFromGithub}
            style={!githubReady ? { opacity: 0.5 } : undefined}
          >
            <span className="row-link-label">
              {pulling || (importing && pendingKind === 'github_pull') ? '导入中…' : '从 GitHub 恢复'}
            </span>
            <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
          </div>
          <div className="settings-row-divider" />
          <div
            className="settings-row-link"
            onClick={() => {
              // 触发文件选择
              fileInputRef.current?.click();
            }}
          >
            <span className="row-link-label">
              {importing && pendingKind === 'local_import' ? '导入中…' : '从本地文件导入'}
            </span>
            <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={handleImportSelect}
          />
        </div>

        {/* 备份历史记录 */}
        <div className="settings-section-card" style={{ marginTop: '16px' }}>
          <div className="settings-section-title">备份记录</div>
          {logsLoading ? (
            <div style={{ padding: '16px', color: 'var(--secondary-foreground)', fontSize: '13px', textAlign: 'center' }}>
              加载中…
            </div>
          ) : backupLogs.length === 0 ? (
            <div style={{ padding: '24px 16px', color: 'var(--secondary-foreground)', fontSize: '13px', textAlign: 'center' }}>
              暂无备份记录
            </div>
          ) : (
            backupLogs.map((log) => (
              <div key={log.id} className="log-item">
                <div className="log-icon">
                  {log.status === 'success' ? (
                    <IconCheck style={{ width: '16px', height: '16px', color: 'var(--success)' }} />
                  ) : log.status === 'failed' ? (
                    <IconWarning style={{ width: '16px', height: '16px', color: 'var(--destructive)' }} />
                  ) : (
                    <IconWarning style={{ width: '16px', height: '16px', color: '#F5A623' }} />
                  )}
                </div>
                <div className="log-content">
                  <div className="log-title">
                    {statusLabel(log.status)}
                  </div>
                  <div className="log-meta">
                    {log.message || formatDateTime(log.createdAt)}
                  </div>
                </div>
                <div className="log-qty" style={{ fontSize: '11px', color: 'var(--secondary-foreground)' }}>
                  {formatDateTime(log.createdAt).slice(-11)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* 备份提醒说明 */}
        <div className="backup-hint-box">
          <IconWarning style={{ width: '16px', height: '16px', color: 'var(--accent)', flexShrink: 0 }} />
          <span>超过 7 天未备份时，首页会出现黄色提醒。</span>
        </div>
      </div>

      {/* 恢复确认浮层 */}
      {showRestoreConfirm && (
        <div
          className="confirm-overlay"
          onClick={(e) => { e.stopPropagation(); handleCancelRestore(); }}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-icon">!</div>
            <div className="confirm-title">确定从备份文件恢复？</div>
            <div className="confirm-detail-box">
              <div className="confirm-detail-title">恢复后将覆盖：</div>
              <div style={{ fontSize: '13px', color: 'var(--secondary-foreground)', lineHeight: '1.6' }}>
                {pendingKind === 'github_pull' && pendingFilename && (
                  <>
                备份文件：{pendingFilename}（GitHub 拉取）
                    <br /><br />
                  </>
                )}
                物料、成衣、任务、模板、用量记录、图片等共 <strong>{pendingParsedRows}</strong> 行数据
                <br /><br />
                本机的令牌、设备 ID、用户姓名等不会被覆盖
              </div>
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                onClick={handleCancelRestore}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                onClick={handleConfirmRestore}
                disabled={importing}
              >
                {importing ? '恢复中…' : '确定恢复'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================ GithubSettings（GitHub 配置子页） ============================

function GithubSettings() {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => ({
    username: '',
    repo: 'sewing-space-backup',
    token: '',
  }));
  const [formReady, setFormReady] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { status: 'success' | 'warning' | 'failed' | null; message: string }
  >({ status: null, message: '' });
  const [showGuide, setShowGuide] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  // 从 Dexie 加载已有配置
  // §S7-D 修复：db.settings.get() 在空行/缺失行时返回 undefined，与「未解析」同态 → useEffect 兜底永远跑不到
  // 改用 toArray + find：undefined=加载中，已解析后 find 可能返回 undefined（行不存在）但 formReady 仍可置 true
  const allGhSettings = useLiveQuery(() => db.settings.toArray());
  const githubToken = allGhSettings?.find((s) => s.key === 'github_token');
  const githubUsername = allGhSettings?.find((s) => s.key === 'github_username');
  const githubRepo = allGhSettings?.find((s) => s.key === 'github_repo');
  const patExpiresAt = allGhSettings?.find((s) => s.key === 'pat_expires_at');

  // useLiveQuery 返回后重同步表单
  // W-B 设置1：令牌过期日字段已从 UI 移除（pat_expires_at 键与既有数据保留，
  // PAT 临期提醒横幅逻辑保留，读不到过期日时不展示横幅——详见 wb-notes）。
  useEffect(() => {
    if (allGhSettings === undefined) return; // 仍加载中
    if (!formReady) {
      setForm({
        // AE-A Q3：GitHub 用户名预置 AhDaiMolly（仅默认值，可改）。
        // 用 || 而非 ??：存量用户旧 seed 种入的是空串，空串视为未配置、回落预置；
        // 用户改过（含恢复备份带入）的任意非空值原样显示。
        username: githubUsername?.value || 'AhDaiMolly',
        repo: githubRepo?.value ?? 'sewing-space-backup',
        token: githubToken?.value ?? '',
      });
      setFormReady(true);
    }
  }, [allGhSettings, githubToken, githubUsername, githubRepo, formReady]);

  const configured = isGithubConfigured(
    githubToken?.value,
    githubUsername?.value,
    githubRepo?.value,
  );
  const maskedToken = configured
    ? maskPat(githubToken?.value ?? '')
    : '';

  const updateField = (key: string, val: string) => {
    setForm((prev) => ({ ...prev, [key]: val }));
  };

  // 保存配置（P2-1：走服务层 setSetting 统一写路径，不再 UI 直写 db）
  // W-B 设置1：不再写 pat_expires_at（录入 UI 已移除；若本机存有旧值则原样保留，
  // 供既有临期提醒逻辑继续读取，不被空值覆盖）。
  const handleSave = async () => {
    try {
      await setSetting('github_username', form.username.trim());
      await setSetting('github_repo', form.repo.trim() || 'sewing-space-backup');
      if (!configured) {
        // 仅在未配置时保存 token（已配置不覆盖）
        await setSetting('github_token', form.token.trim());
      }
      toast(configured ? '配置已更新' : '配置已保存', 'success');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : '保存失败，请重试', 'error');
    }
  };

  // 测试连接（P2-2：走服务层 testGithubConnection，文案按 PRD §12.3 逐字对齐）
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult({ status: null, message: '' });
    try {
      const token = configured ? (githubToken?.value ?? '') : form.token.trim();
      const owner = form.username.trim() || (githubUsername?.value ?? '');
      const repo = form.repo.trim() || (githubRepo?.value ?? '');
      if (!token || !owner || !repo) {
        setTestResult({ status: 'failed', message: '请先填写完整的配置信息' });
        setTesting(false);
        return;
      }
      const result = await testGithubConnection({ token, owner, repo });
      if (result.state === 'success') {
        setTestResult({ status: 'success', message: '连接正常，仓库可访问' });
      } else if (result.state === 'auth_rejected') {
        setTestResult({ status: 'failed', message: '令牌无效或已过期，请重新生成' });
      } else if (result.state === 'repo_missing') {
        setTestResult({ status: 'warning', message: '找不到该仓库，请检查仓库名与用户名' });
      } else {
        setTestResult({ status: 'warning', message: '网络不可用，稍后再试' });
      }
    } finally {
      setTesting(false);
    }
  };

  // 清除令牌（P2-1：走 setSetting；backup_interval 属 FROM_ZIP 组会按 §5.11 打脏，
  // github_token / pat_expires_at 属保留组不打脏——这正是 §9.9 对照表的口径）
  const handleClearToken = async () => {
    try {
      await setSetting('github_token', '');
      await setSetting('pat_expires_at', '');
      await setSetting('backup_interval', 'manual');
      setForm((prev) => ({ ...prev, token: '' }));
      toast('令牌已清除，推送备份已关闭', 'default');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : '清除失败，请重试', 'error');
    }
    setShowClearConfirm(false);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">GitHub 配置</h1>
        <div className="right-actions">
          <div style={{ width: '36px' }} />
        </div>
      </div>

      <div className="page-content with-bottom-nav">
        {/* PAT 临期提醒（7-2 S7-B：过期前 7 天起横幅提示；S7-FIX：过期判定统一 UTC 日期边界） */}
        {(() => {
          const expires = patExpiresAt?.value ?? '';
          if (!expires) return null;
          const info = patExpiryInfo(expires);
          if (!info || info.status === 'expired' || info.diffDays > 7) return null;
          return (
            <div
              className="backup-hint-box"
              style={{ cursor: 'pointer', marginTop: '0' }}
              onClick={() => tokenInputRef.current?.focus()}
            >
              <IconWarning style={{ width: '16px', height: '16px', color: '#F5A623', flexShrink: 0 }} />
              <span>访问令牌将在 {info.diffDays} 天后（{expires}）过期，请及时更换</span>
            </div>
          );
        })()}

        {/* 过期日已过：顶部警告横幅（PRD §12.3，锚点跳回令牌输入框，不弹窗；S7-FIX：UTC 日期边界） */}
        {(() => {
          const expires = patExpiresAt?.value ?? '';
          if (!expires) return null;
          const info = patExpiryInfo(expires);
          if (!info || info.status === 'valid') return null;
          return (
            <div
              className="backup-hint-box"
              style={{ cursor: 'pointer' }}
              onClick={() => tokenInputRef.current?.focus()}
            >
              <IconWarning style={{ width: '16px', height: '16px', color: '#F5A623', flexShrink: 0 }} />
              <span>访问令牌已于 {expires} 过期，请重新生成</span>
            </div>
          );
        })()}

        <div className="settings-section-card">
          <div className="input-row" style={{ padding: '10px 0', borderBottom: 'none' }}>
            <label className="input-label">GitHub 用户名</label>
            <input
              className="input-field"
              placeholder="your-github-name"
              value={form.username}
              onChange={(e) => updateField('username', e.target.value)}
            />
          </div>
          <div className="input-row" style={{ padding: '10px 0', borderBottom: 'none' }}>
            <label className="input-label">仓库名</label>
            <input
              className="input-field"
              value={form.repo}
              onChange={(e) => updateField('repo', e.target.value)}
            />
          </div>
          <div className="input-row" style={{ padding: '10px 0', borderBottom: 'none' }}>
            <label className="input-label">Personal Access Token</label>
            <input
              className="input-field"
              type="password"
              placeholder={configured ? maskedToken : 'ghp_xxxxxxxxx'}
              value={configured ? maskedToken : form.token}
              onChange={(e) => {
                if (!configured) updateField('token', e.target.value);
              }}
              disabled={configured}
              style={{ color: configured ? '#999' : 'inherit' }}
              ref={tokenInputRef}
            />
            {configured && (
              <div style={{ fontSize: '11px', color: 'var(--secondary-foreground)', marginTop: '6px' }}>
                令牌已保存，如需更换请先清除
              </div>
            )}
          </div>
        </div>

        {/* 测试连接结果 */}
        {testResult.status && (
          <div
            className="backup-hint-box"
            style={{ marginTop: '12px' }}
          >
            {testResult.status === 'success' ? (
              <IconCheck style={{ width: '16px', height: '16px', color: 'var(--success)', flexShrink: 0 }} />
            ) : testResult.status === 'warning' ? (
              <IconWarning style={{ width: '16px', height: '16px', color: '#F5A623', flexShrink: 0 }} />
            ) : (
              <IconWarning style={{ width: '16px', height: '16px', color: 'var(--destructive)', flexShrink: 0 }} />
            )}
            <span>{testResult.message}</span>
          </div>
        )}

        {/* 按钮组 */}
        <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
          <button
            className="btn btn-secondary"
            style={{ flex: 1 }}
            disabled={testing}
            onClick={handleTestConnection}
          >
            {testing ? '连接中…' : '测试连接'}
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={handleSave}
          >
            保存
          </button>
        </div>

        {/* 清除令牌 */}
        {configured && (
          <button
            className="btn btn-secondary"
            style={{ marginTop: '12px', width: '100%', color: 'var(--destructive)' }}
            onClick={() => setShowClearConfirm(true)}
          >
            清除令牌
          </button>
        )}

        {/* 配置指南折叠区 */}
        <div className="settings-section-card" style={{ marginTop: '16px' }}>
          <div
            className="settings-row-link"
            onClick={() => setShowGuide(!showGuide)}
            style={{ padding: '8px 0' }}
          >
            <span className="row-link-label" style={{ fontWeight: 600 }}>配置指南</span>
            <span style={{
              transform: showGuide ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              color: '#ccc',
            }}>
              <IconArrowRight style={{ width: '14px', height: '14px' }} />
            </span>
          </div>
          {showGuide && (
            <div className="guide-content">
              <p>1. 登录 GitHub，进入 <strong>Settings → Developer settings → Personal access tokens → Fine-grained tokens</strong></p>
              <p>2. 点击 <strong>Generate new token</strong>，命名（如 sewing-space-backup），选择过期时间</p>
              <p>3. Repository access 选 <strong>Only select repositories</strong>，选择备份仓库</p>
              <p>4. Permissions → Repository permissions → Contents → 选 <strong>Read and write</strong></p>
              <p>5. 点击 Generate token，复制生成的令牌粘贴到上方输入框</p>
            </div>
          )}
        </div>

        {/* 到期提醒（>7 天后的未过期令牌；7 天内的走顶部临期横幅；S7-FIX：UTC 日期边界） */}
        {patExpiresAt?.value && (() => {
          const info = patExpiryInfo(patExpiresAt.value);
          if (!info || info.status !== 'valid' || info.diffDays <= 7) return null; // 由顶部临期横幅处理
          return (
            <div className="backup-hint-box">
              <IconWarning style={{ width: '16px', height: '16px', color: '#F5A623', flexShrink: 0 }} />
              <span>令牌将于 {patExpiresAt.value} 到期，到期前请及时更换。</span>
            </div>
          );
        })()}

        {/* 免责文案 */}
        <div className="backup-hint-box" style={{ marginTop: '16px' }}>
          <IconWarning style={{ width: '16px', height: '16px', color: 'var(--accent)', flexShrink: 0 }} />
          <span>令牌明文保存在本机浏览器中，不会被上传到任何服务器，也不会写进备份文件。建议创建一个只勾选 `public_repo` 权限、有效期 90 天的细粒度令牌。备份仓库是公开的，仓库里会有你的物料、成衣与照片。</span>
        </div>
      </div>

      {/* 清除令牌确认弹窗 */}
      {showClearConfirm && (
        <div
          className="confirm-overlay"
          onClick={(e) => { e.stopPropagation(); setShowClearConfirm(false); }}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-icon">!</div>
            <div className="confirm-title">确定清除令牌？</div>
            <div className="confirm-detail-box">
              <div className="confirm-detail-title">清除后：</div>
              <div style={{ fontSize: '13px', color: 'var(--secondary-foreground)', lineHeight: '1.6' }}>
                推送备份将不可用，需重新配置令牌才能推送到 GitHub
              </div>
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setShowClearConfirm(false)}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                onClick={handleClearToken}
              >
                确定清除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================ ProfileSettings（个人信息子页） ============================

function ProfileSettings() {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [ready, setReady] = useState(false);

  // §S7-D 修复：db.settings.get() 在空行/缺失行时返回 undefined，与「未解析」同态 → ready 永远 false
  // 改用 toArray + find：undefined=加载中，已解析则可置 ready
  // W-B 设置3：缝纫年限字段已从 UI 移除（sewing_years 键、既有数据与 settingsService
  // 的钳制逻辑全部保留不动，保存时不再写 sewing_years，不覆盖既有值）。
  const allProfileSettings = useLiveQuery(() => db.settings.toArray());
  const userName = allProfileSettings?.find((s) => s.key === 'user_name');

  useEffect(() => {
    if (allProfileSettings === undefined) return; // 仍加载中
    if (!ready) {
      setName(userName?.value || '泥头李');
      setReady(true);
    }
  }, [allProfileSettings, userName, ready]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const trimmed = name.trim();
      await setSetting('user_name', trimmed || '泥头李');
      toast('个人信息已保存', 'success');
      // AA-B 设置1：保存成功后返回设置页（不再停留在个人信息页）。
      navigate('/settings');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">个人信息</h1>
        <div className="right-actions">
          <div style={{ width: '36px' }} />
        </div>
      </div>

      <div className="page-content with-bottom-nav">
        <div className="settings-section-card">
          <div className="input-row" style={{ padding: '10px 0', borderBottom: 'none' }}>
            <label className="input-label">昵称</label>
            <input
              className="input-field"
              placeholder="泥头李"
              value={name}
              maxLength={20}
              onChange={(e) => setName(e.target.value)}
            />
            <div style={{ fontSize: '11px', color: 'var(--secondary-foreground)', marginTop: '4px' }}>
              1–20 个字符，留空则保存为「泥头李」
            </div>
          </div>
        </div>

        <button
          className="btn btn-primary btn-block"
          style={{ marginTop: '12px' }}
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

// ============================ AboutSettings（关于子页，S7-FIX P1-1/P1-2 重做） ============================
//
// PRD §12.10 页面结构：产品头（about-hero）/ 存储用量卡片 / 链接列表卡片（应用内浮层，不发外链）/ 页脚。
// （AA-B 设置4-a：数据同步卡片已按用户决定移除；设置4-b：产品头图标复用 iOS 主屏 180 PNG；
//   设置4-c：版本号引用 src/lib/version.ts 的 APP_VERSION。）
// 类名逐字对齐 demo AboutSettings
// （about-hero / storage-* / settings-row-link / row-link-label / settings-row-divider）。
// 存储用量必须是真实数据：已用体积现算（navigator.storage.estimate 的字节数），
// 上限按是否安装分两档（未安装约 50 MB / 已安装约 1 GB）。

/** 字节数格式化：B / KB / MB（保留 1 位小数）。 */
function formatStorageBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 链接卡三行的应用内浮层内容（PRD §12.10：不发外链，浮层为简要文本）。 */
const ABOUT_SHEETS: Record<'agreement' | 'privacy' | 'stack', { title: string; body: string[] }> = {
  agreement: {
    title: '用户协议',
    body: [
      '缝纫空间是运行在你自己设备浏览器里的个人缝纫记录工具。',
      '你的全部数据（物料、成衣、任务与照片）只存在本机浏览器与你自己配置的 GitHub 仓库中，请保持定期备份习惯。',
      '本应用按「现状」提供，不对数据丢失承担责任；继续使用即视为接受本说明。',
    ],
  },
  privacy: {
    title: '隐私政策',
    body: [
      '你的数据只存在这台设备的浏览器里，以及你自己配置的 GitHub 仓库里。我们不收集、不上传任何内容。',
      '备份推送仅在你在设置页主动配置 GitHub 凭据后、由你手动触发时才会发生。',
    ],
  },
  stack: {
    title: '开源与技术栈',
    body: [
      '本版使用的开源项目：React、React Router、Dexie、Zustand、Zod、Vite、TypeScript、Tailwind CSS、Workbox、JSZip、lucide-react、nanoid。',
    ],
  },
};

function AboutSettings() {
  const navigate = useNavigate();
  /** 已用存储字节数（navigator.storage.estimate 实测；null = 读取中）。 */
  const [usageBytes, setUsageBytes] = useState<number | null>(null);
  /** 是否已安装为独立应用（standalone 检测，决定配额档位）。 */
  const [installed, setInstalled] = useState(false);
  /** 链接卡浮层（应用内说明浮层，不发外链）。 */
  const [sheet, setSheet] = useState<keyof typeof ABOUT_SHEETS | null>(null);

  useEffect(() => {
    // 是否安装为独立应用：PWA standalone 或 iOS standalone
    const standalone =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches) ||
      (navigator as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    // 真实存储字节数：navigator.storage.estimate（P1-1，不得用「条数」冒充字节数）
    if (navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then((est) => {
          setUsageBytes(typeof est.usage === 'number' ? est.usage : 0);
        })
        .catch(() => setUsageBytes(0));
    } else {
      setUsageBytes(0);
    }
  }, []);

  // AA-B 设置4-a：数据同步模块已移除（PRD §12.5 多设备同步为占位、未排期，用户决定移除），
  // last_sync_at / last_sync_remote 的读取随之删除（设置键本身保留，不动存量数据）。

  const quotaBytes = installed ? 1024 * 1024 * 1024 : 50 * 1024 * 1024;
  const quotaLabel = installed ? '约 1 GB' : '约 50 MB';
  const storagePct =
    usageBytes === null ? 0 : Math.min(100, Math.round((usageBytes / quotaBytes) * 100));

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">关于</h1>
        <div className="right-actions">
          <div style={{ width: '36px' }} />
        </div>
      </div>

      <div className="page-content with-bottom-nav">
        {/* 产品头 */}
        <div className="about-hero">
          {/* AA-B 设置4-b：顶部图标改为与 iOS 主屏图标一致（复用包内 180×180 PNG） */}
          <div className="about-logo">
            <img
              src={`${import.meta.env.BASE_URL}icons/apple-touch-icon.png`}
              alt="缝纫空间"
              style={{ width: '56px', height: '56px', borderRadius: '12px', display: 'block' }}
            />
          </div>
          <div className="about-app-name">缝纫空间</div>
          <div className="about-version">版本 {APP_VERSION}</div>
        </div>

        {/* 存储用量（真实字节数 + 配额进度条，PRD §12.10） */}
        <div className="settings-section-card">
          <div className="settings-section-title">存储用量</div>
          <div className="storage-row">
            <div className="storage-used">
              <div className="storage-bar">
                <div className="storage-fill" style={{ width: `${storagePct}%` }} />
              </div>
              <div className="storage-text">
                {usageBytes === null
                  ? '统计中…'
                  : `已用 ${formatStorageBytes(usageBytes)} / ${quotaLabel} 配额`}
              </div>
            </div>
          </div>
          <div className="storage-hint">
            未安装为独立应用时可用约 50 MB；安装到桌面后可用约 1 GB。系统可能在长期未使用时清理浏览器数据，请保持备份习惯。
          </div>
        </div>

        {/* AA-B 设置4-a：数据同步卡片已整体移除（PRD §12.5 占位未排期，用户 2026-09-30 决定移除） */}

        {/* 隐私说明（PRD §12.10 固定口径，逐字） */}
        <div className="settings-section-card" style={{ marginTop: '16px' }}>
          <div className="settings-section-title">隐私说明</div>
          <div className="settings-row">
            <div className="settings-row-value" style={{ fontSize: '13px', lineHeight: 1.6 }}>
              你的数据只存在这台设备的浏览器里，以及你自己配置的 GitHub 仓库里。我们不收集、不上传任何内容。
            </div>
          </div>
        </div>

        {/* 链接列表（三行都打开应用内说明浮层，不发外链，PRD §12.10） */}
        <div className="settings-section-card" style={{ marginTop: '16px' }}>
          <div className="settings-row-link" onClick={() => setSheet('agreement')}>
            <span className="row-link-label">用户协议</span>
            <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
          </div>
          <div className="settings-row-divider" />
          <div className="settings-row-link" onClick={() => setSheet('privacy')}>
            <span className="row-link-label">隐私政策</span>
            <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
          </div>
          <div className="settings-row-divider" />
          <div className="settings-row-link" onClick={() => setSheet('stack')}>
            <span className="row-link-label">开源与技术栈</span>
            <IconArrowRight style={{ width: '14px', height: '14px', color: '#ccc' }} />
          </div>
        </div>

        {/* 页脚（PRD §12.10：一句「用 ♥ 为缝纫爱好者打造」，不可点） */}
        <div className="settings-footer">
          <div className="settings-made">用 ♥ 为缝纫爱好者打造</div>
        </div>
      </div>

      {/* 应用内说明浮层（只用冻结 CSS 已有类） */}
      {sheet && (
        <div className="confirm-overlay" onClick={() => setSheet(null)}>
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-icon">i</div>
            <div className="confirm-title">{ABOUT_SHEETS[sheet].title}</div>
            <div className="confirm-detail-box">
              {ABOUT_SHEETS[sheet].body.map((line, i) => (
                <div
                  key={i}
                  className="confirm-detail-note"
                  style={i > 0 ? { paddingTop: '8px', borderTop: '1px solid var(--border-light)', marginTop: '8px' } : undefined}
                >
                  {line}
                </div>
              ))}
            </div>
            <div className="confirm-actions">
              <button className="btn btn-primary" onClick={() => setSheet(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



// ============================ PresetsSettings（预设管理子页，S7-FIX P0-2 重做） ============================
//
// PRD §12.7（原文）：六 tab 固定顺序 = 款式预设/标签预设/人群选项/尺码预设/
// 面料品牌/纸样品牌；面料幅宽/辅料幅宽不设 tab（数据层键与 settingsService 幅宽
// 函数保留不动，仅 UI 不展示）。
// W-B 口径变更：§12.7「款式/标签/人群只读」被用户反馈第二棒推翻，六 tab 全部
// 可编辑（新增/删除/行内编辑），交互与「尺码/面料品牌/纸样品牌」既有 CRUD 形态
// 完全一致；§12.7 文档不回改，见 wb-notes 口径变更记录。
// AA-D 物料6 口径变更：移除「标签预设」tab（表单不再采集标签），§12.7 文档
// 不回改，见 ad-notes 口径变更记录；accessoryTags 数据层键与种子保留（存量
// 兼容，不删数据）。

function validatePresetItem(item: string, label: string): string {
  const trimmed = item.trim();
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (trimmed.length > 20) throw new Error(`${label}不能超过 20 个字符`);
  return trimmed;
}

/** 各 tab 的差异化配置（占位符/空态文案/输入上限随 tab 不同，随 demo）。 */
const EDITABLE_TAB_META: Record<
  PresetTabKey,
  { itemLabel: string; placeholder: string; emptyText: string; maxLength: number }
> = {
  patternStyles: {
    itemLabel: '款式',
    placeholder: '输入款式，如 连衣裙 / 衬衫',
    emptyText: '还没有款式，添加一个吧',
    maxLength: 20,
  },
  patternAudiences: {
    itemLabel: '人群',
    placeholder: '输入人群，如 女童 / 宠物',
    emptyText: '还没有人群选项，添加一个吧',
    maxLength: 20,
  },
  patternSizes: {
    itemLabel: '尺码',
    placeholder: '输入尺码，如 S / M / 38 / 均码',
    emptyText: '还没有尺码，添加一个吧',
    maxLength: 10,
  },
  fabricCategories: {
    itemLabel: '分类',
    placeholder: '输入面料分类，如 棉布 / 麻布',
    emptyText: '还没有面料分类，添加一个吧',
    maxLength: 20,
  },
  accessoryCategories: {
    itemLabel: '分类',
    placeholder: '输入辅料分类，如 拉链 / 纽扣',
    emptyText: '还没有辅料分类，添加一个吧',
    maxLength: 20,
  },
  fabricBrands: {
    itemLabel: '品牌',
    placeholder: '输入品牌名，如 优衣库 / 无印良品',
    emptyText: '还没有面料品牌，添加一个吧',
    maxLength: 20,
  },
  patternBrands: {
    itemLabel: '品牌',
    placeholder: '输入品牌名，如 Burda / 果壳',
    emptyText: '还没有纸样品牌，添加一个吧',
    maxLength: 20,
  },
};

function PresetsSettings() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<PresetTabKey>('patternStyles');
  const [presets, setPresets] = useState<PresetsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  /** 删除确认弹层（PRD §12.8）：待删除项的下标与值。 */
  const [pendingDelete, setPendingDelete] = useState<{ idx: number; value: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 读取当前 presets。
  // §S7-D 修复保留：toArray + find 消除「空行/缺失行」与「未解析」的 undefined 二义性。
  const allSettings = useLiveQuery(() => db.settings.toArray());
  const presetsRaw = allSettings?.find((s) => s.key === 'presets');

  useEffect(() => {
    if (allSettings === undefined) return; // 仍加载中
    try {
      const parsed = JSON.parse(presetsRaw?.value || '{}') as Partial<PresetsConfig>;
      // AD-D 预设1/2：与 DEFAULT_PRESETS 缺键合并——旧存量 presets JSON（无
      // fabricCategories / accessoryCategories 键）补默认值，保证新增 tab 可
      // 增删改且整值写回后为完整十键格式；已存在的键（含用户清空的 []）不覆盖。
      setPresets({ ...DEFAULT_PRESETS, ...parsed });
    } catch {
      setPresets({ ...DEFAULT_PRESETS });
    }
    setLoading(false);
  }, [allSettings, presetsRaw]);

  const tab0 = PRESET_TABS.find((t) => t.key === activeTab) ?? PRESET_TABS[0];
  if (!tab0) return null;
  const tab = tab0;

  // 当前 tab 的数据（人群 tab 存储值为字符串数组，展示层映射中文标签）
  const items: string[] =
    presets && tab.key in presets
      ? ((presets as unknown as Record<string, unknown>)[tab.key] as string[]) || []
      : [];

  // ------ CRUD：单键整值一次写（PRD §12.9，经 updatePresets 全量写） ------
  const addPresetItem = async (val: string) => {
    if (!presets) return;
    const meta = EDITABLE_TAB_META[tab.key];
    const v = validatePresetItem(val, meta.itemLabel);
    const arr = [...items];
    if (arr.includes(v)) throw new Error(PRESET_DUPLICATE_TEXT);
    arr.push(v);
    await updatePresets({ ...presets, [tab.key]: arr } as PresetsConfig);
    toast('已添加', 'success');
  };

  const editPresetItem = async (idx: number, val: string) => {
    if (!presets) return;
    const meta = EDITABLE_TAB_META[tab.key];
    const v = validatePresetItem(val, meta.itemLabel);
    if (idx < 0 || idx >= items.length) throw new Error('索引越界');
    const old = items[idx] as string;
    if (v !== old && items.some((s, i) => i !== idx && s === v)) {
      throw new Error(PRESET_DUPLICATE_TEXT);
    }
    const next = [...items];
    next[idx] = v; // §12.8 规则 3：原位置替换，不重排
    await updatePresets({ ...presets, [tab.key]: next } as PresetsConfig);
    toast('已保存', 'success');
  };

  const removePresetItemAt = async (idx: number) => {
    if (!presets) return;
    const next = items.filter((_, i) => i !== idx); // §12.8 规则 2：不做引用计数
    await updatePresets({ ...presets, [tab.key]: next } as PresetsConfig);
    toast('已删除', 'default');
  };

  if (loading) {
    return (
      <div className="page">
        <div className="page-header">
          <div className="left-actions">
            <button className="icon-btn" onClick={() => navigate('/settings')}>
              <IconBack style={{ width: '20px', height: '20px' }} />
            </button>
          </div>
          <h1 className="title">预设管理</h1>
          <div className="right-actions"><div style={{ width: '36px' }} /></div>
        </div>
        <div className="page-content with-bottom-nav" style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--secondary-foreground)' }}>
          加载中…
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="left-actions">
          <button className="icon-btn" onClick={() => navigate('/settings')}>
            <IconBack style={{ width: '20px', height: '20px' }} />
          </button>
        </div>
        <h1 className="title">预设管理</h1>
        <div className="right-actions"><div style={{ width: '36px' }} /></div>
      </div>

      <div className="tabs-row sticky-tabs">
        {PRESET_TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-item ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="page-content with-bottom-nav" style={{ paddingTop: '44px' }}>
        {/* W-B：六 tab 全可编辑，统一走 CRUD 形态（与尺码/品牌分区一致）。 */}
        <PresetCrudTab
          tabKey={tab.key}
          items={items}
          onAdd={addPresetItem}
          onEdit={editPresetItem}
          onRequestDelete={(idx, value) => setPendingDelete({ idx, value })}
        />
      </div>

      {/* 删除确认弹层（PRD §12.8「确定删除「<值>」吗？」，只用冻结 CSS 已有类） */}
      {pendingDelete && (
        <div
          className="confirm-overlay"
          onClick={() => { if (!deleting) setPendingDelete(null); }}
        >
          <div
            className="confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-icon">⚠</div>
            <div className="confirm-title">
              {presetDeleteConfirmText(pendingDelete.value)}
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await removePresetItemAt(pendingDelete.idx);
                    setPendingDelete(null);
                  } catch (e) {
                    toast(e instanceof Error ? e.message : '删除失败', 'error');
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** CRUD Tab：demo 布局逐字复刻——preset-size-section / preset-list / preset-item
 * （点击行内编辑）/ size-add-row / size-hint。
 * W-B：六个 tab 统一走此形态；人群 tab 列表项名称沿用原只读展示的
 * AUDIENCE_LABELS 中文标签映射（未映射值显原值），编辑时输入框预填原始存储值。 */
function PresetCrudTab({
  tabKey,
  items,
  onAdd,
  onEdit,
  onRequestDelete,
}: {
  tabKey: PresetTabKey;
  items: string[];
  onAdd: (val: string) => Promise<void>;
  onEdit: (idx: number, val: string) => Promise<void>;
  onRequestDelete: (idx: number, value: string) => void;
}) {
  const meta = EDITABLE_TAB_META[tabKey];
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [addValue, setAddValue] = useState('');
  const [busy, setBusy] = useState(false);

  /** 列表项展示名：人群 tab 内置枚举键显中文标签，其余 tab 显原值。 */
  const displayName = (item: string): string =>
    tabKey === 'patternAudiences' ? (AUDIENCE_LABELS[item] ?? item) : item;

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditValue(items[idx] || '');
  };
  const cancelEdit = () => { setEditingIdx(null); setEditValue(''); };

  const saveEdit = async () => {
    if (busy || !editValue.trim()) return;
    setBusy(true);
    try {
      await onEdit(editingIdx as number, editValue);
      cancelEdit();
    } catch (e) {
      toast(e instanceof Error ? e.message : '编辑失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmAdd = async () => {
    if (busy || !addValue.trim()) return;
    setBusy(true);
    try {
      await onAdd(addValue);
      setAddValue('');
    } catch (e) {
      toast(e instanceof Error ? e.message : '添加失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preset-size-section">
      <div className="preset-list">
        {items.map((item, i) => (
          editingIdx === i ? (
            <div key={'edit_' + i} className="preset-item preset-size-edit">
              <input
                className="size-edit-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); }}
                maxLength={meta.maxLength}
                autoFocus
                style={{
                  flex: 1,
                  border: 'none',
                  outline: 'none',
                  fontSize: '14px',
                  color: 'var(--foreground)',
                  background: 'transparent',
                }}
              />
              <button
                className="size-edit-save"
                onClick={saveEdit}
                disabled={busy || !editValue.trim()}
                style={{
                  fontSize: '13px',
                  color: 'var(--accent)',
                  background: 'transparent',
                  border: 'none',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                保存
              </button>
              <button
                onClick={cancelEdit}
                disabled={busy}
                style={{
                  fontSize: '13px',
                  color: '#999',
                  background: 'transparent',
                  border: 'none',
                  padding: '4px 8px',
                  cursor: 'pointer',
                }}
              >
                取消
              </button>
            </div>
          ) : (
            <div key={i} className="preset-item" onClick={() => startEdit(i)}>
              <span className="preset-item-name">{displayName(item)}</span>
              <button
                className="preset-delete"
                onClick={(e) => { e.stopPropagation(); onRequestDelete(i, displayName(item)); }}
              >
                <IconTrash style={{ width: '14px', height: '14px', color: '#ccc' }} />
              </button>
            </div>
          )
        ))}
        {items.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--secondary-foreground)', fontSize: '13px' }}>
            {meta.emptyText}
          </div>
        )}
      </div>

      {/* 添加输入行 */}
      <div className="size-add-row">
        <input
          className="size-add-input"
          placeholder={meta.placeholder}
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
          maxLength={meta.maxLength}
          style={{
            flex: 1,
            height: '40px',
            padding: '0 12px',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            fontSize: '14px',
            outline: 'none',
            background: 'var(--card)',
            color: 'var(--foreground)',
          }}
          onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
        />
        <button
          className="btn btn-primary"
          onClick={confirmAdd}
          disabled={busy || !addValue.trim()}
          style={{
            marginLeft: '10px',
            flexShrink: 0,
            opacity: addValue.trim() ? 1 : 0.5,
          }}
        >
          添加
        </button>
      </div>

      <div className="size-hint">{PRESET_TAB_HINTS[tabKey]}</div>
    </div>
  );
}
