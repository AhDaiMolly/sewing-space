// src/components/BottomNav.tsx — S7-C 底部导航栏
// 四个 tab：首页、物料、成衣、工作台（顺序固定，PRD §5.5）。
// 选中态高亮（--accent）、未选中态灰（--secondary-foreground）。
// CSS 冻结 .bottom-nav / .nav-item / .nav-item.active / .nav-icon 类。

import { useLocation, useNavigate } from 'react-router-dom';
import { ROUTES } from '@/lib/routes';

const TABS: { path: string; label: string; icon: JSX.Element }[] = [
  {
    path: ROUTES.home,
    label: '首页',
    icon: (
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 10l9-7 9 7v10a1 1 0 01-1 1H4a1 1 0 01-1-1V10z" />
        <path d="M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    path: ROUTES.materials,
    label: '物料',
    icon: (
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 01-8 0" />
      </svg>
    ),
  },
  {
    path: ROUTES.garments,
    label: '成衣',
    icon: (
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3L4 8v4c0 5 4 9 8 9s8-4 8-9V8l-8-5z" />
        <path d="M12 12v9" />
      </svg>
    ),
  },
  {
    path: ROUTES.workbench,
    label: '工作台',
    icon: (
      <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18" />
        <path d="M9 21V9" />
      </svg>
    ),
  },
];

export default function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  // 仅显示在四个主区根路径上（PRD §5.1：底部导航是四个主区的平级入口）
  const visiblePaths: string[] = [ROUTES.home, ROUTES.materials, ROUTES.garments, ROUTES.workbench];
  if (!visiblePaths.includes(location.pathname)) return null;

  return (
    <nav className="bottom-nav" role="navigation" aria-label="主导航">
      {TABS.map((tab) => {
        const isActive = location.pathname === tab.path;
        return (
          <button
            key={tab.path}
            type="button"
            className={`nav-item${isActive ? ' active' : ''}`}
            onClick={() => navigate(tab.path)}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="nav-icon">{tab.icon}</span>
            <span className="nav-label">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}