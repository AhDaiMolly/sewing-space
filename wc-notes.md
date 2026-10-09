# W-C 棒验收记录：任务模板预设清理 + 任务表单与成衣状态流转（用户反馈第三棒，3 项）

基线：sewing-space-w-b.zip（W-B 交付评论），自测基线 **1210** 条全绿（W-B notes 实报）。
本棒改动文件（对基线 diff 核实，6 改 0 删）：

- `M src/db/seed.ts` — 设置4：删 DEFAULT_TASK_TEMPLATES 种子段；新增 `PRESET_TEMPLATE_IDS` 常量与 `cleanupPresetTemplates()` 一次性清理；seedIfFirstRun 事务收窄为 [settings]
- `M src/main.tsx` — 设置4：启动期在 seedIfFirstRun 后调用 `cleanupPresetTemplates()`（fire-and-forget，失败静默不影响启动）
- `M src/components/TaskFormSheet.tsx` — 新增任务1：移除手工关联成衣控件；设置4：零模板空态；新增任务2：生成成衣 status='planning'、删除确认按成衣状态分文案
- `M src/pages/WorkbenchPage.tsx` — 新增任务2：任务卡「开始制作」双入口收敛（成衣侧启动按钮及全管线移除）
- `M src/services/taskService.ts` — 新增任务2：setTaskStatus / toggleTaskStep 派生开始的 planning→in_progress 联动；deleteTask planning 成衣级联删除（含共享绑定守卫）
- `M scripts/test-services.ts` — S4A2 存量 preset 断言改写 + 文件头 seed 零模板断言 + 新增 W-C 专项自测段

`package.json` 与 W-B 基线**逐字节一致**（sha256 对比核实）。

---

## 设置4：删除预设的 3 个任务模板，全部由用户自建 —— 已修复

**处置**：

1. **seed 零模板**：`seed.ts` 删除 `DEFAULT_TASK_TEMPLATES` 常量与 `seedIfFirstRun` 内种模板段；事务表由 `[settings, taskTemplates]` 收窄为 `[settings]`。与 V-C 修复的 seedIfFirstRun 运行时调用联动核对：`main.tsx` 与 `scripts/seed-dev.ts` 两处调用点均调用同名函数，去模板后首次启动**不再种任何模板**（test-services 文件头断言 `seedIfFirstRun 后任务模板表为空` 留证）。
2. **存量一次性清理 `cleanupPresetTemplates()`**：启动期（main.tsx，seedIfFirstRun 之后）幂等调用。**识别依据（现有 schema 无来源标记的补齐方案）**：双重判定 `source === 'preset'` **且** `id ∈ PRESET_TEMPLATE_IDS`（tmpl-skirt-std / tmpl-top-std / tmpl-dress-std 三固定 id）。两条件均种子专属——用户建模板唯一入口 `createTaskTemplate` 与 `copyPresetTemplateAsCustom` 均写死 `source: 'custom'`，用户模板 id 为 12 位 nanoid，与固定 id 前缀结构性不冲突；双重判定使**用户自建模板绝无可能命中**（既非 preset 来源、id 也非三固定值）。命中零条时零写入直接返回 0（幂等可重入）；命中时 bulkDelete 后打脏 `dirty_since_backup`。旧备份恢复若带回 preset 行，下次启动再次自愈清理。
3. **删除模板不影响已建任务**：任务套用模板时 steps 是**复制快照**（applyTemplate 生成独立副本，id 嵌 taskId），templateId 仅为弱引用悬挂——服务层 `deleteTaskTemplate` 既有注释与 S4A2 既有断言「删模板不检查引用：任务 templateId 保留」双重确认。**清理 3 条种子模板不影响任何已建任务的步骤与展示**。
4. **「从模板加载」零模板空态**：任务表单模板选择器由「有模板才渲染」改为**始终渲染**（仅新建态），零模板时显示提示文案「暂无模板——可在『设置 → 任务模板』中自建模板，步骤也可直接在下方手动输入」——入口不消失、不报错、用户不会误以为功能没了；loading 态仍正常（templates undefined 时显示加载中）。模板管理页（/settings/templates）自身已有空态「还没有模板，点击右上角 + 新建一个吧」原样保留。
5. **TemplateSettings「复制为自建」入口**：种子模板清理后 preset 行不存在，该按钮零命中自然不渲染，逻辑无需改（函数 `copyPresetTemplateAsCustom` 保留，服务层拒绝路径不变，非 preset 模板调用仍被拒「只能复制内置模板」）。

**留证**：文件头 1 条（seed 后模板表空）+ S4A2 补种存量段 2 条（补种计数 / id 集与 PRESET_TEMPLATE_IDS 一致）+ 清理段 9 条（返回 3 / 三 id 已删 / 自建不误删 / 仅剩 1 条 custom / templateId 悬挂 / 二次幂等返回 0 / 清理后不可复制、不可套用）+ 源码级 5 条（seed 无 DEFAULT_TASK_TEMPLATES / 导出 cleanupPresetTemplates / main 调用 / 表单空态文案 / 模板页空态文案）。

## 新增任务1：去掉「关联成衣（非必填）」选项 —— 已修复

**处置**：任务表单（TaskFormSheet）移除 garmentId 手工选择控件——`showGarmentPicker` state、全表 garments 查询、`candidateGarments`、`selectedGarment`、「关联成衣（非必填）」input-row 与成衣选择器浮层整段删除。改为定向查询 `boundGarment = db.garments.get(task?.garmentId ?? '')`，**仅用于编辑既有任务时的删除确认文案分态**（关联成衣尚在 planning → 提示「将随任务一并删除」；其他状态 → 「将保留在成衣库」），与新增任务2 的级联删除口径对齐。

**数据字段保留兼容**：`FormState.garmentId / garmentName` 字段保留，编辑既有绑定任务时原值透传提交（不删既有数据、不强制解绑）。**任务↔成衣关联唯一通道 = 勾选「生成成衣」**（新建时创建 planning 成衣并绑定，见新增任务2）。

**garmentId 其他读写点排查结论**：

- 读侧全部保留、不受影响：WorkbenchPage 任务卡 GarmentCard（关联成衣卡展示）、GarmentDetail（成衣绑定任务列表）、DoneTaskDetail（完工详情展示关联成衣）、CompletionWizard（完工登记读取）——均为展示性读取，无录入入口。
- 写侧：`bindGarmentToTask` / `unbindGarmentFromTask` / `updateTask({garmentId})` 服务层函数保留（成衣详情页「关联任务」入口等既有路径仍在用，未发现除任务表单外的手工录入 UI）；数据模型强引用校验（resolveBinding）不变。
- 完工流程不受影响（handleTaskComplete 联动读 garmentId，属读侧）。

**留证**：服务层行为断言 2 条（既有任务 garmentId / garmentName 快照保留）+ 源码级 4 条（无 showGarmentPicker / 无「关联成衣（非必填）」label / 含「生成成衣」唯一通道 / FormState.garmentId 字段保留）。

## 新增任务2：补齐「规划中」成衣状态流转【状态机改动】 —— 已修复（口径变更，单独成节见下）

**处置**：按用户口径补齐 planning 中段，联动落点全在服务层事务内：

- **建任务（勾选生成成衣，任务=todo）→ 成衣 planning**：TaskFormSheet 生成成衣分支 `status: 'planning'`（原为 in_progress）——快照落库但**未扣库存**（S3-FIX-A 语义：planning = deducted=false 零流水）。
- **任务开始（todo→in_progress）→ 成衣制作中 + 此时扣库存**：`setTaskStatus` 写任务行后，若关联成衣仍 planning → 事务内调用 `startGarmentProduction`（架构既有约束：**唯一**跨扣减边界的成衣状态入口，幂等自愈）；`toggleTaskStep` 的「勾步骤派生 todo→in_progress」分支同口径联动。扣减时点由「成衣创建」迁移至「任务开始」。
- **任务完工 → 成衣 completed**：V-C 工作台Q4 既有实现，不动（只对 in_progress 成衣写 completed；planning 不联动；completed 幂等跳过）。
- **幂等不降级**：任务开始时成衣已 in_progress / completed（成衣侧入口先行 / 手工新增场景）→ 条件 `g.status === 'planning'` 天然跳过，不阻塞任务开始、不降级成衣状态、不重复扣库存；重复调用 setTaskStatus 同值为 no-op（联动不重复触发）。
- **原子性**：`startGarmentProduction` 抛错（如库存不足）→ 整事务回滚——任务停留原状态、成衣停留 planning、零流水。事务表扩容：setTaskStatus / toggleTaskStep → `[tasks, garments, materials, usageLogs, settings]`；嵌套的 startGarmentProduction / handleTaskComplete 表集合均为其子集，Dexie 复用外层事务，原子生效。
- **任务删除/取消时 planning 成衣处置（工程裁定：随任务删除）**：`deleteTask` 在删任务行后，若关联成衣仍 planning 且**无其他任务绑定**（级联守卫，防误删共享关联）→ 复用 `deleteGarmentWithRestore` 级联删除——planning 未扣库存，内部 deducted 过滤天然保证**零回补零流水**；仍被其他任务绑定时保留，删最后一条绑定任务才随之删除。in_progress / completed 成衣保留不动（DM §5.5 九原口径）。
- **双入口收敛**：任务卡上的成衣侧「开始制作」按钮及全管线（renderStartProductionButton / handleStartProduction / startGarmentProduction import、看板与列表 todo 卡传参）从 WorkbenchPage 移除——任务开始即联动成衣，双入口会绕过扣减时点迁移语义；**成衣库详情页的成衣侧入口保留不动**（手工新增成衣场景仍可从成衣侧开始制作）。

**验收五场景服务层自测全覆盖**：① 建任务→成衣 planning 且未扣库存（库存 20 不变、快照 deducted=false、零流水）；② 开始任务→成衣 in_progress 且此时扣库存（20→15、恰好 1 条 consume 流水）；③ 完工→completed（含 completionDate=当天）；④ 幂等——重复开始不重复扣（仍 15、仍 1 条流水）；⑤ planning 成衣不触发完工联动（V-C 口径复证：任务正常 done、成衣仍 planning、零扣减）。另覆盖：勾步骤派生开始同口径联动+全勾完工联动；成衣已 in_progress/completed 时任务开始幂等跳过不降级；deleteTask 独占绑定 planning 级联删除（零回补零流水）；共享绑定守卫（删其一保留、删最后随删）。

**留证**：W-C 专项自测段服务层断言 33 条 + 源码级 2 条（WorkbenchPage 无 renderStartProductionButton / 无 startGarmentProduction 调用）。

---

## 口径变更记录（不回改 PRD / 数据模型 / 架构文档，供主 AD 裁决）

### 状态机口径变化（单独成节）

**新状态机全链**（用户 2026-09-29 第三棒口径，本棒落地）：

```
勾选生成成衣新建任务（任务=todo）→ 成衣 planning（快照落库、未扣库存）
任务开始（todo→in_progress）    → 成衣 in_progress + 此时扣库存（consume 流水）
任务完工（→done）               → 成衣 completed（V-C 既有，不变）
```

与既有文档/实现的出入：

1. **库存扣减时点迁移（推翻 S3-FIX-A 的扣减入口语义中的时点）**：原实现成衣创建为 in_progress 时即扣库存（createGarmentWithMaterials / 成衣侧「开始制作」两路径）。本棒迁移后：任务表单「生成成衣」路径创建 planning **不扣**，扣减发生在「任务开始（planning→in_progress）」；`startGarmentProduction` 仍是唯一跨扣减边界的入口（架构 §13.4 约束不破），仅触发时点变化。成衣库手工新增（in_progress / completed）与成衣侧「开始制作」入口的**创建即扣**语义不变；完工扣减/回补逻辑不受影响的部分全部保持（completed 删除回补、revert 流水对冲等）。S3-FIX-A 语义重述为：**planning = 快照落库未扣库存；跨入 in_progress 必经 startGarmentProduction 扣减**——本棒是该语义在任务链路的自然延伸。
2. **任务删除时 planning 成衣随任务删除（工程裁定）**：DM §5.5 九原口径「删任务不级联删成衣」对 planning 成衣不再成立——孤立 planning 成衣（无任务引用）对用户是死数据且无库存语义。裁定**随任务级联删除**，附「无其他任务绑定」守卫（共享绑定不误删）；planning 未扣库存 → 零回补零流水，`deleteGarmentWithRestore` 单一实现复用。in_progress / completed 成衣保留口径不变。
3. **与 V-C「完工时 planning 不联动 completed」决策的关系**：不冲突，互补成完整状态机——planning→in_progress 联动在**任务开始**时点（本棒新增），in_progress→completed 联动在**任务完工**时点（V-C 既有）；planning 不被完工直接写成 completed（防绕过扣减边界）的决策**原样保留**。任务开始时成衣已是 in_progress / completed（手工新增场景）→ 幂等跳过不降级（本棒新增守护）。
4. **任务回退（→ todo）不回退成衣状态**：无用户口径、无文档依据，不擅自实现回退扣减（回补涉及 revert 流水语义，属另一口径）；如需支持由主 AD 裁决。
5. **任务卡成衣侧「开始制作」按钮移除**：原「任务卡开始制作（成衣侧入口）」与「开始任务」双入口并存，在扣减时点迁移后语义冲突（任务卡按钮可先于任务开始扣库存，绕过新状态机）。裁定收敛为单通道：任务开始联动；成衣库详情页入口保留（服务手工新增成衣场景）。

### 其他口径变更

6. **设置4 预设模板整体移除（推翻 S4A 种子口径）**：S4A 原按 PRD §6.7 种 3 条内置模板（source='preset'，只读、可复制为自建）；用户第三棒要求全部由用户自建。seed 零模板 + 启动期 `cleanupPresetTemplates` 一次性清理存量（识别依据见设置4 处置 2）；服务层 preset 只读/拒绝路径**保留不删**（旧备份恢复带回的 preset 行仍受只读保护，且下次启动被清理）——`copyPresetTemplateAsCustom` 在清理后的库中自然零命中，函数与拒绝路径保留为兼容存量。schemas.ts 的 `builtinTemplateId` 枚举与 TaskTemplateRowSchema 校验**保留**（旧备份恢复的 zod 校验兼容），仅不再有新种子写入。
7. **新增任务1 关联通道收敛**：任务表单手工关联成衣入口移除，关联唯一通道 = 勾选「生成成衣」；garmentId 数据字段与既有绑定数据全部保留（兼容不删）。PRD 任务表单字段清单未回改。
8. **任务表单删除确认文案分态**：随级联删除口径，编辑既有任务删除确认按关联成衣状态区分提示（planning → 将随任务删除；其他 → 将保留在成衣库），原文案口径未单独成文档，一并记此。

## 验证记录（全过）

- `npm run typecheck`（tsc -b）→ exit 0
- `npm run lint`（--max-warnings 0）→ exit 0
- `npm run schema:check` → schema ok
- `npm run build` → exit 0（vite + PWA generateSW 19 entries 正常生成）
- `npm run test:services` → **1274/1274 全绿**（基线 1210，净增 64：文件头 seed 零模板 1 + S4A2 存量/清理段 11 + W-C 专项段 33 + 源码级 11 + 改写段新增识别断言 8；S4A2 原依赖内置模板的 12 条断言改写为「手工补种存量 preset」前置下的同语义验证——只读保护/复制为自建/套用 7 步/弱引用悬挂全部复验，口径变化部分按上文记录改写）

## 打包口径（同既往）

- zip 内 98 文件 = W-B 基线 97 + wc-notes.md（wb-notes.md / wa-notes.md 随包保留）
- 必含 `index.html` 与 `.github/workflows/deploy.yml`（zip 内清单核实命中）
- 剔除项零命中：dist / node_modules / *.tsbuildinfo / 诊断脚本
- PAT grep 零命中（github_pat / ghp_ / github_token 真实令牌模式扫描）
- `package.json` 与 W-B 基线逐字节一致
