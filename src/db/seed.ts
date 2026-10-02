// src/db/seed.ts
import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import type { PresetsConfig } from '@/db/types';

/** `settings.presets` 的初值。值来源：§4.9.6 表。 */
export const DEFAULT_PRESETS: PresetsConfig = {
  // V-A Q7 口径变更：面料品牌不再预置内置数据，由用户在「设置→预设配置→
  // 面料品牌」维护，或在新增面料时点「+ 新增品牌」添加（两处同写单 'presets' 键）。
  fabricBrands: [],
  patternBrands: ['Burda', 'Vogue', 'McCall', 'Simplicity', 'Butterick', '贝蕾', '果壳', '丁香', '布想说', '其他'],
  patternStyles: ['连衣裙', '衬衫', '裤子', '外套', 'T恤', '半裙', '大衣', '旗袍', '上衣', '背带裙', '背心', '发饰'],
  accessoryTags: ['棉布', '麻布', '丝绸', '松紧', '花边', '扣子', '衬', '填充', '蕾丝', '线', '拉链', '织带'],
  patternAudiences: ['women', 'men', 'children', 'baby', 'pet'],
  patternSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '均码'],
  fabricWidths: ['130cm', '145cm', '150cm', '175cm'],
  accessoryWidths: ['1cm', '2cm', '5cm'],
  // AD-D 预设1/2：面料/辅料分类预设（初值 = MaterialForm 原代码预置清单，
  // 保证既有用户升级后表单分类选项不变；文档未改，见 ad-d-notes 口径变更记录）。
  fabricCategories: ['棉布', '麻布', '丝绸', '雪纺', '牛仔', '灯芯绒', '毛呢', '针织', '府绸', '帆布', '蕾丝', '其他'],
  accessoryCategories: ['拉链', '纽扣', '扣子', '线', '包边条', '衬', '衬布', '花边', '松紧', '织带', '螺纹', '填充', '填充棉', '烫画', '其他'],
};



/**
 * 首启种子：库为空（`onboarding_completed` 不存在）时写入：
 *   - 18 个 settings key（§4.16）
 * W-C 设置4（2026-09-29 用户验收口径）：不再写入任何任务模板——
 * 模板全部由用户自建（设置 → 任务模板）。旧版本种入的 3 个预设模板由
 * `cleanupPresetTemplates` 一次性清理（见下）。
 * 已退役的 `wizardCompleted` / `last_backup_at` / `last_sync_status` 一个都不写。
 * 整个过程在 `[db.settings]` 一个事务内完成。
 */
export async function seedIfFirstRun(): Promise<void> {
  const done = await db.settings.get('onboarding_completed');
  if (done) return; // 已初始化过，直接返回

  await db.transaction('rw', [db.settings], async () => {
    const now = new Date().toISOString();

    // 1) 18 个 settings key（§4.16）。ensure = 不存在才写。
    const ensure = async (key: string, value: string): Promise<void> => {
      const row = await db.settings.get(key);
      if (!row) await db.settings.add({ key, value, updatedAt: now });
    };

    await ensure('device_id', nanoid(12)); // 12 位，见 §4.16 说明
    await ensure('onboarding_completed', 'false');
    await ensure('import_completed', 'false');
    await ensure('user_name', '泥头李'); // AA-B 设置1：预置昵称改「泥头李」
    await ensure('sewing_years', '0');
    await ensure('backup_interval', 'daily');
    await ensure('backup_last_success', '');
    await ensure('backup_reminder_last', '');
    await ensure('dirty_since_backup', 'false');
    await ensure('dirty_since_sync', 'false');
    await ensure('last_sync_at', '');
    await ensure('last_sync_remote', '');
    await ensure('github_token', '');
    // AE-A Q3：GitHub 用户名预置 AhDaiMolly（仓库 owner；仅默认值，用户可改）。
    await ensure('github_username', 'AhDaiMolly');
    await ensure('github_repo', 'sewing-space-backup');
    await ensure('pat_expires_at', '');
    await ensure('search_history', '[]');
    await ensure('presets', JSON.stringify(DEFAULT_PRESETS));

  });
}

/** W-C 设置4：旧版本 seed 种入的 3 个预设任务模板的固定 id（DM §1.8
 *  `builtinTemplateId` 枚举；用户自建模板 id 为 12 位 nanoid，结构性不冲突）。 */
export const PRESET_TEMPLATE_IDS: readonly string[] = [
  'tmpl-skirt-std',
  'tmpl-top-std',
  'tmpl-dress-std',
];

/**
 * W-C 设置4：一次性清理存量数据里旧版本 seed 种入的 3 个预设任务模板。
 *
 * 识别依据（双重判定，记 wc-notes）：schema 有来源标记 `source` 字段——
 * 种子模板恒 `source='preset'`，用户自建模板恒 `source='custom'`
 * （createTaskTemplate / copyPresetTemplateAsCustom 是仅有的两个用户建模板
 * 入口，均写死 'custom'）。在 source 判定之上再叠加 id ∈ 三个固定内置 id
 * （`PRESET_TEMPLATE_IDS`）兜底，绝不误删用户自建模板（自建 id 为 12 位
 * nanoid，与内置 id 结构性不同）。
 *
 * 调用时机：main.tsx 启动期（seedIfFirstRun 之后）每次执行、幂等——
 * 零命中时零写入、不打脏；已清库再跑为 no-op。旧备份恢复会把 preset 行
 * 带回（备份为整表替换语义），下次启动时本函数再次清掉（自愈）。
 *
 * 模板是创建任务时的快照复制：任务的 steps / templateId 是独立副本，
 * 删模板不影响任何已建任务（DM §2.3 规则 3 / §3.4 生命周期）。
 *
 * @returns 本次实际删除的行数（0 = 无种子模板残留）。
 */
export async function cleanupPresetTemplates(): Promise<number> {
  return await db.transaction('rw', [db.taskTemplates, db.settings], async () => {
    const all = await db.taskTemplates.toArray();
    const seedRows = all.filter(
      (t) => t.source === 'preset' && PRESET_TEMPLATE_IDS.includes(t.id),
    );
    if (seedRows.length === 0) return 0;
    await db.taskTemplates.bulkDelete(seedRows.map((t) => t.id));
    await db.settings.put({
      key: 'dirty_since_backup',
      value: 'true',
      updatedAt: new Date().toISOString(),
    });
    return seedRows.length;
  });
}
