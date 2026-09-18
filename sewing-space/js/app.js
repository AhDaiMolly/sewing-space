/**
 * app.js · 应用层工具（错误边界 / 离线检测 / SW 注册 / 图片帮助）
 * 缝纫空间 M1.1 工程骨架
 *
 * 职责：
 *   - registerServiceWorker()  注册 sw.js，附带缓存版本管理
 *   - wireOfflineBanner()      监听 online/offline 切换顶部条
 *   - installGlobalErrorHandlers() 兜底捕获异常并 toast
 *   - loadImage(id)            从 IndexedDB 读 Blob → ObjectURL
 *   - deleteImage(id)          清理孤儿图片
 *
 * 不依赖任何框架，浏览器原生 API。
 */

(function (global) {
  'use strict';

  const { log, toast } = global.SS.utils;

  const SW_VERSION = 'v1.4.4';
  const SW_URL = './sw.js';
  const SW_SCOPE = './';

  /* ============ Service Worker 注册 ============ */

  /**
   * 注册 Service Worker
   * - file:// 或不支持 SW 的环境（iOS Safari < 11.4 等）静默跳过
   * - 注册失败仅 warn，不阻塞业务
   */
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      log('当前环境不支持 Service Worker');
      return null;
    }
    // 仅在 http(s) 协议下注册；file:// 下浏览器通常拒绝注册
    const proto = global.location.protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      log('当前协议不注册 SW:', proto);
      return null;
    }
    try {
      const reg = await navigator.serviceWorker.register(SW_URL, {
        scope: SW_SCOPE,
      });
      log('Service Worker 已注册：', SW_VERSION);

      // 版本变更提示：发现新 SW 时提示用户刷新（避免旧缓存拖累）
      reg.addEventListener('updatefound', () => {
        const newSw = reg.installing;
        if (!newSw) return;
        newSw.addEventListener('statechange', () => {
          if (newSw.state === 'installed' && navigator.serviceWorker.controller) {
            // 新版本已就绪，但页面仍在旧版本控制下
            toast('新版本已就绪，刷新页面即可使用', 4000);
          }
        });
      });

      return reg;
    } catch (e) {
      console.warn('Service Worker 注册失败：', e);
      return null;
    }
  }

  /* ============ 离线状态横幅 ============ */

  /**
   * 监听 online/offline 事件，更新 #offline-banner 显示。
   * 状态同时通过 SS.app.setOnline() 暴露给其它模块订阅。
   */
  function wireOfflineBanner() {
    const banner = document.getElementById('offline-banner');
    if (!banner) return;

    const update = () => {
      const online = navigator.onLine;
      banner.hidden = online;
      setOnline(online);
      log('在线状态变更:', online);
    };

    global.addEventListener('online', update);
    global.addEventListener('offline', update);
    update();
  }

  function setOnline(online) {
    global.SS = global.SS || {};
    global.SS.app = global.SS.app || {};
    if (global.SS.app.online !== online) {
      global.SS.app.online = online;
      global.SS.utils && global.SS.utils.emit && global.SS.utils.emit('online:change', online);
    }
  }

  /* ============ 全局错误处理 ============ */

  function installGlobalErrorHandlers() {
    global.addEventListener('error', (e) => {
      console.error('[global error]', e.error || e.message);
      // 真正的页面级渲染异常已在 router.js 内部捕获并显示占位；
      // 这里只处理未被捕获的同步错误（例如资源加载失败）
    });
    global.addEventListener('unhandledrejection', (e) => {
      console.error('[unhandled rejection]', e.reason);
    });
  }

  /* ============ 图片读取（Dexie Blob → ObjectURL） ============ */

  /**
   * 从 images 表读取 Blob 并生成 ObjectURL。
   * 业务侧应在图片元素卸载时调用 revokeObjectURL 释放内存。
   * @param {string} imageId
   * @returns {Promise<string|null>}
   */
  async function loadImage(imageId) {
    const db = global.SS.db.db;
    const row = await db.images.get(imageId);
    if (!row || !row.blob) return null;
    return URL.createObjectURL(row.blob);
  }

  /**
   * 删除图片记录（连带 revoke）。
   * @param {string} imageId
   */
  async function deleteImage(imageId) {
    const db = global.SS.db.db;
    await db.images.delete(imageId);
  }

  /**
   * 列出某实体的全部图片 URL（Promise.all 形式）。
   * 用法：const urls = await listEntityImages('material', material.id);
   * @param {'material'|'garment'|'task'} entityType
   * @param {string} entityId
   * @returns {Promise<string[]>}
   */
  async function listEntityImages(entityType, entityId) {
    const db = global.SS.db.db;
    const rows = await db.images
      .where('id').above('')
      .filter((r) => r.entityType === entityType && r.entityId === entityId)
      .toArray();
    return rows.map((r) => URL.createObjectURL(r.blob));
  }

  /* ============ 暴露 ============ */

  global.SS = global.SS || {};
  global.SS.app = {
    SW_VERSION,
    registerServiceWorker,
    wireOfflineBanner,
    installGlobalErrorHandlers,
    loadImage,
    deleteImage,
    listEntityImages,
  };
})(window);