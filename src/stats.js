import { HOURS } from "./rules.js";
import { dayNumber, toDateStr } from "./daily.js";
import { listDailyRuns, listCustomRuns } from "./runs.js";

// ---------------------------------------------------------------------------
// PERSONAL STATS — computed from this device's saved runs, Wordle-style: no
// account, no server. Headline numbers count dailies only; specials (ic_)
// get a single side line. A run counts once it's finished — in-progress runs
// are invisible here.
//
// Streaks walk the schedule (the day numbers that actually had an incident),
// so a calendar day with nothing scheduled can't break one — but a scheduled
// daily you didn't solve does. Today gets a grace period: still-winnable
// means not-yet-broken.
// ---------------------------------------------------------------------------
export function computeStats(schedule) {
  const todayKey = Math.max(0, dayNumber(toDateStr(new Date()))) + 1;
  const dailies = listDailyRuns();
  const byNum = new Map(dailies.map(({ num, run }) => [num, run]));

  // solve-hour distribution: T+1 … T+HOURS, plus the escalated bucket
  const dist = Array.from({ length: HOURS }, () => 0);
  let escalated = 0;
  for (const { run } of dailies) {
    if (run.s === "solved") dist[run.a.length - 1]++;
    else if (run.s === "failed") escalated++;
  }
  const played = dist.reduce((a, b) => a + b, 0) + escalated;

  const due = schedule.filter((n) => n <= todayKey).sort((a, b) => a - b);
  let maxStreak = 0;
  for (let i = 0, cur = 0; i < due.length; i++) {
    cur = byNum.get(due[i])?.s === "solved" ? cur + 1 : 0;
    if (cur > maxStreak) maxStreak = cur;
  }
  let currentStreak = 0;
  for (let i = due.length - 1; i >= 0; i--) {
    const run = byNum.get(due[i]);
    if (run?.s === "solved") currentStreak++;
    else if (due[i] === todayKey && run?.s !== "failed") continue;
    else break;
  }

  // which bucket today's finished run landed in, for the chart highlight
  const todayRun = byNum.get(todayKey);
  const today =
    todayRun?.s === "solved" ? todayRun.a.length : todayRun?.s === "failed" ? "esc" : null;

  const customs = listCustomRuns().filter(({ run }) => run.s !== "active");
  const customsSolved = customs.filter(({ run }) => run.s === "solved").length;

  return {
    played,
    solved: played - escalated,
    dist,
    escalated,
    currentStreak,
    maxStreak,
    today,
    customs: customs.length,
    customsSolved,
  };
}
