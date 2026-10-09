import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { cleanupOrphanImages } from '@/services/imageService';
import { seedIfFirstRun, cleanupPresetTemplates } from '@/db/seed';
import { registerSW } from '@/pwa/registerSW';
import { requestPersistentStorage } from '@/lib/storagePersist';
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

// V-C 工作台Q3：首启种子数据（settings 默认值）。
// 此前 seedIfFirstRun 只在 scripts/ 里被调用，应用运行时从不执行——
// 对齐 cleanupOrphanImages 模式：异步、不阻塞首屏、失败静默（幂等：
// settings.onboarding_completed 等就位标记存在时零写入）。
// W-C 设置4：seed 不再种任务模板（模板全部由用户自建），下方清理函数
// 负责把旧版本种入的 3 个预设模板从存量数据里一次性删掉。
void seedIfFirstRun().catch(() => undefined);

// W-C 设置4：旧版本种子模板的一次性清理（幂等：零命中零写入；旧备份
// 恢复带回的 preset 行下次启动自愈清除）。异步、不阻塞首屏、失败静默。
void cleanupPresetTemplates().catch(() => undefined);

// AF-B P2-3：请求持久化存储（navigator.storage.persist()），增强长期数据
// 留存确定性。iOS 15.2+ 支持；不支持 / 被拒 / 异常一律静默降级，不影响
// 任何现有行为。详见 src/lib/storagePersist.ts 头注释。
void requestPersistentStorage().catch(() => undefined);

// Service Worker 注册：仅生产环境
registerSW();
