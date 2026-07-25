/** Stamped onto `updates.week_id` at insert time, e.g. "2026-W23". */
export function currentWeekId(): string {
  const now = new Date();
  // ISO week: YYYY-Www
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000);
  const weekNum = Math.ceil((dayOfYear + jan4.getDay()) / 7);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
