# AD-D 交付说明（第 4 棒：备份 + 预设管理 + 统计，6 项）

基线：AD-C（sewing-space-ad-c.zip）。本棒严格只做验收反馈 6 项，先复现再修，测试只增不减。
未改 PRD / 数据模型 / 架构三份文档（涉及口径变更处在下方「口径变更记录」逐条列出）。

## 修改文件清单（11 个）

- `src/pages/HomePage.tsx`（备份1）
- `src/pages/SettingsPage.tsx`（备份1 / 备份3 / 预设1/2）
- `src/services/backupService.ts`（备份2 / 备份3）
- `src/db/types.ts`、`src/db/schemas.ts`、`src/db/seed.ts`（预设1/2 数据层）
- `src/lib/presetTabs.ts`（预设1/2 UI 层）
- `src/pages/MaterialForm.tsx`（预设1/2 表单联动）
- `src/services/statsService.ts`、`src/pages/StatsPage.tsx`（统计1）
- `scripts/test-services.ts`（既有断言改写 + ADD 段新增）

`package.json` 与 AD-C 基线逐字一致（cmp 校验通过），未新增依赖。

## 逐项：复现 → 根因 → 修复 → 验证

### 备份1：移除「自动备份」模块；未备份提醒阈值 24h → 超过一周（7 天）

- **复现**：设置-备份页存在「自动备份」settings-section-card（每日/仅手动 chips），但全代码库无任何定时器/调度消费者（AA 系已确认该功能从未实装）；首页提醒逻辑为「从未备份（红）+ 超过 24h（黄）」。
- **根因**：UI 摆了一个无后端的模块；阈值常量 `BACKUP_NEVER_DAYS = -1` 配合 24h 判定。
- **修复**：删除整个「自动备份」卡片及 `handleIntervalChange` / `currentInterval` / `backupInterval` useLiveQuery；`HomePage.tsx` 阈值常量改为 `BACKUP_STALE_DAYS = 7`，三态改为「从未备份（红，文案不变）／≥7 天（黄）／7 天内（不渲染）」；设置页 hint 改为「超过 7 天未备份时，首页会出现黄色提醒。」
- **验证**：截图 `settings-390/500/900/1280.png`（备份页已无自动备份模块，仅剩备份状态卡 + 立即备份/推送按钮 + 恢复与迁移 + 备份记录 + 7 天 hint）；测试 `ADD 备份1` 4 条断言（阈值常量、模块移除、间隔逻辑移除、hint 文案）。

### 备份2：GitHub 推送日志增加 zip 包名

- **复现**：`pushToGithub` 成功日志为「已推送到 main（commit 455cfb）」，不含包名。
- **修复**：成功日志改为 `` `已推送到 ${result.branch}：${filename}（commit ${result.commitSha.slice(0, 6)}）` ``，`filename` 即本次实际上传的 `sewing-space-backup-YYYYMMDD-HHmm.zip`。
- **验证**：mock fetch 集成测试 `ADD 备份2`：日志正则匹配「已推送到 main：sewing-space-backup-xxxxxxxx-xxxx.zip（commit abcdef）」；既有断言 `AA-B 设置3-1` 同步改写为新格式。**只改新增日志的展示格式，存量历史日志为已落库数据，不受影响。**

### 备份3：GitHub 恢复日志增加 zip 包名

- **复现**：`applyRestore` 日志固定为「从 zip 恢复（N 行数据, M 张图片）」，不含包名。
- **修复**：`applyRestore` 新增 `ApplyRestoreOptions { filename? }`：带名 → 「从 zip 恢复：<zip 名>（N 行数据, M 张图片）」；缺名 → 回落旧格式。`pullFromGithub` 把远端文件名（`fetchLatestGithubBackup` 返回的 `filename`）透传；本地导入时 `SettingsPage` 把所选 `File.name` 传入。
- **验证**：`ADD 备份3` 3 条断言：带名日志含包名前缀、缺名（Blob 无名/本地旧路径）回落旧格式、`github_pull` 全链路传名；既有 S6A 段传 Blob 无名的恢复断言保持 PASS（回落分支）。**存量历史日志不受影响。**

### 预设1：面料分类预设（增删改 + 新增/编辑面料表单分类下拉联动）

- **复现**：预设管理只有 5 个 tab（款式/人群/尺码/面料品牌/纸样品牌）；面料表单分类下拉读代码内硬编码 `CATEGORY_PRESETS.fabric`。
- **修复**：`PresetsConfig` 新增 `fabricCategories: string[]`；schema `z.array(presetItem).default([])`（旧八键 JSON 仍过校验）；`DEFAULT_PRESETS.fabricCategories` 初值与表单原 `CATEGORY_PRESETS.fabric` **逐字一致**（升级用户表单选项零变化）；`presetTabs.ts` 七 tab（面料分类插在尺码与面料品牌之间）；`MaterialForm` 分类下拉改读预设（空清单回落原硬编码清单，与纸样侧 AD-A 物料6 完全同构）；设置页 `PresetsSettings` 读侧 `{...DEFAULT_PRESETS, ...parsed}` 合并（旧数据自动补全新键）。
- **验证**：`ADD 预设` 段：旧八键 heal、CRUD 增/删/改数据级断言、类型/schema/seed/表单联动/读侧合并源码级断言；既有 `S7FIX` tab 断言按七 tab 新口径改写。

### 预设2：辅料分类预设

- 同预设1，`accessoryCategories` 键、辅料表单联动、七 tab 中的「辅料分类」。
- 工具**未**加分类预设（AD-B 已移除工具分类 UI，本棒维持；测试有专门断言）。

### 统计1：统计页「采购占比」下方新增「采购明细」

- **复现**：统计页只有采购占比环形图（聚合数字），无流水级明细。
- **修复**：`statsService.ts` 新增 `listPurchaseFlowsInRange(from, to)`：行集 = `purchasePrice != null` 且 `purchaseDate ∈ [from, to]`（含首尾）的四类物料统一计入；金额 = `purchasePrice` 直取（V-A Q16 总价口径，与 `purchaseByCategory` 完全一致）；数量列 = `initialQuantity` 优先（信息列，不参与聚合）；排序时间降序、同刻按物料名/id 升序（与布料明细同式）。`StatsPage.tsx` 在采购占比模块后新增「采购明细」stats-block，**完全复用** `fabric-flow-list aa-fixed10` 行结构与 ff-* 样式（行高 60px、容器 max-height 600px = 固定 10 条、超出滚动）；空区间整块不渲染；`useLiveQuery` 随 `period` 切换——本月/今年/汇总三粒度同步生效。
- **验证**：`ADD 统计1` 9 条断言：服务级（区间过滤、未记价不计、降序、品类中文名同源、金额口径、数量列、跨品类、对账 `purchaseTotal = 明细金额合计`）+ 源码级（服务函数存在、StatsPage 结构）；截图 `stats-390/500/900/1280.png`：注入 12 笔采购后「采购明细（12 笔）」出现在采购占比下方，固定高度露出约 10 条、条目含日期/数量/单位/品类徽标/金额。

## 同类问题修复清单（顺手修，均在备份1 范围内的连带文案）

1. 设置-备份页副标题「立即备份、自动备份、导出/导入」→「立即备份、导出/导入」（「自动备份」字样随模块一并移除）。
2. 设置页 hint 中「超过 30 天会弹出强提醒」句删除——强提醒同样从未实装（与自动备份同源的死文案）。
3. 清除令牌 toast「令牌已清除，自动推送备份已关闭」→「令牌已清除，推送备份已关闭」；确认浮层同步去掉「自动」字样。

## 同类问题候选（未修，留待后续棒裁决）

- `backup_interval` settings 键的数据层读写未删（模块 UI 已移除，键成为无消费者的休眠数据；删键涉及数据模型文档口径，本棒不动）。

## 口径变更记录（文档未改，以此为准）

1. 首页未备份提醒阈值：24 小时 → **超过一周（7 天）** 出黄色提醒；「30 天强提醒」文案移除（功能从未实装）。
2. 备份日志格式：github_push 成功日志增加 zip 包名；restore 日志带名时增加包名（缺名回落旧格式，存量日志不受影响）。
3. `PresetsConfig` 新增 `fabricCategories` / `accessoryCategories` 两键（schema default([]) 兼容旧数据）；预设管理五 tab → 七 tab。
4. 统计页新增「采购明细」模块（采购占比口径的流水级延伸，不新增聚合概念）。
5. 既有测试断言改写 4 条（`AA-B 设置3-1` 推送格式 1 条、`S7FIX PRESET_TABS` 3 条）——均为上述口径变更的同步，非删测试。

## 测试

- `npm run test:services`：**1756 / 1756 全绿**（`终局计数：通过 1756 / 1756`，退出码 0）。
- 基线说明：本机可复现的 AD-C 基线为 **1725**（AD-C notes 记录 1726；差异来自条件断言在不同日期的执行分支——S8B e2e 数据包缺失段与 S5A5 月末守卫段按当天日期条件执行，本机两轮复跑均稳定 1725）。本棒净增 31 条断言（新增 ADD 段约 27 条 + 断言改写后既有口径 4 条），**只增不减**达标。
- `npm run typecheck` / `npm run lint`（--max-warnings 0）/ `npm run build`（tsc -b && vite build，PWA precache 19 entries）全部通过。

## 打包与安全自查

- 包含 `index.html`、`.github/workflows/deploy.yml`、`scripts/test-services.ts`；剔除 `node_modules/`、`dist/`、`*.tsbuildinfo`、截图脚本（`_shot-ad-d.mjs` 已删）。
- `package.json` 与 AD-C 基线 cmp 逐字一致。
- 全包 PAT grep：`github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}` 零命中。

## 未验证项

- 真实 GitHub 远端推送/拉取（本棒全部走 mock fetch 集成测试，与既有 S6A 口径一致）。
- 真机 iOS/Android 浏览器上的 7 天提醒触发（逻辑为纯前端日期比较，源码级断言覆盖）。
