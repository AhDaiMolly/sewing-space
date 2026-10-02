// src/services/settingsService.ts
//
// 设置页预设读写函数：fabricWidths / accessoryWidths 的增删改。
// 按数据模型 v2.0 §4.9.6 规则实现：
//   - Add→trim 后非空、不重复、1–20 字（重复提示「该项已存在」）
//   - Delete→直接删，不做引用计数检查
//   - Edit→校验后原位替换（不同位置重复同样报「该项已存在」）
//   - 写入是一整个 put（§4.9.6 规则 6）
// 供 S7 设置页使用。无界面。
//
// S7-a（7-1）：按 DM §4.16 / §5.10 六 / §5.11 逐 key 核齐 18 个 key 的
// 白名单、校验与读取默认值口径：
//   - setSetting 第 4 步语义校验按 §5.11 四逐 key 补齐（ISO 时刻串收紧为
//     §8.6 严格格式；last_sync_remote 恢复「任意字符串」；dirty_since_backup
//     补 true/false；presets 走 §11 PresetsConfigSchema；search_history 补 ≤10 条）
//   - getSettingValue 读缺失 key 返回 §4.16 初值且不回写（§3.7 硬约束 4）；
//     user_name 读时空串/纯空白回落「泥头李」不回写（§4.16；AA-B 设置1 预置昵称改「泥头李」）
//   - 补 DM P10 / arch §6.7 冻结签名：updatePresets / getSettings
//   - 内部 writePresets 收进 setSetting 单事务（§5.10 六「事务」条）
// 不推翻 S6 既有调用路径与函数签名。

import { db } from '@/db/schema';
import { DEFAULT_PRESETS } from '@/db/seed';
import {
  PresetsConfigSchema,
  RESTORE_FROM_ZIP_KEYS,
  SETTINGS_KEYS,
  firstIssueMessage,
  type SettingsKey,
} from '@/db/schemas';
import type { PresetsConfig } from '@/db/types';

// ============================ 读取默认值（DM §4.16 初值列，§3.7 硬约束 4） ============================
// 读缺失 key 返回这里的默认值，且不回写。默认值的唯一权威是 §4.16 的表，
// 不是数据库里的行。device_id 的初值是「首启生成」，没有静态默认串，读侧
// 不伪造（缺失回落 ''，生成只属于 seedIfFirstRun 一个入口）。

export const SETTINGS_DEFAULTS: Record<SettingsKey, string> = {
  device_id: '',
  onboarding_completed: 'false',
  // AA-B 设置1：预置昵称由「缝纫人」改为「泥头李」（用户 2026-09-30 验收口径）。
  user_name: '泥头李',
  sewing_years: '0',
  backup_last_success: '',
  backup_reminder_last: '',
  backup_interval: 'daily',
  import_completed: 'false',
  github_token: '',
  // AE-A Q3：GitHub 用户名预置 AhDaiMolly（仅默认值；与 seed.ts / SettingsPage /
  // WizardPage 三处预置口径一致，用户可改，校验逻辑不变——详见 ae-a-notes）。
  github_username: 'AhDaiMolly',
  github_repo: 'sewing-space-backup',
  pat_expires_at: '',
  last_sync_at: '',
  last_sync_remote: '',
  dirty_since_sync: 'false',
  dirty_since_backup: 'false',
  presets: JSON.stringify(DEFAULT_PRESETS),
  search_history: '[]',
};

// ============================ 通用写路径：setSetting（DM §5.11，S6-fix P2-1 / P1-3） ============================

const SETTING_VALUE_MAX_LENGTH = 100000; // §3.7 硬约束 3

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // §8.4 日期格式

/** §8.6 时刻串：`YYYY-MM-DDTHH:MM:SS.sssZ`（与 §11 isoDateTime 同一口径）。 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isIsoDateTimeOrEmpty(value: string): boolean {
  return value === '' || ISO_DATETIME_RE.test(value);
}

/** presets 值校验（DM §5.11 四：走 §5.10 第六条的 §11 PresetsConfig schema）。 */
function validatePresetsJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('presets 必须是合法的 JSON 对象');
  }
  const result = PresetsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`presets 校验失败：${firstIssueMessage(result.error)}`);
  }
}

/**
 * DM §5.11 一：`setSetting(key, value)` 的固定六步。
 * 1. key 必须在 §4.16 的 18 项内，否则抛错；
 * 2. value 必须是字符串；
 * 3. 长度 > 100000 抛错（不截断）；
 * 4. 按 key 做语义校验（§5.11 四的逐 key 规则表）；
 * 5. 事务内写入；
 * 6. 打脏按 key 分支：`RESTORE_FROM_ZIP_KEYS` 5 项打脏，其余 13 项不打脏。
 * S6-fix P2-1：GitHub 配置读写、清除令牌、备份频率切换统一走本函数，
 * 不再从 UI 直写 db.settings。
 */
export async function setSetting(key: SettingsKey, value: string): Promise<void> {
  // 第 1 步：key 白名单（SettingsKey 类型已收窄，这里再运行时防御一次）。
  if (!SETTINGS_KEYS.includes(key)) {
    throw new Error(`未声明的 settings key: ${key}`);
  }
  // 第 2 步：value 必须是字符串。
  if (typeof value !== 'string') {
    throw new Error('settings 值必须是字符串');
  }
  // 第 3 步：长度兜底（不截断）。
  if (value.length > SETTING_VALUE_MAX_LENGTH) {
    throw new Error('设置值过长');
  }
  // 第 4 步：逐 key 语义校验与规范化（DM §5.11 四）。
  let normalized = value;
  switch (key) {
    case 'user_name': {
      const trimmed = value.trim();
      if (trimmed === '') {
        normalized = '泥头李'; // 空串回落，不抛错（§4.16；AA-B 设置1 预置昵称改「泥头李」）
      } else if (trimmed.length > 20) {
        throw new Error('昵称不能超过 20 个字符');
      } else {
        normalized = trimmed;
      }
      break;
    }
    case 'sewing_years': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('缝纫年数必须是数字');
      const clamped = Math.min(99, Math.max(0, n)); // 越界钳制并回写（§4.16）
      normalized = String(clamped);
      break;
    }
    case 'backup_interval':
      if (value !== 'daily' && value !== 'manual') {
        throw new Error('备份频率只支持 daily 或 manual');
      }
      break;
    case 'onboarding_completed':
    case 'import_completed':
      if (value !== 'true' && value !== 'false') {
        throw new Error('该设置只接受 true 或 false');
      }
      break;
    case 'github_repo':
    case 'github_username':
    case 'github_token':
      normalized = value.trim(); // 允许空串；令牌写前不校验格式（§4.16）
      break;
    case 'pat_expires_at':
      if (value !== '' && !DATE_RE.test(value)) {
        throw new Error('过期日必须是 YYYY-MM-DD 格式或留空');
      }
      break;
    case 'device_id':
      throw new Error('device_id 只读，不允许修改');
    case 'backup_last_success':
    case 'backup_reminder_last':
    case 'last_sync_at':
      // §4.16 值形态：ISO 时刻串或空串（§8.6 严格格式，日期串不算时刻串）。
      if (!isIsoDateTimeOrEmpty(value)) throw new Error('该设置必须是 ISO 时刻串或空串');
      break;
    case 'last_sync_remote':
      // §4.16 值形态「字符串或 ''」：远端标识，任意字符串都合法，不做改写。
      break;
    case 'dirty_since_sync':
    case 'dirty_since_backup':
      if (value !== 'true' && value !== 'false') {
        throw new Error('该设置只接受 true 或 false');
      }
      break;
    case 'presets':
      validatePresetsJson(value); // §5.11 四：走 §11 PresetsConfig schema，枚举违例抛中文错误
      break;
    case 'search_history': {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== 'string')) {
        throw new Error('search_history 必须是字符串数组');
      }
      // §4.16 值形态「≤10 条」：超限拒绝写入，不静默截断（同 §3.7 硬约束 3 哲学）。
      if (parsed.length > 10) {
        throw new Error('search_history 最多 10 条');
      }
      break;
    }
    default:
      break;
  }
  // 第 5 + 6 步：事务内写入 + 按 key 打脏（FROM_ZIP 5 项打脏，其余不打脏）。
  const now = new Date().toISOString();
  await db.transaction('rw', [db.settings], async () => {
    await db.settings.put({ key, value: normalized, updatedAt: now });
    if ((RESTORE_FROM_ZIP_KEYS as readonly string[]).includes(key)) {
      await db.settings.put({ key: 'dirty_since_backup', value: 'true', updatedAt: now });
    }
  });
}

/**
 * 读取单个 settings 值（§3.7 生命周期 2 + 硬约束 4）：
 * 行缺失时返回 §4.16 初值（SETTINGS_DEFAULTS），**不回写**；
 * `user_name` 读到空串/纯空白时回落 `'泥头李'`，同样不回写（§4.16；AA-B 设置1）。
 */
export async function getSettingValue(key: SettingsKey): Promise<string> {
  const row = await db.settings.get(key);
  const raw = row?.value ?? SETTINGS_DEFAULTS[key];
  if (key === 'user_name' && raw.trim() === '') {
    return '泥头李';
  }
  return raw;
}

/**
 * 批量读多个 settings key（arch §6.7 冻结签名），供页面初始化一次取多 key。
 * 口径与 getSettingValue 一致：缺失回落 §4.16 初值，不回写。
 */
export async function getSettings(
  keys: readonly SettingsKey[],
): Promise<Record<SettingsKey, string>> {
  const rows = await db.settings.bulkGet([...keys]);
  const out = {} as Record<SettingsKey, string>;
  keys.forEach((key, i) => {
    const raw = rows[i]?.value ?? SETTINGS_DEFAULTS[key];
    out[key] = key === 'user_name' && raw.trim() === '' ? '泥头李' : raw;
  });
  return out;
}

// ============================ 内部：读写 settings.presets ============================

async function readPresets(): Promise<PresetsConfig> {
  const row = await db.settings.get('presets');
  if (!row) return { ...DEFAULT_PRESETS };
  const result = PresetsConfigSchema.safeParse(jsonLoose(row.value));
  if (result.success) {
    return result.data;
  }
  // DM §3.7 硬约束 5 / §5.10 六「读」条：坏值（JSON 解析失败或 schema 不过，
  // 含 patternAudiences 枚举违例）回落默认值并回写，记一次 console 警告。
  console.warn('settings.presets 坏值，已回落默认预设并回写', result.error.issues[0]?.path);
  const fallback = { ...DEFAULT_PRESETS };
  await db.settings.put({
    key: 'presets',
    value: JSON.stringify(fallback),
    updatedAt: new Date().toISOString(),
  });
  return fallback;
}

/** JSON.parse 的宽松包装：解析失败返回 undefined（由调用方按坏值处置）。 */
function jsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * P10 `updatePresets`（DM §5.11 开头：setSetting 的特例，只写 presets 一个 key）。
 * 校验、事务与打脏全部复用 setSetting 的通用路径（§5.10 六）。
 */
export async function updatePresets(presets: PresetsConfig): Promise<void> {
  await setSetting('presets', JSON.stringify(presets));
}

async function writePresets(p: PresetsConfig): Promise<void> {
  // §5.10 六「写 / 校验 / 事务」三条：写前过 §11 schema，presets ∈
  // RESTORE_FROM_ZIP_KEYS 故随包打脏；事务为 db.transaction('rw', db.settings)。
  // 经 setSetting 通用路径落库（单事务），替代原先 put + 打脏两次独立写。
  await setSetting('presets', JSON.stringify(p));
}

// ============================ 通用校验 ============================

function validateItem(item: string, label: string): string {
  const trimmed = item.trim();
  if (!trimmed) throw new Error(`${label}不能为空`);
  if (trimmed.length > 20) throw new Error(`${label}不能超过 20 个字符`);
  return trimmed;
}

// ============================ 读取 ============================

export async function getPresetFabricWidths(): Promise<string[]> {
  const p = await readPresets();
  return [...p.fabricWidths];
}

export async function getPresetAccessoryWidths(): Promise<string[]> {
  const p = await readPresets();
  return [...p.accessoryWidths];
}

// ============================ 新增 ============================

export async function addPresetFabricWidth(item: string): Promise<void> {
  const validated = validateItem(item, '幅宽预设');
  const p = await readPresets();
  if (p.fabricWidths.includes(validated)) throw new Error('该项已存在');
  p.fabricWidths = [...p.fabricWidths, validated];
  await writePresets(p);
}

export async function addPresetAccessoryWidth(item: string): Promise<void> {
  const validated = validateItem(item, '幅宽预设');
  const p = await readPresets();
  if (p.accessoryWidths.includes(validated)) throw new Error('该项已存在');
  p.accessoryWidths = [...p.accessoryWidths, validated];
  await writePresets(p);
}

// ============================ 删除 ============================

export async function removePresetFabricWidth(item: string): Promise<void> {
  const p = await readPresets();
  p.fabricWidths = p.fabricWidths.filter((w) => w !== item);
  await writePresets(p);
}

export async function removePresetAccessoryWidth(item: string): Promise<void> {
  const p = await readPresets();
  p.accessoryWidths = p.accessoryWidths.filter((w) => w !== item);
  await writePresets(p);
}

// ============================ 原位替换 ============================

export async function updatePresetFabricWidth(index: number, value: string): Promise<void> {
  const validated = validateItem(value, '幅宽预设');
  const p = await readPresets();
  if (index < 0 || index >= p.fabricWidths.length) throw new Error('索引越界');
  const old = p.fabricWidths[index] as string;
  if (validated !== old && p.fabricWidths.some((w, i) => i !== index && w === validated)) {
    throw new Error('该项已存在');
  }
  p.fabricWidths = p.fabricWidths.map((w, i) => (i === index ? validated : w));
  await writePresets(p);
}

export async function updatePresetAccessoryWidth(index: number, value: string): Promise<void> {
  const validated = validateItem(value, '幅宽预设');
  const p = await readPresets();
  if (index < 0 || index >= p.accessoryWidths.length) throw new Error('索引越界');
  const old = p.accessoryWidths[index] as string;
  if (validated !== old && p.accessoryWidths.some((w, i) => i !== index && w === validated)) {
    throw new Error('该项已存在');
  }
  p.accessoryWidths = p.accessoryWidths.map((w, i) => (i === index ? validated : w));
  await writePresets(p);
}