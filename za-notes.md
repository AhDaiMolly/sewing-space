# Z-A：iOS「添加到主屏幕」后页面底部被遮挡修复说明

## 1. 问题与根因

**现象**（用户截图 IMG_7657.png，1206×2622 PNG，iPhone 16 Pro）：添加到主屏幕后以
standalone 模式打开，初始化向导第 1 页「下一步」只露出上半截、「跳过」贴屏幕底缘。

**根因确认（截图几何反推，先确认再修）**：

- 像素分析：页面背景（粉底）从 y=0 起铺满整屏（webview 本身全屏），但内容整体
  下移约 **62–63px（= 状态栏高度）**；「下一步」按钮底缘贴屏幕物理底缘；
  向导进度条从 CSS 预期位置（顶部 12–17px）偏移到 80.6–84.3px。
- 几何推证：iPhone 16 Pro 物理高 874px（CSS），standalone 下 webview 被状态栏下推，
  **可视高度 812px = 874 − 62**；而壳层 `#phone-frame` 用 `height: 100vh`，
  在该模式下 `100vh` 仍按全屏物理高度 874px 解析 → 壳溢出可视区 62px → 底部被裁。
- 与 WebKit 已知缺陷吻合（iOS 26.x standalone：`vh/lvh` 按全屏物理高度解析，
  `dvh/svh/innerHeight` 报告可视高度；对应 WebKit Bug 301994 / 313800 系列）。

**诊断方向逐项排除**：

| 方向 | 结论 |
| --- | --- |
| 1. viewport 缺 `viewport-fit=cover` | 排除——基线 index.html 已含，`env(safe-area-inset-bottom)` 可用 |
| 2. 吸底元素缺安全区补白 | 排除——基线已齐备（见 §3 清单，本次核实留证，未改动） |
| 3. `100vh` 容器高度在 standalone 超出可视区 | **命中**——根因，本次修复 |
| 4. 与 X-A 桌面壳交互 | 一并处理——transform 包含块无条件化（见 §2、§5） |

## 2. 修复内容（集中在壳层 3 处，`src/styles/styles.css`）

不逐页面散弹式调样式，只改壳层高度基准 + 包含块，吸底元素补白沿用基线：

1. `#desktop-shell`：`height: 100vh` 后补 `height: 100dvh`（渐进增强，dvh 覆盖）。
2. `#phone-frame`：`max-height: calc(100vh - 40px)` 后补 `max-height: calc(100dvh - 40px)`。
3. 移动端 `@media (max-width: 500px)` 内 `#phone-frame`：`height: 100vh` 后补
   `height: 100dvh`——**主修复**，standalone 下壳回落到可视高度，吸底元素随之回到可视区。
4. `transform: translateZ(0)` 从 `@media (min-width: 501px)` 移入 `#phone-frame` 基础规则
   （无条件生效）：保证 fixed 吸底元素（BottomNav、FAB、浮层）始终以壳为包含块，
   不因 standalone 下布局差异脱离壳。

写法为「vh 在前、dvh 在后」的渐进增强：不支持 dvh 的旧浏览器取 vh，行为与基线完全一致。

## 3. 吸底元素处理清单（全量排查，逐一核验）

| 吸底元素 | 处理 | 状态 |
| --- | --- | --- |
| 向导 4 页底部操作条（下一步/跳过，WizardPage 共用） | `paddingBottom: calc(12px + var(--safe-area-bottom))` | 基线已具备，核实留证 |
| `--safe-area-bottom: 34px` 常量（:root，iPhone home indicator 34px） | 常量维持 | 基线口径，核实留证 |
| 一级页 BottomNav（bottom-nav 壳样式） | `padding-bottom: var(--safe-area-bottom)`，背景色延伸进安全区 | 基线已具备，核实留证 |
| 悬浮按钮 FAB | `bottom: calc(var(--bottom-nav-height) + var(--safe-area-bottom) + 16px)` | 基线已具备，核实留证 |
| UpdatePrompt 提示条 | `bottom: calc(导航高 + 安全区 + 8px)` | 基线已具备，核实留证 |
| 图片/物料选择弹框底栏（picker-bottom-bar） | `env(safe-area-inset-bottom)` 补白 | 基线已具备，核实留证 |
| 一级页内容区（with-bottom-nav） | `padding-bottom: calc(导航高 + 安全区 + 8px)` 让位 | 基线已具备，核实留证 |
| 表单浮层 form-sheet `.form-body` | `max-height: calc(90vh - 50px)` 钳制维持（移动端 overlay=视口，数学等价） | 核实留证 |
| styles-batch4.css | 无散点 dvh 改动（修复集中在壳层） | 断言留证 |

以上清单均有 test-services.ts 源码级断言覆盖（§4）。

## 4. 验证证据（模拟手段全部验证并留证）

**静态检查与构建（均 EXIT=0）**：typecheck 0 错误 / lint 0 错误 / schema:check 通过 / build 0 错误。

**test:services**：`通过 1316 / 1316`，EXIT=0。含：
- 新增「Z-A：iOS standalone 底部裁切修复源码级断言」段 12 条
  （viewport-fit=cover 核实、壳层 dvh 渐进增强 ×3、吸底清单 ×6、浮层钳制 ×2）；
- X-A 包含块断言更新为 3 条（见 §5 口径变更）。

**Playwright 设备模拟 + 几何度量**（diag/shots.js，4 视口 × 9 场景：向导 4 步 + 首页 +
物料/成衣/工作台直达 + 快速添加浮层）：

| 视口 | frameH（基线→修复后） | navBottom / fabBottom | 结论 |
| --- | --- | --- | --- |
| mobile-390x844 | 844 → 844 | 844 / 760 不变 | 零回归 |
| mobile-402x874（iPhone 16 Pro CSS 尺寸） | 874 → 874 | 874 / 790 不变 | 零回归 |
| desktop-1280x800（X-A 桌面壳） | 760 → 760 | 780 / 696 不变 | 零回归 |
| desktop-1920x1080（X-A 桌面壳） | 844 → 844 | 962 / 878 不变 | 零回归 |

**截图像素对比（基线包 vs 修复后，36 张）**：28 张逐像素一致；8 张差异 ≤0.016%
（最大 470px、max 通道差 14，为 translateZ 合成层激活后的亚像素抗锯齿噪声，无几何位移）。

**回归红线核验**：
- ① 移动端 Safari 浏览器模式（有地址栏、安全区为 0）：Chromium 模拟下 390×844 /
  402×874 两视口几何与像素均与基线一致，且该模式 vh=dvh、无安全区，dvh 覆盖不产生任何变化；
- ② X-A 桌面限宽壳 1280×800 / 1920×1080：几何度量与像素对比零差异，壳内定位逻辑未破坏；
- ③ 底部安全区视觉协调：BottomNav / 向导操作条背景色随壳延伸进安全区（背景绘制在补白
  padding 区内，非额外色块），FAB / 提示条 / 弹框底栏按常量抬升——基线口径维持。

## 5. 未验证声明与口径变更记录

**未验证声明**：**iOS 真机 standalone 模式未验证**。Chromium 等模拟环境无法复现
iOS 26.x standalone 的 `vh`（全屏物理高）与 `dvh`（可视高）分离——模拟器中二者恒等，
故修复有效性依据为：dvh 语义 + WebKit Bug 301994/313800 几何推证 + 壳层源码级断言。
最终真机确认由用户部署后进行（添加到主屏幕 → standalone 打开 → 检查向导「下一步/跳过」
及各页底部元素完整可见）。

**口径变更记录**（不入 PRD / 数据模型 / 架构文档）：
1. X-A transform 包含块口径：原「桌面（≥501px）限定 transform: translateZ(0)」由 Z-A
   扩展为**无条件生效**（基础规则内）。移动端几何经四视口度量与像素比对确认零变化
   （包含块变更在该模式下无几何影响）；test-services.ts 对应断言由 2 条更新为 3 条。
2. 测试基线口径：任务基线 1391 含「S8B-6 / S8C-4 / S8D 直读」条件执行段（需真实数据包
   置于工程旁）；本环境无该数据包，本机可复现基线为 **1303**，修复后 **1316**
   （= 1303 + 新增 13），相对本机可复现基线**只增不减**。

**打包口径（同既往）**：含 index.html、.github/workflows/deploy.yml、scripts/test-services.ts、
za-notes.md；剔除 dist / node_modules / *.tsbuildinfo / 诊断脚本（diag/、diff_shots.py 均在
工程目录之外）；package.json 与基线逐字节一致（sha256 4ddd08e2…42205 核对）；PAT grep 零命中。
