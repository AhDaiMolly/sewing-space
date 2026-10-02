// src/App.tsx — 应用壳层（S7-C）
//
// 挂载：
//   - BottomNav（仅四个主路由可见：/ /materials /garments /workbench）
//   - ToastContainer
//
// W-B 口径变更：移除 S7-C 挂载的 StatusBar 壳层组件（系统时间/电池电量），
// 用户新要求高于 demo 基线；顶部安全区间距未调整（内容贴顶无视觉断裂，见 wb-notes）。
//
// AA-E 向导1（2026-09-30 用户验收）：移除「未完成向导强制重定向 /wizard」逻辑
// （PRD §13.1 旧口径）——部署后第一次打开应用直接进入主页；向导页面保留
// （/wizard 路由不动），入口改为设置页「数据管理 → 重新运行初始化向导」
// （该入口自 S7-C 行为 5 起即存在，本棒验证保留）。onboarding_completed
// 设置键与向导第 4 步「开始使用」写入逻辑均保留（向导可反复进入查看，
// 不再影响路由跳转）。口径变更记入 ae-notes「口径变更记录」。

import { Outlet, useLocation } from 'react-router-dom';
import ToastContainer from './components/Toast';
import BottomNav from './components/BottomNav';
import UpdatePrompt from './components/UpdatePrompt';
import { ROUTES } from './lib/routes';

/** 底部导航仅在四个主路由上渲染（PRD §5.3「隐藏规则」）。 */
const MAIN_ROUTES = new Set<string>([
  ROUTES.home,
  ROUTES.materials,
  ROUTES.garments,
  ROUTES.workbench,
]);

export default function App() {
  const location = useLocation();

  // AA-E 向导1：原「实时读取引导完成标记 + 路由变化强制跳转向导」的 effect
  // 已整块移除（首开直接进主页，不再有加载判定门，也无需在 settings
  // 解析前挂起渲染）。向导路由与设置页入口保留，由用户主动进入。

// X-A 桌面适配：移除 App 内重复渲染的 #desktop-shell/#phone-frame/#root 三层包裹。
// 基线里 index.html（静态壳）与 App.tsx（运行时壳）双重嵌套：内层壳用 100vw/100vh
// 视口单位，不随外层 390px 壳收缩，内容被居中到视口中部、整页裁出可见区外——
// 桌面端「页面显示不全」的根因。壳层统一由 index.html 提供（React 挂载前即存在，
// 无闪屏）；App 直出 Toast / 路由页 / BottomNav / UpdatePrompt 到真实 #root。

  const showBottomNav = MAIN_ROUTES.has(location.pathname);

  return (
    <>
      <ToastContainer />
      <Outlet />
      {showBottomNav && <BottomNav />}
      {/* SW 更新提示 banner（架构 §8.3）：紧接 <BottomNav /> 之后 */}
      <UpdatePrompt />
    </>
  );
}
