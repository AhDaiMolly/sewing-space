# AA-B 交付说明（设置页 4 组 + 2 疑问回答）

- 棒次：AA-B（sewing-space 验收反馈 AA 系第 2 棒）
- 输入基线：AA-A 交付的 sewing-space-aa-a.zip（file-token `XBUNbB5Z1o4bV5xVmDzclRbvnw5`，基线测试 1349/1349）
- 改动范围：仅本棒 4 组需求，共 7 个文件修改 + 1 个新增（`src/lib/version.ts`），与基线 `diff -rq` 核对无越界改动
- 测试结果：**1374 / 1374 全绿**（基线 1349，净增 25 条断言，只增不减）；`tsc -b` 退出码 0；`eslint . --max-warnings 0` 退出码 0

---

## 设置1 个人信息：保存后返回设置页；预置昵称「泥头李」

**复现**：设置 → 个人信息 → 修改昵称 → 保存。基线 `ProfileSettings.handleSave` 成功路径只 `toast('个人信息已保存')`，无任何导航，页面停留在个人信息页。预置昵称方面，`SETTINGS_DEFAULTS.user_name`、seed 种子、个人信息页/首页/向导回落值均为「缝纫人」。

**根因**：`handleSave` 缺少保存成功后的返回导航；预置昵称散落在 5 处（服务层默认值、seed、SettingsPage 两处、HomePage、WizardPage）。

**修复**：
1. `SettingsPage.tsx` `handleSave`：保存成功后 `navigate('/settings')` 返回设置页（toast 与导航均在成功路径内，失败仍停留原页可重试）。
2. `src/services/settingsService.ts`：`SETTINGS_DEFAULTS.user_name` 改 `'泥头李'`；setSetting 空串回落、getSettingValue 空串回落、getSettings 批量读回落三处同步改「泥头李」。
3. `src/db/seed.ts`：首启种子 `ensure('user_name', '泥头李')`。
4. `SettingsPage.tsx`：设置主列表用户名回落、个人信息页初始化回落、输入框 placeholder 与提示文案均改「泥头李」。
5. `HomePage.tsx`：首页问候语回落「泥头李」。
6. `WizardPage.tsx`：placeholder 改「泥头李」；预填判断 `v === '泥头李' || v === '缝纫人' ? '' : v`——旧预置值「缝纫人」的存量用户重新跑向导时仍按默认值处理（不预填），避免存量体验回退（口径见下「口径变更记录」）。

**验证**：AA-B 断言 6 条（handleSave navigate 正则、SETTINGS_DEFAULTS、seed、首页回落、向导兼容、个人信息页回落）+ S7A 既有 4 条 user_name 断言更新为「泥头李」后全绿。

## 设置2 任务模板：去掉分类字段（存量兼容）

**复现**：设置 → 任务模板 → 新建/编辑模板，表单出现「分类」chips（`CATEGORY_OPTIONS` 7 项）。**预设模板部分：不存在-已验证**——W-C 棒已移除全部预设模板种子（`seed.ts` 的 `PRESET_TEMPLATE_IDS` cleanup 逻辑，基线代码 `grep PRESET_TEMPLATE_IDS` 确认），数据库不再产生预设模板，故「预设模板中的分类字段」无从谈起；验证方法：`src/db/seed.ts` 无 addTemplate 种子调用 + `scripts/test-services.ts` 既有断言「内置模板不可修改」路径仍通过。

**根因**：`TemplateSettings.tsx` 表单含 `category` 状态、分类 chips UI、payload 携带 category。

**修复**（只动 UI 层，服务层与数据模型不动）：
1. 删除 `CATEGORY_OPTIONS` 常量、`TemplateFormState.category`、表单初始化 `category`、分类 chips UI 块、payload 的 `category` 字段。
2. **存量兼容**：`taskService.ts` 未做任何改动——`updateTaskTemplate` 对 patch 中未出现的字段不覆盖（`if (category !== undefined) next.category = category;`），编辑存量模板时其原 category 值原样保留；`createTaskTemplate` 的 category 入参保留（不传时落库为空串）。存量模板的 category 字段保留、读取链路完全不变，仅 UI 不再展示。

**验证**：AA-B 断言 4 条（UI 无分类字段、payload 不带 category、update 不覆盖、create 入参保留）全绿。

## 设置3-1 推送 GitHub：成功提示改「推送成功」

**复现**：配置令牌与仓库后点「推送到 GitHub」，成功 toast 为 `已推送到 main（commit abc123）`——分支名 + 6 位 commit SHA，即用户描述的「一堆字符」。

**根因**：`SettingsPage.tsx` `handlePushToGithub` 成功路径用模板字符串拼接 branch + commitSha 展示。

**修复**：toast 改为固定文案 `toast('推送成功', 'success')`。**备份日志不变**：`backupService.ts` 的 `pushToGithub` 成功日志仍写 `` `已推送到 ${result.branch}（commit ${result.commitSha.slice(0, 6)}）` ``（github_push 记录，完整 commit 信息保留），服务层零改动。

**验证**：AA-B 断言 3 条（toast 文案、无 SHA 拼接、服务层日志原文保留）全绿。

## 设置3-2【疑问，只答未改】从 GitHub 恢复取哪一条？

**代码级回答：不是按「更新日期」，而是按文件名降序取第一条；用户不能选择。**

证据链（`src/services/githubService.ts` + `src/services/backupService.ts`，本棒零改动）：

1. `listRemoteBackups`（githubService.ts:551）：调 GitHub Contents API 列 `backups/` 目录，过滤 `type === 'file'` 的条目，然后 `files.sort((a,b) => (a.name > b.name ? -1 : ...))` **按文件名降序**，截取前 `REMOTE_BACKUPS_LIMIT = 20` 条。备份文件名形如 `sewing-space-backup-YYYYMMDD-HHmm[-n].zip`，内含 **UTC 时间戳**，字典序即时间序——所以「文件名最新」≈「时间最新」，与 GitHub 网页上显示的「更新日期」排序通常一致，但排序依据是文件名不是 API 的更新时间字段。
2. `fetchLatestGithubBackup`（backupService.ts:716）：取 `files[0]`（文件名最大的那条）下载。同名冲突时推送序列会给文件名追加 `-2` ~ `-9` 后缀，字典序上 `-9` > `-2`，极端情况下取到的是最后一次成功推送，逻辑自洽。
3. **用户无法选择**：恢复按钮走 `fetchLatestGithubBackup → 确认浮层（展示文件名/大小/时间）→ importBackupFile` 固定序列，UI 没有任何「列出远端备份让用户挑一条」的交互；`REMOTE_BACKUPS_LIMIT = 20` 只是拉取列表的上限，用于取最新，不暴露给用户。

一句话：**恢复的永远是远端文件名最新的一条（即最近一次成功推送），不能选**。若仓库里有人手动改过文件名或上传过名字更大的文件，才会出现「取到的不是时间最新」的偏差。

## 设置3-3【疑问，只答未改】每日备份的时间与动作？

**代码级回答：代码中不存在任何每日自动备份触发器；「每日备份」目前不会自动执行，应用不打开时什么都不做。**

证据链（本棒零改动）：

1. `backup_interval` 只是设置存储项：首启默认 `'daily'`（seed.ts:49 / settingsService.ts:46），设置页切换开关仅写 settings（SettingsPage.tsx:315 `setSetting('backup_interval', val)`）。**全代码对 `backup_interval` 的消费只有设置页的开关展示与校验白名单**——没有任何代码读它来决定「是否到点该备份」。
2. 无调度器：全 `src/` 无 `setInterval`；`setTimeout` 仅用于 toast 自动消失、搜索防抖、网络超时，均与备份无关；无 `periodicSync` / Background Sync 注册；`src/pwa/registerSW.ts` 只做「新版本可用」提示（onNeedRefresh → UpdatePrompt），不触发任何备份。
3. `exportBackup` 的 `kind: 'auto_export'` 参数存在但**全代码调用方为 0**（仅类型定义与函数签名；`pushBackupToGithub` 注释明确「auto_export 归启动时的自动备份触发器，UI 按钮不再借用」，而该启动触发器尚未实装）。实际产生备份的只有两个手动动作：「立即备份」按钮（`exportBackup('local_export')`，导出 zip 不推送）和「推送到 GitHub」按钮（`pushBackupToGithub`）。
4. 纯前端 PWA 无后端：不打开应用就没有任何代码在跑，**关闭状态下不会有任何备份动作**。唯一与「每日」相关的是首页提醒三态（HomePage）：距上次成功备份超过 24h 显示黄色提醒卡片，催用户手动备份。

结论：**「每日备份」当前只是设置页的一个开关语义，选了它也不会有任何自动推送发生**。这与 PRD §10.4 的自动备份设计存在实装缺口，已记入「同类问题候选」报主 AD。

## 设置4 关于页

**复现**：设置 → 关于。基线页面含「数据同步」卡片（上次同步 / 远端标识 / 置灰按钮「同步功能开发中…」，PRD §12.5 占位）；顶部图标为 IconDress 线性图标；版本号硬编码 `1.0.0` 出现 3 处（关于页版本行、设置主列表「关于」项 subtitle、设置页脚）。

**修复**：
- **a) 移除数据同步模块**：删除整张卡片及 `lastSyncAt` / `lastSyncRemote` 两个 useLiveQuery；`last_sync_at` / `last_sync_remote` 设置键仍在白名单，存量数据不动。
- **b) 顶部图标**：`about-logo` 改为 `<img src={${import.meta.env.BASE_URL}icons/apple-touch-icon.png}>`（56×56，圆角 12px），与 iOS 主屏图标同一文件（index.html 的 apple-touch-icon 引用未动，包内 180×180 PNG 复用）。
- **c) 版本号**：新建独立常量文件 `src/lib/version.ts`（见下节），关于页版本行、设置主列表 subtitle、设置页脚三处统一引用 `APP_VERSION`，硬编码 `1.0.0` 全部清除。

**验证**：AA-B 断言 11 条（lastSync 查询删除、无数据同步卡片、设置键白名单保留、apple-touch-icon 引用、IconDress 移除、index.html 引用在、APP_VERSION 格式/当前值/注释、三处引用、1.0.0 清零）全绿。

## 版本号维护说明（每次部署前看这里）

- **规则**：`发布日期 + 当日序号`，形如 `2026.09.30.1`——前三段是发布日期（年.月.日，月/日补零），第四段是当天第几次部署（从 1 起，同天再部署递增 2、3…）。
- **改哪里**：只改一个文件——`src/lib/version.ts` 里的 `export const APP_VERSION = '2026.09.30.1';`，把字符串换成新版本号即可。文件头部注释已写明规则。
- **怎么改**：例如 2026-10-05 当天第 2 次部署，改为 `'2026.10.05.2'`。
- **生效范围**：关于页版本行、设置主列表「关于」项副标题、设置页脚三处自动引用，无需改其他文件；`npm run build` 部署后生效。
- **注意**：PWA manifest 由 vite-plugin-pwa 构建期生成、无显式 version 字段，Service Worker 更新提示走构建产物 hash，均与 APP_VERSION 无联动（见同类问题候选第 3 条）。

## 同类问题候选（未改，报主 AD）

1. **每日自动备份未实装**（3-3 的直接结论）：`backup_interval='daily'` 无任何触发器，设置页文案「已设为每日自动备份」可能让用户误以为会自动执行。建议后续棒次决策：实装启动时检查 + 提醒推送，或改文案。
2. **存量「缝纫人」用户的首页问候**：存量库里 user_name 已是「缝纫人」的用户，首页问候仍显示「缝纫人」（存量数据不动是本棒口径）；只有空串/缺失才回落「泥头李」。若希望全量统一，需一次性数据迁移，未经允许未做。
3. **manifest 无版本字段**：vite.config.ts 的 PWA manifest 配置无 `version`/`id_version`，PWA 安装信息不展示 APP_VERSION；SW 更新提示依赖构建 hash。可考虑后续把 APP_VERSION 注入 manifest。

## 口径变更记录（不改三份文档，仅记录）

1. 预置昵称「缝纫人」→「泥头李」：涉及 PRD §8.1 问候语回落口径与 §4.16 user_name 初值——本棒按用户验收原文执行，PRD 文档未改。
2. 向导预填判断新增「缝纫人」兼容：§13.9「当前值为默认值时显示空」的默认值集合扩大为 {泥头李, 缝纫人}（实现层兼容，文档未改）。
3. 关于页数据同步模块移除：PRD §12.5（多设备同步占位）与 §12.10（关于页结构含数据同步卡片）——按用户决定移除，PRD 文档未改。
4. 版本号从 `1.0.0` 改为日期式 `2026.09.30.1`：无 PRD 对应章节，属新增口径（独立常量文件 + 注释成文）。

## 测试基线

- 基线（AA-A）：1349 条。本棒交付：**1374 条**（更新 4 条 user_name 回落断言为「泥头李」，新增 AA-B 断言段 25 条 + S7A 段内文案更新），`npm run test:services` 1374/1374 全绿。
- `npm run typecheck`（tsc -b）退出码 0；`npm run lint`（--max-warnings 0）退出码 0。
- 附注：本机验证时 `lucide-react@0.441.0` 因离线安装缺 `.d.ts` 导致 typecheck 误报 TS7016，重装该包后通过——与代码改动无关，package.json / package-lock.json 与基线逐字一致（diff 验证）。

## 未验证项

- 浏览器端 UI 实操（点击保存后实际跳转、关于页图标渲染效果、iOS 主屏并排比对）未做端到端截图验证——本沙箱无浏览器环境；以上均有源码级断言覆盖，建议用户部署后按验收标准逐条点检。
- GitHub 真实推送/恢复的 toast 实拍未做（需真实 PAT 与仓库；3-2/3-3 的回答基于代码阅读，未连真实仓库验证远端列表行为）。
