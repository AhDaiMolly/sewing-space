// src/lib/patExpiry.ts
// S7-FIX P1-5：PAT 过期判定统一 UTC 日期边界（ISO 日期串比较），
// 消除东八区本地日界带来的 8 小时偏差。
// 日期格式与日历真实性双重校验：非 YYYY-MM-DD 或日历不存在的日期一律视为非法。

export interface PatExpiryInfo {
  status: 'expired' | 'valid';
  diffDays: number;
}

/** 解析 PAT 过期日（YYYY-MM-DD）相对 now（默认当前时刻）的状态。
 * - 过期判定用 UTC 日界（toISOString().slice(0,10) 字符串比较），与本地时区无关；
 * - diffDays 以 `expires 00:00 UTC` 为锚点、按整天取整，正数 = 未过期剩余天数；
 * - 非法格式 / 日历不真实日期（如 2 月 30 日）返回 null。 */
export function patExpiryInfo(expires: string, now: Date = new Date()): PatExpiryInfo | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return null;
  const year = Number(expires.slice(0, 4));
  const month = Number(expires.slice(5, 7));
  const day = Number(expires.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const anchor = Date.parse(`${expires}T00:00:00Z`);
  if (Number.isNaN(anchor)) return null;
  // 日历真实性回读校验：V8 对 '2026-02-30T00:00:00Z' 等宽松回卷不返回 NaN，
  // 必须回读 UTC 字段比对才能识破。
  const d = new Date(anchor);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  const todayUtc = now.toISOString().slice(0, 10);
  const todayAnchor = Date.parse(`${todayUtc}T00:00:00Z`);
  if (Number.isNaN(todayAnchor)) return null;
  const diffDays = Math.round((anchor - todayAnchor) / 86_400_000);
  return { status: expires < todayUtc ? 'expired' : 'valid', diffDays };
}
