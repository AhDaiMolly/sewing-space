# S8-D 交付报告：全量 DoD 验收 + 真实数据端到端验证

日期：2026-09-27 · 基线：sewing-space-s8-c.zip（S8-C 交付）· 本包：sewing-space-s8-final.zip

## 一、发现并修复的阻断缺陷（1 项，小修直接修）

**缺陷**：真实图片 zip（Windows 工具打包）条目路径用反斜杠分隔（`sewing_fabrics\1787382970588-28508.jpg`），`legacyFiles.ts` 的 `basenameOf` 只按 `/` 切分，导致提取出的 `name` 带整段路径、与引用文件名全失配——浏览器真实环境 246 张图片全部「未找到」、images 表 0 行（Node 测试通过是因为自建 zip 用正斜杠，形成盲区）。

**修复**：`basenameOf` 改为 `entryPath.split(/[\\/]/)`（同时切分 `/` 与 `\`）。该文件为 UI 层文件解析（非冻结接口 legacy.ts/import.ts），属「小修直接修并记录」范围。修复后新增 11 条回归断言（见下）防止复发。

## 二、DoD 逐条验收矩阵（架构 §13.8）

| # | DoD 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | 选择旧 JSON 后导入可完成，界面展示 ImportReport 全部计数与清单，失败行给出旧 id 与原因 | ✅ 通过 | 浏览器真实 UI：上传 7 NDJSON + 5 zip → 预览 221/35/38/3/245/103.6KB → 确认导入 → 报告界面完整渲染（221/35/38、presets 8/10/3、图片四计数 246/0/0/0、已忽略 24 类字段、丢弃 109 条用量明细、6 条 warnings 含旧 id 与原因）。截图 s8d-shots/01–05 |
| 2 | 导入只 put 不 clear，旧数据并入现有库，现有数据不丢 | ✅ 通过 | import.ts 十步流程均为 bulkPut/put，无 clear（代码审查 + 1164 断言中 S8B/S8C 多条 put-only 断言）；导入前 seed 的 3 条任务模板保留（taskTemplates=3 直读） |
| 3 | presets 并集合并，只动三个子键，其余五个子键一个字不动 | ✅ 通过 | 实测新增 patternBrands 10 / fabricBrands 8 / accessoryTags 3；测试套件含「其余子键不动」断言（S8A 段） |
| 4 | import_completed 与 dirty_since_backup 两行写入成功；tasks 与 taskTemplates 不被触碰 | ✅ 通过 | 浏览器 IndexedDB 直读：import_completed="true"、dirty_since_backup="true"；tasks=0、taskTemplates=3（seed 原样保留） |
| 5 | 幂等：同一份 JSON 连导两次，结果同一份数据（不翻倍、不报错） | ✅ 通过 | Node 同管线（importLegacyDatabase）重放：第二遍 materials/garments/usageLogs/importedImages 全 0、skipped 256 条全为「sourceRef 已存在，跳过」；DB 直读 221/35/38/244 不翻倍。注：浏览器 UI 层向导在 onboarding 完成后不再提供导入入口（设计如此，再次导入走设置页数据管理），故 UI 层幂等以 Node 同管线重放为准 |
| 6 | 日期转换按 §9.6：`2026-08-22 18:15` 形态转带时区 ISO 串；旧记录时间取不到用导入时刻 | ✅ 通过 | 38 条流水 createdAt 全部 ISO 8601 带时区形态（s8d-evidence.json usageLogIsoOk）；45 条物料 purchaseDate 落导入当天并在 warnings 提示（§9.8 口径） |

**阻塞条件核对**：四门全过（tsc 0 错 / eslint 0 警告 / schema-check ok / vite build 成功 PWA precache 13 entries 859.78 KiB）；test:services **1164/1164 全绿**（S7 基线 1153，只增不减，+11 为本次新增 S8D 段）。

## 三、真实数据端到端全量数字（双口径）

**数据包**：7 个 NDJSON（fabric 71 / accessory 65 / tools 40 / pattern 45 / garment 35 / preset 1 / task_archive 3，内容特征识别，不看文件名）+ 五个图片包全齐（fabric 71 / accessory 63 / tools 39 / pattern 45 / garment 27，共 245 张，与集合引用逐张对上）。

| 指标 | Node 管线口径 | 浏览器真实 UI 口径 | 说明 |
|---|---|---|---|
| materials | 221 | 221 | 71+65+40+45 |
| garments | 35 | 35 | |
| usageLogs | 38 | 38 | fabric 18 + accessory 20 |
| 图片成功导入 | 244 | 246 | Node 无 canvas，2 张 >2MB PNG 透传拒收（rejected=2）；浏览器有 canvas，压缩后全部入库（246/0/0/0）。246=被引用的 legacyImageId 总数 |
| missingImages | 0 | 0 | 五包全齐，任务书补充资料 2 口径达成 |
| rejected / truncated | 2 / 0 | 0 / 0 | 同上环境差异 |
| presets 新增 | 10/8/3 | 10/8/3 | patternBrands/fabricBrands/accessoryTags |
| skipped | 0 | 0 | 无整行丢弃（首遍） |
| danglingRefs | 0 | 0 | |
| droppedFields | 24 类字段 | 报告界面「已忽略旧库的 24 类字段」 | |
| droppedAmounts | 56 条 | 报告「丢弃 109 条用量明细」（条目数 vs 字段计数口径） | |
| warnings | 5 条 | 6 条（界面含归档任务提示） | D-WH5 降级 ×2、流水类型推定、26 条辅料无 tag、45 条 purchaseDate 落导入当天、3 条归档任务未迁移 |
| backupLogs | 1 条 migration/success「导入旧数据：物料 221, 成衣 35, 跳过 0」 | 同 | |
| settings | import_completed=true、dirty_since_backup=true | 同 | |

**库存恒等式**：221 行 initialQuantity === quantity 全部成立；sourceRef 分布 `{oldTable}:{oldId}` 全表唯一。

**应用内渲染抽查（浏览器，390px 视口）**：物料页搜索「红格子棉布」命中、详情含数量 0.49、图片加载 1 张；成衣页「短款T恤」命中、详情图片加载 1 张；全程无 page error / console error。截图 s8d-shots/06–09。

**幂等终验（Node 同管线重放）**：第二遍全 0 导入、256 条 skipped 全判重、DB 直读 221/35/38/244 不翻倍、backupLogs 按事件计 2 条（数据不翻倍）。

## 四、S8D 新增回归测试（test-services.ts，+11 断言）

1. 反斜杠 zip 条目：计数、提取、basename 剥离（jpg/png MIME 推断）、name 无路径残留（5 条）
2. 真实五包原始 zip 直读（非自建 zip，防回归盲区）：条目计数 245、提取 245、磁盘基准名 245、提取名唯一 245、与磁盘基准全量吻合、无路径残留（6 条；数据包缺失时优雅跳过）

## 五、交付包内容

- 必含：`index.html`、`.github/workflows/deploy.yml`、`scripts/test-services.ts`（4980+ 行，1164 断言）、`s8d-report.md`（本文件）
- 剔除：node_modules / dist / *.tsbuildinfo / 联调验收诊断脚本（s8d-verify.ts、s8d-browser-e2e.mjs、s8d-shots/ 均不随包）
- 密钥扫描：全包 grep `github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}` 零命中
- package.json 与 S7 基线逐字 diff 一致（本次仅改 src/db/migrations/legacyFiles.ts 与 scripts/test-services.ts）

## 六、S1–S7 关键路径抽测

test:services 1164 断言含 S1–S7 全部既有测试段（备份恢复、usageLogs 流水、任务、模板、设置、图片 canvas、GitHub 备份等），全绿只增不减，无回退。

## 七、遗留说明

- 向导 step3（GitHub 备份）与 step4（安装引导）的交互属 S6/S1 范畴且已有测试覆盖；本次 e2e 走到 step2 完成后，路由解锁采用直接写入 onboarding_completed（等价向导末步「开始使用」效果）以验证导入后页面渲染。
- 浏览器 canvas 压缩使 2 张 >2MB PNG 在浏览器口径全部入库（imageMimeHistogram：246 行全 image/jpeg）——与 Node 透传口径 rejected=2 的差异为环境能力差异，非缺陷。
