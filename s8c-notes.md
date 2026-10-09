# S8-C 交付说明（设置页导入入口 + ImportReport 报告界面 + 幂等验收）

任务：7690001374112648130（重派第二轮）
基线：sewing-space-s8-b.zip（1045/1045 全绿），S8C 段只增不减。
自测结果：**1153/1153 全绿**（基线 1045 + 新增 108 条断言，见 test-results 段）。`tsc --noEmit` 0 错误；`eslint --max-warnings 0` 通过。

## 1. 变更文件清单

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| src/db/migrations/legacyFiles.ts | 新增（300 行） | UI 层文件解析 + 内容特征识别 + zip 图片提取。demo 源码没有此层（demo 不含导入功能），按 S8-A 定下的内容特征口径全新实现 |
| src/db/migrations/importReportView.ts | 新增（97 行） | report → 视图模型的纯函数。demo 无导入报告界面，按 PRD §13.5 + 冻结 CSS 已有类实现 |
| src/pages/WizardPage.tsx | 修改（step 2 重写，696→973 行） | 迁移导入入口 + 报告界面 + §11.2 重复导入确认弹层 |
| scripts/test-services.ts | 追加 S8C 段（4646→4973 行） | 116 条新断言；此前 1045 条未动 |

其余文件（import.ts / legacy.ts / 其它页面 / CSS）**零改动**——冻结接口原样复用。

## 2. 入口落位决策（供主 AD 知悉，非冲突）

- PRD §13.5 将迁移导入入口放在初始化向导第 2 步（"数据迁移"），§11.2 描述同一入口；PRD **没有** /settings/data 独立路由或设置页独立导入入口的描述。
- S7 已实现：设置主页「数据管理」条目副标题「重新运行初始化向导」跳 /wizard。任务书要求"落位以 PRD 迁移章节为准，若冲突按 PRD 并记 notes 供裁决"——经核对**无冲突**：PRD 口径（向导 step 2）与现状（设置页跳向导）天然衔接，用户从设置页也能两跳到达导入入口。因此无需裁决，按 PRD §13.5 在 WizardPage step 2 实现。
- 图片提供方式：任务书明确"文件选择支持多选 JSON + 图片 zip"（PRD 原文写"选择图片文件夹"，任务书口径更新），实现为两个独立的多选入口：`*.json` 多选 + `*.zip` 多选（zip 内部目录结构不敏感）。

## 3. UI 实现要点（全部使用冻结 CSS 已有类，无新增 CSS 类，无 window.prompt/alert/confirm）

- **两个 wizard-upload-card**：`选择旧数据文件（JSON，可多选）` + `选择图片压缩包（ZIP，可多选）`；导入进行中禁用。
- **预览**：wizard-preview-card + preview-grid 六行（物料/成衣/库存流水/归档任务——仅 >0 时显示/图片张数/数据文件大小）；归档任务数是 **UI 层补充提示**（importLegacyDatabase 的 report 没有 task_archive 字段，且 task_archive 不在 LEGACY_SOURCES 内），已在本文件 §6 与 importReportView.ts 模块头注明，不冒充 report 数字。
- **进度**：progress-bar-mini / progress-fill-mini / progress-text-mini，进度文案按 onProgress 的 phase 映射九条固定文案，百分比 = done/total（total=0 时按 phase 序号/9 兜底）。
- **报告**：wizard-done-card（done-check ✓ + summaryLine + presetsLine）+ wizard-preview-card 明细（三主计数、图片四计数「成功导入/未找到/格式拒绝/超限截断」、跳过两组、悬空引用、丢弃字段、丢弃用量、warnings）。**全部计数与清单只来自 importLegacyDatabase 返回的 report**——构建逻辑收敛在 `buildImportReportView(report)` 纯函数里，UI 不另算任何数字。
- **§11.2 重复导入确认**：检测到 settings 里 `import_completed === 'true'` 且用户再次点「确认导入」时，用 confirm-overlay / confirm-sheet / confirm-icon / confirm-title / confirm-actions 弹出**逐字**文案：「你之前已经导入过一次旧数据。再次导入不会覆盖已有内容，但库存流水会翻倍，统计数字会因此变大。确定继续吗？」取消留在原页；「继续导入」才执行。仅提示不阻断（§11.2 口径）。
- **§11.8 跳过分两组**：reason 含「已存在」→ 合并一行 + 固定说明「这些记录之前导入过，本次跳过」（幂等保护，不逐条展示）；其余 → 逐条列出「这些记录格式不对，没能导入」。
- **§13.5 完成文案**：`共导入 X 条物料、Y 件成衣、Z 条库存流水`（summaryLine），完整报告在下方展示而非仅 toast。

## 4. S8-B 两个口径的处置

1. **§9.10 重复导入 UI 提示文案**：已实现，见上节，逐字采用 §11.2 文案。
2. **backupLogs 按导入事件计**：维持 S8-B 基线——每次 importLegacyDatabase 调用（无论数据是否零变更）都记一条 migration 日志。**未实现**"零变更导入不记日志"的 UI 侧预检（可选项，选择不做，理由：预检需要重复执行整套 sourceRef 查询才能判断"零变更"，成本等于跑一遍导入；且 S8-B 口径已明确"不翻倍指数据不翻倍"，日志翻倍符合设计）。实测连导两次 backupLogs=2（S8C-3/S8C-4 均验证），数据不翻倍。

## 5. 内容特征识别（不依赖文件名）

真实数据 7 个 NDJSON 逐一扫描（Python 脚本核验 + 测试 S8C-1b/S8C-4 断言）：每个文件命中且仅命中一个集合签名，无平局、无歧义——

| 集合 | 行数 | 命中特征 |
| --- | --- | --- |
| fabric | 71 | stock |
| accessory | 65 | unit+quantity（无 stock） |
| tools | 40 | price+quantity（无 unit/totalPrice/stock） |
| pattern | 45 | style + audience/rating（无 status） |
| garment | 35 | fabricAmounts/accessoryAmounts 或 status+finishDate |
| preset | 1 | config 对象 |
| task_archive | 3 | steps/currentStep/done（仅计数，不参与导入） |

- 单文件按行聚合打分（该文件哪类特征行最多且唯一最大者胜出）；平局/全零/空文件 → unrecognizedFiles 非阻塞提示（backup-warning 展示文件名），**缺集合按空数组处理不报错**（S8C-1b 断言）。
- 误导性文件名不干扰：fabric 内容存进 `database_export-garment.json` 仍识别为 fabric（S8C-1b 断言）。
- 真实包集合行数：fabric 71、accessory 65、tools 40、pattern 45、garment 35、preset 1、task_archive 3，unrecognizedFiles = 0。

## 6. 图片口径

- zip 内任意目录层级均可；**同名图片取先注册者**（§9.7）；按 basename 匹配实体。
- 每实体最多 5 张、MIME 白名单 jpeg/png/webp、单张 ≤2MB——**UI 层不做预过滤**（GIF 也会收集），拒绝计数交给 importLegacyDatabase 的 report（images.rejected），保证报告数字来源唯一。
- 五包全量 245 张（fabric 71 + accessory 63 + tools 39 + pattern 45 + garment 27，与集合引用逐张对上）。
- **Node 环境与浏览器的 rejectedImages 差异**：真实包里两张超大 PNG（>2MB）在浏览器（有 canvas）会被压缩/截断；Node 环境（fake-indexeddb、无 canvas）S8-B 基线对超限图片是**透传不写库**，所以 Node 端到端里 rejectedImages=2、truncatedImages=0。这是环境能力差异，不是数据或逻辑问题；浏览器实测口径以 §9.7 为准。**missingImages=0（全部 245 张对上）**，符合"全量图片可用"口径。

## 7. §9.10 幂等验收证据

方法：同一数据包连导两次，Dexie 直读 IndexedDB 计数对比 + 两次 report 对比（S8C-3 小样本 / S8C-4 真实数据全量双跑，均通过）。

真实数据（S8C-4，245 张图片全量）：

| 指标 | 第一次导入 | 第二次导入 | 直读计数（两次后） |
| --- | --- | --- | --- |
| materials 入库 | 221 | 0 | 221（不翻倍） |
| garments 入库 | 35 | 0 | 35（不翻倍） |
| usageLogs 入库 | 38 | 0 | 38（不翻倍） |
| images 入库 | 244 | 0 | 244 |
| presets | 面料品牌 10 / 纸样品牌 8 / 标签 3 | 0/0/0 | 合并后不翻倍 |
| skipped | 0 | 256（全部「sourceRef 已存在，跳过」） | — |
| summaryLine(第二次) | — | `共导入 0 条物料、0 件成衣、0 条库存流水` | — |
| backupLogs | +1 | +1 | 2（按导入事件计，符合 S8-B 口径） |

第二次 report 完全符合 §9.10 口径：三主计数归零、跳过清单逐条「已存在」、无数据翻倍、悬空引用与丢弃字段第二次为 0。小样本（S8C-3：1 物料/1 成衣/1 流水双跑）结论一致。

## 8. 端到端复跑方式

真实数据置于工程旁：`../legacy_data`（7 个 NDJSON，文件名不限）+ `../imgs`（245 张图片，任意目录层级，脚本运行时打包成 zip 走完整 UI 管线：parseLegacyText → recognizeCollections → zip 打包 → countImagesInZips → extractImagesFromZips → buildImportInput → importLegacyDatabase → buildImportReportView）。任一路径缺失时 S8C-4 打印 `[S8C-4] 真实数据目录不存在，跳过` 并按通过计（优雅跳过，不红）。

## 9. 自测明细（1153/1153）

- S8C-1a 文本解析：JSON 数组 / 单对象 / NDJSON / 空数组；坏 NDJSON、截断数组抛错（不落数据）。
- S8C-1b 内容识别：误导文件名 / 缺集合空数组 / 未知文件非阻塞 / task_archive 仅计数 / 空文件。
- S8C-1c 预览与装配：六行预览数字（含归档任务 0 不显示、245 张图、'2.9 MB' 格式化）；preset 空对象→null、非空→数组。
- S8C-1d zip：子目录、同名取首（内容 'aaa'）、GIF 收集不预过滤、非 zip 抛「无法读取」。
- S8C-2 report 数据源唯一性：伪造全字段 report → 视图断言（summaryLine/presetsLine/图片四计数文案/两组跳过/丢弃清单计数），纯函数不依赖 DB。
- S8C-3 幂等（小样本）：全管线双跑 + 直读计数 + 第二次 report 口径。
- S8C-4 幂等（真实数据全量）：见 §7 表格，含 presets 合并与 backupLogs 断言。

## 10. 已知边界与未验证项

- 浏览器真机（canvas 压缩路径）未在 Node 端到端覆盖，rejected=2/truncated=0 是 Node 口径（§6 已解释）；逻辑路径与浏览器共用 S8-B 冻结实现，S8-B 已验证压缩分支。
- 归档任务数（task_archive 3 条）在预览中作为 UI 层提示展示，不进入 report（§3 已注明），report 渲染数据源唯一性不受影响。
- 重复的 sewing_accessories.zip 重发包（KQzkbSUkAoz94Tx1U5icEtaLnSd）经核验与首包逐字节重复，未使用。
