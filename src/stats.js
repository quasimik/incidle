import { HOURS } from "./rules.js";
import { listDailyRuns } from "./runs.js";

// ---------------------------------------------------------------------------
// PERSONAL STATS — computed from this device's saved runs, Wordle-style: no
// account, no server. Everything counts dailies only; specials (ic_) don't
// figure in. A run counts once it's finished — in-progress runs are
// invisible here.
//
// The distinctive axis of this game is explore vs. exploit — when a player
// stops investigating and starts naming culprits — so past the counts, the
// stats slice every finished run's action sequence by hour (the stacked
// chart) and keep a square-by-square log of each run (the waterfall).
// solveTime / clues / guesses average solved runs only: an escalation has no
// solve hour, and letting its forced 7-action tail into the averages would
// drown the signal. Escalations still show in the solve rate, the chart's
// red, and the waterfall's greenless rows.
// ---------------------------------------------------------------------------
export function computeStats() {
  const finished = listDailyRuns().filter(({ run }) => run.s !== "active");
  const solved = finished.filter(({ run }) => run.s === "solved");

  // what happened at each hour T+1…T+HOURS across all finished runs — a run
  // that ended early just isn't counted in the hours after its solve
  const hours = Array.from({ length: HOURS }, () => ({ obs: 0, wrong: 0, near: 0, solve: 0 }));
  for (const { run } of finished)
    run.a.forEach((act, i) => {
      if (hours[i][act] !== undefined) hours[i][act]++;
    });

  const avg = (f) =>
    solved.length ? solved.reduce((sum, { run }) => sum + f(run), 0) / solved.length : null;

  return {
    played: finished.length,
    solved: solved.length,
    solveTime: avg((r) => r.a.length),
    clues: avg((r) => r.a.filter((a) => a === "obs").length),
    guesses: avg((r) => r.a.filter((a) => a !== "obs").length),
    hours,
    log: [...finished].sort((a, b) => b.num - a.num), // newest first, git-log style
  };
}
