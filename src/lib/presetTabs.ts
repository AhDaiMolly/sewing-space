// src/lib/presetTabs.ts —— 预设管理页 tab 配置（S7-FIX P0-2，PRD §12.7 / §12.8）
//
// 唯一权威：PRD §12.7「六个页签」——AA-D 物料6 口径变更（用户反馈第 4 棒
// 物料6）：物料表单去掉标签字段后，设置-预设管理同步移除「标签预设」入口，
// 六 tab 缩为五 tab（款式/人群/尺码/面料品牌/纸样品牌），推翻 PRD §12.7
// 「不得增删」口径，文档未改，见 ad-notes 口径变更记录。
// AD-D 预设1/2 口径变更（用户验收 AD 系第 4 棒）：新增「面料分类」「辅料分类」
// 两个 tab（与新增/编辑面料、辅料表单的分类下拉联动），五 tab 扩为七 tab；
// 文档未改，见 ad-d-notes 口径变更记录。工具分类已在 AD-B 物料15 移除，
// 不设「工具分类」tab。
// 面料幅宽 / 辅料幅宽两个子键不设页签（PRD 产品裁定），数据层键、种子与
// settingsService 的幅宽读写函数全部保留不动，仅 UI 不展示（物料表单的幅宽
// 快捷选项仍从 settingsService 读取）。
//
// 本模块独立成文件的目的：让 test-services 可以对 tab 的名称、顺序、只读
// 归属、文案逐字性做断言（S7-FIX 验收门槛第 6 条的断言证据）。

/** 只读 tab 的说明文案（PRD §12.7 原文，逐字）。 */
export const PRESET_READONLY_NOTICE = '此项为内置清单，暂不支持修改';

/** 删除确认文案（PRD §12.8 原文，逐字）：确定删除「<值>」吗？ */
export function presetDeleteConfirmText(value: string): string {
  return `确定删除「${value}」吗？`;
}

/** 重复提示文案（PRD §12.8 统一，不分页签）。 */
export const PRESET_DUPLICATE_TEXT = '该项已存在';

/** 人群选项的中文标签（PRD §12.7：展示中文标签：女 / 男 / 儿童 / 婴儿 / 宠物）。 */
export const AUDIENCE_LABELS: Record<string, string> = {
  women: '女',
  men: '男',
  children: '儿童',
  baby: '婴儿',
  pet: '宠物',
};

/** 预设子键（各 tab 对应的 PresetsConfig 字段）。 */
export type PresetTabKey =
  | 'patternStyles'
  | 'patternAudiences'
  | 'patternSizes'
  | 'fabricCategories'
  | 'accessoryCategories'
  | 'fabricBrands'
  | 'patternBrands';

export interface PresetTabDef {
  key: PresetTabKey;
  label: string;
  readonly: boolean;
}

/** 七 tab 固定定义：顺序固定、名称逐字。W-B 口径变更（用户反馈第二棒
 * 设置8）：款式/标签/人群三个 tab 由只读改为可增删，推翻 PRD §12.7「只读」口径；
 * AA-D 物料6：移除「标签预设」tab（accessoryTags），文档未改，见 ad-notes
 * 口径变更记录；AD-D 预设1/2：新增「面料分类」「辅料分类」两 tab（位于尺码
 * 预设与面料品牌之间），文档未改，见 ad-d-notes 口径变更记录。 */
export const PRESET_TABS: readonly PresetTabDef[] = [
  { key: 'patternStyles', label: '款式预设', readonly: false },
  { key: 'patternAudiences', label: '人群选项', readonly: false },
  { key: 'patternSizes', label: '尺码预设', readonly: false },
  { key: 'fabricCategories', label: '面料分类', readonly: false },
  { key: 'accessoryCategories', label: '辅料分类', readonly: false },
  { key: 'fabricBrands', label: '面料品牌', readonly: false },
  { key: 'patternBrands', label: '纸样品牌', readonly: false },
];

/** 各 tab 底部说明文案。W-B：前三 tab 改为可编辑说明（原只读文案
 * PRESET_READONLY_NOTICE 保留导出、不再作为 tab hint 使用）；后三照搬参照
 * 实现（demo）的措辞，逐字——PRD §12.7「后三个页签的说明文案（照搬参照实现
 * 的措辞，逐字）」，纸样品牌为面料品牌文案的同构替换（「面料」→「纸样」）。 */
export const PRESET_TAB_HINTS: Record<PresetTabKey, string> = {
  patternStyles: '点击款式名称可编辑；支持自由新增与删除款式预设。',
  patternAudiences: '支持自由新增与删除人群选项；内置五项显示为中文标签。',
  patternSizes:
    '点击尺码名称可编辑；支持字母码（S/M/L）、数字码（38/40）、文字码（均码）等任意格式。',
  fabricCategories: '点击分类名称可编辑；新增的分类会同步出现在新增面料时的分类选择列表中。',
  accessoryCategories: '点击分类名称可编辑；新增的分类会同步出现在新增辅料时的分类选择列表中。',
  fabricBrands: '点击品牌名可编辑；新增的品牌会同步出现在新增面料时的品牌选择列表中。',
  patternBrands: '点击品牌名可编辑；新增的品牌会同步出现在新增纸样时的品牌选择列表中。',
};
