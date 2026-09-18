/**
 * main.js · 应用引导入口（M1.1 工程骨架）
 * 缝纫空间 · 纯静态 PWA
 *
 * 启动顺序：
 *   1. 注入版本号 + 时间戳到 footer（方便定位缓存版本）
 *   2. 安装全局错误处理
 *   3. 首启种子写入（device_id / presets / 任务模板等）
 *   4. 监听在线/离线事件
 *   5. 注册 Service Worker（异步，不阻塞 UI）
 *   6. 启动 hash 路由
 *
 * 任何步骤失败都不会阻塞 UI 渲染（fail-soft），
 * 但会通过 console.error / toast 上报，便于排查。
 */

(function (global) {
  'use strict';

  const { log, toast } = global.SS.utils;
  const A = global.SS.app;

  /**
   * 启动主流程
   */
  async function bootstrap() {
    log('=== 缝纫空间 M1.1 启动 ===');
    log('SW_VERSION =', A.SW_VERSION);

    // 1) 错误兜底
    A.installGlobalErrorHandlers();

    // 2) 首启种子（含 device_id 原子写入、3 个任务模板、presets）
    try {
      await global.SS.db.seedIfFirstRun();
      log('首启种子完成');
    } catch (e) {
      console.error('首启种子失败：', e);
      toast('初始化数据失败，请刷新页面重试', 4000);
    }

    // 3) 离线/在线横幅
    A.wireOfflineBanner();

    // 4) 顶部 / 底部导航壳显现（去掉 boot-screen）
    const appShell = document.getElementById('app');
    if (appShell) appShell.removeAttribute('aria-busy');
    const header = document.getElementById('app-header');
    const bottomNav = document.getElementById('bottom-nav');
    if (header) header.hidden = false;
    if (bottomNav) bottomNav.hidden = false;

    // 清掉 boot-screen
    const root = document.getElementById('page-root');
    if (root) root.innerHTML = '';

    // 5) 注册 Service Worker（异步，不阻塞）
    A.registerServiceWorker().catch((e) => console.warn('SW 注册异常：', e));

    // 6) 启动路由（同步）
    try {
      global.SS.router.start();
    } catch (e) {
      console.error('路由启动失败：', e);
      if (root) {
        root.innerHTML = `
          <div class="placeholder-page">
            <div class="placeholder-icon">⚠️</div>
            <div class="placeholder-title">启动失败</div>
            <div class="placeholder-desc">${e.message || e}</div>
            <button class="btn btn-primary" onclick="location.reload()" style="margin-top:16px;">刷新页面</button>
          </div>`;
      }
    }

    log('=== 启动完成 ===');
  }

  // 等待 DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(window);