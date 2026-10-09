# AH-A 交付说明：sewing-space 七项反馈修复

基线：sewing-space-ag-a.zip（测试基线 1884 条全绿）。
本轮结果：**通过 1912 / 1912**（净增 28 条，明细见文末测试记录）。

---

## Q7（P0）：推送 GitHub 报「令牌无效或已过期（上传备份文件）」但测试连接正常

### 根因

测试连接与推送走的是**权限要求不同的两条链路**：

- 测试连接只调 `GET /repos/{owner}/{repo}` —— **读权限**即可通过。fine-grained PAT 只给 Contents: Read-only 时，测试连接一样显示正常。
- 推送需要 `PUT /repos/.../contents/backups/...`（**Contents 写权限**），仓库不存在时的自动建仓还需要 `POST /user/repos`（Administration 权限）。
- 旧代码把推送路径的 403（权限不足）与 401（令牌无效）混同成同一句「令牌无效或已过期」——用户被误导去重新生成令牌，但令牌本身是有效的，缺的是 scope，方向错了。

### 修复（githubService.ts / SettingsPage / WizardPage）

1. `testGithubConnection` 结果新增 `reason: 'invalid' | 'forbidden' | null`：401 → invalid（令牌无效/过期）、403 → forbidden（权限不足≠令牌无效）、200/404/网络异常 → null。四态（success/auth_rejected/repo_missing/network）不变，reason 只用于文案分流。
2. 新增统一 403 文案常量 `TOKEN_FORBIDDEN_HINT`（测试连接与推送共用）：「令牌权限不足：classic PAT 需勾选 repo（或 public_repo）scope；fine-grained PAT 需在该令牌的 Repository permissions 里给 Contents: Read and write 权限（推送备份还需要 Administration: Read and write 用于自动建仓）」。
3. 设置页与向导页的测试连接 401/403 分流展示：403 → 权限不足细化文案，401 → 「令牌无效或已过期，请重新生成」。
4. 推送路径 `classifyStatusError` 的 403 权限不足分支（限流剩余 ≠ 0 时）复用同一 `TOKEN_FORBIDDEN_HINT`，推送报错与测试连接口径一致。

### 测试口径（无 PAT 实测，全部 mock/契约测试）

- 测试连接五态 reason 断言：401→invalid、403→forbidden、200→success+null、404→repo_missing+null、网络异常→network+null。
- `TOKEN_FORBIDDEN_HINT` 内容断言：同时覆盖 classic（public_repo）与 fine-grained（Contents: Read and write）。
- 推送「读通写拒」契约测试（复现实况路径）：mock 路由 `GET /repos → 200`、`GET contents → 404`、`PUT contents → 403`，断言抛出的 userMessage 含「Read and write」权限指引、retryable=false。
- 设置页/向导页/推送路径三处源码断言（文案分流存在、向导页已无原生 fetch 直连）。

### 自助排查指引（真机排障顺序）

1. 报「令牌权限不足」→ 先看令牌类型：classic PAT 检查是否勾选 repo scope（私有仓库必须 repo，仅公开仓库可 public_repo）；fine-grained PAT 检查 Repository access 是否包含目标仓库、Repository permissions 里 Contents 是否 Read and write，首次推送需自动建仓时还需 Administration: Read and write。
2. 报「令牌无效或已过期」→ 这才是重新生成令牌能解决的场景（输错/过期/吊销）。
3. 记住「测试连接通过 ≠ 推送一定通过」：测试连接只验证了读权限，推送失败时按新文案提示的 scope 逐项核对。

## Q2（P1）：统计「今年」卡月度成衣点击月份 → 下方模块切换为该月数据

### 交互决策

- 入口：「今年」卡的月度成衣热力图 12 个月格可点。热力图**保持全年 12 格不随过滤缩减**——否则选中某月后只剩一格，失去切换到其他月的入口。
- 选中态：月格描边高亮（boxShadow）+ `aria-pressed`（可达性）+ cursor pointer。
- **再点同一月 → 取消过滤**，恢复全年全量；**切其他统计卡再切回 → selectedMonth 重置为 null**（handlePeriodChange 一律重置，状态切换干净）。

### 月份过滤作用模块（StatsPage 内三个 useLiveQuery 统一改走 effRange = [选中月月初, 当月月末]，月末按实际天数计算）

1. 战果主卡（stats 汇总：成衣数、物料米数等）
2. 囤布指数（与战果主卡共用 stats 的入布/消耗/净囤布）
3. 布料明细（fabricFlows）
4. 采购占比与采购明细（purchaseFlows）

热力图本身不走 effRange（仍按 period 全年取数，作切换入口）。useLiveQuery 依赖数组含 effRange，选中月变化即驱动上述模块重新取数。

## Q6（P1）：物料损耗流水删除——确认浮层 + 默认不回补

### 两方案取舍（代码注释同步记录）

- 方案 A（回补库存，V-B Q10 旧行为）：删除流水时回退库存。风险——被删流水之后已有成衣消耗发生时（时间纠缠），回退会绕过库存下限校验、库存虚高甚至负成本。
- **方案 B（不回补，本轮采纳）**：删除仅移除流水记录，物料行 quantity/updatedAt 均不动。修正库存走「另记一条调整流水」（adjust），每一步可审计。

### 实现

- 基线已有的 manual-only 校验保留（成衣关联流水不可删）；不可逆操作确认浮层保留，文案改为明确口径：「删除只是移除这条记录，当前库存不会回补；操作不可恢复。如需修正库存，请另记一条调整流水。」
- 删除成功 toast 同口径：「流水已删除（库存不变，如需修正请记一条调整流水）」。
- 删除后统计页聚合：统计从流水表实时聚合（useLiveQuery），被删流水自然不再计入——服务级测试验证删除后库存/成本不变、流水行消失。
- 重复删除同一流水 → 拒绝（「流水不存在」）；删除不改写物料行 updatedAt（物料行未被触碰，测试断言）。

**口径变更记录（Q6）**：删除损耗/调整流水由「回补库存」改为「不回补」；V-B Q10 测试段按新口径整体重写（11 条旧断言 → 新口径断言，见文末测试记录）。

## Q1（P2）：统计采购明细不显示 price 为 0 的记录

- `listPurchaseFlowsInRange` 排除 `purchasePrice` 不为正数的记录——**0 与缺失（按 0 处理）同口径**，均不进明细。
- **聚合同口径**：采购总额（purchaseTotal）与占比同步排除，与展示一致。
- 服务级测试：3 笔采购（30 元 / 0 元 / 未记价 null）→ 明细 1 条、总额 30（不是 30+0）。

**口径变更记录（Q1）**：采购明细与采购总额从「含 0 价与未记价」改为「排除 0 价与未记价」。

## Q3（P2）：工作台去掉任务截止日期字段

- 移除全部录入与展示位置：表单（TaskFormSheet 的 date input）、看板卡（TaskCard）、列表行（TaskListItem）、已完成详情（DoneTaskDetail）。
- **数据层保留**：tasks.dueDate 字段与 date.ts 截止日期相关函数均不删；编辑存量任务时 dueDate 原值透传（不丢数据，测试断言）。
- 列表视图的日期分组（今天/明天/本周/更早/无日期）本身就是截止日期的展示形态，随 Q3 一并移除，改 sortTasks 平铺。

**口径变更记录（Q3）**：任务列表视图由日期分组改为平铺排序（分组标签依赖截止日期，随字段展示一并移除）。

## Q4（P2）：看板视图所有步骤默认展开

- TaskCard 增加 onToggleStep 接线，步骤以行内形态（step-inline-item）展示，与列表视图一致，不再折叠/省略。
- todo 状态的勾选拦截与列表视图同文案（「开始任务后才能勾选步骤」）；看板与列表复用 WorkbenchPage 同一 handleToggleStep 服务。

## Q5（P2）：面料去掉「适合款式」字段

- MaterialForm 的录入区块（预置 chips + 自由输入）整体移除；提交时 suitableFor：编辑透传存量值、新建恒 `[]`（存量数据不丢）。
- MaterialDetail 的匹配空态文案不再引导「去编辑适合款式标签」，改为「暂无名称能对上的布料：纸样与布料按名称关键词自动匹配」。
- **数据层保留**：materialService 的 suitableFor 校验（编辑透传路径仍在用）不删；预置清单常量已移除；迁移/导入映射无该字段引用（已核对）。

**口径变更记录（Q5）**：面料与纸样不再录入、展示「适合款式」；存量 suitableFor 数据保留不删。

## 同类问题修复清单

1. **WizardPage 测试连接直连原生 fetch**（`api.github.com/repos` 硬编码）：401/403 混同同一句「令牌无效或已过期」——与 Q7 设置页同源问题。统一改走 `testGithubConnection` 服务层，文案分流与设置页一致（源码断言向导页已无 `api.github.com/repos` 字样）。
2. **classifyStatusError 403 权限不足文案写死 public_repo**：只覆盖 classic PAT 一种令牌类型，fine-grained 用户按提示找不到勾选处。复用 `TOKEN_FORBIDDEN_HINT` 后两类令牌的自助指引齐了。

## 实测记录（均在最终交付包解压目录全新复跑）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc -b` | 0 | 类型检查通过 |
| `npm run build` | 0 | PWA 构建成功（precache 15 entries） |
| `npm run test:services` | 0 | 通过 1912 / 1912，全部通过 ✅ |

- 打包口径：含 index.html + .github/workflows/deploy.yml；剔除 node_modules / dist / *.tsbuildinfo；scripts/test-services.ts 随包；package.json 与基线逐字一致（diff 为空）；全包 PAT grep（ghp_ / github_pat_ 20+ 位真实令牌模式）零命中。
- 测试基线 1884 → 1912（净增 28）：新增 29 条 AH-A 断言；Q6（V-B Q10 段 11 条旧断言按不回补口径重写）与 Q5（ADA3 段 3 条重写为 2 条）为口径变更的**有意替换**，其余断言只增不减（已用脚本全量对比基线与新版断言名清单核实）。
- 本轮无 PAT 真机联调；GitHub 相关结论均来自 mock/契约测试（见 Q7 测试口径）。

## 真机验证建议

1. **Q7**：设置页填一个只读 PAT（fine-grained 只给 Contents: Read）→ 测试连接应显示权限不足细化文案（不再误报「令牌无效」）；换正确 scope 后推送成功。再试一个过期令牌 → 应提示「令牌无效或已过期，请重新生成」。
2. **Q2**：统计页切「今年」→ 点月度热力图某月 → 下方战果/囤布/布料明细/采购模块全部只剩该月；再点同一月取消；切「全部」再切回「今年」→ 无残留选中态。
3. **Q6**：物料详情删一条手动损耗流水 → 确认浮层出现且写明「库存不会回补」；删除后库存数字不变、统计页该笔消耗消失；成衣关联流水无删除入口。
4. **Q3**：新建任务表单无截止日期输入；看板/列表/已完成详情无日期展示；带 dueDate 的存量任务编辑保存后字段不丢（数据层保留）。
5. **Q4**：看板卡步骤全部展开，todo 态点勾选提示「开始任务后才能勾选步骤」，进行中可直接勾选。
6. **Q5**：面料表单无「适合款式」区块；存量面料编辑保存后适合款式数据不丢；纸样匹配空态显示新文案。
