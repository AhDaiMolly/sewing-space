import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  base: '/sewing-space/',
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
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/icon-192.svg', 'icons/icon-512.svg'],
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
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: '新增物料', short_name: '物料', description: '快速记录新买的面料/辅料/工具/纸样', url: '/sewing-space/#/materials/new' },
          { name: '新增成衣', short_name: '成衣', description: '开始记录一件新的成衣', url: '/sewing-space/#/garments/new' },
          { name: '工作台', short_name: '任务', description: '查看今日待办任务', url: '/sewing-space/#/workbench' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/sewing-space/index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
