# Y-A 数据迁移修复说明（2026-09-29）

针对用户用真实迁移数据反馈的 4 个问题逐项处置。全部改动集中在 S8 迁移模块
（`src/db/migrations/legacy.ts` 为主，`import.ts` / `importReportView.ts` /
`WizardPage.tsx` / `garmentService.ts` 少量配合），验证用真实 NDJSON（7 集合 +
五图片包 245 文件）全量重跑。测试基线 1365 → **1391 全绿**（+26 条新断言，
含基线包 4 条 presets 过时断言修正，见文末）。

---

## 一、四项问题逐项处置

### 1. 成衣关联物料与成本未迁移【真 bug】

**根因**：旧版 `mapGarmentRow` 只搬 `materials` 字符串冗余副本，未把
`fabricAmounts` / `accessoryAmounts` 的旧 id → 新 id 映射成
`materialSnapshot` 快照行，导致成衣页看不到关联物料、totalCost 无法核算。

**修复**：
- 重写 `collectAmounts`：返回 `ResolvedAmount[] {newId, amount}`，兼容字典与
  数组两形态；refId 空串、idMap 翻不到（danglingRefs）、数量 ≤0 三类计
  dropped（droppedAmounts 语义同步收窄，见口径变更）。
- 同物料数量累加（round2）后构造 `GarmentMaterialSnapshot`：
  `priceSnapshot = unitPriceOf(mat)`、`subtotal = round2(priceSnapshot ×
  quantityUsed)`、活跃行 `deducted: true`；`materialIds` 恒等于活跃快照
  materialId 去重集（GarmentRowSchema superRefine 约束）。
- `totalCost` 核算条件：**有快照行 或 旧 patternId 非空（含悬空引用）** →
  `round2(Σ subtotal + patternPrice)`，patternPrice 悬空记 0；两者皆无才
  null。
- `unitPriceOf` 从 garmentService export（V-A Q16 口径唯一实现，迁移与
  成衣页手工行同一算法）。

**真实数据验证（35 件成衣）**：快照行合计 **109 行**、34 件有快照、dropped
引用 **0** 条、totalCost=null **0** 件、0 元 1 件（FL24-03 背带裙，patternId
悬空，按口径记 0 非 null）、>0 34 件。

**3 件人工核对样本（与旧 JSON 原值逐项对上）**：
- 紫色套装连衣裙 idmt7g4w0mjuxp：10 行快照，totalCost=**24.83**（盐缩棉布紫花
  15.0×1.0 + 白色15cm拉链 0.6×1.0 + 透明橡筋 0.02×0.8 + 1cm浅紫丝带
  0.77×0.74 + 雪白包边条 0.34×6.45 + 双层欧根纱花边 3.0×2.0 + 水溶胶带
  0.9×0.3 + 弹力后领条 0.44×0.4，其余 0 价物料行合计 0）；旧
  fabricAmounts 2 项 + accessoryAmounts 8 项全部迁成快照，数量一致。
- 蛋糕半裙 idmt4j7ec20073：1 行快照，粉条纹衬衫布 总价 69.99 / 购买 3.0 →
  单价 23.33 × 3.0 = totalCost=**69.99**（与旧布总价分毫不差）。
- 短款T恤 idmt41sv9u9nzj：5 行快照 totalCost=**12.85**（陶瓷白弹力冰感针织
  70/2→35×0.2=7.0、漂白色织带 0、陶瓷白螺纹 0、大D烫画 68/12→5.67×1.0、
  水溶胶带 18/20→0.9×0.2=0.18）。

另：有价纸样 2 件（3847情侣短袖 18.6、3115高腰阔腿工装裤 26.8）未被任何
成衣引用，其价格不计入任何 totalCost（符合口径）。

### 2. 工具备注自动写入需去除

**修复**：`mapToolsRow` 中 `m.notes = 'D-WH5 降级：purchased=0 未做除法'`
的自动备注已删除，notes 保持用户原值（无则空）；purchased=0 的行仅写
warning（`purchased=0，initialQuantity 落当前库存（D-WH5）`）进导入报告，
不污染数据行。全量排查 fabric / accessory / pattern / garment / preset 五个
集合的映射函数，**无其他同类自动写 notes 的代码路径**。

### 3. 纸样「是否使用」口径

**口径**：`rating ≠ 0` → used=1（已使用）；`rating = 0` 或缺失 → used=0。

**真实数据迁移前后对比（pattern 45 件）**：rating 分布
`{0:17, 1:4, 2:1, 3:2, 4:6, 5:15}` → 迁移后 **28 已使用 / 17 未使用**
（旧库无 used 字段，此为新口径首次落库；e2e 断言含 rating5→1、无
rating→0 双向样本）。

### 4. 库存对齐损耗记录

**规则**（fabric / accessory / tools 三表统一）：购买量 purchased > 0 且旧库
无 usageRecords 时，`diff = round2(purchased − 当前库存)`：
- diff > 0：补一条 consume 流水，`quantity=diff`、
  `source=legacy:align:{table}:{旧id}`、`note='迁移时数据对齐'`；
- diff < 0：不补，仅 warning（真实数据 **0 行**负差）；
- diff = 0 或已有损耗记录：不补。

**幂等**：对齐流水挂在 `mapped.usageLogs`，import.ts 第 3 步对父行
sourceRef 判重时其派生流水一并跳过——真实数据同包二跑 **256 实体全判重、
流水仍 102 条不翻倍**（e2e 断言 r2.usageLogs=0 且库中仍 102）。

**报告**：ImportReport 新增 `alignmentLogs` 单列计数，导入报告视图与向导页
展示「其中 N 条流水为迁移时库存对齐（购买量 − 当前库存）」。

**真实数据验证**：对齐流水 **64 条**（fabric 34 条 Σ62.5 / accessory 24 条
Σ64.43 / tools 6 条 Σ48.0），流水总数 38 → **102**；validate 阶段
total 294 → **358**（221+35+102）。

**8 件已有损耗记录、但 purchased−Σrecords≠库存 的残差物料**（按「已有损耗
记录不补」处理，残差留在旧库侧不再对齐，逐项列明）：

| 表 | 旧 id | 名称 | purchased | Σrecords | 库存 | 残差 |
| --- | --- | --- | --- | --- | --- | --- |
| fabric | idmt4hxzu5tt2j | 深杏棉锦速干 | 3.0 | 0.5 | 1.5 | +1.0 |
| fabric | idmt4jxjthuzgj | 碎花布组 | 5.0 | 0.5 | 3.0 | +1.5 |
| fabric | idmt4kl8jpt0sx | 小熊花布 | 2.0 | 1.55 | 0.35 | +0.1 |
| fabric | idmt4ljtbfmr9i | 波点绵绸 | 3.0 | 2.0 | 2.0 | −1.0 |
| accessory | idmt46i5yl3u2h | 0.8cm扁松紧 | 36.0 | 2.17 | 33.63 | +0.2 |
| accessory | idmt4io01rbjc4 | 豆豆花边1cm宽 | 10.0 | 1.3 | 8.25 | +0.45 |
| accessory | idmt84jwl0r7fz | 已使用拉链 | 1.0 | 2.0 | 0.0 | −1.0 |
| accessory | idmt85620r38ex | 辅棉 | 1.0 | 2.0 | 0.0 | −1.0 |

（负残差说明旧库记录本身超扣，正残差说明旧库曾手工改过库存；两方向均按
「已有损耗记录不补」口径维持原样，不猜不补。）

---

## 二、口径变更记录（不改 PRD / 数据模型 / 架构文档，以本记录为准）

1. **迁移行价格口径 = 总价直取**：fabric `totalPrice` / accessory
   `totalPrice` / tools `price` → `purchasePrice`（总价）；
   `initialQuantity` = 购买量（purchased>0 ? purchased : 当前库存）。与
   V-A Q16 手工行口径完全自洽（单价恒经 unitPriceOf 推导）。真实数据 71 行
   fabric 的 `totalPrice ÷ purchased` 与旧 price 单价差异 >0.005 的为 **0**
   行，换算安全。`purchased` 从 DROPPED_REASONS 移除、进 CONSUMED_KEYS。
2. **§9.5（成衣 materials 冗余副本直迁）裁决作废**：以 Y-A 快照迁移方案
   取代；materials 字符串副本不再迁移。
3. **droppedAmounts 语义收窄**：从「全部数量丢弃」改为「未迁成快照的条目」
   （悬空引用 / 坏元素 / 数量 ≤0）；真实数据为 0 条。
4. **totalCost 核算条件**：有快照行 或 旧 patternId 非空（含悬空）即核算，
   patternPrice 悬空记 0；两者皆无才 null。
5. **纸样 used 口径**：rating≠0=已使用（见问题 3）。
6. **库存对齐口径**（问题 4 全套规则）为新增口径。
7. **基线 presets 断言过时修正**（基线包遗留 4 条失败断言，本次一并修正）：
   V-A Q7 后 DEFAULT_PRESETS.fabricBrands 已为空数组，基线包断言仍按旧
   「默认 13 项」书写。真实数据 preset 三子键 patternBrands 11 / fabricBrands
   9 / accessoryTags 11，相对 DEFAULT 并集新增 **10 / 9 / 3**
   （patternBrands 重合「其他」1 项；fabricBrands DEFAULT 为空全量新增；
   accessoryTags 重合 8 项仅新增「烫画」「包边条」「螺纹」3 项）→ 合并后
   20 / 9 / 15。旧断言 10/8/3、13+8=21 为过时口径，已更新。

---

## 三、验证汇总

- typecheck 0 / lint 0 / schema:check 通过 / build 0
- `npm run test:services`：**1391 / 1391 全绿**（基线 1365，+26；只增不减）
- 真实数据 e2e（S8B-6 / S8C-4 双管线）：materials 221 / garments 35 /
  usageLogs 102（38+64）/ images imported 244 / missing 0 / rejected 2 /
  skipped 0 / danglingRefs 0；幂等二跑 256 全判重、库中 221/35/102/244
  全不翻倍、backupLogs 按事件计 2 条
- 精算脚本 `work/analyze_ya.py` 留档，全部数字可复算
