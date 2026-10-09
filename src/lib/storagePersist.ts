/**
 * AF-B P2-3：启动期请求持久化存储（navigator.storage.persist()）。
 *
 * 背景：主屏 web app 的数据存于第一方域的 IndexedDB，WebKit 对「已安装到
 * 主屏」的站点在存储驱逐启发式里有加分（AF-A Q2 调研，WebKit 存储策略
 * 文档），但默认仍是启发式兜底——极端存储压力下理论可被驱逐。显式调用
 * persist() 把「尽量别删我的数据」的意愿交给浏览器， granted 后该源的
 * 存储进入持久桶，驱逐优先级最低。
 *
 * iOS 支持情况（注明）：
 * - Safari 15.2+ 提供 StorageManager（navigator.storage.estimate / persist）；
 *   主屏 web app 与 Safari 同源共享同一套 StorageManager。
 * - persist() 是请求不是命令：WebKit 可能直接拒绝（denied），也可能授予。
 * - 旧版 iOS / 非标准环境完全没有 navigator.storage——此时本函数静默降级
 *   （返回 null，不抛错），应用行为与未引入本调用完全一致。
 *
 * 契约：只在应用启动时调用一次（main.tsx），异步、不阻塞首屏、失败静默，
 * 与 cleanupOrphanImages / seedIfFirstRun 的启动期模式一致。
 */

/** persist 调用结果。null = 环境不支持或调用异常（静默降级，非失败）。 */
export type PersistResult = 'granted' | 'denied' | 'unavailable';

/** 便于测试注入的存储宿主抽象；默认取全局 navigator。 */
function storageHost(): { storage?: { persist?: () => Promise<boolean> } } | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator as unknown as { storage?: { persist?: () => Promise<boolean> } };
}

/**
 * 请求持久化存储。幂等（浏览器侧自行去重），重复调用安全。
 * - 无 navigator.storage.persist → 'unavailable'（静默降级）
 * - persist() resolve(true)  → 'granted'
 * - persist() resolve(false) → 'denied'（正常情况，非错误）
 * - persist() reject         → 'unavailable'（静默降级，不向上抛）
 */
export async function requestPersistentStorage(): Promise<PersistResult> {
  try {
    const host = storageHost();
    const persist = host?.storage?.persist;
    if (typeof persist !== 'function') return 'unavailable';
    return (await persist.call(host!.storage)) ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}
