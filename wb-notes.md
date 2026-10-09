# W-B 棒验收记录：设置与全局 UI 修复（用户反馈第二棒，6 项）

基线：sewing-space-w-a.zip（W-A 交付评论实报「有代码改动，下游请改用新包」），自测基线 **1182** 条全绿（W-A notes 实报）。
本棒改动文件（对基线 diff 逐字节核实，7 改 1 删）：

- `M src/App.tsx` — 移除 StatusBar 挂载（全局项）
- `- src/components/StatusBar.tsx` — 状态栏组件文件删除（全局项）
- `M src/styles/styles.css` — 清理 `.status-bar` 样式块与 `--status-bar-height` 变量（全局项）
- `M src/pages/SettingsPage.tsx` — 设置1 / 设置3 / 设置6 / 设置8
- `M src/lib/presetTabs.ts` — 设置8（六 tab 可编辑 + 新 hint）
- `M src/db/schemas.ts` — 设置8 关联改动（patternAudiences schema 放宽，见口径变更记录）
- `M src/pages/WorkbenchPage.tsx` — 工作台1
- `M scripts/test-services.ts` — 4 处口径冲突断言改写 + 新增 W-B 自测段

`package.json` 与 W-A 基线**逐字节一致**（sha256 对比核实）。

---

## 全局：所有页面顶部去掉系统时间和电池电量 —— 已修复

**处置**：整体移除 S7-C 挂载的 StatusBar 壳层组件。具体：App.tsx 删除 `import StatusBar` 与 `<StatusBar />` 渲染；`src/components/StatusBar.tsx` 文件删除；styles.css 清理 `.status-bar` / `.right-icons` / `.battery` 系列样式块，`--status-bar-height: 44px` 变量经全局检索确认无其它引用后一并删除（原注释位留下 W-B 说明防止未预期引用）。

**顶部安全区间距核对**：StatusBar 在 `#root`（flex column）中独立占位 44px、`flex-shrink: 0`，其后才是各页 `page-header`；移除后 page-header 自然贴顶，各页自身 padding 未动（`.settings-page { padding-top: 0 }`、`.stats-page { padding-top: 0 }` 等均与状态栏无关，核实无联动）——**无需微调，零 padding 改动**。build 产物复核无样式断裂。

**demo 核对**：demo 基线含 StatusBar（S7-C「复刻 demo」），本项为**口径变更**（用户新要求高于 demo 基线），详见口径变更记录 ①。

**留证**：test-services 新增 4 条源码级 DOM 断言（App.tsx 无 import / 无 `<StatusBar />` 渲染 / 组件文件不存在 / styles.css 无 `.status-bar` 规则残留）。

## 设置1：GitHub 配置页去掉「令牌过期日」字段 —— 已修复

**处置**：仅移除录入/展示 UI——GithubSettings 表单 state 删 `expiresAt`、表单同步 useEffect 删 `patExpiresAt` 相关、handleSave 不再写 `pat_expires_at`（**本机旧值原样保留，不被空值覆盖**）、「令牌过期日」input-row 删除。

**PAT 临期提醒逻辑**：完整保留，未删任何服务层逻辑。两个 PAT 临期/过期横幅仍从 `pat_expires_at` 键读取并经 `patExpiryInfo` 判定；「清除令牌」仍会清 `pat_expires_at` 键本身。

**兜底行为说明**：字段移除后新用户没有录入过期日的入口 → `pat_expires_at` 为空/缺失时横幅不展示（`patExpiresAt?.value &&` 判定，既有行为），提醒**静默不触发、不报错**；存量用户的旧过期日仍被读取、横幅仍正常工作（数据保留、读取路径未动）。提醒**不会完全失效**，只是失去新录入来源——若主 AD 认为需要恢复录入入口或改从 GitHub API 推断过期日，属后续棒决策，本棒不擅自扩逻辑。

**留证**：3 条源码级断言（`expiresAt` state 零残留 / `key === 'pat_expires_at'` 读取保留 / 清除令牌仍清键）。S7FIX-1 的 patExpiryInfo 12 条既有断言全绿未动（提醒逻辑不回归）。

## 设置3：个人信息页去掉「缝纫年限」字段 —— 已修复

**处置**：仅 UI 移除——ProfileSettings 删 `years` state、`sewingYears` useLiveQuery、handleSave 中的 `sewing_years` 写入（含钳制调用）与「缝纫年限」input-row。设置主页用户信息头 sub 文案由「缝纫 X 年 / 点击编辑个人信息」二态改为固定「点击编辑个人信息」（原二态依赖已删字段的查询）。

**保留不动**：`settingsService` 的 `sewing_years` key 声明、20 字符内数字串校验与 `sewing_years` 钳制逻辑（1-80）全部保留；本机既有 `sewing_years` 数据保留（UI 不再写 = 不覆盖，存量值原样留存，恢复备份等既有读写路径不受影响）。

**留证**：2 条源码级断言（`sewingYears` 查询零残留 / UI 无 `setSetting('sewing_years'` 写入）。

## 设置6：设置主页加「返回主页」按钮 —— 已修复

**处置**：设置主页（一级页）原用 `<PageHeader title="设置" />`，改为与各子页完全一致的手写 page-header 形态：left-actions 内 `icon-btn` + `IconBack`（20×20，同图标），onClick `navigate('/')` 跳首页，right-actions 36px 占位 div（同位置、同交互）。设置页所有子页（个人信息/预设管理/GitHub 等）的返回按钮逐字同构，本按钮与之仅路由目标不同。

**底部导航冲突核对**：App.tsx `MAIN_ROUTES` 仅四个主路由（/ /materials /garments /workbench），**/settings 不在列 → 设置页本身不渲染底部导航**，返回按钮跳首页后底部导航正常回归，无交互冲突（源码核实）。

**留证**：源码级断言 `navigate('/')` 存在于 SettingsPage（该字符串在本文件中仅设置主页返回按钮使用）。

## 设置8：预设管理「款式、标签、人群」增加新增和删除 —— 已修复（口径变更）

**处置**：交互完全复用同页「尺码/面料品牌/纸样品牌」既有 CRUD 形态（输入框+添加、点击行内编辑、列表项删除按钮、§12.8 删除确认弹层、去重校验、20 字上限、trim 非空）：

- `presetTabs.ts`：PRESET_TABS 前三 tab `readonly: false`（六 tab 全可编辑）；PRESET_TAB_HINTS 前三改为可编辑说明（新文案逐字断言留证）；`PRESET_READONLY_NOTICE` 常量保留导出（不再作为 hint 使用，历史口径兼容）。
- `SettingsPage.tsx`：删除 `tab.readonly` 分支与 `PresetReadOnlyTab` 组件，六 tab 统一走 `PresetCrudTab`；`EDITABLE_TAB_META` 放宽为全六 tab（款式/标签/人群的占位符、空态文案、20 字上限与既有分区同构）。
- 人群 tab 展示：内置五项（women/men/children/baby/pet）沿用 `AUDIENCE_LABELS` 中文标签映射（女/男/儿童/婴儿/宠物），未映射的自由值显原值；行内编辑预填原始存储值；删除确认弹层显示与列表一致的展示名。

**删除策略**：沿用既有可编辑分区同一策略——PRD §12.8 规则 2「不做引用计数」，被物料/成衣引用的预设值删除时**不做阻断、不级联改写**引用方数据（引用方存的是快照值，展示不受影响），不新增任何阻断逻辑。

**schema 关联改动（必须）**：`patternAudiences` 原为 `z.enum(['women','men','children','baby','pet'])` 枚举数组，若不改，用户新增的自由人群值会被 `readPresets` 判为坏值 → **回落 DEFAULT_PRESETS 并回写，覆盖用户全部预设**（S7A-8 既有断言证明该回落路径存在）。故放宽为 `z.array(presetItem)`（trim 后非空字符串，与其它五键同构）。这是**口径变更**（PRD §11.3 未改，见记录 ③）。

**表单联动核对**：GarmentForm 的 STYLE_PRESETS 与 MaterialForm 的 FOR_WHOM_OPTIONS 均为硬编码常量、不读预设键（源码核实），预设 tab 可编辑不影响表单选项来源；MaterialDetail 的 forWhom 标签展示兼容任意字符串。

**留证**：数据层 CRUD 断言 12 条（款式/标签/人群各：新增写入生效、删除生效、还原；人群自由字符串写入、内置映射不受影响）+ 源码级断言 2 条 + 4 处口径冲突旧断言改写（详见下）。

**test-services 断言改写说明（4 处，均因 W-B 口径变更与旧断言冲突）**：

1. S7A-6「patternAudiences 枚举违例拒绝」→ 改为「自由字符串通过 + 空白项（trim 后 min 1）拒绝」
2. S7A-7「updatePresets 枚举违例拒绝」→ 改为「人群自由字符串写入生效」
3. S7A-8「枚举违例回落默认并回写」→ 改用空串项违例复验同一回落路径（坏值自修复行为本身不回归）
4. S7FIX-2「前三 tab 只读」→ 改为「六 tab 全部可编辑」

## 工作台1：看板视图栏位标题 icon 去掉 —— 已修复

**处置**：KanbanView `columns` 数组删除 `IconComp` 字段，header 渲染由「icon+文字」改为纯「`<span className="title">{col.label}</span>`」；黄色（待办 `--status-todo`）/蓝色（进行中 `--status-in-progress`）圆点指示 `<span className="dot">` 保留原样；WorkbenchPage 的 `IconTask` / `IconDress` import 一并清理（`IconPlus` 新建按钮仍用，保留）。

**「已完成」栏位核对**：看板视图 `columns` 数组**仅含待办/进行中两栏，无「已完成」栏位**（源码核实）；已完成任务在看板视图不展示，仅列表视图（ListView）以极简行（`task-done-item`）呈现且无同类 icon——故无第三栏 icon 需移除，两栏一致性即全部。

**留证**：3 条源码级 DOM 断言（无 `IconComp` / 无 `IconTask|IconDress` 残留 / `.dot` 圆点保留）。

---

## 口径变更记录（不回改 PRD / 数据模型 / 架构文档，供主 AD 裁决）

1. **全局状态栏移除（推翻 demo 基线）**：S7-C 按「复刻 demo」挂载 StatusBar；用户反馈第二棒要求全部页面顶部去掉系统时间与电池电量。用户新要求高于 demo 基线，整体移除。demo 相关文件不回改。
2. **设置1 令牌过期日录入入口移除**：PRD/架构文档中 PAT 过期日录入口径（S6-FIX 加入）不再有 UI 入口；`pat_expires_at` 键、存量数据、临期提醒读取逻辑全部保留，读不到过期日时横幅静默不展示（不报错、不误报）。提醒逻辑无录入来源，是否后续恢复入口或改 API 推断由主 AD 决策。
3. **设置8 推翻 PRD §12.7「款式/标签/人群只读」**：三 tab 改为可增删改，交互与既有可编辑分区完全一致；删除沿用 §12.8 规则 2「不做引用计数」。**连带**：PRD §11.3 PresetsConfig 的 `patternAudiences` 枚举口径（ForWhom 五值）在代码层放宽为自由字符串（`z.array(presetItem)`），否则新增值触发坏值回落覆盖用户全部预设。§11.3 / §12.7 文档均未回改。
4. **PRESET_TAB_HINTS 前三 tab 文案**：随只读→可编辑变更，hint 由「此项为内置清单，暂不支持修改」改为可编辑说明（新文案已逐字断言）；`PRESET_READONLY_NOTICE` 常量保留导出未删。

## 验证记录（全过）

- `npx tsc --noEmit` → exit 0
- `npm run lint`（--max-warnings 0）→ exit 0
- `npm run schema:check` → schema ok
- `npm run build` → exit 0（vite + PWA generateSW 19 entries 正常生成）
- `npm run test:services` → **1210/1210 全绿**（基线 1182，净增 28；4 处口径冲突断言按上文说明改写，改写后语义仍覆盖原路径——枚举校验改为空白项校验、坏值回落改用空串违例复验）

## 打包口径（同既往）

- zip 内 97 文件 = W-A 基线 97 − StatusBar.tsx + wb-notes.md（wa-notes.md 随包保留）
- 必含 `index.html` 与 `.github/workflows/deploy.yml`（zip 内清单核实命中）
- 剔除项零命中：dist / node_modules / *.tsbuildinfo / 诊断脚本（wa-repro 等）
- PAT grep 零命中（github_pat / ghp_ / github_token 真实令牌模式扫描）
- `package.json` 与 W-A 基线逐字节一致
