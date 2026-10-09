// src/lib/routes.ts（供组件引用，避免字符串散落）
// SettingsSubPage 的联合定义见架构文档 §3.4 与 §5.3；S1 阶段 SettingsPage.tsx 尚未落，
// 先在此处本地声明以保持 routes.ts 的强类型约束；后续 S5/S7 落 SettingsPage 时将类型迁回 §5.3 定义点。
export type SettingsSubPage = 'backup' | 'github' | 'templates' | 'presets' | 'about' | 'profile';

export const ROUTES = {
  home: '/',
  materials: '/materials',
  materialNew: '/materials/new',
  materialDetail: (id: string) => `/materials/${id}`,
  materialEdit: (id: string) => `/materials/${id}/edit`,
  garments: '/garments',
  garmentNew: '/garments/new',
  garmentDetail: (id: string) => `/garments/${id}`,
  garmentEdit: (id: string) => `/garments/${id}/edit`,
  workbench: '/workbench',
  stats: '/stats',
  settings: '/settings',
  settingsSub: (s: SettingsSubPage) => `/settings/${s}`,
  wizard: '/wizard',
  pickerPatterns: '/pickers/patterns',
  pickerMaterials: '/pickers/materials',
} as const;