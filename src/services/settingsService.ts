// src/services/settingsService.ts
//
// 设置页预设读写函数：fabricWidths / accessoryWidths 的增删改。
// 按数据模型 v2.0 §4.9.6 规则实现：
//   - Add→trim 后非空、不重复、1–20 字（重复提示「该项已存在」）
//   - Delete→直接删，不做引用计数检查
//   - Edit→校验后原位替换（不同位置重复同样报「该项已存在」）
//   - 写入是一整个 put（§4.9.6 规则 6）
// 供 S7 设置页使用。无界面。

import { db } from '@/db/schema';
import { DEFAULT_PRESETS } from '@/db/seed';
import type { PresetsConfig } from '@/db/types';

// ============================ 内部：读写 settings.presets ============================

const PRESETS_KEYS: (keyof PresetsConfig)[] = [
  'fabricBrands',
  'patternBrands',
  'patternStyles',
  'accessoryTags',
  'patternAudiences',
  'patternSizes',
  'fabricWidths',
  'accessoryWidths',
];

async function readPresets(): Promise<PresetsConfig> {
  const row = await db.settings.get('presets');
  if (!row) return { ...DEFAULT_PRESETS };
  try {
    const parsed = JSON.parse(row.value);
    for (const k of PRESETS_KEYS) {
      if (!Array.isArray(parsed[k])) throw new Error(`presets.${k} 不是数组`);
    }
    return parsed as PresetsConfig;
  } catch {
    // DM §3.7 HC5 / §4.9.6 规则 7：解析失败回落默认值并回写。
    const fallback = { ...DEFAULT_PRESETS };
    await db.settings.put({
      key: 'presets',
      value: JSON.stringify(fallback),
      updatedAt: new Date().toISOString(),
    });
    return fallback;
  }
}

async function writePresets(p: PresetsConfig): Promise<void> {
  await db.settings.put({
    key: 'presets',
    value: JSON.stringify(p),
    updatedAt: new Date().toISOString(),
  });
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