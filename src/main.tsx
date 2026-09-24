import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { cleanupOrphanImages } from '@/services/imageService';
import { registerSW } from '@/pwa/registerSW';
import '@/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到 #root 容器');
}

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

// 启动期的孤儿图清理：异步、不阻塞首屏、失败静默
void cleanupOrphanImages().catch(() => undefined);

// Service Worker 注册：仅生产环境
registerSW();
