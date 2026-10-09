// src/pwa/registerSW.ts — Service Worker 注册与更新（架构 §8.3，AE-A Q1 修订）
//
// AE-A Q1：registerType 由 'prompt' 改为 'autoUpdate'（vite.config.ts，口径
// 变更见 ae-a-notes.md）。原因（真机现象 + 证据链）：
//   - iOS 普通页签白屏：存量旧 SW 持旧 precache，新部署资源 hash 变化后
//     旧壳引用的资源 fetch 全 miss；prompt 模式的「waiting → 用户点
//     UpdatePrompt → skipWaiting」链路在长驻页签上收敛不到用户 → 卡死在
//     旧版缓存。无痕页签 SW 注册不持久、每次直连网络，故正常。
//   - autoUpdate 修复链路：新 sw.js 字节变化 → 浏览器（导航时/定时检查时）
//     安装新 SW → skipWaiting 立即接管（workbox 显式开启，因
//     injectRegister: false 时插件不自动注入）→ activated(isUpdate) 时
//     virtual:pwa-register 客户端自动 window.location.reload() →
//     cleanupOutdatedCaches 清掉旧 precache。存量旧 SW 用户打开普通页签
//     即自愈，数据不受影响（SW 缓存与 IndexedDB 互不相干）。
//
// 保留兼容：onNeedRefresh 仍接 uiStore（autoUpdate 下常规更新不触发，仅作
// 外部 SW 等异常路径兜底）；UpdatePrompt 组件与 updateSW() 导出不动（幂等）。
// 新增兜底：
//   - onRegisteredSW：每小时 registration.update() —— iOS Safari 只在页面
//     导航时检查 sw.js，standalone/长驻页签收不到更新，定时检查补上；
//   - onRegisterError：注册失败打点不阻塞——无 SW 时页面直连网络仍可用
//     （GitHub Pages 资源均在线可达，等价于无痕页签的正常路径）。
//
// 旧 SW 清理（§8.2 / §8.6）口径不变：sw.js 由 vite-plugin-pwa 构建期生成，
// cleanupOutdatedCaches: true 在新 SW 激活时自动清理旧 precache。

import { registerSW as register } from 'virtual:pwa-register';
import { useUiStore } from '@/store/uiStore';

/** updateSW(true)：autoUpdate 模式下等待注册完成即返回（skipWaiting 已在
 * SW 内自动执行）。开发环境 / 注册前为空操作。 */
let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

/** AE-A Q1：更新检查间隔（60 分钟）。只查 sw.js 字节是否变化，不打扰用户。 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function registerSW(): void {
  if (!import.meta.env.PROD) return;

  applyUpdate = register({
    onNeedRefresh() {
      // autoUpdate 下常规更新不触发；保留作外部 SW 等异常路径兜底，
      // 让 UpdatePrompt（若真出现）仍能显示
      useUiStore.getState().setUpdateAvailable(true);
    },
    onOfflineReady() {
      // 首次预缓存完成。本版不弹提示（避免与向导第 4 步的安装提示抢注意力）
    },
    onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (registration == null) return;
      // AE-A Q1：长驻页签 / standalone 的定时更新检查。离线时跳过（下一轮
      // 再试）；检查失败静默（registration.update() 只触发标准更新流程，
      // 发现新版后由 autoUpdate 链路自动接管 + reload）。
      setInterval(() => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        void registration.update().catch(() => undefined);
      }, UPDATE_CHECK_INTERVAL_MS);
    },
    onRegisterError(e: unknown) {
      // 注册失败不阻塞应用：无 SW 时页面直连网络（线上资源均可访问）
      console.warn('[PWA] Service Worker 注册失败，应用仍可在线使用', e);
    },
  });
}

/** 供 UpdatePrompt「立即更新」调用（AE-A 后常规链路不再走到；保留导出，
 * 组件与既有调用零改动）。 */
export function updateSW(reloadPage = true): Promise<void> {
  return applyUpdate?.(reloadPage) ?? Promise.resolve();
}
