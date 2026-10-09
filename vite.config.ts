import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

/** AF-A Q1：构建期版本号（vite define 注入 src/lib/version.ts）。
 *  ⚠️ AF-B P2-2 双配置维护警示：本工程同时存在 vite.config.ts 与
 *  vite.config.js，**Vite 解析时 .js 优先加载**（先找到先用），运行时生效
 *  的是 .js！任何对本文件 define / sewingBuildVersion 的修改，必须同步
 *  改写 vite.config.js，否则改动会被 .js 静默覆盖。防回归双保险：
 *  ① scripts/test-services.ts 的 AFB-P2② 断言两份配置都含 define 行；
 *  ② deploy.yml 构建后 grep 断言 dist 内含注入版本值。改这里前先看 .js。
 *  优先 CI 提供的 SEWING_VERSION（.github/workflows/deploy.yml 拼好
 *  「日期 + github.run_number」，每次部署必然不同）；本地 / 沙箱构建回落
 *  「日期 + HHMM」时间戳。此前版本号靠人工手改 src/lib/version.ts，AE 系
 *  发布忘 bump 导致关于页版本号不变、用户无法分辨部署是否成功——此后
 *  版本号天然随每次构建变化，无需任何人工步骤。 */
function sewingBuildVersion(): string {
  const env = process.env.SEWING_VERSION;
  if (env && env.trim()) return env.trim();
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}.${p(now.getMonth() + 1)}.${p(now.getDate())}.${p(now.getHours())}${p(now.getMinutes())}`;
}

export default defineConfig({
  base: '/sewing-space/',
  define: {
    __SEWING_BUILD_VERSION__: JSON.stringify(sewingBuildVersion()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
      },
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          db: ['dexie', 'dexie-react-hooks', 'nanoid', 'zod'],
          zip: ['jszip'],
          ui: ['class-variance-authority', 'clsx', 'tailwind-merge', 'lucide-react'],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // AE-A Q1：registerType 由 'prompt' 改为 'autoUpdate'（口径变更，见
      // ae-a-notes.md）。prompt 模式依赖 waiting → UpdatePrompt 用户点击链路，
      // iOS 普通页签长驻不导航时永远收敛不到用户：旧 SW 持旧 precache，新部署
      // 资源 hash 变化后 fetch 全 miss → 白屏只剩壳文字；无痕页签无 SW、直连
      // 网络，故正常。autoUpdate：新 SW 装好即接管（skipWaiting + clientsClaim
      // 显式开启），SW activated(isUpdate) 时客户端自动 reload，
      // cleanupOutdatedCaches 清旧 precache，存量旧 SW 用户自愈。
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: '缝纫空间',
        short_name: '缝纫空间',
        description: '你的私人缝纫仓库与工作台 · 物料 / 成衣 / 任务 / 统计',
        start_url: '/sewing-space/',
        scope: '/sewing-space/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FFF5F7',
        theme_color: '#FFB3C7',
        lang: 'zh-CN',
        dir: 'ltr',
        categories: ['lifestyle', 'productivity'],
        prefer_related_applications: false,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: '新增物料', short_name: '物料', description: '快速记录新买的面料/辅料/工具/纸样', url: '/sewing-space/#/materials/new' },
          { name: '新增成衣', short_name: '成衣', description: '开始记录一件新的成衣', url: '/sewing-space/#/garments/new' },
          { name: '工作台', short_name: '任务', description: '查看今日待办任务', url: '/sewing-space/#/workbench' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // AE-A Q1 首载优化：猫系列分类 SVG（4 张共约 653 KiB，2048×2048 用户
        // 原设计稿）只在物料库/空态卡片按需 <img> 加载，不属于首屏关键资源，
        // 却占 SW 首装预缓存流量约 36%（1.8 MB 中的 0.65 MB），移动网络下与
        // 应用壳资源抢带宽、拖慢首次打开。移出 precache，改走下方
        // runtimeCaching CacheFirst：首次进物料页时才拉取并缓存，此后离线
        // 仍可用；首装预缓存降至约 1.18 MB（-36%，估算收益：典型 4G 首载
        // 少抢约 0.65 MB 带宽）。manifest 图标（192/512/apple-touch）保留在
        // precache——安装到主屏的图标离线可用性不受影响。
        globIgnores: ['icons/cat-*.svg'],
        navigateFallback: '/sewing-space/index.html',
        cleanupOutdatedCaches: true,
        // AE-A Q1：injectRegister: false 时 vite-plugin-pwa（0.20.5 源码核实）
        // 不会自动注入这两项（仅 injectRegister 为 auto/null 才注入）。autoUpdate
        // 的 activated(isUpdate) → 客户端 reload 链路依赖新 SW 装好立即激活，
        // 必须显式开启，否则新 SW 卡 waiting、存量用户仍收不到新版。
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // 猫系列分类 SVG：按需加载 + CacheFirst（首次访问物料页后进缓存）
            urlPattern: /\/sewing-space\/icons\/cat-[^/]+\.svg$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cat-icons',
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 天
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
