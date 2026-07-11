import { HOURS } from "./rules.js";
import { saveRun } from "./runs.js";

// ---------------------------------------------------------------------------
// DEV SEEDER — fabricates a history of daily runs in localStorage so the
// stats modal has a real-looking distribution to render. Only reachable from
// the dev buttons in Stats.jsx, which are gated off production; the runs it
// writes are shaped exactly like real ones ("obs"/"wrong"/"near"/"solve" per
// hour), but their guess ids are fakes, so a seeded day's game page will name
// guesses by id and show no postmortem. That's fine for what this is for.
// ---------------------------------------------------------------------------
const SEED_DAYS = 60;

// weighted pick: [[value, weight], ...]
function pick(pairs) {
  let roll = Math.random() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((roll -= w) < 0) return v;
  return pairs[pairs.length - 1][0];
}

// One plausible run: investigate a while, then start naming culprits, with
// the occasional extra observation between guesses. Incidents have 4 clues.
function fabricateRun(startedAt) {
  const a = [];
  let obs = 0;
  const openWith = pick([[1, 1], [2, 2], [3, 3], [4, 2.5]]);
  const solveChance = 0.45;
  while (a.length < HOURS) {
    const wantObs = obs < openWith || (obs < 4 && Math.random() < 0.25);
    if (wantObs && obs < 4) {
      a.push("obs");
      obs++;
      continue;
    }
    if (Math.random() < solveChance) {
      a.push("solve");
      break;
    }
    a.push(Math.random() < 0.18 ? "near" : "wrong");
  }
  const solved = a[a.length - 1] === "solve";
  return {
    s: solved ? "solved" : "failed",
    a,
    g: a.filter((x) => x !== "obs").map((_, i) => `seed-guess-${i + 1}`), // solve included, like real runs
    t: startedAt,
  };
}

// Overwrites runs for days 1…SEED_DAYS (skipping ~15% as unplayed days) plus
// a few specials. Numbers past today's are fine here — this never runs on
// real player storage.
export function seedRuns() {
  const dayMs = 864e5;
  const start = Date.now() - SEED_DAYS * dayMs;
  for (let n = 1; n <= SEED_DAYS; n++) {
    if (Math.random() < 0.15) continue; // a day they skipped
    saveRun(n, fabricateRun(start + n * dayMs));
  }
  for (const id of ["ic_seedaaaa", "ic_seedbbbb", "ic_seedcccc"]) {
    saveRun(id, fabricateRun(Date.now()));
  }
}

// Wipes every saved run (seeded or not) on this origin.
export function clearRuns() {
  const doomed = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("incidle:run:")) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {}
}
