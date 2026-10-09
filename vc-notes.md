# V-C 交付说明（成衣库 + 工作台修复）

任务：7690458268723858632（V-C2 收尾；代码主体来自 V-C 7690351180693638373）
基线：sewing-space-v-b.zip（1120/1120 全绿），V-C 段只增不减。
自测结果：**test:services 1143/1143 全绿**（基线 1120 + 新增 23 条）；typecheck 0 错误；lint 0 警告；schema:check 通过；`npm run build` 通过（PWA SW 正常生成）。

## 1. 七项修复逐项处置

| # | 问题 | 根因 / 处置 | 改动文件 |
| --- | --- | --- | --- |
| 成衣Q1 | 新增成衣选图弹框报 Maximum update depth exceeded | 根因实锤：ImageGallery.tsx 内 `images` 每次 render 都 filter 产生新数组引用，下游 useMemo/useEffect 依赖链失效形成渲染死循环（复现脚本曾捕获 3060 条报错）。修复：filter 移入 useMemo。上传控件宽度 V-A 已修，实测占比 1.00 铺满，无需再动 | src/components/ImageGallery.tsx |
| 成衣Q2 | 基本信息字段顺序 | GarmentForm「名称」调至「款式」之前，实测顺序：名称→款式→尺码→穿着者 | src/pages/GarmentForm.tsx |
| 成衣Q3 | 手工新增成衣状态语义 | garmentService.resolveCreateStatus 放行 completed；completed 创建的扣库存/流水/deducted=true 语义与 in_progress 相同，completionDate 由服务层写当天；GarmentForm 新增态删除状态 chips（编辑态只读展示保留），提交固定传 'completed' | src/services/garmentService.ts、src/pages/GarmentForm.tsx |
| 工作台Q1 | 任务表单去备注/标签录入 | TaskFormSheet 删除备注与标签录入控件；FormState 字段保留，编辑提交仍透传既有数据（历史数据不删）；完工登记无备注字段，不受影响 | src/pages/TaskFormSheet.tsx |
| 工作台Q2 | 任务关联纸样 | Task 接口新增 patternId（弱引用，'' = 未关联）；TaskFormSheet 新增「+ 去选择纸样」控件（复用 PatternPickerPage overlay，demo 同构形态）；createTask / updateTask / createTaskFromTemplate 均透传 | src/types/task.ts（Task.patternId）、src/pages/TaskFormSheet.tsx、src/services/taskService.ts |
| 工作台Q3 | 从模板加载不渲染 | 根因实锤：seedIfFirstRun() 此前只在 scripts 里被调用，应用运行时从不执行，taskTemplates 表空导致模板选择器整行不渲染（功能代码 S4 已存在）。修复：main.tsx 启动期调用 seedIfFirstRun（对齐 cleanupOrphanImages 模式，异步静默） | src/main.tsx |
| 工作台Q4 | 完工→成衣状态联动 | handleTaskComplete 事务扩为 [tasks, garments, settings]：关联 in_progress 成衣联动写 completed + completionDate=当天；planning 不联动（避免绕过扣减边界）；completed 幂等跳过；toggleTaskStep 嵌套事务表同步补 garments | src/pages/WorkbenchPage.tsx |

测试改写：三处被新口径推翻的旧断言已改写（S3FA-1c / S4A-3 / S5A-2），并修复 Q4 引入的 S4A-4 级联影响（g2 联动为 completed 后的后续断言）。新增 23 条断言：成衣Q3 手工直达 completed 语义 4 条、工作台Q4 联动边界 10 条、patternId 透传 3 条 + 既有断言口径改写若干。

## 2. 口径变更记录（供主 AD 裁决留档）

1. **手工新增成衣默认已完成**：新增态表单不再让用户选状态，固定 'completed'（含扣库存语义）；任务触发的成衣仍随任务流转（planning→in_progress→completed），Q3/Q4 自洽。
2. **任务表单去备注/标签录入**：仅去 UI 录入控件，FormState 字段与既有数据全部保留，编辑透传不删历史。
3. **Task.patternId 为新增弱引用**：DM §3.3 原文无此字段，为满足工作台「关联纸样」需求新增；'' 表示未关联，服务层不校验纸样存在性（与 demo 同构）。
4. **完工联动推翻 S4-A 旧口径**：S4-A 旧决策「完工不改成衣 status」被本次需求明确推翻——完工任务关联的 in_progress 成衣联动为 completed；planning 态成衣明确不联动（避免绕过扣减边界），completed 幂等跳过。

## 3. build 排错说明（V-C2 本轮完成）

- **现象**：`npm run build` 在 rollup close 阶段抛 `Error: Dynamic require of "workbox-build" is not supported`（此前只见堆栈尾部，疑似 EACCES，实非）。
- **根因**：本地 node_modules 树损坏——package-lock 已正确解析 `node_modules/path-scurry/node_modules/lru-cache@11.5.3`，但该嵌套目录实际缺失；根目录被 ejs 的 lru-cache@5.1.1 占位。path-scurry（glob v11 → workbox-build 依赖链）按 v6+ 命名导出取 `LRUCache`，取到 undefined 抛 `lru_cache_1.LRUCache is not a constructor`；vite-plugin-pwa 的 `import('workbox-build')` 因此失败，掉进其 `require` 兜底分支，在 ESM 上下文抛出上述报错。
- **处置**：外科式补装——从 npm registry 拉 lru-cache@11.5.3 tarball（零运行时依赖）恢复到 `node_modules/path-scurry/node_modules/lru-cache`。**零代码改动**：package.json / package-lock.json / 业务代码均未动（package.json 经与基线 zip 逐字节比对一致）。
- **影响面**：纯本地环境修复。交付包不含 node_modules，消费侧 `npm ci` 按 package-lock 正确解析，不受影响。
- **结果**：`npm run build` 通过（48.55s，PWA generateSW 13 entries，sw.js + workbox 正常产出）。build 内含 `tsc -b` 已过，另复跑 lint 0 / schema:check 通过。

## 4. 真机回验结论（成衣Q1 渲染循环修复）

- **方式**：复用项目根 repro-q1.mjs（vite createServer + playwright，390px 视口），跳过向导后直达 `/#/garments/new` 新增成衣表单，上传图片走完整链路。
- **结论：通过。** 证据：
  - 表单正常打开（form-sheet count: 1），上传控件存在且占比 1.00 铺满；
  - 选择图片后 preview count: 1，图片正常显示，无 toast 报错；
  - 控制台 0 error / 0 pageerror，**无 Maximum update depth exceeded**（修复前同脚本捕获 3060 条）；仅剩 1 条 React Router v7 future flag 无害警告（基线即有）。

## 5. 交付物

- `sewing-space-v-c.zip`：口径同 V-B——必含 index.html + .github/workflows/deploy.yml，test-services.ts 随包；剔除 node_modules / dist / *.tsbuildinfo / 诊断脚本（repro-q1.mjs）；package.json 与基线逐字一致（已逐字节比对）；全包 PAT grep 零命中（ghp_ / github_pat_ / gho_ / ghs_ / ghr_ / ghu_ / xoxb- / AKIA 等模式均无）。
- `vc-notes.md`：本文件。
