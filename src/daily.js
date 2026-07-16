// ---------------------------------------------------------------------------
// DAILY SCHEDULE — day #1 is DAILY_EPOCH; day numbers count SF (America/
// Los_Angeles) calendar days from it. The day flips at SF midnight for
// everyone: the server refuses to serve days beyond SF-today (api/incidents
// gates the payload), so "today" has to mean one thing globally — a
// client-local boundary would let clocks disagree with the gate. Date math on
// the strings runs at noon so DST shifts can't move a day boundary. Shared by
// the client and the api/ functions.
// ---------------------------------------------------------------------------
export const DAILY_EPOCH = "2026-07-07";

// en-CA formats as YYYY-MM-DD
const SF_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" });
export function todayStr() {
  return SF_DAY.format(new Date());
}

function toDateStr(d) {
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
