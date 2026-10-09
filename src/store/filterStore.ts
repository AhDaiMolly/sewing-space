// src/store/filterStore.ts — 列表筛选态（架构 §4.3）
// 不持久化：刷新回到默认值。
//
// AA-C 口径（记入 notes，不改架构文档）：
// 1. 物料1：物料列表上下文（页签/搜索词/滚动位置）从组件局部 state 迁入本 store
//    （内存态、不落库），详情返回后可恢复；刷新仍回默认值（与原「不持久化」口径一致）。
// 2. 物料2：非纸样列表排序按品类独立记忆（sortByMap），面料/工具默认「购入时间由近及远」，
//    辅料默认维持「创建时间」（用户原文只点名面料/工具，辅料不改）。
//
// AD-B 口径（记入 notes，不改架构文档）：
// - 物料9：切换物料页签时清空搜索词（每个页签进入时为干净搜索态）；
//   详情返回恢复的语义不变（返回不经过 setMaterialTab）。
// - 物料10：去掉「创建时间」排序选项，三类默认统一「购入时间由近及远」
//   （辅料原默认 createdAt 一并改 purchaseDate；'createdAt' 保留在类型联合中
//   仅作遗留值兜底，组件侧归一到 purchaseDate）。
// - 物料14：纸样排序按使用状态区分——未使用默认/仅提供「购入时间」（由近及远），
//   已使用默认/仅提供「星级」；setPatternUsedFilter 联动重置 patternSortBy。

import { create } from 'zustand';
import type { GarmentStatus, MaterialType } from '@/db/types';

export type StockFilter = 'all' | 'in' | 'low' | 'out';
export type MaterialSortBy = 'createdAt' | 'purchaseDate' | 'quantity' | 'name' | 'updatedAt';
export type PatternUsedFilter = 'all' | 'unused' | 'used';
export type PatternSortBy = 'rating' | 'purchaseDate' | 'createdAt' | 'name';
export type GarmentStatusFilter = 'all' | GarmentStatus;
export type GarmentSearchInput = string;

/** 非纸样物料列表品类（有库存筛选与 sortByMap 排序的那三类）。 */
export type MaterialListType = Exclude<MaterialType, 'pattern'>;

/** AD-B 物料10：三类默认排序统一「购入时间由近及远」。 */
export const DEFAULT_SORT_BY: Record<MaterialListType, MaterialSortBy> = {
  fabric: 'purchaseDate',
  accessory: 'purchaseDate',
  tool: 'purchaseDate',
};

/** AD-B 物料14：纸样排序随使用状态联动。未使用=购入时间（由近及远）；已使用=星级。 */
export function patternSortByForUsed(used: PatternUsedFilter): PatternSortBy {
  return used === 'used' ? 'rating' : 'purchaseDate';
}

const DEFAULT_TAB: MaterialType = 'fabric';

export interface FilterState {
  // ── 物料列表 ──
  /** 物料列表：库存筛选。默认 'in'（有库存）。 */
  stockFilter: StockFilter;
  /** 物料列表：排序，按品类独立记忆。AA-C 物料2 起取代原共享 sortBy。 */
  sortByMap: Record<MaterialListType, MaterialSortBy>;
  /** 物料列表：当前页签。AA-C 物料1：迁入 store 以便详情返回恢复。 */
  materialTab: MaterialType;
  /** 物料列表：搜索框输入。AA-C 物料1：迁入 store 以便详情返回恢复。 */
  materialSearch: string;
  /** 物料列表：滚动容器 scrollTop。AA-C 物料1：离开列表时记录，返回时回填。 */
  materialScrollTop: number;
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
  setSortByFor: (type: MaterialListType, v: MaterialSortBy) => void;
  setMaterialTab: (v: MaterialType) => void;
  setMaterialSearch: (v: string) => void;
  setMaterialScrollTop: (v: number) => void;
  setPatternUsedFilter: (v: PatternUsedFilter) => void;
  setPatternSortBy: (v: PatternSortBy) => void;
  setGarmentStatusFilter: (v: GarmentStatusFilter) => void;
  setGarmentSearchOpen: (v: boolean) => void;
  resetFilters: () => void;
}

export const useFilterStore = create<FilterState>((set) => ({
  stockFilter: 'in',
  sortByMap: { ...DEFAULT_SORT_BY },
  materialTab: DEFAULT_TAB,
  materialSearch: '',
  materialScrollTop: 0,
  patternUsedFilter: 'unused',
  // AD-B 物料14：默认视图「未使用」→ 默认排序购入时间（由近及远）
  patternSortBy: 'purchaseDate',
  garmentStatusFilter: 'all',
  garmentSearchOpen: false,

  setStockFilter: (v) => set({ stockFilter: v }),
  setSortByFor: (type, v) => set((s) => ({ sortByMap: { ...s.sortByMap, [type]: v } })),
  // AD-B 物料9：切页签 = 进入新的列表上下文，搜索词一并清空（每个页签进入时为干净搜索态）；
  // 详情返回恢复不经过本 action，AA-C 物料1 的恢复语义不变。
  setMaterialTab: (v) => set({ materialTab: v, materialSearch: '' }),
  setMaterialSearch: (v) => set({ materialSearch: v }),
  setMaterialScrollTop: (v) => set({ materialScrollTop: v }),
  // AD-B 物料14：使用状态与排序联动——「已使用」默认星级，其余默认购入时间
  setPatternUsedFilter: (v) =>
    set({ patternUsedFilter: v, patternSortBy: patternSortByForUsed(v) }),
  setPatternSortBy: (v) => set({ patternSortBy: v }),
  setGarmentStatusFilter: (v) => set({ garmentStatusFilter: v }),
  setGarmentSearchOpen: (v) => set({ garmentSearchOpen: v }),
  resetFilters: () =>
    set({
      stockFilter: 'in',
      sortByMap: { ...DEFAULT_SORT_BY },
      materialTab: DEFAULT_TAB,
      materialSearch: '',
      materialScrollTop: 0,
      patternUsedFilter: 'unused',
      patternSortBy: 'purchaseDate',
      garmentStatusFilter: 'all',
      garmentSearchOpen: false,
    }),
}));
