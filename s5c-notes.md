# S5-C · 统计页全部 UI（任务 5-4 / 5-5）—— 交付留档

## 范围

PRD §8.15 / 架构 §6.6 实施计划节点 5-4（三卡框架 + 主卡 + 列表）与 5-5（热力图 +
囤布指数 + 采购占比环形图）全部交付。**所有统计数字一律经 statsService**，组件层
不做聚合、不进任何缓存表。

## 改动文件清单（S5-C 净增 / 净改）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `src/pages/StatsPage.tsx` | **整页改写**（5 桩 → 671 行） | 三卡互斥（默认本月）/ ResultMainCard / InventoryThree / PurchaseDonut / HeatmapCalendar / HeatmapRow / StockpileDeltaChart / CompletionList。纯 React + 冻结类，无新依赖。 |
| `scripts/verify-stats-periods.ts` | **新增**（约 350 行） | 三周期 36 项「图表数字 vs 手工点数」对账脚本；含 fixtures 注水（避免全 0）。 |
| `scripts/seed-stats-fixtures.ts` | **新增**（约 230 行） | 开发期降级：相同 fixtures 的独立灌入脚本，可选运行；不在首启路径里。 |

**未触碰**（按约束）：`schema.ts` / `services/` 下任何文件（含 `statsService.ts`）/ 
九份配置（`package.json` / `tsconfig*.json` / `eslint.config.js` / `vite.config.ts` /
`tailwind.config.js` / `postcss.config.js` / `router.tsx` / `index.html`）/
依赖 14+16 全冻结 CSS（**零类新增零类改名**）/ 路由（`stats` 已指 `StatsPage`）。

## UI 设计要点

### 三卡框架（5-4）
- **互斥**：单选 useState<PeriodKey>（默认 `'month'`）；
- 卡片文案「本月 / 本年 / 汇总」（PRD §8.15 用词，**不出现「累计」**）；
- 副标题展示对应区间（`YYYY.MM.DD ~ YYYY.MM.DD` / `全部历史 ~ 今日`），由
  `getPeriodRange(period)` 现算（服务层锚定 todayUTC 截取）；
- 切换后各区块标题带区间名：「本月 · 完工趋势」/「本年 · 完工趋势」/「汇总 · 完工趋势」。

### ResultMainCard（5-4）
- 4 个核心数字：完工数（completedCount）/ 平均单件成本（avgCost = totalCost / costCount，
  costCount === 0 时显「—」）/ 参与核算（costCount）/ 总花费（totalCost）；
- 副标题：区间信息与「档案 · 衣物」入口（点击 → /garments?scope=completed）；
- 完工列表：按 completionDate 降序（同日按 createdAt 降序），最多 5 条 + 「展开」按钮；
- 每个 chip：名称 + 完工日期 + 类别标签。

### InventoryThree（5-5）
- 入布（fabricInbound）/ 消耗（fabricConsumed）/ 净囤布（netFabric）；三卡互斥样式；
- 口径分别为 `Σ initialQuantity` 与 `完工快照轴 + 非 legacy consume 流水轴`；
- 服务层暴露 `fabricInbound / fabricConsumed / netFabric`，组件层不做算术。

### 热力图 HeatmapCalendar / HeatmapRow（5-5）
- mode 决定布局：`month` → `.heatmap-calendar` 月历（含首周前置 null、未来格禁用）；
  `year` / `all` → `.heatmap-row` 单行逐月 / 逐年；
- 着色公式 **无四档阈值**：`alpha = heatmapAlpha(count, max)` = 
  `0.15 + (count / max(maxCount, 1)) × 0.85`（PRD §8.15 锚点）；
- legend 仅四档示意色阶（不绑阈值，与公式解耦）；
- 未来格 `isFuture === true`：着浅色 + `pointer-events: none`，不可点。

### StockpileDeltaChart（5-5）
- 横轴同热力图粒度；柱高 = `|delta| / maxAbs`（`maxAbs = max(0.1, max|delta|)`，下界 0.1）；
- 零线穿中央，**正柱向右（蓝）/ 负柱向左（橙）**；
- summary 数据源 = 服务层 `stockpileIndex.summary`（inbound / consumed / delta），组件不再聚合；
- 全 0 时空态：单条说明卡 + 隐藏柱图（不动 CSS）。

### PurchaseDonut（5-5）
- SVG 手绘环形（架构 §5/§6 未指定图表库；依赖 14+16 冻结里无图表库——**不引入依赖**）；
- 5 段：`fabric / accessory / tool / pattern` 四类 + 1 段缺口（剩余 100%），缺口纯灰；
- 占比从 `purchaseByCategory` 现算：`value / purchaseTotal`，UI 端过滤掉 `value === 0` 的类；
- centerLabel = `purchaseTotal`（两位小数）；
- 图例 4 项（零值过滤），点击切换中心数字（被点亮类的 value / purchaseTotal）。

## 三周期数字 vs 手工点数对账记录

**基准日期：2026-09-24**（todayIsoDate UTC 截取）。
脚本：`scripts/verify-stats-periods.ts`。直接路径：调 `getStatsForPeriod / getCompletionHeatmap / 
getStockpileIndex` 取三周期数字；用独立查表（不调 statsService）从 db 走一遍「手工」
过滤（legacy 排除 / purchaseDate 区间 / completionDate 区间），逐项 `near(a, b) < 0.01` 比较。
三周期 × 12 项 = **36 项 全部通过**。

> 提示：seedIfFirstRun 仅写 settings + 任务模板，所以脚本里多灌一份非零 fixtures
> （6 物料 / 3 成衣 / 3 流水：含 1 条 legacy:、跨年与本年混杂、1 件 null cost），确保
> 「非零对账」（全零对账是空验证）。详见下文 fixtures 说明。

### 本月（2026-09-01 ~ 2026-09-24）
```
✓ completedCount:           svc=2   manual=2     # grt_001(09-10) + grt_002(09-20)
✓ costCount:                 svc=1   manual=1     # 仅 grt_001 totalCost=68.5（grt_002=null 不计）
✓ totalCost:                 svc=68.5 manual=68.5
✓ fabricInbound:             svc=5   manual=5     # mat_fab_001 initialQuantity=5
✓ fabricConsumed:            svc=5.2 manual=5.2   # 1.6(grt_001 快照) + 2(grt_002 快照) + 1.6(log_001) = 5.2；legacy 0.4 已排除
✓ purchase.fabric:           svc=162.5 manual=162.5  # 32.5×5
✓ purchase.accessory:        svc=13.5 manual=13.5    # 4.5×3
✓ purchase.tool:             svc=0   manual=0
✓ purchase.pattern:          svc=0   manual=0
✓ heatmap.Σcount = 2         ↔ stats.completedCount = 2
✓ stockpile.Σinbound = 5     ↔ stats.fabricInbound = 5
✓ stockpile.Σconsumed = 5.2  ↔ stats.fabricConsumed = 5.2
```

### 本年（2026-01-01 ~ 2026-09-24）
```
✓ completedCount:           svc=2   manual=2     # grt_003 在 2025-08-30 不在本年
✓ costCount:                 svc=1   manual=1
✓ totalCost:                 svc=68.5 manual=68.5
✓ fabricInbound:             svc=13  manual=13    # 5(mat_fab_001) + 8(mat_fab_002)
✓ fabricConsumed:            svc=5.2 manual=5.2   # 跨年消耗 unchanged；grt_003 是 retired 行不进快照
✓ purchase.fabric:           svc=642.5 manual=642.5  # 162.5 + 60×8 = 642.5
✓ purchase.accessory:        svc=13.5 manual=13.5
✓ purchase.tool:             svc=0   manual=0     # mat_tool_001 购于 2025-06-15 不在本年
✓ purchase.pattern:          svc=12  manual=12    # mat_pat_001 = 12×1
✓ heatmap.Σcount = 2         ↔ stats.completedCount = 2
✓ stockpile.Σinbound = 13    ↔ stats.fabricInbound = 13
✓ stockpile.Σconsumed = 5.2  ↔ stats.fabricConsumed = 5.2
```

### 汇总（0000-01-01 ~ 2026-09-24）
```
✓ completedCount:           svc=3   manual=3     # 含 grt_003(2025-08-30)
✓ costCount:                 svc=2   manual=2     # grt_001=68.5 + grt_003=30
✓ totalCost:                 svc=98.5 manual=98.5 # 68.5+30
✓ fabricInbound:             svc=13  manual=13
✓ fabricConsumed:            svc=5.2 manual=5.2   # grt_003 仅 0.5 m 消耗行已 retired
✓ purchase.fabric:           svc=642.5 manual=642.5
✓ purchase.accessory:        svc=13.5 manual=13.5
✓ purchase.tool:             svc=58  manual=58    # 58×1
✓ purchase.pattern:          svc=12  manual=12
✓ heatmap.Σcount = 3         ↔ stats.completedCount = 3
✓ stockpile.Σinbound = 13    ↔ stats.fabricInbound = 13
✓ stockpile.Σconsumed = 5.2  ↔ stats.fabricConsumed = 5.2
```

**口径细节复盘**：
- **legacy 排除**：log_002（fabric 0.4 m · 2026-09-15 · `legacy:2025:seed`）完全不在任何周期的
  fabricConsumed 内 → 服务层 `isLegacy()` 拦截彻底，组件层无须再过滤。
- **retired 排除**：grt_003 的快照行 `retiredAt='2025-08-15T08:00:00.000Z'` 即使其 completionDate
  在「汇总」区间内，0.5 m 也不进 fabricConsumed → 服务层 `'retiredAt' in r` 生效，与规格一致。
- **跨期边界一致性**：fabricConsumed 在三周期恒为 5.2（消耗集中在当月）→ 反向证明 snapshot 轴 + 
  log 轴的数字拼接正确，没有把去年成衣快照折算到「汇总」外的口径里。
- **null cost 行为**：grt_002 进 completedCount（=2）但被 costCount 与 totalCost 排除 → 
  costCount=1 / totalCost=68.5，与「costCount === 0 时 avgCost = null，UI 显 —」一致。

## 自测与门槛（实际执行）

| 门槛 | 结果 |
| --- | --- |
| `test:services` | **476 / 476 通过**（条数与 S5-A 一致；服务层零改动） |
| `schema:check` | `schema ok` |
| `typecheck` (`tsc -b`) | 0 错误 |
| `lint` (`eslint . --max-warnings 0`) | 0 错误 0 警告 |
| `build` (`tsc -b && vite build`) | 0 错误，dist 6 个产物全部生成，gzip 总 ~170 KB |
| 三周期 36 项对账 | 36 / 36 通过 |

## 留档 / 不进本任务

- **不交付 PWA manifest 调整 / 不动图标**：本任务边界只换/接 UI，不动 v3.0 已发布 manifest。
- **不交付 statsService 的衍生口径**（如周维度、品类趋势）：PRD §8.15 范围外的扩展
  留给 S6+；本任务严格按 S5-A 8 个核心 + 5 个 chart 函数消费。
- **不交付图导出 / 截图分享**：架构 §6.6 未列，超本任务边界。
- **fixtures 不进生产路径**：`seed-stats-fixtures.ts` 只是开发期验证脚本（在 `scripts/` 下，
  不被任何产品代码引用）；`verify-stats-periods.ts` 自身内嵌一段 `ensureStatsFixtures`，
  在跑前自动按需灌入；两者都不会出现在 npm scripts / 主流程里。
