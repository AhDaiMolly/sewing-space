# X-A 棒验收记录：桌面端谷歌浏览器适配（用户反馈：页面显示不全）

基线：sewing-space-w-c.zip（file-token CLNfbpaz6oyaXVxVACrcQ8U1ntb），自测基线 **1274** 条全绿（本棒复跑核实）。
本棒改动文件（对基线逐字节 diff 核实，4 改 0 删）：

- `M src/App.tsx` — 移除运行时重复渲染的 #desktop-shell/#phone-frame/#root 三层包裹（主修复）
- `M src/styles/styles.css` — 桌面媒体查询内 #phone-frame transform: translateZ(0)（fixed 后代包含块）；completion-wizard max-height 改 min(85vh, 100%)
- `M src/pages/TemplateSettings.tsx` — 模板表单 maxHeight 90vh → 90%（壳内基准）
- `M scripts/test-services.ts` — 新增 X-A 源码级自测段 7 条

`package.json` 与基线**逐字节一致**（sha256 4ddd08e2…42205 对比核实）；包内其余全部文件与基线逐字节一致（cmp 全量核对零差异）。PAT grep 零命中。

---

## 第一步·诊断结论：内容整体裁出可见区外，不是拉伸也不是溢出

用 Playwright（Chromium 141 headless）在 1280×800 与 1920×1080 实测全部一级页 + 关键二级页（首页/物料/物料新增/成衣/成衣新增/工作台/统计/设置/模板设置）+ 6 类浮层交互态。**所有桌面页面呈现同一形态：只剩粉色渐变背景 + 一个空的圆角「手机壳」，应用内容完全不可见**（截图证据 base/desktop-*/home.png 等 27 张）。

**根因：壳层双重嵌套。** 基线代码里桌面壳存在两份：

1. `index.html` 静态壳：`#desktop-shell > #phone-frame > #root`（React 挂载点）；
2. `App.tsx` 运行时壳：组件树里又渲染了一层 `#desktop-shell > #phone-frame > div#root`。

内外两层壳叠套后，**内层** `#desktop-shell` 的 `width/height: 100vw/100vh` 按视口单位解析、**不随外层 390px 壳收缩**——1280×800 视口下内层壳仍宽 1280px，把内层 390px 手机框居中到 x≈890 处；而外层手机框可见区只有 x=445–835，内框连同全部内容被外框 `overflow: hidden` 整体裁掉。实测度量（base/desktop-1280x800/metrics.json，9 页全部同构）：

```
外层 frame: x=445, w=390（可见）
内层 frame: x=890, w=390（全部内容，被裁，不可见）
```

移动端（≤500px 媒体查询）两层壳都塌缩为全屏 100vw/100vh，嵌套无害——这就是「移动端一直正常、桌面端显示不全」的原因。

**次生问题（修复后核出，一并处理）：**

- 全项目 **12 处以视口为定位基准的 fixed 元素**（详见下节清单）——即使解除双嵌套，桌面端它们也会横贯整个浏览器视口（FAB 飘到屏幕右下角、确认弹窗遮罩全屏宽等）；
- 两处浮层 max-height 以视口高度为基准：`completion-wizard` 85vh、模板表单 90vh——1920×1080 下分别为 918px/972px，超出 844px 壳高，表头会被裁出壳顶不可达。

## 第二步·适配实现：限宽居中手机壳（方案落地）

桌面壳样式（390px 居中 + 渐变背景 + 圆角阴影）**基线里本就存在且符合主 AD 既定方向，无需新增设计**；本棒做的是让它真正生效：

1. **壳层单源（主修复）**：删 App.tsx 内重复包裹，壳统一由 index.html 静态提供（React 挂载前即存在，无闪屏；standalone PWA 窗口同样生效）。App 直出 Toast/路由页/BottomNav/UpdatePrompt 到真实 #root。
2. **fixed 后代收编（一行 CSS）**：`@media (min-width: 501px) { #phone-frame { transform: translateZ(0); } }`。依 CSS 规范，transform 非 none 的元素是其 fixed 后代的包含块——12 处 fixed 元素（FAB、成衣搜索按钮、纸样/物料选择器整页、筛选面板遮罩、物料选择底栏、删除确认弹窗、删图遮罩、更新提示 banner）全部自动跟随 390px 壳居中，**组件代码零改动**。逐一改 absolute 需核对每处的滚动祖先，风险高，不采用。
3. **浮层高度钳制**：`completion-wizard` → `max-height: min(85vh, 100%)`；模板表单 → `maxHeight: '90%'`。100% 以 form-overlay（壳内 inset:0）为基准；移动端 overlay=视口，取值与原值数学等价。
4. **BottomNav 无需处理**：基线即 `position: sticky` 随文档流，天然在壳内（实测 y=682/w=390 贴壳底）。
5. **壳宽取 390px**（非 430px）：与移动端设计稿宽度（iPhone 390pt）及全部组件断点一致，避免 40px 拉伸差改变任何换行/栅格表现；「430 左右」的意图是手机形态居中，390 即设计稿本宽。
6. **PWA standalone 核对**：适配全部基于视口宽度（>500px 即套壳），与 display-mode 无关——安装到桌面的 standalone 窗口无论何种尺寸都走同一规则（≤500px 窄窗全屏、>500px 手机壳居中），manifest 未改动。

**移动端零回归的保证机制**：新增 CSS 全部位于 `min-width: 501px` 媒体查询内，≤500px 的 CSS 路径与基线**逐字节一致**（test-services 源码级断言留证）；DOM 层仅移除两个在移动端渲染为全屏且无视觉样式的包裹 div。实测见下节像素对比。

## 截图证据清单（6 组 100 张，随包另附 x-a-screenshots.zip）

| 组 | 张数 | 内容 |
| --- | --- | --- |
| base/desktop-1280x800 | 18 | 9 页面 + 6 浮层 + 模板表单 2 态（**修复前：全部只剩空壳，内容不可见**） |
| base/desktop-1920x1080 | 9 | 9 页面（同上形态） |
| base/mobile-390x844 | 18 | 修复前移动端基线（正常） |
| fixed/desktop-1280x800 | 18 | 修复后：9 页面 + 6 浮层 + 模板表单 2 态，全部在壳内完整可读 |
| fixed/desktop-1920x1080 | 19 | 修复后：9 页面 + 6 浮层 + 模板表单 + **完工登记向导** + 物料选择底栏（选中态），全部在壳内 |
| fixed/mobile-390x844 | 18 | 修复后移动端（与 base 组逐像素对比） |

**移动端逐像素对比：18 张截图（9 页面 + 6 浮层 + 模板表单 2 态）前后全部 IDENTICAL**（PIL ImageChops.difference 零差异，容差 0）。模板表单两态为 TemplateSettings 改动文件的专项回归，基线版与修复版分别构建后拍摄对比。

**fixed 元素壳内审计（1920×1080，Playwright 度量 bounding box vs #phone-frame x=765,w=390）**：FAB / 成衣搜索按钮 / 纸样选择器整页 / 筛选面板遮罩 / 物料选择器整页 / 物料选择底栏（选中态 y=896 贴壳底）/ 删除确认弹罩 / 任务表单（absolute 对照）——**8 类实测全部 IN-SHELL**；其余 4 处（删图遮罩、更新 banner、两处 picker overlay 模式内联样式）与已测同类同机制，由同一包含块规则覆盖。

## 回归自测

test-services.ts 新增 X-A 段源码级断言 **7 条**（壳层单源 3 + fixed 包含块 2 + 浮层钳制 2），全套 `npm run test:services` **1281/1281 全绿**（基线 1274，只增不减）。`typecheck` 0 错 / `lint` 0 警 / `schema:check` ok / `build` 0 错。

## 打包口径

- 必含 index.html、.github/workflows/deploy.yml ✓；剔除 node_modules / dist / *.tsbuildinfo / 诊断脚本（Playwright 脚本与截图均在包外）✓；test-services.ts 随包 ✓；package.json 与基线逐字一致 ✓；PAT grep 零命中 ✓。

## 口径变更记录

**无。** 本棒全部改动位于 UI 壳层与浮层高度钳制，不触 PRD / 数据模型 / 架构文档任何口径。两点事实性说明（非口径变更）：

1. 桌面「手机壳」样式（390px 居中 + 渐变背景）在基线 styles.css 中已存在（demo 遗产），基线问题在于双重嵌套使其失效——本棒是修复而非新增设计；
2. 壳宽取 390px 而非任务书建议的「430px 左右」：390 为移动端设计稿实际宽度，理由见实现说明第 5 条。
