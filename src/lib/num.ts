// src/lib/num.ts
//
// 数值精度基元（DM §11.4 逐字）：round2 的唯一实现点，schemas.ts 只
// import 不重复定义。容差比较的唯一权威也在 §11.4——两位小数的数
// 相等判定用 Math.round(a*100)===Math.round(b*100)，容差为 0。

/** 两位小数四舍五入（DM §11.4）。 */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

/** 「最多两位小数」。用乘法后取整比较，不用 toFixed，也不用字符串。 */
export const hasAtMost2Decimals = (v: number): boolean =>
  Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

/** 「最多一位小数」，只有 `materials.width` 用它。 */
export const hasAtMost1Decimals = (v: number): boolean =>
  Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
