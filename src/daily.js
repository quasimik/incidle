// ---------------------------------------------------------------------------
// DAILY SCHEDULE — day #1 is DAILY_EPOCH; day numbers count local calendar
// days from it. All date math runs at local noon so DST shifts can't move a
// day boundary.
// ---------------------------------------------------------------------------
export const DAILY_EPOCH = "2026-07-07";

export function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localNoon(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
export function dayNumber(dateStr) {
  return Math.round((localNoon(dateStr) - localNoon(DAILY_EPOCH)) / 864e5);
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return toDateStr(new Date(y, m - 1, d + n, 12));
}
export function fmtShort(dateStr) {
  return localNoon(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
