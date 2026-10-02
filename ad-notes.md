# AA-D 交付说明（物料库第二组：物料6-10，含纸样首页按参考图改版）

- 基线：AA-C（任务 7691026765268815931）sewing-space-aa-c.zip
- 测试基线：1401 → 本棒 **1432 / 1432 全绿**（+31，只增不减；命令 `npm run test:services`）
- `npm run typecheck` ✅　`npm run lint`（--max-warnings 0）✅　`npm run build` ✅
- 改动文件（8 个）：`src/components/MaterialCard.tsx`、`src/pages/MaterialsList.tsx`、`src/pages/MaterialForm.tsx`、`src/pages/MaterialDetail.tsx`、`src/lib/presetTabs.ts`、`src/pages/SettingsPage.tsx`、`src/services/materialService.ts`、`src/db/migrations/legacy.ts`、`src/styles/styles-batch4.css`（追加）+ `scripts/test-services.ts`（更新既有断言 + 新增 AA-D 段）

## 逐项记录

### 物料6 去掉「标签」字段（表单 / 预设管理 / 迁移；存量兼容）
- **复现**：基线中 MaterialForm.tsx 有 TAG_PRESETS 常量、tagInput state、handleAddTag/handleRemoveTag、纸样与面料两处「标签」渲染块；presetTabs.ts PRESET_TABS 含 accessoryTags「标签预设」tab；materialService create/update 各有一处 `assertTextArray(*.tags,'标签')`；legacy.ts mapPatternRow 把旧 audience 第 2 元素起以 `audience:` 前缀写入 m.tags；MaterialDetail 基础信息展示「标签」行。
- **根因**：标签字段为历史功能，本棒用户口径为退役。
- **修复**：① MaterialForm 删标签 UI 全链（预设 chips / 自由输入 / 已选 chips / 回显），编辑提交 patch 不含 tags（存量值不被覆盖），新增提交 `tags: []`（数据模型 tags 必填恒为数组）；② presetTabs.ts PRESET_TABS 六 tab → 五 tab（删 accessoryTags），类型、HINTS、头部注释同步；SettingsPage EDITABLE_TAB_META 删 accessoryTags 项，预设管理 subtitle 改「款式、人群、尺码、面料与纸样品牌」；③ materialService 删 create/update 两处标签断言（assertTextArray 仍被 suitableFor 使用，保留）；④ legacy.ts 纸样迁移不再把旧 audience 第 2 元素写入物料 tags（传临时数组承接后弃用，m.tags 恒 []；forWhom 首元素映射保留）；⑤ MaterialDetail 删基础信息「标签」展示行。
- **存量兼容（不删数据、不破坏备份/恢复）**：types.ts 的 `Material.tags` 字段与 `PresetsConfig.accessoryTags` 键、schemas/backupService 的 MaterialRowSchema、Dexie 索引 `*tags`、import.ts MERGE_PRESET_KEYS 的 accessoryTags 合并、seed 默认值全部保留不动；已有行的 tags 数据原样留存（编辑其他字段不触碰），仅不再展示与不再写入。
- **验证**：test-services AA-D 段 10 条断言（表单无标签 UI、编辑 patch 无 tags、新增恒 []、设置无入口、服务层无断言、详情不展示、schema/索引/备份校验保留）；S7FIX-2 / WB 段断言改写为五 tab；S8A_P2.tags 断言改为 `[]`；WB accessoryTags 数据层读写改写为「存量兼容」断言（updatePresets 对该键仍可读写）。

### 物料7 纸样首页卡片改版（参考图）
- **复现**：基线纸样卡片复用通用 material-card 布局（紫渐变缩略图 + 名称 + 类型标签），与参考图（两列粉系卡片、已使用胶囊、紫色尺码胶囊、五颗粉星、灰色品牌名）不符。
- **修复**：MaterialCard.tsx 纸样走独立分支：`pattern-card` 圆角浅粉卡片（#FFFAFB）、缩略图粉渐变（#FFEDF3→#FFD9E5）、右上角「已使用」粉色胶囊（#FF7FA5，仅 `used===1` 渲染）、名称黑粗单行截断、尺码紫色胶囊（底 #F3E8FF / 字 #7C3AED）、PatternStars 恒 5 槽位星级（实心 #FF7FA5 / 空心 #E8CDD6）、底部灰色品牌名（#9B9B9B）；纸样页签滚动容器挂 `pattern-list-pink` 浅粉底。样式全部追加在 styles-batch4.css 末尾（按既有引入顺序覆盖 `.material-thumb.pattern` 紫渐变），不污染其他品类与详情页。必须展示的五项信息：纸样名称、尺码、评分、是否使用、纸样品牌（尺码/品牌值为空时自然省略对应元素；星级恒显 5 槽）。CSS 由 Tailwind 同款 media query 适配，移动浏览器模式（≤500px 全屏）与桌面壳（>500px 手机框）同一布局。
- **验证**：AA-D 段 10 条断言（类名体系齐全、胶囊条件渲染、尺码/品牌条件渲染、5 槽星级、CSS 色值 #FF7FA5/#7C3AED、pattern-list-pink 挂载）。

### 物料8 各类物料卡片名称下类型标签去掉
- **复现**：基线 MaterialCard 非纸样分支渲染 `<span className="material-type-badge">{typeLabels[...]}</span>`，面料/辅料/工具卡片名称下方均显示类型标签。
- **修复**：删除该渲染与 typeLabels 常量；四类卡片均无类型标签。
- **验证**：AA-D 段断言 cardSrc 无 material-type-badge / typeLabels。

### 物料9 纸样编辑放开「是否使用」
- **复现**：基线 MaterialForm 编辑提交 `used: preserve.used`（preserve 取实体当前值），表单无 used 控件——纸样状态只读/自动判定（Y-A 迁移口径 rating≠0→已使用），用户无法手工改。
- **修复**：form 增 `used` 态（编辑回显 `editMaterial.used`，新增默认 0）；纸样信息区新增「是否使用」chips（已使用/未使用可切换）；提交 `used: form.type==='pattern' ? form.used : preserve.used`（非纸样维持原 preserve 行为，避免行为面外溢）。
- **验证**：AA-D 段 4 条断言（label 存在、两枚 chips 可写、编辑回显、提交透传）。

### 物料10 顶部搜索改造
- **复现**：基线 MaterialsList 过滤为 `m.name.includes(q) || m.tags.some(...)`，placeholder「搜名称、标签…」。
- **修复**：过滤改为——纸样：名称+品牌+尺码；面料/辅料/工具：名称+品牌+分类（brand/category 均为现有 Material 字段，`''` 未指定不参与命中）；不再匹配 tags。placeholder 按页签区分：纸样「搜名称、品牌、尺码…」、其余「搜名称、品牌、分类…」。searchQuery 派生 useMemo 依赖本就含 activeType，页签切换即时生效。
- **范围说明**：MaterialPickerPage / PatternPickerPage（制衣流程内的物料选择器）自带独立搜索，不在「物料库顶部搜索」范围，未改动（记入同类问题候选）。
- **验证**：AA-D 段 5 条断言（无 tags.some、三维度变量、两分支返回、placeholder 逐字）。

## 改版前后截图说明
四视口（mobile390 390×844 / mobile500 500×844 / shell900 900×800 / shell1280 1280×800）截图**未完成**，详见下方「未验证项」；改版前形态可在 AA-C 基线包自行跑 `npx vite` 对照。改版要素（两列、粉系、胶囊、紫尺码、五粉星、灰品牌）以源码级断言 + CSS 计算值断言锁定（见 test-services AA-D 段），并附本棒验证脚本 `aad-quick.cjs` 的 DOM 检查项。

## 同类问题候选（未改，报主 AD）
1. MaterialPickerPage / PatternPickerPage 的搜索仍为旧维度（名称匹配），物料库顶部搜索已改品牌/分类维度，选择器内搜索是否同步待用户裁定。
2. MaterialDetail「双向匹配」逻辑（面料↔纸样互相推荐）仍用 material.tags 参与匹配（非展示，存量数据仍可产生匹配结果）；标签退役后该匹配是否保留待裁定。
3. 设置-预设管理 accessoryTags 数据层键与种子保留（存量兼容），若后续确认永久退役可考虑清理种子默认值。
4. AA-C 已报 4 条同类候选继续有效：辅料默认排序仍创建时间、面料/辅料 0 库存记损耗未拦截、工具/纸样详情无购买量展示、纸样默认排序维持星级。

## 口径变更记录（文档未改）
1. PRD §12.7「六个页签（不得增删改名）」→ AA-D 物料6 移除「标签预设」，缩为五 tab（款式/人群/尺码/面料品牌/纸样品牌）。
2. DM 迁移规则「audience 第 2 元素起加 `audience:` 前缀进 tags」→ AA-D 物料6 纸样迁移不再写物料 tags（成衣 garment 迁移的 tags 行为不变，不在本棒范围）。
3. Y-A「纸样 used 由迁移自动判定（rating≠0→1）」→ AA-D 物料9 表单放开手工编辑；迁移自动判定逻辑保留（仅迁移期）。
4. PRD §8.4 物料表单字段 #17「标签」→ 不再展示/写入（数据模型字段保留）。

## 测试基线数
- AA-C 基线：1401；本棒：**1432 / 1432 全绿**（净增 31：AA-D 新段 29 条 + S8A/S7FIX/WB 改写净增 2）
- 更新的既有断言：S7FIX-2（六 tab→五 tab）、WB 段（hint/CRUD 改写）、S8A_P2.tags（['audience:宠物']→[]）、FIX1④（删标签 21 字拒绝断言——服务层断言已随物料6 移除）

## 未验证项
1. **四视口截图对比（改版前后）**：沙箱内 Playwright 三次运行均在页面选择器等待处超时（基线 dev server 首屏按需编译 + 当前版 5173 亦复现 `.tabs-row button` 45s 不可见，疑似沙箱 2C/4G 下 React SPA 首帧渲染超时），按 fail-fast 停止，未取得截图。已通过的替代验证：1432 条服务级/源码级断言全绿（含物料7 全部类名与 CSS 关键色值断言）、typecheck/lint/build 全绿、`npm run build` 产物含全部新样式。建议主 AD 在本地跑 `npx vite` 目验两形态四视口。
2. **桌面壳（Electron/容器形态）实机**：桌面壳为同一 Web 产物（#phone-frame 由 CSS >500px 分支呈现），build 已含该分支样式；未做实机容器验证。
