# AG-A 交付说明：sewing-space 六项反馈修复

基线：sewing-space-af-b.zip（测试基线 1841 条全绿）。
本轮结果：**通过 1884 / 1884（只增不减，净增 43 条）**。

---

## Q6（P0 阻塞）：工作台新建任务选关联纸样后页面自动跳出

**根因**：`TaskFormSheet.tsx` 根节点是 `<div className="form-overlay" onClick={onClose}>` 的遮罩关闭模式；「选择关联纸样」打开的 `PatternPickerPage` 浮层虽是 `position:fixed` 全屏，但**在 DOM 上仍是 TaskFormSheet 的子树**。点击选中某张纸样卡片时，click 事件沿 DOM 冒泡到 form-overlay 根节点，触发 `onClose` —— 整个新建任务表单被卸载，已填内容全部丢失。这与 S4 时期修过的「选择器浮层冒泡」是同一类缺陷（S3-FIX-C R1 在 GarmentForm 加过守卫，TaskFormSheet 复用 PatternPickerPage 时漏掉了守卫），确认是**同类回归**。

**修复**（对齐 GarmentForm 既有守卫模式）：
- `PatternPickerPage` 浮层外包一层 `<div onClick={(e) => e.stopPropagation()}>`，阻断冒泡；选中回调仍正常走 `updateField('patternId', ...)` 并收起浮层。
- 遮罩本身点击关闭的语义保留（点浮层外空白处仍可关闭新建任务表单，与既有交互一致）。

**验证**：源码级回归断言（守卫存在、form-overlay 遮罩语义保留）+ 服务级既有任务链路测试；真机建议见文末。

## Q2（P1）：成衣登记物料扣减改为「提交时统一扣减记流水」

### 评估结论（按用户提议实施）

用户场景：登记成衣时关联面料A损耗1m（未提交）→ 通过「管理面料」删掉面料A重加 → 详情页出现 扣1→入库1→扣1 三条流水，统计页只见两条扣减，两处口径对不上。根因是**编辑关联物料/管理面料的中间操作即时写库存流水**。

评估要点：
1. **与「startGarmentProduction 唯一扣减入口」的关系**：该约束的本质是 `deducted false→true` 的状态翻转只发生在开始生产边界（S3-FIX-A：planning 状态零库存动作零流水）。本轮改动**只发生在 completed 成衣的编辑分支**，不翻转 `deducted` 标志，仅对「量差」落流水，与唯一入口约束不冲突。
2. **与 AA-E「先回滚再重扣」的关系**：AA-E 机制（编辑 completed 成衣 = 全额回滚全部旧占用 + 按新选择全量重扣）已废止，改为**差量结算**：结算基线 = `deducted === true` 的 `quantityUsed`；未变化的物料**零动作、零流水、零快照重写**；移除的物料全额回补；减量的按差额回补；增量/新增的按差额/全额补扣。用户的「删了重加」场景在差量结算下 = 净变化为零 = 零流水，正是期望行为。
3. **更优等价方案**：评估过「编辑期间暂存、事务提交」方案，但 Dexie 本地事务与现有「管理面料」入口共享 `applyStockDelta` 原语，改动面大且引入暂存一致性风险；差量结算在不改数据模型（硬约束）的前提下达到同等效果，故按差量结算实施（这也是用户提议的自然落地形态）。

### 实现（`garmentService.ts` updateGarmentWithMaterials completed 分支重写）

- **差量预检**：`need = newQty - baseQty`（base 为 deducted 占用基线），`need > startQty` 时抛「库存不足：编辑后共需 X…已占用 Y…还需补扣 Z…当前仅 W」（预检口径从「回滚后可用」改为直接与 startQty 比较，因为不再先回滚）。
- **changedMids** = 移除 ∪ 用量变化（|new-old|>0.001）∪ 新增；集合外物料完全不动。
- **回补侧**：changed 中有旧占用且物料仍存在 → 移除的全额回补、减量的差额回补，流水 `kind: revert`、note「编辑回补」，记**操作时刻**（回补不是「成衣消耗」）。
- **扣减侧**：changed 中新用量 > 基线 → 差额补扣/新增全额扣，流水 `kind: consume`、note「编辑补扣」、`occurredAt` = 成衣完工日（见 Q1）。
- **新占用行** `deducted: true` 与旧口径一致。

### 不影响历史数据

不迁移、不改写任何已有流水；只改新行为。**口径变更记录**：
- 变更 1（Q2）：completed 成衣编辑关联物料，由「全额回滚+全量重扣（AA-E）」改为「差量结算」；中间操作（编辑期管理面料等）不再产生即时流水。
- 变更 2（Q1）：见下节。

### 回归测试

服务级复现用户全场景：创建（1条 consume）→ 删了重加提交（**零新增流水**，库存不变）→ 增量编辑（2 条补扣：matA 差额 4→3 + matB 全额 5→4）→ 减量编辑（1 条 revert 回补差额）；AA-E 旧测试段同步改写为差量口径（编辑后 5 条流水、零残留、快照逐字节不变）。

## Q1（P1）：成衣消耗流水日期记完工日期

**口径变更记录**：新产生的「成衣消耗」流水 `createdAt` = 成衣完工日期（`完工日T00:00:00.000Z`），不再记操作当天。历史流水不改写。

实现：`materialService.applyStockDelta` 新增可选参数 `occurredAt`（缺省记操作时刻，历史行为不变；`material.updatedAt` 始终记真实操作时刻）；`garmentService` 在创建 completed 成衣与编辑补扣两处传入完工日（带 `YYYY-MM-DD` 格式守卫）。非 completed（如 revert 回补）仍记操作时刻。

统计页同步核对：`listFabricFlowsInRange` 的 `dateLabel = createdAt.slice(0,10)`，新流水自动按完工日聚合并命中区间；测试断言完工日当天区间命中 1 条且 dateLabel = 完工日。快照轴（VEQ8 等）按 completionDate 汇总，不受影响。

## Q3（P1）：登记成衣关联纸样 → 未使用→已使用

- 创建与编辑两路径均实现：提交后关联纸样 `used: 0→1`；已为 1 则不重复写（幂等，重复提交零副作用）。
- 与 AB 系「被引用成衣」共存：`linkedGarmentIds` 追加式反写逻辑不变，两件成衣复用同一纸样时数组按序去重、`used` 保持 1。
- 编辑换纸样：新纸样置 1，**旧纸样不回收**（使用状态只增不减，与 linkedGarmentIds 追加式弱引用口径一致）。
- 测试覆盖：0→1、幂等、1:N 复用、编辑换纸样、linkedGarmentIds 同步反写。

## Q4（P2）：无库存置灰只限列表/预览卡片，观感对齐示例

- **作用面核实**：置灰类（thumb-grayed / thumb-img-grayed / name-grayed）只被 `MaterialCard`（列表/预览卡片）引用；`MaterialDetail.tsx` 不引用任何置灰类——详情页大图本来就不置灰，无误伤，无需改动。
- **观感调整**（参照布山示例图：整图去色变灰但隐约可见图案）：`filter: grayscale(1)` 为主 + 轻度降不透明度 `opacity: 0.55 → 0.82`（原重度淡化会盖掉图案，改为几乎全保留），配浅灰渐变底 `#E9E9E9→#DBDBDB`，与有库存卡片一眼可区分。

## Q5（P2）：统计页完工明细去成本列、名称与完工时间同行

- `StatsPage.tsx`：每条只保留 `cl-name`（成衣名称，超长省略）+ `cl-date`（完工时间），同一行 flex 布局（`justify-content: space-between`）；`cl-right` 成本列及「未核算」展示全部移除。
- `styles-batch3.css`：删除 `.cl-right` / `.cl-cost` 样式，`.cl-left` 改为同行 flex。

## 同类问题修复清单（顺手修）

1. `TaskFormSheet.tsx` 删除确认浮层：嵌套在 form-overlay 内，点其遮罩会连坐关闭任务表单 → 根节点补 `stopPropagation`。
2. `TemplateSettings.tsx` 两处确认浮层（pendingDelete 删除确认、copySource 复制来源选择）：同为 form-overlay 内嵌套浮层 → 补 `stopPropagation`。
3. 已审计其余入口：SettingsPage / WizardPage 根节点是 `.page` 无连坐风险；DoneTaskDetail 已有 confirming 守卫；ConsumptionSheet / CompletionWizard 无嵌套浮层，均无需改动。

## 交付包内实测（解压目录复跑，AF 系质检口径）

| 命令（在 sewing-space-ag-a.zip 解压目录） | 退出码 |
| --- | --- |
| `npx tsc -b` | 0 |
| `npx vite build` | 0（precache 15 entries，生成 sw.js） |
| `npx tsx scripts/test-services.ts` | 0（通过 1884 / 1884，全部通过 ✅） |

打包口径：含 index.html、.github/workflows/deploy.yml、scripts/test-services.ts、全部 src/scripts/public/配置/历史 notes；剔除 node_modules、dist、*.tsbuildinfo；package.json 与基线**逐字一致**（diff 零差异）；全包 PAT 扫描 `github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}` 零命中（grep rc=1，0 行）。

## 真机验证建议

1. **Q6 主链路**：工作台 → 新建任务 → 选关联纸样 → 选中卡片（表单不退出、纸样名回填）→ 继续填写 → 提交 → 任务列表可见。
2. **Q6 边界**：选纸样时点浮层空白处 = 收起纸样选择器（表单保留）；点任务表单遮罩空白处 = 关闭表单（既有语义）。
3. **Q2**：登记成衣关联面料 → 不提交进「管理面料」删掉重加 → 提交 → 物料详情页流水应只有 1 条成衣消耗（无扣-入库-扣中间对），统计页口径一致。
4. **Q1**：登记完工日期为过去某日的成衣 → 流水日期显示该完工日；统计页按日期筛选命中该日。
5. **Q3**：登记关联纸样的成衣提交 → 纸样卡片状态变「已使用」；再次提交另一件成衣复用同纸样 → 仍为「已使用」无异常。
6. **Q4**：物料列表/预览卡片中无库存物料整图去色、图案隐约可见；进入详情页大图正常彩色。
7. **Q5**：统计页完工明细每条一行「名称 … 完工时间」，无成本列。
