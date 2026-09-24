// src/db/seed.ts
import { nanoid } from 'nanoid';
import { db } from '@/db/schema';
import type { PresetsConfig, TaskTemplate } from '@/db/types';

/** `settings.presets` 的初值。值来源：§4.9.6 表。 */
export const DEFAULT_PRESETS: PresetsConfig = {
  fabricBrands: ['优衣库', '无印良品', '江南布衣', '全棉时代', 'ZARA', 'H&M', 'UR', '淘宝自制', '拼多多白牌', '1688工厂', '日本进口', '韩国代购', '其他'],
  patternBrands: ['Burda', 'Vogue', 'McCall', 'Simplicity', 'Butterick', '贝蕾', '果壳', '丁香', '布想说', '其他'],
  patternStyles: ['连衣裙', '衬衫', '裤子', '外套', 'T恤', '半裙', '大衣', '旗袍', '上衣', '背带裙', '背心', '发饰'],
  accessoryTags: ['棉布', '麻布', '丝绸', '松紧', '花边', '扣子', '衬', '填充', '蕾丝', '线', '拉链', '织带'],
  patternAudiences: ['women', 'men', 'children', 'baby', 'pet'],
  patternSizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '均码'],
  fabricWidths: ['130cm', '145cm', '150cm', '175cm'],
  accessoryWidths: ['1cm', '2cm', '5cm'],
};

/** 3 个内置任务模板。值来源：§4.14。**不含 `source` / `createdAt` / `updatedAt`**——这三项由 `seedIfFirstRun` 写入时补（见本节上方 `{ ...t, source: 'preset', createdAt: now, updatedAt: now }`）。 */
export const DEFAULT_TASK_TEMPLATES: ReadonlyArray<
  Pick<TaskTemplate, 'id' | 'name' | 'description' | 'category' | 'steps' | 'tags'>
> = [
  {
    id: 'tmpl-skirt-std',
    name: '半身裙',
    description: '半身裙裁缝基本步骤',
    category: '半身裙',
    steps: [
      { title: '量体 & 选纸样', order: 1 },
      { title: '采购布料辅料', order: 2 },
      { title: '裁剪裙片', order: 3 },
      { title: '缝合侧缝', order: 4 },
      { title: '装拉链 & 腰头', order: 5 },
      { title: '锁边 & 整烫', order: 6 },
      { title: '完工登记', order: 7 },
    ],
    tags: ['半身裙'],
  },
  {
    id: 'tmpl-top-std',
    name: '上衣基础',
    description: '基础款上装缝制',
    category: '上衣基础',
    steps: [
      { title: '量体 & 选纸样', order: 1 },
      { title: '采购布料辅料', order: 2 },
      { title: '裁剪前/后片', order: 3 },
      { title: '缝合肩缝 & 侧缝', order: 4 },
      { title: '做领子 & 装袖子', order: 5 },
      { title: '锁扣眼 & 钉扣', order: 6 },
      { title: '整烫 & 完工', order: 7 },
    ],
    tags: ['上衣'],
  },
  {
    id: 'tmpl-dress-std',
    name: '连衣裙',
    description: '从裁剪到完工的完整步骤',
    category: '连衣裙',
    steps: [
      { title: '量体 & 选纸样', order: 1 },
      { title: '采购布料辅料', order: 2 },
      { title: '裁剪布料', order: 3 },
      { title: '缝合主体', order: 4 },
      { title: '装袖子/领子', order: 5 },
      { title: '锁边 & 熨烫', order: 6 },
      { title: '完工登记', order: 7 },
    ],
    tags: ['连衣裙'],
  },
];

/**
 * 首启种子：库为空（`onboarding_completed` 不存在）时写入：
 *   - 18 个 settings key（§4.16）
 *   - 3 个内置任务模板（§4.14）
 * 已退役的 `wizardCompleted` / `last_backup_at` / `last_sync_status` 一个都不写。
 * 整个过程在 `[db.settings, db.taskTemplates]` 一个事务内完成。
 */
export async function seedIfFirstRun(): Promise<void> {
  const done = await db.settings.get('onboarding_completed');
  if (done) return; // 已初始化过，直接返回

  await db.transaction('rw', [db.settings, db.taskTemplates], async () => {
    const now = new Date().toISOString();

    // 1) 18 个 settings key（§4.16）。ensure = 不存在才写。
    const ensure = async (key: string, value: string): Promise<void> => {
      const row = await db.settings.get(key);
      if (!row) await db.settings.add({ key, value, updatedAt: now });
    };

    await ensure('device_id', nanoid(12)); // 12 位，见 §4.16 说明
    await ensure('onboarding_completed', 'false');
    await ensure('import_completed', 'false');
    await ensure('user_name', '缝纫人');
    await ensure('sewing_years', '0');
    await ensure('backup_interval', 'daily');
    await ensure('backup_last_success', '');
    await ensure('backup_reminder_last', '');
    await ensure('dirty_since_backup', 'false');
    await ensure('dirty_since_sync', 'false');
    await ensure('last_sync_at', '');
    await ensure('last_sync_remote', '');
    await ensure('github_token', '');
    await ensure('github_username', '');
    await ensure('github_repo', 'sewing-space-backup');
    await ensure('pat_expires_at', '');
    await ensure('search_history', '[]');
    await ensure('presets', JSON.stringify(DEFAULT_PRESETS));

    // 2) 3 个内置任务模板（§4.14）。
    for (const t of DEFAULT_TASK_TEMPLATES) {
      const exist = await db.taskTemplates.get(t.id);
      if (!exist) {
        await db.taskTemplates.add({
          ...t,
          source: 'preset',
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });
}
