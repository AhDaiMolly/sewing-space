# V-D 交付说明（首页 + 全局修复）

任务：7690351284095814598（V-D）
基线：sewing-space-v-c.zip（V-C2 交付，token `VLNUbi8BkokGKcxaTQdcbkp2nRe`），test:services 基线 **1143**（V-C2 实报值，与本次自测一致）。
改动面：**仅 `src/pages/HomePage.tsx`**（与基线 diff -rq 全量核对，除新增本说明文件外零其它差异；package.json 与基线逐字节一致）。

自测结果：typecheck 0 错误；lint 0 警告；schema:check 通过；`npm run build` 通过（48.76s，PWA generateSW 13 entries 862.52 KiB）；test:services **1143/1143 全绿**（纯 UI 层改动，不涉服务层，条数与基线持平，只增不减）。

## 1. 五项逐项处置

| # | 问题 | 复现结论 | 处置 |
| --- | --- | --- | --- |
| 首页Q1 | 去掉「最近条目」栏位 | 可复现：基线首页确有「最近条目」段（S5-B 任务 5-3 增量，取最近 5 件成衣 ∪ 5 件物料按 createdAt 降序） | **已修**：整段移除，连同 RecentItem 类型 / fmtRecentCreatedAt / recentItemLabel 辅助函数与 recentGarments / recentMaterials 两条 useLiveQuery 一并删除（无死代码残留）。间距处置见下「布局节奏」 |
| 首页Q2 | 问候「你好」下方小字「今天也来缝一会儿呀」去掉 | 可复现：`.home-greeting .user-name` 节点 | **已修**：节点删除；demo 问候行本就只有「你好，{name} ♡」单行，与 demo 对齐 |
| 首页Q3 | 首页点击任务条目应为浮层详情，而非新开页面跳转 | 可复现（根因定位见「口径变更记录 #1」）：基线首页快速添加「任务」按钮 `navigate('/workbench')` 整页跳转；对照物料 / 成衣快速添加均为 form-overlay 浮层表单 | **已修**：首页挂载 TaskFormSheet（工作台同款组件），点「任务」就地打开新建任务浮层；取消 / 点浮层外关闭后留在首页（hash 保持 `#/`）；保存后由 TaskFormSheet 既有逻辑显式落 /workbench——与物料表单保存后落 /materials 的既有模式一致 |
| 全局Q2 | 应用底部应有「首页、物料、成衣、工作台」四入口底部导航 | **不存在-已验证**（用户验收的应是旧包）：基线包 S7-C 已挂载 BottomNav 壳层且工作正常 | **未改代码**。核实页面与形态（vd-verify.mjs，390px 真机视口）：`/`、`/materials`、`/garments`、`/workbench` 四页均有 `nav.bottom-nav`，4 个 `.nav-item` 标签依次为「首页,物料,成衣,工作台」，高 98px、贴底渲染，当前页高亮；`/stats` 等非主路由按 PRD §5.3 隐藏规则不渲染（核实存在=false）。截图 01/02/03 |
| 全局Q1 | iOS 主屏图标 | —— | **已由 V-IOS 闭合**（任务 7690388556707089608，素材已到位由其承接处理）。本任务未触碰任何图标资源（public/icons/ 两文件与基线逐字节一致） |

## 2. 布局节奏说明（首页Q1 后半句「适当调整其余控件的上下间距和大小」）

移除「最近条目」后，首页结构与 demo 完全同构（问候行 → 总览卡 → 快速添加 → 备份提醒），四段间距即 demo 同款 CSS 节奏：问候行 padding-top 16 → 内容区 paddingTop 16 → overview-card margin-bottom 20 → quick-add-section margin-bottom 18。**未引入额外间距 hack**：实测截图（vd-shots/01-home.png）目视核对，控件无拥挤 / 无错位，demo 布局节奏即验收参考口径本身，故以「对齐 demo」为最终形态，不做主观发挥。

## 3. 口径变更记录（供主 AD 裁决留档，不改 PRD / 数据模型 / 架构三文档）

1. **「首页任务条目」指快速添加区「任务」按钮**：当前首页（含 demo）除快速添加三按钮外不存在其它任务入口，「最近条目」仅含成衣 / 物料。Q3 所指「与物料/成衣条目一样的浮层交互」落地为：快速添加三按钮统一浮层交互（物料 / 成衣本就打开 form-overlay 表单，任务改为打开 TaskFormSheet 浮层）。若用户原意是首页应展示任务列表条目（点击看浮层详情），则属新增首页功能，不在本棒 5 项修复范围，需另行立项。
2. **「最近条目」栏位回退**：S5-B 任务 5-3 增量（PRD §1.5 #11「最近物料/成衣」首页落地）被本次验收口径明确推翻，按「去掉」执行；PRD §8.1 未同步修改（按任务纪律不改三文档）。
3. **首页任务浮层保存后落点**：TaskFormSheet 保存 / 删除后显式 `navigate('/workbench')`（S2 P2-4 模式，工作台既有行为），从首页打开时亦然——对齐物料表单「保存后落 /materials」的既有模式，未为首页入口单做返回逻辑。

## 4. 真机回验（vd-verify.mjs，vite dev + chromium，390×844）

- 方式：项目根 `vd-verify.mjs`（createServer + playwright + 系统 chromium；**不随包**，同 repro-q1.mjs 口径），IndexedDB 预写 `onboarding_completed=true` 跳过向导。
- 结果：**14/14 PASS**——Q1「最近条目」/「暂无最近条目」文案均不在 body；Q2「今天也来缝一会儿呀」不在 body 且 `.user-name` 节点不存在、问候语仍在；Q3 点击「任务」出现 form-overlay=1 + form-sheet、URL 保持 `#/` 不跳页、取消后浮层关闭且仍在首页；全局Q2 四主路由 BottomNav 4 tab 齐全贴底、stats 页按隐藏规则无导航；全程控制台 0 error / 0 pageerror。
- 留证：`vd-shots/01-home.png`（改后首页全貌）、`02-home-bottomnav.png`、`03-workbench-bottomnav.png`、`04-task-form-sheet.png`（任务浮层叠加在首页上的形态）；机器可读结果 `vd-verify-result.json`。以上均在沙箱留档，不随交付包（口径同既往诊断脚本剔除项）。

## 5. 交付包口径核对（同 V-B / V-C）

- 必含：`index.html` ✅、`.github/workflows/deploy.yml` ✅、`scripts/test-services.ts` ✅ 随包。
- 条目集 = V-C 基线条目集 + `vd-notes.md`，剔除项为零（node_modules / dist / *.tsbuildinfo / vd-verify.mjs / vd-verify-result.json / vd-shots/ 均不打包）。
- `package.json` 与基线 zip 逐字节一致（diff 核对，本轮零依赖变更）。
- 全包 PAT grep 零命中（ghp_ / github_pat_ / gho_ / ghs_ / ghr_ / ghu_ / xoxb- / AKIA 等模式均无）。
