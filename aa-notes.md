# AA-A 数据迁移修正与排查 · 交接说明

任务：sewing-space 验收反馈 AA 系第 1 棒（迁移1 口径修正 / 迁移2 补漏 / 迁移3 排查）。
基线：Z-A 包（含 Y 系迁移代码）。本棒改动文件仅 3 个：
`src/db/migrations/legacy.ts`（迁移1/2）、`src/services/statsService.ts`（迁移3）、`scripts/test-services.ts`（断言更新与新增）。
`scripts/verify-aa-a-local.ts` 为本机临时诊断脚本（不随包分发，打包已剔除）。

---

## 迁移1【口径修正】成衣关联物料的库存差异改记「成衣消耗」

**复现**：Y-A 迁移后，「杏色波点网纱」等被成衣关联的面料，其库存差异全部落成「迁移时数据对齐」流水（source=`legacy:align:*`、createdAt=导入时刻）。真实数据 64 条对齐流水中大量为成衣关联物料（例：漂白色织带 purchased 20 − quantity 14.95 = 5.05 全记对齐，而它实际被 3 件成衣消耗 0.25+4.6+0.2=5.05）。

**根因**：`legacy.ts` 在 fabric/accessory 行映射时**即时**判定「无 usageRecords 且差额>0 → 补对齐」，此刻 garment 表尚未映射，无从得知物料是否被成衣关联。

**修复**（三处，均在 `legacy.ts`）：
1. fabric/accessory 行映射改为登记 `pendingAlign` 候选（携带 purchased / hasUsageRecords / urSum），延迟到 garment 表映射完成后统一裁决；
2. `mapGarmentRow` 对每个可解析的 **(成衣, 物料) 关联对**，在既有快照行之外补写一条成衣消耗流水：`kind=consume`、`source=garment:{成衣新id}`、`garmentId=成衣新id`、`quantity=记录用量`、`createdAt=完工时间`（date-only → 当日 00:00 UTC；未完工成衣落导入时刻）、`note=旧数据导入：{成衣名} 成衣消耗`。与正常流程 `materialService.consumeOnAssociate` 完全同形态，通过 `UsageSourceSchema` 与 §3.5 硬约束 3 组合校验（曾评估 `legacy:garment:` 前缀方案，被 schema「source 非 garment:{id} 形态时 garmentId 必须空」否决，故采用正常流程形态）。**逐对记账**的原因：同一物料可被多件成衣关联（漂白色织带 3 件），必须逐对才能各自按完工时间落账；
3. 新增 `resolvePendingAlignments`（garment 映射后、preset 前调用）：**三条件同时成立**才补「迁移时数据对齐」——①未被任何成衣关联；②旧程序无已迁移损耗记录；③购买量−库存>0。同时做残留诊断：关联物料若「库存差额 ≠ Σ关联用量+Σ旧损耗」、或未关联有损耗物料「库存差额 ≠ Σ旧损耗」，push warning（不造数）。

**验证**（真实数据全量，本机 7 表 NDJSON 实跑，`verify-aa-a-local.ts`）：
- 成衣消耗流水 **109 条**（面料 43 条 Σ52.30、辅料 66 条 Σ65.08），全部挂在 34 件 done 成衣上（1 件 doing 无关联）；
- 对齐流水 **64 → 13**（fabric 7 条 Σ12.80：卡其里衬 2 / 淡黄格子 0.5 / 杏色珠光纱 3 / 米白里衬 0.8 / 网纱胶印小花 3 / 浅灰速干 3 / 浅灰四面弹 0.5；tools 6 条；accessory 0 条）；
- usageLogs 总数 102 → **160**；
- 关联物料恒等式：**56/56** 成立（库存差额 = Σ关联成衣用量 + Σ旧损耗，误差 <0.005）；
- 幂等：同包二跑 materials 0 / usageLogs 0 / alignmentLogs 0，库中 221/35/160 不变（新流水挂父物料行 mapped.usageLogs，随 sourceRef 判重跳过，§2.3 规则 3 机制不变，`import.ts` 零改动）。

## 迁移2【补漏】零库存工具对齐流水复核

**复现与对账**（tools 40 行逐行核）：

| 工具 | purchased | quantity | 旧损耗 | Y-A 是否有对齐流水 |
|---|---|---|---|---|
| 锁边压脚 | 1 | 0 | 无 | 有（1）✓ |
| 强力粘胶滚筒 | 1 | 0 | 无 | 有（1）✓ |
| 服装包装袋 | 10 | 0 | 无 | 有（10）✓ |
| 14号风琴针 | 5 | 0 | 无 | 有（5）✓ |
| A4文件袋 ×2 行 | 0 | 0 | 无 | 无（purchased=0 无差额可记，规则正确不补） |
| 彩色高温消失笔 | 75 | 45 | 无 | 有（30）——库存非零但有差额 |
| 刻度贴纸 | 24 | 23 | 无 | 有（1）——同上 |

**结论**：用户实测「6 个无库存工具」= 上表前 6 行；其中有差额的 4 个在 Y-A 规则下**已有**对齐流水，2 个 A4文件袋 purchased=0 无差额。**迁移2 无需改代码**（Y-A 规则本身正确），本棒将三条件口径固化进 `pushAlignmentLog` 注释，并在 test-services.ts 新增 S8A_TOOL_ZERO fixture 断言：零库存工具（购 5 库 0 无损耗）补对齐流水 5、purchased=0 行不补。

## 迁移3【排查】面料统计三数不自洽（173.25 − 52.3 ≠ 89.09，差 31.86）

**复现**：Y-A 迁移后全时段面料统计：总购买 173.25m、消耗 52.3m、库存 89.09m。173.25 − 52.3 = 120.95 ≠ 89.09。

**排查过程**（候选方向逐一验证）：
1. **单位换算**：71 行面料 unit 恒「米」，无英寸/码字段 → 排除；
2. **购买量聚合**：`sumFabricInbound` Σ initialQuantity = 173.25，与用户小程序一致 → 正确；
3. **库存**：Σ quantity = 89.09，用户已知正确 → 正确；
4. **消耗统计口径（根因）**：PRD §8.15 消耗为双轴——快照轴① `sumSnapshotFabricUsed` = **52.30（恰为用户所见 52.3）**；流水轴② `sumConsumeLogs` 原实现 `if (isLegacy(l)) continue;` 把所有 `legacy:*` 前缀流水排除。而 Y-A 迁移把全部历史扣减写成 legacy source（旧损耗 18 条 fabric 流水 + fabric 对齐流水），**轴② 贡献被清零**，消耗只剩快照轴 52.30。差值 31.86 = 流水轴应计 32.86（旧损耗 20.06 + AA-A 对齐 12.80）− 波点绵绸旧库超扣 1.00（见下残差解释）。

**修复**（`statsService.ts` `sumConsumeLogs`）：删除 `isLegacy` 排除（保留 `garmentId !== ''` 排除——V-E Q8 双轴防重复，成衣消耗已由快照轴①计一次）。修复后消耗 = 快照 52.30 + 流水轴 32.86（旧损耗 20.06 + AA-A 对齐 12.80）= **85.16**。

**残差书面解释与证据**：173.25 − 85.16 = 88.09 ≠ 89.09，仍差 **1.00**。逐布恒等式（initial − Σ流水 − Σ快照 − quantity）定位：唯一残差面料 = **波点绵绸**（`fabric:idmt4ljtbfmr9i`，purchased=3.0、stock=2.0、旧损耗记录 Σ=2.0）——**原小程序数据自身超扣 1.0**（3 − 2 记录损耗 = 1，但库存记 2）。即该 1 米差异在旧库中就存在，不是迁移引入。处置：不造数补流水，保留残差并出迁移 warning「fabric:idmt4ljtbfmr9i 旧损耗合计（2）与库存差额（1）不一致，差 -1（旧库记录自身不平，AA-A）」为证。
另发现 2 条辅料同性质旧库不平（`accessory:idmt84jwl0r7fz`、`accessory:idmt85620r38ex` 各差 −1），不影响面料三数，同样只记 warning。

**验证**（本机全量落库后）：三数 = 总购买 **173.25** / 消耗 **85.16**（快照 52.30 + 流水 32.86）/ 库存 **89.09**；残差 1.00 全额归属波点绵绸，有 warning 为证。`getStatsForPeriod` 与 `getStockpileIndex` 均经 `sumConsumeLogs` 自动生效。

---

## 同类问题候选（报主 AD，本棒未改）

1. **Top-N 物料消耗榜仍排除 legacy 流水**：`statsService.getNetConsumptionTopFabric`（isLegacy 保留处）迁移后不含历史消耗。与迁移3 同源，建议后续棒次统一口径。
2. **DM §7.1 五「legacy 一律排除出统计」与 AA-A 新口径冲突**：本棒按代码新口径执行（见下节口径变更记录），三文档按铁律未改。
3. **2 条辅料旧库不平**（各 −1）：与波点绵绸同性质，均只记 warning 不补数；若用户在原小程序修正过账，可在导出数据中先行修正再迁移。
4. **pattern 表无对齐/消耗概念**、task_archive 不迁移：无同类问题。

## 口径变更记录（与 PRD/DM 的出入）

- 「迁移时数据对齐」登记条件：Y-A「无旧损耗记录 ∧ 差额>0」→ AA-A「**未被成衣关联** ∧ 无旧损耗记录 ∧ 差额>0」三条件（任务书原文口径）。
- 成衣关联物料差异记账：Y-A 对齐流水（导入时刻、legacy:align: source）→ AA-A 成衣消耗流水（**完工时间**、`garment:{id}` source、随父物料行幂等）。
- 消耗统计轴②：DM §7.1 五「legacy 一律排除」→ AA-A 纳入 `legacy:*`（保留 garment 来源排除防双轴重复）。涉及 `sumConsumeLogs` 及其派生（`getStatsForPeriod.fabricConsumed` / 热力图 / `getStockpileIndex`）。
- 库存恒等式（DM §5.6 五，S4A5）仍按「非 legacy 流水」口径——手工行断言，迁移数据不经过该路径，不受影响，未动。

## 测试基线与验证证据

- 自测：`npm run test:services` **1349/1349 全绿**（Z-A 基线 1316 条，只增不减；净增 33 条：S8A 迁移1/2 流水+warning 断言、GMIX 成衣结构断言、自洽恒等式断言、S8B e2e garment:109 断言、S5A3 数字更新）。
- S5A3 统计对账更新：legacy 流水计入消耗轴（expectedLog 1→51、consumed 5.5→56.5、net 12.5→−38.5），garment 来源排除与范围外排除断言不变。
- 真实数据全量（本机、images:[]）：materials 221 / garments 35 / usageLogs 160 / alignmentLogs 13；source 分布 legacy:fabric 18 / legacy:accessory 20 / legacy:align 13 / garment: 109；幂等二跑零翻倍；三数 173.25 / 85.16 / 89.09。
- TypeScript `tsc --noEmit` 与 `eslint`（改动三文件）零错误零警告。

## 未验证项

- **S8B-6 / S8C-4 真实数据 e2e 条件段**（需 `../legacy_data` + `../imgs` 245 张图片同置）：本机无图片包不可复现（Y 系已知口径，75 条不算回归）。其断言数字已按本机同数据全量实跑结果更新（usageLogs 102→160、alignmentLogs 64→13、validate total 358→416、source 分布 18/20/13 + garment 109）；图片相关断言未动。待有图片包的环境复验一轮。
- UI 浏览器端到端导入流程未跑（本机无浏览器验证环境）；映射层与入库层均以 fake-indexeddb 全链路覆盖。
