// src/components/UpdatePrompt.tsx — SW 更新提示 banner（架构 §8.3，S7-D 落地）
//
// 冻结规格（§8.3 表）：
//   挂载点     App.tsx 根布局内，紧接 <BottomNav /> 之后
//   屏幕位置   position: fixed，底部 bottom: calc(var(--bottom-nav-height) + var(--safe-area-bottom) + 8px)
//   左右边距   var(--page-padding)
//   文案       主文案「发现新版本」，按钮「立即更新」
//   图标       lucide-react 的 RefreshCw（§1.3 允许：demo 里不存在的新增 UI）
//   显示条件   uiStore.updateAvailable === true 且当前路由不在
//              /materials/:id、/garments/:id、/*/new、/*/:id/edit 上（编辑页不遮底部按钮）
//   点击       updateSW(true) → SW skipWaiting → 页面刷新
//   关闭方式   无关闭按钮（不提供「稍后」）
//   全局最多   1 个（updateAvailable 布尔量天然去重）
//
// 样式：复用冻结 CSS 类 .card / .btn / .btn-primary，定位走内联 style（不新增 CSS 类，§11 冻结约束）。

import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useUiStore } from '@/store/uiStore';
import { updateSW } from '@/pwa/registerSW';

/** 编辑/详情页判定：横条在这些路由上隐藏（§8.3「为什么在编辑页不显示」）。 */
function isExcludeRoute(pathname: string): boolean {
  // /materials/:id、/garments/:id（详情页）
  if (/^\/(materials|garments)\/[^/]+$/.test(pathname)) return true;
  // /*/new（新建页，含 /materials/new、/garments/new）
  if (/^\/[^/]+\/new$/.test(pathname)) return true;
  // /*/:id/edit（编辑页）
  if (/^\/[^/]+\/[^/]+\/edit$/.test(pathname)) return true;
  return false;
}

export default function UpdatePrompt() {
  const updateAvailable = useUiStore((s) => s.updateAvailable);
  const setUpdateAvailable = useUiStore((s) => s.setUpdateAvailable);
  const location = useLocation();

  const handleUpdate = useCallback(async () => {
    // 用户确认更新：复位提示 → skipWaiting → 刷新（§8.3）
    setUpdateAvailable(false);
    try {
      await updateSW(true);
    } catch {
      // SW 层失败不阻塞：浏览器刷新兜底
      window.location.reload();
    }
  }, [setUpdateAvailable]);

  if (!updateAvailable) return null;
  if (isExcludeRoute(location.pathname)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="card"
      style={{
        position: 'fixed',
        left: 'var(--page-padding)',
        right: 'var(--page-padding)',
        bottom: 'calc(var(--bottom-nav-height) + var(--safe-area-bottom) + 8px)',
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
      }}
    >
      <RefreshCw size={18} color="var(--accent)" aria-hidden="true" />
      <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: 'var(--foreground)' }}>
        发现新版本
      </span>
      <button type="button" className="btn btn-primary" onClick={handleUpdate}>
        立即更新
      </button>
    </div>
  );
}
