// src/lib/quantityInput.ts — AD-A 物料5：物料表单「数量」输入解析
//
// 根因背景：MaterialForm 数量输入的 onChange 曾写 `Number(e.target.value)`，
// 把 V-A Q3 的字符串态就地转回 number——① 输入框清空时 Number('') === 0，
// 「0 删不掉」；② 提交校验走 form.quantity.trim()，number 没有 trim，
// 抛 TypeError: m.quantity.trim is not a function，只要改过数量就永远提交不了。
//
// 修复口径：onChange 保持字符串原样入 state；提交时统一走本模块解析，
// 错误语义与 V-A Q3 一致（空值/非数 → 「请输入数量」；负数 → 「数量不能为负」）。

export type QuantityParseResult =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'not_number' | 'negative' };

/** 解析表单数量字符串。不做任何自动回填（V-A Q3：空值由校验拦截，不补 0）。 */
export function parseQuantityInput(raw: string): QuantityParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty' };
  }
  const num = Number(trimmed);
  if (Number.isNaN(num)) {
    return { ok: false, reason: 'not_number' };
  }
  if (num < 0) {
    return { ok: false, reason: 'negative' };
  }
  return { ok: true, value: num };
}

/** 解析失败 → 用户可读 toast 文案（与 V-A Q3 既有文案逐字一致）。 */
export function quantityErrorMessage(reason: 'empty' | 'not_number' | 'negative'): string {
  if (reason === 'negative') return '数量不能为负';
  return '请输入数量';
}
