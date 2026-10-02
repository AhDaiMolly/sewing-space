// src/store/toastStore.ts — Toast 队列（架构 §4.4）
// 队列最多 3 条，同消息去重，默认 2000ms

import { create } from 'zustand';
import { nanoid } from 'nanoid';

export type ToastKind = 'default' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
  duration: number; // ms，0 = 常驻
}

export interface ToastState {
  current: ToastItem | null;
  queue: ToastItem[]; // 不含 current，长度 ≤ 3
  show: (message: string, kind?: ToastKind, duration?: number) => void;
  dismiss: () => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  current: null,
  queue: [],

  show: (message, kind = 'default', duration = 2000) => {
    const { current, queue } = get();
    if (current?.message === message) return;
    if (queue.some((t) => t.message === message)) return;
    const item: ToastItem = { id: nanoid(8), message, kind, duration };
    if (!current) {
      set({ current: item });
      return;
    }
    set({ queue: [...queue, item].slice(-3) });
  },

  dismiss: () => {
    const { queue } = get();
    set({ current: queue[0] ?? null, queue: queue.slice(1) });
  },
}));

/** 场景内便捷调用（组件外也可用） */
export const toast = (
  message: string,
  kind: ToastKind = 'default',
  duration = 2000,
) => useToastStore.getState().show(message, kind, duration);