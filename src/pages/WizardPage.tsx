// src/pages/WizardPage.tsx — 初始化向导（S7-C · 7-4）
//
// 四步强制向导（PRD §13）：
//   第 1 步 欢迎 → 第 2 步 迁移导入 → 第 3 步 GitHub 备份 → 第 4 步 安装引导
//
// 五种行为（PRD §13.1–§13.9）：
//   1. 空库强制：onboarding_completed ≠ 'true' → 任意路由重定向到 /wizard（App.tsx 判定）
//   2. 未走完重定向：同上，每次路由变化判定
//   3. 跳过不写数据：第 1–3 步「跳过」只前进、不写任何设置
//   4. 「开始使用」写标记：仅第 4 步该按钮写入 onboarding_completed='true'
//   5. 重新运行不清已有数据：设置页「数据管理」进入时预填已存值，不重置业务数据
//
// 冻结 CSS 零改动零新增类；禁原生弹框（PRD §15.3）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/schema';
import { setSetting } from '@/services/settingsService';
import { testGithubConnection, TOKEN_FORBIDDEN_HINT } from '@/services/githubService';
import { ROUTES } from '@/lib/routes';
import type { SettingsKey } from '@/db/schemas';
import { importLegacyDatabase } from '@/db/migrations/import';
import {
  buildImportInput,
  buildLegacyPreview,
  countImagesInZips,
  extractImagesFromZips,
  parseLegacyFile,
  recognizeCollections,
  type LegacyPreview,
  type ParsedLegacyFile,
  type RecognizedCollections,
} from '@/db/migrations/legacyFiles';
import { buildImportReportView, type ImportReportView } from '@/db/migrations/importReportView';
import type { ImportProgress } from '@/db/migrations/legacy';

// beforeinstallprompt 事件类型（PWA 标准）
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// ── 步骤定义 ──
const STEPS = ['欢迎', '迁移导入', 'GitHub 备份', '安装引导'] as const;
const TOTAL_STEPS = STEPS.length;

// ── 导入进度文案（S8-C · §11.2/§11.3：phase → 界面进度文案）──
const PHASE_ORDER: ImportProgress['phase'][] = [
  'parse', 'map', 'validate', 'images', 'materials', 'garments', 'usageLogs', 'presets', 'finalize',
];
const PHASE_LABELS: Record<ImportProgress['phase'], string> = {
  parse: '正在读取旧数据…',
  map: '正在整理旧数据…',
  validate: '正在校验数据…',
  images: '正在写入图片…',
  materials: '正在写入物料…',
  garments: '正在写入成衣…',
  usageLogs: '正在写入库存流水…',
  presets: '正在合并预设…',
  finalize: '正在收尾…',
};

// ── 报告明细行样式（内联，冻结 CSS 不新增类）──
const reportRowStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--secondary-foreground)',
  lineHeight: 1.6,
  marginTop: 10,
  textAlign: 'left',
};

// ── GitHub 测试状态 ──
type TestState = 'idle' | 'testing' | 'success' | 'fail';

// ── 进度条（内联样式，冻结 CSS 不新增类） ──
const progressBarStyle: React.CSSProperties = {
  height: 4,
  background: 'var(--border)',
  borderRadius: 2,
  overflow: 'hidden',
  flex: 1,
};

export default function WizardPage() {
  const navigate = useNavigate();

  // ── 数据库读取 ──
  // §S7-D 修复：onboardingRow 改用 settings.toArray() 区分「加载中」与「行不存在」
  // 行不存在时 useLiveQuery 也会返回 undefined，与「未解析」无法区分 → return null 白屏
  const settings = useLiveQuery(() => db.settings.toArray());
  const onboardingRow = settings?.find((s) => s.key === 'onboarding_completed');
  const userNameRow = settings?.find((s) => s.key === 'user_name');
  const githubUsernameRow = settings?.find((s) => s.key === 'github_username');
  const githubRepoRow = settings?.find((s) => s.key === 'github_repo');
  // §11.2 重复导入二次确认的判定依据（只提示、绝不阻止）
  const importCompleted = settings?.find((s) => s.key === 'import_completed')?.value === 'true';

  const onboardingCompleted = onboardingRow?.value;
  // 重新运行时预填（§13.9），目前 UI 始终预填已存值（昵称 / GitHub），不分支判断
  void onboardingCompleted;

  // ── 步骤状态 ──
  const [step, setStep] = useState(0);

  // ── 第 1 步：昵称 ──
  const [nickname, setNickname] = useState('');
  const nicknameInited = useRef(false);
  // 重新运行时预填（§13.9）：当前值为预置默认昵称时显示空
  // AA-B 设置1：预置昵称改「泥头李」；「缝纫人」为旧预置值，存量用户仍按默认值处理（不预填）
  useEffect(() => {
    if (nicknameInited.current) return;
    if (userNameRow?.value === undefined) return;
    nicknameInited.current = true;
    const v = userNameRow.value;
    setNickname(v === '泥头李' || v === '缝纫人' ? '' : v);
  }, [userNameRow?.value]);

  // ── 第 2 步：迁移导入（S8-C · 8-5；PRD §11.2/§13.5）──
  const [dataFiles, setDataFiles] = useState<File[]>([]);
  const [imageZips, setImageZips] = useState<File[]>([]);
  const [recognized, setRecognized] = useState<RecognizedCollections | null>(null);
  const [jsonBytes, setJsonBytes] = useState(0);
  const [imageCount, setImageCount] = useState(0);
  const [previewError, setPreviewError] = useState('');
  const [zipError, setZipError] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [reportView, setReportView] = useState<ImportReportView | null>(null);
  const [importError, setImportError] = useState('');
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imagesInputRef = useRef<HTMLInputElement>(null);

  // 只读预览（§13.5）：从已解析文件与图片包计数派生；解析阶段不写库
  const preview = useMemo<LegacyPreview | null>(
    () => (recognized === null ? null : buildLegacyPreview(recognized, imageCount, jsonBytes)),
    [recognized, imageCount, jsonBytes],
  );

  // 进度百分比：total>0 用条目进度，否则按 9 个 phase 的档位推进
  const progressPercent = useMemo(() => {
    if (progress === null) return 0;
    if (progress.total > 0) return Math.round((progress.done / progress.total) * 100);
    const idx = PHASE_ORDER.indexOf(progress.phase);
    return Math.round(((idx + 1) / PHASE_ORDER.length) * 100);
  }, [progress]);
  const progressLabel = progress === null ? '' : PHASE_LABELS[progress.phase];

  // ── 第 3 步：GitHub ──
  const [ghUser, setGhUser] = useState('');
  const [ghRepo, setGhRepo] = useState('sewing-space-backup');
  const [ghToken, setGhToken] = useState('');
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');
  const ghInited = useRef(false);
  useEffect(() => {
    if (ghInited.current) return;
    if (githubUsernameRow?.value === undefined || githubRepoRow?.value === undefined) return;
    ghInited.current = true;
    // AE-A Q3：GitHub 用户名预置 AhDaiMolly（仅默认值，可改）——空串视为
    // 未配置、回落预置，与 SettingsPage 表单口径一致。
    setGhUser(githubUsernameRow.value || 'AhDaiMolly');
    setGhRepo(githubRepoRow.value || 'sewing-space-backup');
  }, [githubUsernameRow?.value, githubRepoRow?.value]);

  // ── 第 4 步：安装 ──
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  // 捕获 beforeinstallprompt 事件（PRD §13.7）
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    // 检测已安装态：独立窗口模式（display-mode: standalone）或 iOS 专有的独立模式标志
    // （PRD §13.7：两者任一命中即视为已安装）
    const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (window.matchMedia('(display-mode: standalone)').matches || iosStandalone) {
      setIsInstalled(true);
    }
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // ── 步骤导航 ──

  /** 跳过：不写入任何数据，直接前进（PRD §13.2） */
  const handleSkip = useCallback(() => {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    }
  }, [step]);

  /** 上一步 */
  const handlePrev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  /** 下一步：若该步有写入，先写入再前进 */
  const handleNext = useCallback(async () => {
    if (step === 0) {
      // 第 1 步：昵称非空且去空白后非空 → 写入
      const trimmed = nickname.trim();
      if (trimmed !== '') {
        try {
          await setSetting('user_name' as SettingsKey, trimmed);
        } catch {
          // 写入失败不阻塞前进
        }
      }
      setStep(1);
    } else if (step === 1) {
      // 第 2 步：导入由步内「确认导入」执行（§13.5）；导入进行中禁止前进
      if (importing) return;
      setStep(2);
    } else if (step === 2) {
      // 第 3 步：写入 GitHub 三个字段
      const u = ghUser.trim();
      const r = ghRepo.trim();
      const t = ghToken.trim();
      // 三个全空 = 等同跳过效果，不写
      if (u || r || t) {
        try {
          await setSetting('github_username' as SettingsKey, u);
          await setSetting('github_repo' as SettingsKey, r || 'sewing-space-backup');
          await setSetting('github_token' as SettingsKey, t);
        } catch {
          // 写入失败不阻塞前进
        }
      }
      setStep(3);
    }
  }, [step, nickname, ghUser, ghRepo, ghToken, importing]);

  /** 开始使用：写完成标记 → 跳首页（PRD §13.8） */
  const handleStart = useCallback(async () => {
    try {
      await setSetting('onboarding_completed' as SettingsKey, 'true');
    } catch {
      // 写入失败仍跳转（下次启动会再次判定）
    }
    navigate(ROUTES.home, { replace: true });
  }, [navigate]);

  // ── 第 2 步：选择文件 → 只读预览（§13.5：解析不写库）──
  const handleJsonSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setReportView(null);
    setImportError('');
    setPreviewError('');
    if (files.length === 0) {
      setDataFiles([]);
      setRecognized(null);
      setJsonBytes(0);
      return;
    }
    try {
      const parsedFiles: ParsedLegacyFile[] = [];
      for (const f of files) {
        parsedFiles.push(await parseLegacyFile(f));
      }
      // 内容特征识别集合归属（文件名是随机后缀，无语义；§11.1/§11.2）
      const rec = recognizeCollections(parsedFiles);
      setDataFiles(files);
      setRecognized(rec);
      setJsonBytes(parsedFiles.reduce((sum, f) => sum + f.sizeBytes, 0));
    } catch (err) {
      // §11.2 解析层面失败：不写任何数据、不写 import_completed、不写日志，让用户重选
      setDataFiles([]);
      setRecognized(null);
      setJsonBytes(0);
      setPreviewError(
        err instanceof Error ? err.message : '文件解析失败，请确认选择的是旧库导出的 JSON 数据文件',
      );
    }
  }, []);

  const handleZipsSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setZipError('');
    if (files.length === 0) {
      setImageZips([]);
      setImageCount(0);
      return;
    }
    try {
      const count = await countImagesInZips(files);
      setImageZips(files);
      setImageCount(count);
    } catch {
      setImageZips([]);
      setImageCount(0);
      setZipError('图片压缩包无法读取，请确认选择的是有效的 .zip 文件');
    }
  }, []);

  /** 重新选择：清空本步全部选择与结果（已入库的数据不动） */
  const resetMigration = useCallback(() => {
    setDataFiles([]);
    setImageZips([]);
    setRecognized(null);
    setJsonBytes(0);
    setImageCount(0);
    setPreviewError('');
    setZipError('');
    setImportError('');
    setReportView(null);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (imagesInputRef.current) imagesInputRef.current.value = '';
  }, []);

  /** 执行导入（§11.3 十步；onProgress 回调驱动界面进度） */
  const runImport = useCallback(async () => {
    if (recognized === null || importing) return;
    setImporting(true);
    setImportError('');
    setProgress(null);
    try {
      const images = await extractImagesFromZips(imageZips);
      const input = buildImportInput(recognized, images);
      const report = await importLegacyDatabase(input, (p) => setProgress(p));
      // 全部计数与清单只取 report（§11.8：UI 不另算数字）
      setReportView(buildImportReportView(report));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入失败，请重试');
    } finally {
      setImporting(false);
    }
  }, [recognized, imageZips, importing]);

  /** 确认导入：import_completed='true' 时先弹二次确认（§11.2，只提示不阻止） */
  const handleConfirmImport = useCallback(() => {
    if (importCompleted) {
      setShowImportConfirm(true);
      return;
    }
    void runImport();
  }, [importCompleted, runImport]);

  // ── 第 3 步：测试 GitHub 连接 ──
  const handleTestConnection = useCallback(async () => {
    const u = ghUser.trim();
    const r = ghRepo.trim();
    const t = ghToken.trim();
    if (!u || !r || !t) {
      setTestState('fail');
      setTestError('请先填写 GitHub 用户名、仓库名和访问令牌');
      return;
    }
    setTestState('testing');
    setTestError('');
    try {
      const result = await testGithubConnection({ token: t, owner: u, repo: r });
      if (result.state === 'success') {
        setTestState('success');
      } else if (result.state === 'auth_rejected') {
        setTestState('fail');
        setTestError(
          result.reason === 'forbidden' ? TOKEN_FORBIDDEN_HINT : '令牌无效或已过期，请重新生成',
        );
      } else if (result.state === 'repo_missing') {
        setTestState('fail');
        setTestError('找不到该仓库，请确认仓库名与用户名正确');
      } else {
        setTestState('fail');
        setTestError('网络不可用，请检查网络连接');
      }
    } catch {
      setTestState('fail');
      setTestError('网络不可用，请检查网络连接');
    }
  }, [ghUser, ghRepo, ghToken]);

  // ── 第 4 步：触发安装 ──
  const handleInstall = useCallback(async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setIsInstalled(true);
      }
    } catch {
      // 用户取消或浏览器不支持
    }
    setInstallPrompt(null);
  }, [installPrompt]);

  // ── 加载中 ──
  // §S7-D 修复：判 settings（toArray 返回值）区分「加载中」与「空库」；
  // 用 onboardingCompleted 会在空库（行不存在）时误判为加载中 → return null 白屏
  if (settings === undefined) return null;

  // ── 渲染 ──
  return (
    <div className="page">
      {/* ── 顶部进度条 + 步骤指示（PRD §13.2）── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 20px',
          flexShrink: 0,
        }}
      >
        <div style={progressBarStyle}>
          <div
            style={{
              height: '100%',
              width: `${((step + 1) / TOTAL_STEPS) * 100}%`,
              background: 'var(--accent)',
              borderRadius: 2,
              transition: 'width 0.3s ease',
            }}
          />
        </div>
        <span style={{ fontSize: 13, color: 'var(--secondary-foreground)', whiteSpace: 'nowrap' }}>
          {step + 1} / {TOTAL_STEPS}
        </span>
      </div>

      {/* ── 步骤内容区（溢出滚动）── */}
      <div className="page-content" style={{ paddingBottom: 100 }}>
        {step === 0 && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            {/* 成衣插画图标 */}
            <div style={{ fontSize: 56, marginBottom: 20, color: 'var(--accent)' }} aria-hidden="true">
              🧵
            </div>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8, color: 'var(--foreground)' }}>
              欢迎来到缝纫空间
            </h2>
            <p style={{ fontSize: 14, color: 'var(--secondary-foreground)', lineHeight: 1.6, marginBottom: 4 }}>
              专为缝纫爱好者打造的个人物料与作品管理工具
            </p>
            <p style={{ fontSize: 14, color: 'var(--secondary-foreground)', lineHeight: 1.6, marginBottom: 24 }}>
              记录每一块布料、每一件作品、每一次创作
            </p>

            {/* 三个特性条目 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {[
                '物料管理 · 布料、辅料、工具一目了然',
                '作品记录 · 每一件成衣都有完整档案',
                '任务看板 · 缝纫计划井井有条',
              ].map((text) => (
                <div
                  key={text}
                  className="card"
                  style={{
                    padding: '12px 16px',
                    fontSize: 14,
                    color: 'var(--card-foreground)',
                    textAlign: 'left',
                    borderRadius: 12,
                  }}
                >
                  {text}
                </div>
              ))}
            </div>

            {/* 昵称输入 */}
            <div style={{ textAlign: 'left' }}>
              <label className="input-label">你的昵称（可选）</label>
              <input
                className="input-field"
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value.slice(0, 20))}
                placeholder="泥头李"
                maxLength={20}
              />
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 20, color: 'var(--accent)' }} aria-hidden="true">
              ☁️
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, color: 'var(--foreground)' }}>
              从旧小程序迁移？
            </h2>
            <p style={{ fontSize: 14, color: 'var(--secondary-foreground)', lineHeight: 1.6, marginBottom: 24 }}>
              选择旧库导出的数据文件与图片文件夹，把已有的记录搬过来
            </p>

            {/* 选择区（§13.5 两个选择口；图片实际以 zip 压缩包交付，任务书口径） */}
            <div style={{ marginBottom: 4 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                multiple
                style={{ display: 'none' }}
                onChange={handleJsonSelected}
              />
              <button
                type="button"
                className="wizard-upload-card"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                <span className="upload-text">
                  {dataFiles.length > 0 ? `已选 ${dataFiles.length} 个数据文件` : '选择旧库数据文件'}
                </span>
                <span className="upload-hint">
                  {dataFiles.length > 0 ? dataFiles.map((f) => f.name).join('、') : '旧库导出的 .json 文件，可多选'}
                </span>
              </button>
            </div>

            <div style={{ marginBottom: 16 }}>
              <input
                ref={imagesInputRef}
                type="file"
                accept=".zip"
                multiple
                style={{ display: 'none' }}
                onChange={handleZipsSelected}
              />
              <button
                type="button"
                className="wizard-upload-card"
                onClick={() => imagesInputRef.current?.click()}
                disabled={importing}
              >
                <span className="upload-text">
                  {imageZips.length > 0
                    ? `已选 ${imageZips.length} 个图片压缩包（${imageCount} 张）`
                    : '选择图片压缩包'}
                </span>
                <span className="upload-hint">图片 .zip 压缩包，可多选；旧库没有图片可不选</span>
              </button>
            </div>

            {/* 解析/读取失败提示（§11.2：此时不写任何数据） */}
            {(previewError !== '' || zipError !== '') && (
              <div className="backup-warning" style={{ marginBottom: 16 }}>
                <span className="text">{previewError !== '' ? previewError : zipError}</span>
              </div>
            )}

            {/* 无法识别的文件（不报错、不阻断；§11.1 边界 3） */}
            {recognized !== null && recognized.unrecognizedFiles.length > 0 && (
              <div className="backup-warning" style={{ marginBottom: 16, textAlign: 'left' }}>
                <span className="text">
                  有 {recognized.unrecognizedFiles.length} 个文件无法识别内容，已忽略：
                  {recognized.unrecognizedFiles.join('、')}
                </span>
              </div>
            )}

            {/* 只读预览（§13.5：读真实文件，不写库；归档任务 0 不渲染该行） */}
            {preview !== null && previewError === '' && (
              <div className="wizard-preview-card">
                <div className="preview-title">预览</div>
                <div className="preview-grid">
                  <div className="preview-item">
                    <div className="preview-value">{preview.materials}</div>
                    <div className="preview-label">物料（面料/辅料/工具/纸样）</div>
                  </div>
                  <div className="preview-item">
                    <div className="preview-value">{preview.garments}</div>
                    <div className="preview-label">成衣（件）</div>
                  </div>
                  <div className="preview-item">
                    <div className="preview-value">{preview.usageRecords}</div>
                    <div className="preview-label">库存流水（条）</div>
                  </div>
                  {preview.archivedTasks > 0 && (
                    <div className="preview-item">
                      <div className="preview-value">{preview.archivedTasks}</div>
                      <div className="preview-label">归档任务（将被忽略）</div>
                    </div>
                  )}
                  <div className="preview-item">
                    <div className="preview-value">{preview.images}</div>
                    <div className="preview-label">图片（张）</div>
                  </div>
                  <div className="preview-item">
                    <div className="preview-value" style={{ fontSize: 14 }}>{preview.fileSize}</div>
                    <div className="preview-label">数据文件大小</div>
                  </div>
                </div>
              </div>
            )}

            {/* 执行区（§13.5：确认导入 / 重新选择；导入期间置灰防重复点击） */}
            {preview !== null && previewError === '' && reportView === null && (
              <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={handleConfirmImport}
                  disabled={importing}
                >
                  {importing ? '导入中…' : '确认导入'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ flex: 1 }}
                  onClick={resetMigration}
                  disabled={importing}
                >
                  重新选择
                </button>
              </div>
            )}

            {/* 进度（§11.2：进度文案按十步推进） */}
            {importing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div className="progress-bar-mini">
                  <div
                    className="progress-fill-mini"
                    style={{ width: `${progressPercent}%`, transition: 'width 0.2s ease' }}
                  />
                </div>
                <span className="progress-text-mini">{progressLabel}</span>
              </div>
            )}

            {/* 导入失败（§11.2：按钮回到可重试；不写任何数据） */}
            {importError !== '' && (
              <div className="backup-warning" style={{ marginBottom: 16 }}>
                <span className="text">{importError}</span>
              </div>
            )}

            {/* 完成区（§13.5/§11.8：完整报告，不允许只弹一句提示条） */}
            {reportView !== null && (
              <>
                <div className="wizard-done-card">
                  <div className="done-check">✓</div>
                  <div className="done-text">{reportView.summaryLine}</div>
                  <div className="done-sub">{reportView.presetsLine}</div>
                </div>

                <div className="wizard-preview-card">
                  <div className="preview-title">导入报告</div>
                  <div className="preview-grid">
                    {reportView.counts.map((c) => (
                      <div className="preview-item" key={c.label}>
                        <div className="preview-value">{c.value}</div>
                        <div className="preview-label">{`${c.label}（条）`}</div>
                      </div>
                    ))}
                  </div>

                  <div className="preview-title" style={{ marginTop: 14 }}>图片</div>
                  <div className="preview-grid">
                    {reportView.imageCounts.map((c) => (
                      <div className="preview-item" key={c.label}>
                        <div className="preview-value">{c.value}</div>
                        <div className="preview-label">{`${c.label}（张）`}</div>
                      </div>
                    ))}
                  </div>

                  {/* 跳过清单两组（§11.8：幂等保护 / 校验未通过） */}
                  {reportView.skippedExisting.count > 0 && (
                    <div style={reportRowStyle}>
                      已跳过 {reportView.skippedExisting.count} 条：{reportView.skippedExisting.note}
                    </div>
                  )}
                  {reportView.skippedInvalid.length > 0 && (
                    <div style={{ ...reportRowStyle, display: 'block' }}>
                      <div style={{ marginBottom: 6 }}>这些记录格式不对，没能导入：</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {reportView.skippedInvalid.map((s, i) => (
                          <div key={`${s.label}-${i}`} style={{ fontSize: 12 }}>
                            {s.label} — {s.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {reportView.danglingCount > 0 && (
                    <div style={reportRowStyle}>
                      有 {reportView.danglingCount} 处引用指向未能导入的数据
                    </div>
                  )}
                  {reportView.droppedFieldCount > 0 && (
                    <div style={reportRowStyle}>已忽略旧库的 {reportView.droppedFieldCount} 类字段</div>
                  )}
                  {reportView.droppedAmountsCount > 0 && (
                    <div style={reportRowStyle}>
                      因口径变更丢弃 {reportView.droppedAmountsCount} 条旧的用量明细
                    </div>
                  )}
                  {reportView.alignmentLogsCount > 0 && (
                    <div style={reportRowStyle}>
                      其中 {reportView.alignmentLogsCount} 条流水为迁移时库存对齐（购买量 − 当前库存）
                    </div>
                  )}

                  {/* 提醒逐条（§11.8）；归档任务是 UI 层附加提醒，非 report 数字 */}
                  {(reportView.warnings.length > 0 || (recognized?.taskArchiveCount ?? 0) > 0) && (
                    <div style={{ ...reportRowStyle, display: 'block' }}>
                      <div style={{ marginBottom: 6 }}>提醒：</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {reportView.warnings.map((w, i) => (
                          <div key={`w-${i}`} style={{ fontSize: 12 }}>{w}</div>
                        ))}
                        {(recognized?.taskArchiveCount ?? 0) > 0 && (
                          <div style={{ fontSize: 12 }}>
                            旧库有 {recognized?.taskArchiveCount} 条归档任务，未迁移
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 底部提示 */}
            <p className="wizard-skip-hint">
              还没准备好？可以先跳过，之后在设置页的「数据管理」里随时导入
            </p>
          </div>
        )}

        {step === 2 && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 20, color: 'var(--accent)' }} aria-hidden="true">
              ☁️
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, color: 'var(--foreground)' }}>
              配置 GitHub 备份
            </h2>
            <p style={{ fontSize: 14, color: 'var(--secondary-foreground)', lineHeight: 1.6, marginBottom: 24 }}>
              把数据安全备份到自己的 GitHub 私有仓库，换设备时随时恢复
            </p>

            {/* 表单 */}
            <div style={{ textAlign: 'left', marginBottom: 20 }}>
              <div className="input-row">
                <label className="input-label">GitHub 用户名</label>
                <input
                  className="input-field"
                  type="text"
                  value={ghUser}
                  onChange={(e) => { setGhUser(e.target.value); setTestState('idle'); setTestError(''); }}
                  placeholder="your-username"
                />
              </div>
              <div className="input-row">
                <label className="input-label">仓库名</label>
                <input
                  className="input-field"
                  type="text"
                  value={ghRepo}
                  onChange={(e) => { setGhRepo(e.target.value); setTestState('idle'); setTestError(''); }}
                  placeholder="sewing-space-backup"
                />
              </div>
              <div className="input-row">
                <label className="input-label">Personal Access Token</label>
                <input
                  className="input-field"
                  type="password"
                  value={ghToken}
                  onChange={(e) => { setGhToken(e.target.value); setTestState('idle'); setTestError(''); }}
                  placeholder="ghp_xxxxxxxxxxxx"
                />
              </div>
            </div>

            {/* 测试连接按钮 */}
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={handleTestConnection}
              disabled={testState === 'testing'}
              style={{ marginBottom: 12 }}
            >
              {testState === 'testing' ? '测试中…' : '测试连接'}
            </button>

            {/* 测试结果 */}
            {testState === 'success' && (
              <div style={{ fontSize: 13, color: 'var(--success)', marginBottom: 16 }}>
                连接正常，仓库可访问
              </div>
            )}
            {testState === 'fail' && testError && (
              <div className="backup-warning" style={{ marginBottom: 16 }}>
                <span className="text">{testError}</span>
              </div>
            )}

            {/* 指引块 */}
            <div className="card" style={{ marginBottom: 16, textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>💡 怎么获取 Token？</div>
              <div style={{ fontSize: 12, color: 'var(--secondary-foreground)', lineHeight: 1.8 }}>
                <div>GitHub → Settings → Developer settings</div>
                <div>→ Personal access tokens → Fine-grained tokens</div>
                <div>→ Generate new token</div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 20, color: 'var(--accent)' }} aria-hidden="true">
              ➕
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, color: 'var(--foreground)' }}>
              添加到主屏幕
            </h2>
            <p style={{ fontSize: 14, color: 'var(--secondary-foreground)', lineHeight: 1.6, marginBottom: 24 }}>
              像原生应用一样使用，还能获得更大的存储空间
            </p>

            {isInstalled ? (
              /* 已安装态 */
              <div
                className="card"
                style={{
                  marginBottom: 20,
                  background: 'rgba(102,204,153,0.08)',
                  textAlign: 'center',
                  padding: '20px 16px',
                }}
              >
                <div style={{ fontSize: 18, marginBottom: 8 }}>✅</div>
                <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--success)', marginBottom: 4 }}>
                  已安装
                </div>
                <div style={{ fontSize: 13, color: 'var(--secondary-foreground)' }}>
                  你已经把缝纫空间添加到主屏幕了
                </div>
              </div>
            ) : (
              <>
                {/* 未安装：安装按钮（仅可安装时显示） */}
                {installPrompt && (
                  <button
                    type="button"
                    className="btn btn-accent btn-block"
                    onClick={handleInstall}
                    style={{ marginBottom: 16 }}
                  >
                    立即安装
                  </button>
                )}

                {/* 图文引导 */}
                <div style={{ textAlign: 'left', marginBottom: 20 }}>
                  <div className="card" style={{ marginBottom: 8, padding: '14px 16px' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--foreground)' }}>
                      iOS / Safari
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--secondary-foreground)', lineHeight: 1.8 }}>
                      ① 点击底部分享按钮<br />
                      ② 选择「添加到主屏幕」<br />
                      ③ 点击「添加」即可
                    </div>
                  </div>
                  <div className="card" style={{ padding: '14px 16px' }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--foreground)' }}>
                      Android / 桌面
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--secondary-foreground)', lineHeight: 1.8 }}>
                      ① 点击浏览器菜单<br />
                      ② 选择「安装应用」
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* 存储提示 */}
            <p style={{ fontSize: 12, color: 'var(--secondary-foreground)', lineHeight: 1.5, marginBottom: 8 }}>
              为什么要安装？未安装约 50 MB 存储，安装后约 1 GB，数据更安全。
            </p>
          </div>
        )}
      </div>

      {/* ── 底部按钮区（PRD §13.2 按钮矩阵）── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          paddingBottom: 'calc(12px + var(--safe-area-bottom))',
          flexShrink: 0,
          borderTop: '1px solid var(--border)',
          background: 'var(--background)',
          gap: 8,
        }}
      >
        {/* 左侧按钮 */}
        <div style={{ width: 72 }}>
          {step === 0 ? null : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handlePrev}
              disabled={step === 1 && importing}
            >
              上一步
            </button>
          )}
        </div>

        {/* 中间主按钮 */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {step < 3 ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleNext}
              style={{ minWidth: 120 }}
              disabled={step === 1 && importing}
            >
              {step === 1 && reportView !== null ? '完成' : '下一步'}
            </button>
          ) : (
            <button type="button" className="btn btn-accent" onClick={handleStart} style={{ minWidth: 120 }}>
              开始使用
            </button>
          )}
        </div>

        {/* 右侧按钮 */}
        <div style={{ width: 72, display: 'flex', justifyContent: 'flex-end' }}>
          {step < 3 ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSkip}
              disabled={step === 1 && importing}
            >
              跳过
            </button>
          ) : null}
        </div>
      </div>

      {/* §11.2 重复导入二次确认（import_completed 只提示、绝不阻止；§15.5 禁原生弹框） */}
      {showImportConfirm && (
        <div className="confirm-overlay" onClick={() => setShowImportConfirm(false)}>
          <div className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon">⚠</div>
            <div className="confirm-title">
              你之前已经导入过一次旧数据。再次导入不会覆盖已有内容，但库存流水会翻倍，统计数字会因此变大。确定继续吗？
            </div>
            <div className="confirm-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowImportConfirm(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowImportConfirm(false);
                  void runImport();
                }}
              >
                继续导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}