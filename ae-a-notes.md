# AE-A 真机三项修复笔记（sewing-space-ae-a）

- **棒次**：AE-A（AE 系第 1 棒）
- **输入基线**：sewing-space-ad-d.zip（AC/AD 系成果全量，测试基线 1756 条）
- **输出**：sewing-space-ae-a.zip + 本笔记
- **测试基线**：1756 → **1801**（新增 45 条 AEA 断言，`npm run test:services` 全绿）
- **静态检查**：`tsc -b` 0 错误；`eslint --max-warnings 0` 0 问题；`npm run build` 成功
- **真机验证状态**：**本棒全部修复未经 iOS 真机验证**（详见文末「未验证项」），需用户真机复测

---

## Q1【修复】iOS 普通页签只显示「首页」二字 + 首次打开慢

### 复现（用户现场描述 + 线上资源核查）

- 用户 iPhone iOS 26.x Safari：无痕新页签访问正常；普通页签只显示「首页」两个字，首次打开加载慢。
- 线上 GitHub Pages 资源此前已核查全部 200（排除服务端缺文件）。

### 根因证据链（不夸大，推断部分已标注）

1. 「首页」二字来自 BottomNav 的 tab 标签——说明 React 已挂载、JS 已执行；缺的是样式与页面内容渲染 → 指向 CSS 加载失败或旧 precache 指向已失效的资源。
2. iOS Safari 无痕模式下 Service Worker 注册不持久（WebKit 公开行为），无痕页签实际直连网络拿到最新资源 → 无痕正常。
3. 普通页签存在旧 SW：`registerType: 'prompt'` 下新 SW 进入 waiting，需要用户点击「刷新」提示才接管；长驻页签里该提示链路收敛不到用户操作 → 旧 SW + 旧 precache 长期滞留。
4. 首载慢：precache 清单 19 项 1836.79 KiB，其中 4 张猫系列分类 SVG（cat-fabric/accessory/tool/pattern，共 653KB）被 precache 全量缓存，但首页首屏并不需要全部四张。

（1–2 为代码路径 + WebKit 公开行为的推断链，未在真机上直接抓取 SW 状态日志；3–4 为构建产物实测。）

### 修复

| 文件 | 改动 |
| --- | --- |
| `vite.config.ts` | ① `registerType: 'prompt'` → `'autoUpdate'`（新 SW 装好即接管，存量旧 SW 用户下次检查更新后自愈）；② workbox 显式 `skipWaiting: true, clientsClaim: true`——已核实 vite-plugin-pwa 0.20.5 源码：`injectRegister: false` 时插件**不会**自动注入这两个调用，必须显式配置；③ `cleanupOutdatedCaches: true` 保留（新 SW 激活时清旧 precache，存量用户旧缓存自动清理）；④ 首载优化：`globIgnores: ['icons/cat-*.svg']` 把 4 张猫系列 SVG 移出 precache，改 runtimeCaching `CacheFirst`（cacheName `cat-icons`，maxEntries 8、30 天）——用到才缓存 |
| `src/pwa/registerSW.ts` | ① `onRegisteredSW` 里每 60 分钟 `registration.update()`（iOS Safari 只在导航时检查 sw.js，长驻页签/standalone 模式靠定时检查收到新版本；离线时跳过）；② 新增 `onRegisterError` 兜底打点（注册失败时无 SW、直连网络仍可用）；③ `onNeedRefresh → uiStore` 与 `onOfflineReady` 保留（autoUpdate 下常规不触发，仅异常路径兜底），`updateSW()` 导出保留，UpdatePrompt 组件零改动 |

### 验证（沙箱构建产物实测）

- `npm run build` 后 dist/sw.js 逐项验证：`skipWaiting` 注入 ✓、`clientsClaim` 注入 ✓、`cat-icons` 运行时缓存规则 ✓、precacheAndRoute 清单中无 cat-*.svg ✓。
- precache 从 19 项 1836.79 KiB 降至 **15 项 1198.87 KiB（-34.7%）**；移出的 653KB SVG 改为按需缓存。
- 首载收益口径：仅指 precache 下载量减少约 0.65MB；实际体感还受网络与 WebKit 缓存策略影响，不承诺具体秒数。
- 源码级断言：test-services.ts AEA Q1 段 8 条（autoUpdate/skipWaiting/clientsClaim/cleanupOutdatedCaches/globIgnores+CacheFirst/onRegisteredSW+update/onRegisterError/onNeedRefresh 兜底与 updateSW 保留）。

---

## Q2【修复】GitHub 恢复报「部分完成」：470 行数据成功、255 张图片全部保存失败

### 复现（沙箱全链路复跑，用户真实备份包）——必做实证，已做

用 `sewing-space-backup-20260930-0842.zip`（用户现场失败的那个包）在沙箱全链路复跑（fake-indexeddb 环境，诊断脚本 `scripts/rerun-user-backup.ts`，**不随包**）：

- 包体 37,647,981 字节；zip 内图片 255 张全 jpeg，总 37,576,018 字节（35.84MB）；min 4,842 / 中位 125,144 / max 739,115 字节；>512KB 仅 2 张、>1MB 0 张。
- data.json：materials 225 / garments 35 / tasks 0 / taskTemplates 2 / usageLogs 208 / backupLogs 8；settings 含 `github_username: 'AhDaiMolly'`。
- 复跑结果 **18/18 项全过**：255 行图片清单与 zip 条目一一对应（dropped=0）；importBackupFile status=success、failedImages=0；materials 225 / garments 35 / usageLogs 208 / images 255 全部落库；逐图字节比对零差异（读出总字节 37,576,018 与包一致）；原生 indexedDB 直读抽检 20 行均为 Uint8Array 形态；幂等二次导入一致。

**结论：备份包与恢复代码逻辑在沙箱环境完全正常 → 根因在 iOS 环境侧。**

### 根因证据链（iOS 侧）

1. 现场形态：470 行无 Blob 数据全部成功、唯 images 255/255 全灭——只影响图片写路径。
2. AC-A 的 dbcore 中间件在 Dexie 事务作用域内 `await row.blob.arrayBuffer()`（Blob→Uint8Array 转换）。IndexedDB 规范：事务在没有 pending 请求的间隙自动提交；Dexie 官方文档明确警告事务内不得调用其他异步 API，否则 `TransactionInactiveError`。
3. iOS WebKit 严格执行该行为：事务失活后 bulkPut 整批失败，AC-A 的逐条降级 put 同样经过该中间件、同样失败 → 255/255 全灭，与现场形态完全吻合。
4. 沙箱 fake-indexeddb 的事务实现宽松、不触发失活 → 解释沙箱复现不出现场失败。

（2–3 为 Dexie 文档 + WebKit 公开行为 + 代码路径 + 失败形态四方互证的收敛结论；无法在沙箱直接复现 iOS 行为，已如实标注。）

### 修复（按根因选方案：预转换根治，未采用压缩）

用户包图片总量 35.84MB、最大单图 739KB，均属正常量级——**证据不支持「单图过大需压缩」**，压缩会静默损失数据质量，不采用。

| 文件 | 改动 |
| --- | --- |
| `src/db/imageStorage.ts` | `imageRowToStored` 从私有改 `export`（注释写明事务失活根因与 Dexie 文档口径）；顶部「事务安全」注释修正口径：fake-indexeddb 宽松实证不能外推 iOS WebKit，AE-A 起所有写路径改为调用方事务外预转换。读路径 `imageRowFromStored`、中间件结构、`isImageMutateWithBlob` 未动（旧 Blob 行透传等 AC-A 成果保留） |
| `src/services/backupService.ts` | ① **根治**：`putImageRowsResilient` 改为事务外 `await Promise.all(rows.map((row) => imageRowToStored(row)))` 预转换后再分片 bulkPut（写路径零 await）；整批失败仍逐条降级、失败记录 `{ id, error }`；② **前置拦截**：`applyRestore` 第 0 步配额预检 `precheckImageStorageQuota`（`navigator.storage.estimate`，可用量 = quota − usage + 现有 images 字节——恢复会整表替换 images；环境不支持或字段缺失时放行不阻塞）；③ **分级文案**：`RestorePreflightError`（kind: quota / single-image，中文含 iOS 清理路径指引）、`classifyRestoreFailure` 四分类（blob-prepare / quota / transaction-inactive / other）、`summarizeImagePutFailures` 聚合；`RestoreReport` 新增 `failedImagesReason`；`describeRestoreFailure` 新增 RestorePreflightError 与 TransactionInactiveError（「完全关闭该标签页并重开 Safari 后重试；反复失败请改用电脑导入」）分支，WebKit/Quota/other 原有分支保留；restore 日志与设置页 toast 均带出失败原因 |

恢复文案分级口径：
- **配额不足**：「存储空间不足：本次恢复需写入约 X MB 图片，当前可用约 Y MB。请清理浏览器网站数据（iOS：设置 > 应用 > Safari > 高级 > 网站数据）…」
- **单图过大**：「单张图片大小（约 X MB）超过当前可用存储空间…」
- **事务失活（iOS 已知行为）**：「浏览器在写入图片时中断了本地数据库事务（iOS Safari 的已知行为），请完全关闭该标签页并重开 Safari 后重试；反复失败请改用电脑导入」
- **其他写入错误**：保留原始错误信息（不吞不造）。

### 验证

- test-services.ts AEA Q2 段 37 条断言：255 张合成图全链路恢复（status success、255/255 落库、0 失败、字节首/中/尾抽查、幂等）；`putImageRowsResilient` 入参 Blob → 原生 indexedDB 直读落库为 Uint8Array（写路径零 await 的直接证据）；配额预检 6 分支（单图超/quota 超/现有字节计入放行/缺字段放行/null 放行/默认环境放行）；失败四分类与聚合文案（含「重开 Safari」指引）；源码级接入断言。
- 用户真实包复跑 18/18（见上，诊断脚本不随包，结果记录于本笔记）。

---

## Q3【需求】GitHub 配置「GitHub 用户名」预置 AhDaiMolly

仅默认值预置，**校验逻辑不动**（仍走 trim、允许空串，用户可清空改回）。四处口径一致：

| 位置 | 改动 |
| --- | --- |
| `src/db/seed.ts` | `ensure('github_username', 'AhDaiMolly')`（新装用户首启预置） |
| `src/services/settingsService.ts` | `SETTINGS_DEFAULTS.github_username = 'AhDaiMolly'`（读侧默认；只改值不改键，S7A 的 18 键计数断言不受影响） |
| `src/pages/SettingsPage.tsx` | 表单初始化 `githubUsername?.value \|\| 'AhDaiMolly'`——用 `\|\|` 使存量空串用户（seed 曾写入 `''`）也能看到预置值；用户改过的非空值原样显示 |
| `src/pages/WizardPage.tsx` | 向导第 3 步预填 `githubUsernameRow.value \|\| 'AhDaiMolly'`（口径与设置页一致） |

验证：AEA Q3 段 5 条断言（默认值表/seed/两处 `\|\|` 回落/校验逻辑未动的正则断言）。

---

## 同类问题修复清单（本棒顺手修，均在范围内）

- `src/services/imageService.ts` `addImage`：构造 newRow 后 `db.images.add(await imageRowToStored(newRow))`——上传图片走同一中间件写路径，同样存在事务内 await 风险。
- `src/db/migrations/import.ts`：`bulkPut` 前对 imageRows 预转换——旧版本数据迁移导入同路径。

## 同类问题候选（本棒不动，留给后续棒）

- `adoptOrphans`（孤儿图片认领）：调用点在 `db.transaction` 事务内，若读出还原的 Blob 行 put 回去会经中间件触发同一事务失活风险；且 Dexie `Table.update`/`Collection.modify` 底层是整值搬运（getMany + mutate put），无法只改 entityId 字段做字段级更新。需重构调用结构，记候选。
- AD-D 遗留候选（backup_interval 等 settings 键休眠数据）不变，见 ad-d-notes.md。

## 口径变更记录（不改三份文档，仅记录）

1. `registerType` 由 `'prompt'` 改为 `'autoUpdate'`：PWA 更新策略从「提示用户确认刷新」改为「后台自动更新、新 SW 装好即接管」。UpdatePrompt 组件与 onNeedRefresh 兜底保留（异常路径仍可弹提示）。
2. precache 范围调整：cat-*.svg（4 张 653KB）移出 precache 改 CacheFirst 运行时缓存；manifest 图标引用不变（仍在 public/，按需网络加载 + 缓存）。
3. AC-A「事务安全」口径修正：imageStorage.ts 顶部原注释以 fake-indexeddb 宽松行为为据认为事务内 await 安全——实证不能外推 iOS WebKit，AE-A 起改为「所有写路径调用方事务外预转换」口径。
4. RestoreReport 新增 `failedImagesReason` 出参（向后兼容，全量成功时 undefined）；restore 日志失败分支统一以「，可重新导入」结尾（AC-A 断言口径保留）。

## 测试与构建基线

- `npm run test:services`：**通过 1801 / 1801**（基线 1756 + 新增 45 条 AEA 断言，断言随 test-services.ts 走）。
- `npx tsc -b`：0 错误。`npx eslint . --max-warnings 0`：0 问题。
- `npm run build`：成功；precache 15 项 1198.87 KiB（基线 19 项 1836.79 KiB）；sw.js 注入逐项验证（skipWaiting/clientsClaim/cat-icons 运行时缓存/precache 无 cat-*.svg）。
- 打包口径：含 index.html、.github/workflows/deploy.yml、test-services.ts、全部 src/scripts/public/配置；剔除 node_modules、dist、*.tsbuildinfo、诊断脚本 scripts/rerun-user-backup.ts；package.json 与基线逐字一致（本棒未改）；全包 PAT 扫描 `github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}` 零命中。

## 未验证项（重要）

1. **iOS 真机全部未验证**：Q1 普通页签白屏是否消除、旧 SW 存量用户是否自动更新清理、Q2 GitHub 恢复 255 张图片是否成功、Q3 预置值显示——均需用户在 iPhone Safari 真机复测。沙箱无法复现 iOS WebKit 事务行为与 SW 生命周期，已如实标注。
2. Q2 iOS 侧根因（事务内 await → TransactionInactiveError）为证据链收敛结论，非真机日志直接取证；若真机复测仍失败，下一步应抓取 Safari 开发者控制台的错误分类（新文案会区分「事务失活/配额/其他」，可据此再收敛）。
3. 配额预检在 Node 测试环境走「环境不支持放行」分支，真实 estimate 数值行为仅在单测注入分支覆盖，未经真实浏览器低配额场景验证。
