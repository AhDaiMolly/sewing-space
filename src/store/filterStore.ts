// src/store/filterStore.ts — 列表筛选态（架构 §4.3）
// 不持久化：刷新回到默认值。

import { create } from 'zustand';
import type { GarmentStatus } from '@/db/types';

export type StockFilter = 'all' | 'in' | 'low' | 'out';
export type MaterialSortBy = 'createdAt' | 'quantity' | 'name' | 'updatedAt';
export type PatternUsedFilter = 'all' | 'unused' | 'used';
export type PatternSortBy = 'rating' | 'createdAt' | 'name';
export type GarmentStatusFilter = 'all' | GarmentStatus;
export type GarmentSearchInput = string;

export interface FilterState {
  // ── 物料列表 ──
  /** 物料列表：库存筛选。默认 'in'（有库存）。 */
  stockFilter: StockFilter;
  /** 物料列表：排序。默认 'createdAt'（创建时间降序）。 */
  sortBy: MaterialSortBy;
  /** 纸样视图：使用状态。默认 'unused'（未使用）。 */
  patternUsedFilter: PatternUsedFilter;
  /** 纸样视图：排序。默认 'rating'（星级降序）。 */
  patternSortBy: PatternSortBy;

  // ── 成衣列表（S3-B）──
  /** 成衣列表：状态筛选。默认 'all'（全部）。 */
  garmentStatusFilter: GarmentStatusFilter;
  /** 成衣列表：搜索框展开态（独立布尔量，不让输入状态参与自身可见性判断，PRD §8.5 缺陷 2）。 */
  garmentSearchOpen: boolean;

  setStockFilter: (v: StockFilter) => void;
  setSortBy: (v: MaterialSortBy) => void;
  setPatternUsedFilter: (v: PatternUsedFilter) => void;
  setPatternSortBy: (v: PatternSortBy) => void;
  setGarmentStatusFilter: (v: GarmentStatusFilter) => void;
  setGarmentSearchOpen: (v: boolean) => void;
  resetFilters: () => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  stockFilter: 'in',
  sortBy: 'createdAt',
  patternUsedFilter: 'unused',
  patternSortBy: 'rating',
  garmentStatusFilter: 'all',
  garmentSearchOpen: false,

  setStockFilter: (v) => set({ stockFilter: v }),
  setSortBy: (v) => set({ sortBy: v }),
  setPatternUsedFilter: (v) => set({ patternUsedFilter: v }),
  setPatternSortBy: (v) => set({ patternSortBy: v }),
  setGarmentStatusFilter: (v) => set({ garmentStatusFilter: v }),
  setGarmentSearchOpen: (v) => set({ garmentSearchOpen: v }),
  resetFilters: () =>
    set({
      stockFilter: 'in',
      sortBy: 'createdAt',
      patternUsedFilter: 'unused',
      patternSortBy: 'rating',
      garmentStatusFilter: 'all',
      garmentSearchOpen: false,
    }),
}));