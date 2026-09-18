/**
 * utils.js · 通用工具函数
 * 缝纫空间 M1.1 工程骨架 · 纯静态 PWA
 *
 * 本文件提供 ID 生成、时间格式化、事件总线等基础设施。
 * 无依赖（不引 Dexie 之外的库）。
 */

(function (global) {
  'use strict';

  /* ============ ID 生成（nanoid 风格） ============ */
  // 字符表（去歧义：去除 0/O、1/I/l）
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /**
   * 生成随机 ID（默认 12 位，碰撞概率 ~10^(-18)）
   * 不引第三方库，原生 crypto.getRandomValues
   * @param {number} size 字符数
   * @returns {string}
   */
  function nanoid(size = 12) {
    const bytes = new Uint8Array(size);
    (global.crypto || global.msCrypto).getRandomValues(bytes);
    let id = '';
    for (let i = 0; i < size; i++) {
      id += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return id;
  }

  /* ============ 时间格式化 ============ */
  /** 当前时间 ISO 字符串 */
  function nowIso() {
    return new Date().toISOString();
  }

  /** 友好相对时间（"3 分钟前"） */
  function relativeTime(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 30 * 86400) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN');
  }

  /** 日期格式 yyyy-MM-dd */
  function dateOnly(iso) {
    if (!iso) return '';
    return iso.substring(0, 10);
  }

  /* ============ HTML 转义（防 XSS） ============ */
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ============ 极简事件总线（用于跨组件通知） ============ */
  const listeners = new Map();
  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  }
  function emit(event, payload) {
    const set = listeners.get(event);
    if (set) set.forEach((h) => { try { h(payload); } catch (e) { console.error(e); } });
  }

  /* ============ 简单 Toast ============ */
  function toast(msg, duration = 2000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  /* ============ 调试开关 ============ */
  const DEBUG = global.location.hostname === 'localhost'
    || global.location.search.includes('debug=1');

  function log(...args) {
    if (DEBUG) console.log('[sewing]', ...args);
  }

  /* ============ 导出 ============ */
  global.SS = global.SS || {};
  global.SS.utils = {
    nanoid, nowIso, relativeTime, dateOnly,
    escapeHtml, on, emit, toast, log,
  };
})(window);