// src/lib/signedDelta.ts — 流水符号函数（数据模型 §4.6 逐字实现）
// 全项目唯一实现；不要在手写展示逻辑里重新推导符号。

import type { UsageKind } from '@/db/types';

/**
 * 返回流水的带符号库存变化量。
 * - `consume` → `−quantity`（消耗，库存减少）
 * - `refill`  → `+quantity`（补货，库存增加）
 * - `revert`  → `+quantity`（回退，库存增加）
 * - `adjust`  → `+quantity`（adjust 的 quantity 本身已带符号 —— 正值=增加，负值=减少）
 */
export function signedDelta(kind: UsageKind, quantity: number): number {
  switch (kind) {
    case 'consume': return -quantity;
    case 'refill':  return +quantity;
    case 'revert':  return +quantity;
    case 'adjust':  return +quantity;
  }
}