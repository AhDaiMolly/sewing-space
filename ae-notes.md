# AA-E 验收笔记 —— 向导 + 成衣库（1+5 项）

- 任务：7691027072709299158（AA 系第 5 棒）
- 输入基线：AA-D（任务 7691026916685401384）sewing-space-aa-d.zip
- 日期：2026-09-30
- 测试基线：1432（AA-D 交付数）→ 本棒 1482（+50 条 AA-E 断言），`npm run test:services` 全绿
- 静态检查：`npm run typecheck` 0 错误；`npm run lint` 0 警告；`npm run build` 成功（precache 19 entries）
- 改动文件（与 AA-D 基线 diff 确认，仅 5 个，无越界）：
  1. `src/App.tsx`（向导1）
  2. `src/pages/GarmentsPage.tsx`（成衣1 + 成衣2）
  3. `src/pages/GarmentDetail.tsx`（成衣3 UI + 成衣4 + 成衣5）
  4. `src/services/garmentService.ts`（成衣3 服务层）
  5. `scripts/test-services.ts`（AA-E 测试段 50 条断言）

---

## 逐项记录

### 向导1：首开不弹向导，设置页保留入口

- **复现**：源码级复现——基线 `src/App.tsx` 内 `useLiveQuery` 实时读 `onboarding_completed` 标记，路由变化 effect 中标记未完成即 `navigate(ROUTES.wizard)` 强制重定向，部署后首次打开（空库）必然进入向导，无法直达主页。
- **根因**：路由层把「向导未完成」实现为强制重定向门，首开无退出路径。
- **修复**：整块删除该 effect 及配套的 `useLiveQuery`/`useNavigate`/db 导入；`App` 仅保留 `Outlet + BottomNav + ToastContainer + UpdatePrompt`。向导本体不删：`/wizard` 路由保留，设置页「数据管理 → 重新运行初始化向导」入口原有（`navigate('/wizard')`），向导第 4 步「开始使用」写完成标记逻辑原样保留。
- **验证**：
  - 源码断言 ×5（App 无重定向基础设施、无重定向调用、/wizard 路由保留、设置页入口保留、写标记保留）
  - 真实浏览器：vite preview + chromium headless 首开 `#/` 与 `#/garments`，均直接渲染主页/成衣库（截图 `home-m390.png` 见证：问候语+总览卡片，无向导弹层）

### 成衣1：筛选后的数量统计

- **复现**：基线 `GarmentsPage` 筛选区后直接进列表/空态，无任何「共 XX 件」统计；对照物料库 `MaterialsList` 已有 `list-count-row` 统计（AA-C 物料3）——成衣库缺失。
- **根因**：成衣列表页从未实现统计行。
- **修复**：筛选区（状态 tab + 款式 chip）之后、列表/空态之前插入 `<div className="list-count-row">共 {filtered.length} 件</div>`，行内样式与物料库逐字同款（padding 6px 16px 8px / 13px / 次要色 / 右对齐）。`filtered` 是状态+款式+搜索全部生效后的数组，统计随筛选实时变化。
- **验证**：源码断言 ×2；chromium headless DOM dump 确认渲染出 `共 0 件` 与 `list-count-row` 节点；1280 视口截图目视确认统计行位于筛选标签右侧（`garments-d1280.png`）。

### 成衣2：默认排序——未完工在前，完工由近及远

- **复现**：基线排序为 `createdAt` 降序，与要求的「无完工时间在前 + 完工时间由近及远」不符。
- **根因**：列表沿用创建时间排序，未按完工状态/时间排序。
- **修复**：`GarmentsPage` 排序比较器替换为：双方都无 `completionDate` → 组内按 `createdAt` 降序（保持原有体感）；单方无完工时间 → 无完工者排前；双方都有 → `completionDate` 大者在前（由近及远）。纯前端排序，不动数据层。
- **验证**：源码断言 ×3（空值优先、完工降序、原 createdAt 主排序已移除仅作组内次序）。

### 成衣3：已完工成衣放开编辑（本棒最复杂项）

- **复现**：基线 `GarmentDetail` 编辑按钮包在 `{!isCompleted && (…)}` 中——已完工成衣详情页无编辑入口；服务层 `updateGarmentWithMaterials` 对 completed 走「七差集」增量口径（只处理增减变化），无回滚重扣语义。
- **根因**：S5-B 时代口径「已完工不可编辑」＋ DM §5.3 差集扣减口径，与用户本棒口径（先回滚原占用再全额重扣）冲突。按铁律3，以用户口径为准，记入下方「口径变更记录」。
- **修复**：
  - **UI**（`GarmentDetail.tsx`）：移除编辑按钮的 completed 条件包裹，编辑入口对全部状态可见；表单内状态控件仍只读（编辑不改变完工状态语义，`status`/`completionDate` 传入服务层即被三护栏拒绝，护栏保留）。
  - **服务层**（`garmentService.ts` `updateGarmentWithMaterials`）：事务内新增 completed 独立分支，与 in_progress/planning 的原差集分支并列：
    1. **回滚**：原活跃快照行整组退休（`deducted:false + retiredAt` 一次性写入，append 语义不变）；对每条 `deducted=true` 的行按原 `quantityUsed` 写 `revert` 流水加回库存（流水 `source: garment:{id}`、`garmentId` 透传、note「编辑回滚」，与 AA-A「成衣消耗」迁移流水同形态）；悬挂引用（物料已删）与从未占用（planning 转来的行）豁免回滚。
    2. **预检**：对编辑后物料清单逐项检查 `需求量 ≤ startQty + rolledBack`（**回滚后可用口径**，允许「改小用量」「换料」复用自身回滚额度）；不足即抛错，Dexie `rw` 事务整体回滚——库存、快照、流水零污染，绝不出现负库存静默成功。
    3. **重扣**：按编辑后物料清单全额写 `consume` 流水扣减，append 新快照行（`deducted:true`，快照 50 行上限、`materialIds`/`totalCost` 按活跃行重算、图片对账、关联任务打脏等既有组装逻辑共用不变）。
  - **口径细节**：用料不变的编辑同样走「回滚 + 全额重扣」（净额不变、流水完整可追溯），不复用差集口径——已用断言锁定。
- **验证**（服务级测试 28 条断言，`fake-indexeddb` + db 直查）：
  - 回滚重扣：三物料（10/5/10）→ completed 扣 3+2 → 编辑为 mat1×4 + mat3×1 后，库存 6/6/3 断言通过（mat1 原占用加回再扣新量、mat2 整行移除回补、mat3 新增扣减）
  - 流水可追溯：累计 6 条 = 2 创建 + 2 revert（note=编辑回滚、数量=原占用）+ 2 consume（note=编辑重扣、数量=编辑后全额），`source/garmentId` 与「成衣消耗」口径同形态
  - 快照 append：4 行 = 2 退休（`deducted:false + retiredAt`）+ 2 活跃（`deducted:true`）
  - 成本重算：`totalCost = 4×10 + 1×10 = 50`；`materialIds` 重算为 [mat1, mat3]；`status` 仍 completed、`completionDate` 不动
  - 库存不足阻止：编辑需求 99（回滚后可用不足）→ `assertRejects` 明确报错「库存不足：回滚原占用后可用 X」，且事务回滚后库存不变（6）、快照行数不变、流水仍 6 条零残留——无负库存静默成功
  - 口径锁定：同额重扣净额不变（mat1 仍 6、mat3 仍 3）但流水仍写 2 revert + 2 consume（累计 10 条）
  - 清理：删除成衣回补库存断言通过
- **四视口截图**：成衣详情/列表样式改动跑通 390/500/900/1280 四视口截图（见下「未验证项」的说明），页面渲染正常。

### 成衣4：关联物料辅料不展示单价

- **复现**：基线 `GarmentDetail` 快照行 `material-cost-spec` 渲染 `{quantityUsed}{unit} × {fmtCurrency(priceSnapshot)}`，无快照兜底分支渲染折算单价（`purchasePrice ÷ initialQuantity`）——详情页逐行暴露单价。
- **根因**：S3-D 沿用的展示模板包含单价维度。
- **修复**：快照行只渲染 `{item.quantityUsed}{item.unit}`（保留数量与单位）；无快照兜底分支同样不展示折算单价；`priceSnapshot` 数据字段仍在快照中保留（成本重算依赖），仅展示层移除。成本汇总仍在「总成本」区块（`total-cost-value`）展示，不受影响。
- **验证**：源码断言 ×4（不再展示单价、保留数量单位、兜底分支同样移除、成本汇总仍在成本区块）。全库 grep 确认 `priceSnapshot` 仅剩 `GarmentDetail.tsx`（数据读取）与 `garmentService.ts`（快照写入）使用，无其他页面展示单价。

### 成衣5：去掉详情页「关联任务」区块

- **复现**：基线 `GarmentDetail` 底部有「关联任务」detail-section，配套 `linkedTasks` useLiveQuery 查询与 `IconTask` 图标。
- **根因**：S4-C 双向联动 UI 的一侧落在成衣详情页。
- **修复**：删除该展示区块、`linkedTasks` 查询与 `IconTask` 导入。任务↔成衣数据关联不动（任务侧的成衣关联、级联删除、状态机联动全部保留），仅移除详情页展示。S4-C 另一侧（任务详情中的成衣关联展示）不在本棒范围，未动。
- **验证**：源码断言 ×2（无区块与查询、IconTask 随区块移除）。全 pages grep 确认「关联任务」文案仅存在于任务侧页面（非成衣详情）。

---

## 口径变更记录（铁律3，报主 AD 知悉，未改三份文档）

1. **PRD §13.1「空库强制向导」**：向导1 要求首开不弹向导直接进主页，与 PRD「部署后第一次打开强制走向导初始化」冲突。按用户本棒口径执行：向导保留为可选入口（设置页可进），首开不再强制。PRD 未改。
2. **DM §5.3 七差集扣减口径**：成衣3 要求 completed 编辑「先回滚原占用再全额重扣」，与 DM「按差集只处理增量」冲突。按用户口径为准：completed 走独立回滚重扣分支；in_progress/planning 维持差集口径不变。DM 未改。
3. **PRD §4.3 / S5-B「已完工成衣不可编辑」**：成衣3 放开 completed 编辑，与既有「完工即锁定」口径冲突。按用户口径执行：编辑不改变完工状态语义（status/completionDate 三护栏保留，无「改回未完工」入口）。PRD 未改。

## 同类问题候选（铁律2，未改，报主 AD）

1. `GarmentForm.tsx` 编辑表单的物料行仍显示**小计金额**（`cost-detail-subtotal`，数量×单价的结果）——属表单内的成本核算辅助，非详情页展示，与成衣4「展示不露单价」语义不同，未改；是否统一由用户裁决。
2. 成衣5 只移除了成衣详情页的任务关联**展示**；任务详情页的成衣关联展示（S4-C 另一侧）未动——用户原文仅指「成衣详情」，如需双侧对称移除需下一棒明确。

## 未验证项 / 受限说明

1. **四视口截图对比**：已完成。390/500/900/1280 四视口 × 成衣库/首页截图 8 张（`shots/` 目录随工作目录留存，未入交付包）。成衣详情页（成衣3/4/5 改动页）因空库无成衣数据，未能截到带数据的详情页——已用 chromium headless DOM dump + 50 条源码/服务级断言覆盖（编辑按钮全状态可见、单价字符串不存在、关联任务区块不存在均有断言）。若需带数据的详情页截图，需下一棒在真机或 CI 补。
2. **PWA/Service Worker 真机行为**：build 产物正常生成（precache 19 entries），未在真机 PWA 安装环境实测首开行为；首开验证基于 vite preview + headless chromium。
3. **任务回退与成衣状态联动**：铁律4 明确不动，未做任何改动，未验证（保持 AA-D 现状，P2 待用户裁决）。

## 打包与自测清单

- `npm run test:services`：**1482 / 1482 全绿**（基线 1432 + AA-E 50）
- `npm run typecheck`：0 错误；`npm run lint`：0 警告；`npm run build`：成功
- `package.json` / `package-lock.json` 与 AA-D 基线 diff 逐字一致
- 包含：`index.html`、`.github/workflows/deploy.yml`、`scripts/test-services.ts`、`ae-notes.md` 及全部源码
- 剔除：`node_modules/`、`dist/`、`*.tsbuildinfo`、诊断脚本（本棒未新增诊断脚本）
- PAT 泄漏扫描（`github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}`）：全包零命中
