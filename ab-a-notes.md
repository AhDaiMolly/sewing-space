# AB-A 交付说明（纸样「被引用成衣」字段）

- 棒次：AB-A（sewing-space 新需求 AB 系第 1 棒）
- 输入基线：AA-F 交付的 sewing-space-aa-f.zip（file-token `UpJbZoiio27DNxPAfUc0GcZnjd`，基线测试 1515/1515）
- 用户真实数据包：JSON 包 file-token `UfW8bw0XGogxvjxInKycYaPcnnt`（7 个 NDJSON，其中 6 个为迁移六源表：fabric 71 / accessory 65 / tools 40 / pattern 45 / garment 35 / preset 1；task 3 条不属于迁移六源，按既有口径不导入）
- 改动范围：严格只做本棒 4 点需求，共 8 个源文件修改 + test-services.ts 新增断言段（ABA-0~ABA-6）；与基线 `diff -rq` 核对无越界改动
- 测试结果：**1561 / 1561 全绿**（基线 1515，净增 46 条断言，只增不减）；`tsc -b` 退出码 0；`eslint --max-warnings 0` 0 警告；`npm run build` 成功（PWA precache 19 entries）；`npm run schema:check` 通过

## 一、复现（动手前现状确认，铁律 1）

对基线 AA-F 包逐项核验，四点需求全部缺失：

1. 全库 `grep linkedGarment` 仅命中 DoneTaskDetail.tsx 的无关局部变量 `linkedGarmentId`（任务→成衣绑定展示），Material 无 `linkedGarmentIds` 字段（src/db/types.ts）。
2. 迁移未写入：legacy.ts `mapGarmentRow` 仅做正向重映射（`patternIdMap.get(oldPat)` 命中后写 `g.patternId`），无任何 纸样→成衣 反向索引逻辑；`mapPatternRow` 不初始化关联字段。
3. 手动新建/编辑纸样无关联入口：MaterialForm.tsx 无「关联成衣」输入区块；materialService 的 create/update 不处理该字段。
4. 任务创建自动关联存在既有 bug：TaskFormSheet.tsx 勾选「生成成衣」分支硬编码 `patternId: ''`（第 252 行），未透传表单所选 `form.patternId`——即使做了纸样侧反建，任务生成的成衣也不会关联纸样。
5. 详情无展示：MaterialDetail.tsx 仅有删除确认用的 `usedByGarments` 计数（按 `g.patternId === material.id` 实时过滤），无「被引用成衣」展示区块。
6. 基线测试 1515/1515 全绿（`npm run test:services`，即本棒口径的「npm test」——package.json 无 `test` 脚本，与基线逐字一致未增改）。

## 二、设计口径

1. **字段形态**：`Material.linkedGarmentIds?: string[]`（可选，元素为 garments.id）。**纸样 ↔ 成衣 = 1 : N**：一个纸样可被多件成衣引用，linkedGarmentIds 为数组去重追加；成衣侧单值 `patternId` 维持不变。
2. **可选字段的存量兼容（铁律 4）**：与 `purchasePrice` 等既有可选字段同口径——TS 接口可选 + `MaterialRowSchema` 增 `z.array(nanoId12).optional()`（`.strict()` 下缺键可通过 safeParse）。旧备份/旧数据无该键 = 未关联，读侧一律 `?? []` 兜底；新写入路径（createMaterial / 迁移反建 / 自动关联）恒写数组（空也写 `[]`）。
3. **引用强度分写读两侧**：写侧强校验（create/update 纸样时逐个确认成衣存在，中文报错「被引用成衣中包含不存在或已删除的成衣」）；读侧弱引用容错（悬空 id——成衣后续被删——映射名称时跳过，不报错）。成衣删除时是否反向同步清理记入「同类问题候选」。
4. **迁移反建（需求 1）**：落在 legacy.ts `mapGarmentRow` 的 patternId 重映射处——映射成功即把成衣新 id 追加进 `ctx.materialById.get(mapped)` 纸样行的 linkedGarmentIds（去重）。无 patternId（缺键/空串）与悬空（旧 id 翻不到）均不写入，并分别记 warning（悬空同时保留原 §9.8.5 danglingRefs 口径）。**幂等**：依赖既有 §9.10 sourceRef 判重——二跑时纸样/成衣全部跳过、keptMaterials 为空，天然零翻倍（已实测）。
5. **手动关联（需求 2/4）**：MaterialForm 纸样类型下渲染「被引用成衣」chips 多选（候选 = 成衣库全量，可不选，成衣库为空有占位文案）；提交时 `linkedGarmentIds: form.type === 'pattern' ? 所选 : []`；非纸样由 `normalizeTypeFields` 归位 `[]`（与 size/rating 等归位同口径）。编辑沿用 editSyncKey（id+updatedAt）同步回显。
6. **任务创建自动关联（需求 3）**：两层修复——① TaskFormSheet 生成成衣分支透传 `patternId: form.patternId`（修硬编码空串 bug）；② `createGarmentWithMaterials` 在同一事务内，成衣行写入后若 `patternId` 非空则把成衣 id 追加进纸样 linkedGarmentIds（去重；纸样行不存在则跳过不报错）。任务开始/完工（setTaskStatus/handleTaskComplete）只改成衣状态、不新建成衣，无需另做联动。
7. **展示**：MaterialDetail 纸样类型下新增「被引用成衣」区块（位于购入信息与推荐布料之间），按 linkedGarmentIds 顺序映射成衣名称，可点击跳成衣详情；空列表正常渲染「暂无关联成衣」空态文案，不报错。

## 三、修复清单（按文件）

| 文件 | 改动 |
| --- | --- |
| src/db/types.ts | Material 增可选 `linkedGarmentIds?: string[]`（含口径注释） |
| src/db/schemas.ts | MaterialRowSchema 增 `z.array(nanoId12).optional()`（存量兼容关键） |
| src/db/migrations/legacy.ts | mapGarmentRow：反建索引（映射成功追加去重）+ 无 patternId / 悬空两条 warning（悬空保留 danglingRefs 原口径） |
| src/services/materialService.ts | 新增 `assertLinkedGarmentIds`（去重 + 成衣存在校验）；createMaterial / updateMaterial 接入；normalizeTypeFields 非纸样归位 `[]` |
| src/services/garmentService.ts | createGarmentWithMaterials 同事务反写纸样 linkedGarmentIds（去重、悬空容错） |
| src/components/TaskFormSheet.tsx | 生成成衣分支 `patternId: ''` → `patternId: form.patternId` |
| src/pages/MaterialForm.tsx | 「被引用成衣」chips 多选区块（仅纸样）+ 状态/回显/提交透传 |
| src/pages/MaterialDetail.tsx | 「被引用成衣」展示区块（名称列表 + 跳转 + 空态「暂无关联成衣」+ `?? []` 兜底 + 悬空跳过） |
| scripts/test-services.ts | 新增 ABA-0~ABA-6 断言段（46 条，只增不减） |

## 四、验证

### 4.1 真实数据全量实跑迁移（验收第 1 条）

以沙箱内临时脚本（实跑后已删除，不入包）用 fake-indexeddb 走 `importLegacyDatabase` 全链路导入六源表：

- garment 总数 35：**带 patternId 且纸样存在 32 件，全部反建命中**（关联总条数 32，双向一致 32/32——每件成衣的 patternId 均能在对应纸样的 linkedGarmentIds 中找到自己）；**patternId 为空/缺失 3 件，跳过不写入并记 warning 3 条**；**悬空 0 件**（该数据包无悬空引用，悬空路径由测试断言覆盖）。
- 纸样总数 45（全部入库）：**30 个纸样获得关联**；1:N 场景实测：`1023半裙`×2、`166拼色插肩袖T恤`×2，其余 28 个各 1 件。
- 一跑 ImportReport：materials 221 / garments 35 / usageLogs 160 / skipped 0；warning 共 13 条（其中反建相关 3 条均为「无 patternId」）。
- **幂等二跑**：materials 新增 0 / garments 新增 0 / skipped 256（221+35 全部 sourceRef 判重跳过）；全部纸样 linkedGarmentIds 前后快照 JSON 逐字节一致——**零翻倍**。

### 4.2 测试（铁律 5）

`npm run test:services`：**1561 / 1561 全绿** = 基线 1515 + AB-A 新增 46，只增不减。新增断言（ABA-0~ABA-6，随 test-services.ts 走）覆盖任务要求的全部场景：

- ABA-0 兼容：types/schemas 源码级 + 新建不选恒 `[]` + 旧备份行（无键）safeParse 通过 + 非 nanoid 元素拒绝；
- ABA-1 迁移反建：1:N 同纸样两件按序反建 / 无引用纸样不写键 / 无 patternId warning / 悬空 warning + danglingRefs / 正向重映射不回归；
- ABA-2 幂等二跑：全链路 sourceRef 判重 → skipped 3、linkedGarmentIds 快照零翻倍；
- ABA-3 手动关联增删：新建多选 / 重复 id 去重 / 不存在成衣中文报错（新建+编辑）/ 编辑增、删、清空 / patch 无键现值保留 / 非纸样归位 `[]`；
- ABA-4 任务创建自动关联：引用纸样自动追加 / 去重追加 / 无纸样不写 / 悬空容错不报错 + TaskFormSheet 源码级（透传 form.patternId、无 `patternId: ''` 残留）；
- ABA-5 展示源码级：详情区块 + 空态「暂无关联成衣」+ 读侧 `?? []` 兜底 + 表单多选与提交透传；
- ABA-6 备份/恢复兼容：新式备份（带字段）恢复后字段保留；旧式备份（无该键）恢复成功、键缺省不报错（整表替换后行数正确）。

### 4.3 构建与静态检查

`tsc -b` 退出码 0；`eslint . --max-warnings 0` 0 警告；`npm run build` 成功（PWA precache 19 entries）；`npm run schema:check` 通过；`package.json` 与基线逐字一致（diff 验证，未增改任何 script）。

## 五、同类问题候选（未改，报主 AD）

1. **成衣删除时反向同步**：删除成衣（deleteGarmentWithRestore）后，其 id 残留在纸样 linkedGarmentIds 中（读侧跳过不报错、详情计数不误显，但数组里留有悬空 id；恢复成衣后关联自动重新可见）。是否删除时同步清理待定。
2. **成衣编辑改 patternId 时反向同步**：updateGarmentWithMaterials 透传 patternId 修改后，旧纸样的 linkedGarmentIds 不会自动移除、新纸样不会自动追加（本棒严格只做「创建」路径的自动关联）。成衣侧 patternId 变更的反向同步待定。
3. **成衣侧展示所引用纸样**：成衣详情页是否要展示其引用的纸样（正向引用展示），本棒未做。
4. **TaskRowSchema 缺 patternId 字段**（既有隐患，与本棒无关但同域）：types.ts 的 Task 接口有 patternId（V-C 加入），但 schemas.ts 的 TaskRowSchema 未含该键——`.strict()` 下含 patternId 的 Task 行理论上过不了备份第 8 道逐行 safeParse。既有测试全绿说明现行写入路径未触发（备份导出的 Task 行可能同样缺该键或该校验对 tasks 有旁路），建议后续棒次核实。
5. **迁移中 garment 被 Zod 拒收/判重跳过时的关联残留**：映射阶段反建先于 import.ts 第 3 步判重/Zod 校验——若某成衣行在导入时被丢弃而其纸样是新增行，纸样 linkedGarmentIds 会留有该丢弃成衣的悬空 id（读侧跳过，不报错）。真实数据无此形态（skipped 0），构造场景未单测。

## 六、口径变更记录

1. **notes 文件命名**：任务原文要求交付 `ab-notes.md`，但基线包内已存在 AA 系 AA-B 棒的 `ab-notes.md`（AA 系命名 aa/ab/ac/ad/ae/af-notes）。为不覆盖历史棒次记录，本棒 notes 命名 **`ab-a-notes.md`**（与交付包 sewing-space-ab-a.zip 同构），AA-B 的 ab-notes.md 原样保留在包内。
2. **自动关联入口口径**：需求 3 原文点名「任务创建产出的成衣」，但任务生成成衣与手动新建成衣共用 `createGarmentWithMaterials` 单一入口，反向索引落在该入口——**手动新建成衣引用纸样时同样自动关联**（含 V-C 成衣Q3 手工直达 completed 路径）。与「一件成衣引用一个纸样」的关系口径一致，未缩小也未扩大数据语义。
3. **「npm test」实际命令**：package.json 无 `test` 脚本（与基线逐字一致、不可增改），本棒及基线的「npm test」即 `npm run test:services`（tsx scripts/test-services.ts）。
4. **写侧强校验为本棒补充口径**：任务原文未规定服务层对 linkedGarmentIds 的校验强度；本棒按 garments.materialIds 强引用先例做写侧存在性校验（中文报错），读侧弱引用容错（成衣删除后的悬空跳过）。
5. 未改 PRD/数据模型/架构三份文档（包内无这三份文档，本棒也未触碰任何文档）。

## 七、测试基线数

- 基线（AA-F 交付）：1515 条断言，全绿复现于动手前。
- 本棒（AB-A）：**1561 条 = 1515 + 新增 46**，全绿；只增不减（基线断言零改动——唯一相关触碰为新增独立 ABA 段，未修改任何既有断言）。

## 八、未验证项

1. 真机移动端浏览器（iOS Safari / Android Chrome）实测未做——chips 多选、详情区块均为既有组件样式类的复用（chip / detail-section），未新增自定义 CSS；桌面 Chromium headless 构建产物已验证可生成。
2. GitHub Pages 线上部署未实测（本地 build 通过，部署配置 .github/workflows/deploy.yml 未改动）。
3. 浏览器 UI 交互链路（点选 chips → 保存 → 详情展示）以源码级断言 + 服务层数据链路断言覆盖，未跑端到端 UI 自动化（工程内无 UI 测试框架，与历棒口径一致）。
4. 迁移反建在「成衣行被 Zod 拒收而纸样新增」极端形态下的悬空残留（见同类问题候选 5）未构造单测——真实数据包 skipped 0，不触发。
