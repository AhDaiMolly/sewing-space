// src/lib/date.ts —— 日期工具（数据模型 §7.3 / §8.4）

import type { Task, TaskPriority } from '@/db/types';

// ── 优先级权重（DM §3.3 硬约束 5） ──
export const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

// ── 「今天」的唯一实现（DM §8.4） ──
/** UTC 截取日期串，全应用只此一处。不要在各页面另写本地日期版本。 */
export const todayIsoDate = (): string => new Date().toISOString().slice(0, 10);

// ── 日期判断（DM §7.3） ──
/** `dueDate === ''` 表示无截止日期，不参与任何日期比较。 */
export const isDueToday = (t: Task, _today: string): boolean =>
  t.dueDate !== '' && t.status !== 'done' && t.dueDate === _today;

export const isDueTomorrow = (t: Task, _today: string, tomorrow: string): boolean =>
  t.dueDate !== '' && t.status !== 'done' && t.dueDate === tomorrow;

export const isDueThisWeek = (t: Task, _today: string, tomorrow: string, weekEnd: string): boolean =>
  t.dueDate !== '' && t.dueDate > tomorrow && t.dueDate <= weekEnd && t.status !== 'done';

export const isOverdue = (t: Task, today: string): boolean =>
  t.dueDate !== '' && t.status !== 'done' && t.dueDate < today;

export const hasDueDate = (t: Task): boolean => t.dueDate !== '';

// ── 排序（DM §7.3：三级键） ──
export function sortTasks(a: Task, b: Task): number {
  const p = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (p !== 0) return p; // 1) 优先级升序
  if (a.dueDate !== b.dueDate) {
    // 2) 截止日期升序，空串排最后
    if (a.dueDate === '') return 1;
    if (b.dueDate === '') return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  // 3) createdAt 降序（新的在前）
  return a.createdAt < b.createdAt ? 1 : -1;
}

// ── 日期分组辅助 ──
export type DateGroup = 'today' | 'tomorrow' | 'thisWeek' | 'older' | 'noDate';

export const DATE_GROUP_LABELS: Record<DateGroup, string> = {
  today: '今天',
  tomorrow: '明天',
  thisWeek: '本周',
  older: '更早',
  noDate: '无截止日期',
};

/** 计算「明天」的日期串（整日偏移，跨月跨年安全）。 */
export function tomorrowIsoDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 计算「本周日」的日期串（周一为一周起始）。 */
export function sundayIsoDate(): string {
  const d = new Date();
  const dayOfWeek = d.getUTCDay(); // 0=Sun，1=Mon ...
  const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + daysToSunday);
  return d.toISOString().slice(0, 10);
}

/** 判定任务属于哪个日期分组。 */
export function getDateGroup(t: Task, today: string, tomorrow: string, weekEnd: string): DateGroup {
  if (!hasDueDate(t)) return 'noDate';
  if (t.dueDate === today) return 'today';
  if (t.dueDate === tomorrow) return 'tomorrow';
  if (t.dueDate > tomorrow && t.dueDate <= weekEnd) return 'thisWeek';
  return 'older';
}

// ── 展示用日期格式化（§8 通用口径：YYYY.MM.DD） ──
export function fmtDisplayDate(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  const p0 = parts[0] ?? '';
  const p1 = parts[1] ?? '';
  const p2 = parts[2] ?? '';
  if (p0 && p1 && p2 && parts.length === 3) {
    return `${p0}.${p1.padStart(2, '0')}.${p2.padStart(2, '0')}`;
  }
  return dateStr;
}