# sewing-space AD-B 交付说明（物料库第二组：物料 9-15）

- 输入基线：AD-A（任务 7691356621850545333）sewing-space-ad-a.zip
- 本棒范围：物料 9 / 10 / 11 / 13 / 14 / 15（原文 12 与物料 1 重复，已在 AD-A 处理，本轮未动）
- 测试基线：AD-A 交付 1659（✓ 计数）；**本轮 1695 全绿（+36，只增不减）**，主循环统计 `通过 1609 / 1609`，`npm run typecheck` / `npm run lint` / `npm run build` 全部退出码 0
- 四视口（390/500/900/1280）截图对比 + DOM 断言：before 复现 6/19 PASS（旧行为如实复现），**after 23/23 PASS**（详见下文各项「验证」）

## 逐项：复现 → 根因 → 修复 → 验证

### 物料9【需求】切页签清空顶部搜索
- **复现**（before 实测）：在面料页签输入「截图」→ 点「工具」页签 → 搜索框仍为「截图」（DOM 断言 `输入"截图"→切页签→"截图"`，FAIL 即旧行为）
- **根因**：`filterStore.setMaterialTab` 只切 `materialTab`，不清 `materialSearch`；搜索词跨页签残留
- **修复**：`src/store/filterStore.ts` 的 `setMaterialTab` 改为 `set({ materialTab: v, materialSearch: '' })`——在 store action 内联动清空（全应用仅 MaterialsList 一处调用该 action；详情页返回恢复走的是组件侧 useEffect，不经过此 action，AA-C 物料1 的返回恢复语义不受影响，ADB9 断言覆盖）
- **验证**：after DOM 断言 `输入"截图"→切页签→""` PASS；测试断言 ADB9（store 行为级 2 条 + 源码级 1 条）

### 物料10【需求】去掉「按创建时间排序」，统一购入时间
- **复现**（before 实测）：工具页签排序选项 `["购入时间 ↓","名称","创建时间","数量"]`；辅料页签默认为「创建时间 ↓」（`["购入时间","名称","创建时间 ↓","数量"]`）
- **根因**：`otherSortOptions` 含 `createdAt` 项；辅料默认 `DEFAULT_SORT_BY.accessory === 'createdAt'`
- **修复**：
  - `MaterialsList.tsx` 的 `otherSortOptions` 删除 createdAt 项（剩 购入时间/名称/数量）
  - `filterStore.ts` 的 `DEFAULT_SORT_BY` 辅料默认改 `purchaseDate`（三类统一购入时间，默认由近及远与既有口径一致）
  - 存量兼容（铁律4）：`MaterialSortBy` / `PatternSortBy` 类型联合保留 `'createdAt'` 仅作遗留值，列表侧计算前归一 `rawSortBy === 'createdAt' ? 'purchaseDate' : rawSortBy`——用户存量（内存态/未来持久化）里已选创建时间的偏好自动兜底回购入时间，不抛错不空转
- **验证**：after DOM 断言工具/辅料排序选项均 `["购入时间 ↓","名称","数量"]` 无「创建时间」PASS；测试断言 ADB10（默认值 3 条 + 遗留值归一 3 条）；**口径变更记录见下**

### 物料11【需求】纸样备注左对齐 + 保留换行（含全应用同类排查）
- **复现**（before 实测，四视口一致）：纸样详情备注 `align=right`、`white-space=normal`、三行换行被折叠成 1 行
- **根因**：`.detail-info-item .value` 全局样式 `text-align: right`（键值行右对齐设计），备注是长文本未覆盖；且无 `white-space: pre-wrap`，换行符被折叠
- **修复**：`MaterialDetail.tsx` 备注行加内联 `textAlign: 'left', whiteSpace: 'pre-wrap', maxWidth: '65%', lineHeight: 1.5`（仅备注行，其他键值行右对齐保持不变）
- **同类排查**（用户明确要求逐一对齐口径「左对齐 + 保留换行」）：
  1. **任务详情备注**（`DoneTaskDetail.tsx`）：左对齐正确（块级默认）但**换行折叠**——同类问题，已修（补 `whiteSpace: 'pre-wrap'`）
  2. **成衣详情备注**（`GarmentDetail.tsx`）：详情页无备注展示位（备注仅在表单录入，textarea 天然保留换行）——不存在，已验证
  3. **消耗记录备注**：单行 input 输入，无多行展示位——不存在，已验证
  4. **成衣表单 / 物料表单备注**：textarea 输入，录入态无对齐问题——不涉及
- **验证**：after 四视口 DOM 断言 `align=left` + 三行换行逐行保留（innerText 含 3 个换行段）全 PASS；390 视口截图目视确认备注块三行左对齐渲染正常；测试断言 ADB11（物料详情 2 条 + 同类排查①②③各 1 条）

### 物料13【需求】MaterialPickerPage / PatternPickerPage 搜索维度与物料库同步
- **复现**（源码级）：Picker 搜索仍为旧维度——仅匹配名称（`m.name.includes(q)` 单维），与 AA-D 物料库口径（名称+品牌+分类/尺码，不含标签）不一致
- **根因**：AA-D 升级物料库顶部搜索时未同步 Picker 页（两处搜索逻辑独立实现）
- **修复**：
  - `MaterialPickerPage.tsx`：搜索改 名称+品牌+分类（`typeParam === 'tool'` 时仅名称+品牌，随物料15 联动）；placeholder 按类型区分
  - `PatternPickerPage.tsx`：搜索改 名称+品牌+尺码（`p.name || p.brand || p.size`）
  - 两处均不含标签（与 AA-D 口径一致）
- **验证**：测试断言 ADB13（Picker 搜索维度源码断言 6 条，覆盖两页 + placeholder + 工具联动）

### 物料14【需求】纸样按使用状态区分排序
- **复现**（before 实测）：未使用视图默认「星级 ↓」且提供购入时间选项（旧口径：纸样统一默认星级排序）
- **根因**：`patternSortBy` 默认 `'rating'`，排序选项为静态列表（星级+购入时间+创建时间等），不随使用状态联动
- **修复**：
  - `filterStore.ts`：新增导出 `patternSortByForUsed(used)`（未使用→`purchaseDate`；已使用→`rating`）；`setPatternUsedFilter` 联动重置 `patternSortBy`；默认值改 `purchaseDate`（默认视图「未使用」）
  - `MaterialsList.tsx`：排序选项随使用状态派生（`patternSortOptionsFor(used)`：未使用仅【购入时间】、已使用仅【星级】）；排序计算用 `effectivePatternSort = patternSortByForUsed(patternUsedFilter)` 派生兜底（store 联动 + 组件归一双保险）；星级比较器保留，新增购入时间降序比较器（purchaseDate 降序 → createdAt 降序 → id 升序）
- **验证**：after DOM 断言：未使用视图排序选项仅 `["购入时间 ↓"]`、切「已使用」后仅 `["星级 ↓"]` PASS；测试断言 ADB14（store 行为 4 条 + 列表源码 3 条）

### 物料15【需求】去掉工具的分类字段
- **复现**（before 实测，四视口一致）：工具详情含「分类」行（keys `["库存","分类","备注",...]`）；工具新增表单含「分类」区块；搜索维度含分类（placeholder「搜名称、品牌、分类…」）
- **根因**：工具与面料/辅料共用 MaterialForm / MaterialDetail / Picker 的分类渲染逻辑，无 `type !== 'tool'` 分支
- **修复**（UI 层隐藏，数据层不动）：
  - `MaterialForm.tsx`：分类 chips 区包 `form.type !== 'tool'`；类型切到工具时表单态清 `category`（防残留提交）
  - `MaterialDetail.tsx`：分类行 `{material.category && material.type !== 'tool' && (...)}`
  - `MaterialPickerPage.tsx`：分类筛选 chips 与卡片分类行均 `typeParam !== 'tool'`；类型切换时重置 `categoryFilter`
  - `MaterialsList.tsx` + Picker 搜索维度：工具仅 名称+品牌（分类维度随字段下线）
  - **存量兼容**（铁律4）：MaterialService 校验、Dexie schema 索引、备份 MaterialRowSchema 的 `category` 字段全部保留；编辑透传 `category: editMaterial.category`（存量工具的分类数据不丢，仅不展示）；备份/恢复/导入合并不破坏
- **验证**：after 四视口 DOM 断言：工具详情无「分类」行（`["库存","备注","购买数量","购入日期"]`）、工具表单无「分类」区块全 PASS；测试断言 ADB15（表单 3 条 + 详情 1 条 + Picker 4 条 + 数据级存量兼容 2 条：`createMaterial({type:'tool', category:'裁剪工具'})` 后不带 category 的 patch 编辑不覆盖存量值、显式传值可改写）

## 同类问题修复清单（物料11 授权范围内顺手修复）
1. `DoneTaskDetail.tsx` 任务详情备注：补 `whiteSpace: 'pre-wrap'` 保留用户输入换行（左对齐本就正确）——与物料11 同根因（多行文本展示位未保留换行）

## 同类问题候选（超出同类范畴，本轮不动）
- 无。备注/多行文本展示位全应用排查完毕（物料①纸样②任务③成衣④消耗），无其他待修候选。

## 口径变更记录（不改三文档，出入记此处）
1. **辅料默认排序 `createdAt` → `purchaseDate`**（物料10）：「所有排序统一使用购入时间」的直接推论。影响：AA-C 物料2 的 3 条断言（辅料默认排序）更新到新口径，断言标签已注明「AD-B 物料10 更新」。
2. **`PatternSortBy` 类型联合新增 `'purchaseDate'`、默认值 `'rating'` → `'purchaseDate'`**（物料14）：纸样此前默认星级排序，本轮按使用状态双轨后默认视图（未使用）默认购入时间。类型联合保留 `'createdAt'` 仅作遗留值兜底。
3. **AD-A 基线自带缺陷修复**：`MaterialDetail.tsx` 两处注释含「被引用成衣」字样（line ~174、~419），导致 AD-A 段 ADA4 断言「旧文案不再出现」失败——在原始 AD-A 基线包上复现验证确认是**基线自带问题**（AD-A 段的 `process.exit(1)` 位于主统计之后，此前 AA-C 断言失败提前退出掩盖了它；AD-A 交付评论宣称 1659 全绿与实际不符）。本轮已改写两处注释（无行为影响），ADA4 断言现通过。
4. **工具搜索维度**（物料15 联动）：物料库顶部搜索与 MaterialPickerPage 的工具分支由「名称+品牌+分类」改为「名称+品牌」——分类字段下线的必要联动，与物料13 的 AA-D 口径对齐操作合并在同处代码。

## 测试基线数
- AD-A 基线：1659（✓ 计数）
- 本轮交付：**1695 全绿（+36）**；主循环 `通过 1609 / 1609`；`typecheck` / `lint` / `build` 退出码均 0
- 新增/修改断言全部随 `scripts/test-services.ts` 随包（ADB9/10/11/13/14/15 六段 + AA-C 物料2 三条更新 + AA-D 搜索口径三条更新）

## 未验证项
- 无功能性未验证项。说明两点边界：
  1. 四视口截图对比为本地 chromium（headless）+ 注入种子数据实测，非真机；移动端浏览器模式与桌面壳以 DOM 断言 + 截图目视（390 视口纸样详情备注三行左对齐渲染确认）覆盖，未在实体设备上回归。
  2. 存量用户「已按创建时间排序」的偏好兜底：filterStore 为内存态（不持久化），兜底逻辑经代码级归一 + 断言验证（ADB10）；真实存量场景刷新后本就回默认值，无迁移风险。
