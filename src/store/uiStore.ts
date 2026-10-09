// src/store/uiStore.ts — 覆盖层与一次性 UI 态（架构 §4.2）
//
// 冻结接口（架构 §4.2 逐字）：七个覆盖层态 + SW 更新提示态。
// 「函数不入 store」规则：被选中的结果通过 commitToken 递增 + 调用方 useEffect 订阅实现。
//
// 注：S2–S6 各覆盖层组件暂以本地 state 实现，尚未消费本 store 的七个覆盖层态；
// 本文件先按冻结接口落全量字段，保证 registerSW（§8.3）可用的同时接口不再变更。

import { create } from 'zustand';
import type { Task } from '@/db/types';

/** 任务表单 Sheet 的开启态。task 为 null 表示新建。 */
export interface TaskFormState {
  open: boolean;
  task: Task | null; // null = 新建；非 null = 编辑
  /** 打开时预置的纸样（从纸样选择器回填） */
  presetPatternId?: string;
  /** 打开时预置的成衣（从成衣详情发起任务） */
  presetGarmentId?: string;
}

/** 记损耗 Sheet */
export interface ConsumptionSheetState {
  open: boolean;
  materialId: string | null;
}

/** 完工确认（只读单步确认页，见 §5.7） */
export interface CompletionWizardState {
  open: boolean;
  garmentId: string | null;
}

/** 删除成衣确认 */
export interface DeleteGarmentConfirmState {
  open: boolean;
  garmentId: string | null;
}

/** 已完成任务只读详情 */
export interface DoneTaskDetailState {
  open: boolean;
  taskId: string | null;
}

/** 纸样选择器（覆盖层态，与路由 /pickers/patterns 双写，见 §5.4） */
export interface PatternPickerState {
  open: boolean;
  from: 'task' | 'garment';
  selectedId: string;
  /** 关闭后回到的路由 */
  returnTo: string;
  /** 选中回调的标识；组件通过 subscribe 读取，不用函数入 store */
  commitToken: number;
}

/** 物料选择器（同上） */
export interface MaterialPickerState {
  open: boolean;
  type: 'fabric' | 'accessory';
  selectedIds: string[];
  qtys: Record<string, number>;
  returnTo: string;
  commitToken: number;
}

export interface UiState {
  taskForm: TaskFormState;
  consumptionSheet: ConsumptionSheetState;
  completionWizard: CompletionWizardState;
  deleteGarmentConfirm: DeleteGarmentConfirmState;
  doneTaskDetail: DoneTaskDetailState;
  patternPicker: PatternPickerState;
  materialPicker: MaterialPickerState;

  /** SW 有新版本待激活（§8.3 由 registerSW 的 onNeedRefresh 置 true） */
  updateAvailable: boolean;
  /** 置位 / 复位更新提示；用户确认更新后复位为 false */
  setUpdateAvailable: (v: boolean) => void;

  openTaskForm: (init?: Partial<Omit<TaskFormState, 'open'>>) => void;
  closeTaskForm: () => void;
  openConsumptionSheet: (materialId: string) => void;
  closeConsumptionSheet: () => void;
  openCompletionWizard: (garmentId: string) => void;
  closeCompletionWizard: () => void;
  openDeleteGarmentConfirm: (garmentId: string) => void;
  closeDeleteGarmentConfirm: () => void;
  openDoneTaskDetail: (taskId: string) => void;
  closeDoneTaskDetail: () => void;
  openPatternPicker: (p: Omit<PatternPickerState, 'open' | 'commitToken'>) => void;
  commitPatternPicker: (patternId: string) => void;
  closePatternPicker: () => void;
  openMaterialPicker: (p: Omit<MaterialPickerState, 'open' | 'commitToken'>) => void;
  commitMaterialPicker: (payload: { selectedIds: string[]; qtys: Record<string, number> }) => void;
  closeMaterialPicker: () => void;

  /** 一次性关闭全部覆盖层；切 tab 或跳路由时调用（对应 demo App.jsx:58-64） */
  closeAllOverlays: () => void;
}

const INITIAL_TASK_FORM: TaskFormState = { open: false, task: null };
const INITIAL_CONSUMPTION: ConsumptionSheetState = { open: false, materialId: null };
const INITIAL_COMPLETION: CompletionWizardState = { open: false, garmentId: null };
const INITIAL_DELETE_CONFIRM: DeleteGarmentConfirmState = { open: false, garmentId: null };
const INITIAL_DONE_DETAIL: DoneTaskDetailState = { open: false, taskId: null };
const INITIAL_PATTERN_PICKER: PatternPickerState = {
  open: false,
  from: 'task',
  selectedId: '',
  returnTo: '/',
  commitToken: 0,
};
const INITIAL_MATERIAL_PICKER: MaterialPickerState = {
  open: false,
  type: 'fabric',
  selectedIds: [],
  qtys: {},
  returnTo: '/',
  commitToken: 0,
};

export const useUiStore = create<UiState>((set) => ({
  taskForm: INITIAL_TASK_FORM,
  consumptionSheet: INITIAL_CONSUMPTION,
  completionWizard: INITIAL_COMPLETION,
  deleteGarmentConfirm: INITIAL_DELETE_CONFIRM,
  doneTaskDetail: INITIAL_DONE_DETAIL,
  patternPicker: INITIAL_PATTERN_PICKER,
  materialPicker: INITIAL_MATERIAL_PICKER,

  updateAvailable: false,
  setUpdateAvailable: (v) => set({ updateAvailable: v }),

  openTaskForm: (init) =>
    set({ taskForm: { ...INITIAL_TASK_FORM, ...init, open: true } }),
  closeTaskForm: () => set({ taskForm: INITIAL_TASK_FORM }),
  openConsumptionSheet: (materialId) =>
    set({ consumptionSheet: { open: true, materialId } }),
  closeConsumptionSheet: () => set({ consumptionSheet: INITIAL_CONSUMPTION }),
  openCompletionWizard: (garmentId) => set({ completionWizard: { open: true, garmentId } }),
  closeCompletionWizard: () => set({ completionWizard: INITIAL_COMPLETION }),
  openDeleteGarmentConfirm: (garmentId) =>
    set({ deleteGarmentConfirm: { open: true, garmentId } }),
  closeDeleteGarmentConfirm: () => set({ deleteGarmentConfirm: INITIAL_DELETE_CONFIRM }),
  openDoneTaskDetail: (taskId) => set({ doneTaskDetail: { open: true, taskId } }),
  closeDoneTaskDetail: () => set({ doneTaskDetail: INITIAL_DONE_DETAIL }),
  openPatternPicker: (p) => set({ patternPicker: { ...p, open: true, commitToken: 0 } }),
  commitPatternPicker: (patternId) =>
    set((s) => ({
      patternPicker: { ...s.patternPicker, selectedId: patternId, commitToken: s.patternPicker.commitToken + 1 },
    })),
  closePatternPicker: () => set({ patternPicker: INITIAL_PATTERN_PICKER }),
  openMaterialPicker: (p) => set({ materialPicker: { ...p, open: true, commitToken: 0 } }),
  commitMaterialPicker: (payload) =>
    set((s) => ({
      materialPicker: {
        ...s.materialPicker,
        selectedIds: payload.selectedIds,
        qtys: payload.qtys,
        commitToken: s.materialPicker.commitToken + 1,
      },
    })),
  closeMaterialPicker: () => set({ materialPicker: INITIAL_MATERIAL_PICKER }),

  closeAllOverlays: () =>
    set({
      taskForm: INITIAL_TASK_FORM,
      consumptionSheet: INITIAL_CONSUMPTION,
      completionWizard: INITIAL_COMPLETION,
      deleteGarmentConfirm: INITIAL_DELETE_CONFIRM,
      doneTaskDetail: INITIAL_DONE_DETAIL,
      patternPicker: INITIAL_PATTERN_PICKER,
      materialPicker: INITIAL_MATERIAL_PICKER,
    }),
}));
