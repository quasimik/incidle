// ---------------------------------------------------------------------------
// SAVED RUNS — one localStorage entry per incident: { s: status, a: actions,
// g: guessed ids in order (the solving guess included), t: started-at ms,
// r: reveal ({ answerIds: accepted causes best-first, postmortem }, present
// once the run ends) }, keyed by the incident's ic_ id — always, dailies
// included. The id is the incident's one identity; a daily's num is schedule
// metadata resolved through the boot payload (setSchedule below), never
// written into an entry. So promoting a custom to a daily moves nothing: the
// run just starts counting as a daily because the schedule now says so.
// Saved mid-game too, so a reload or a trip to the archive resumes where you
// were — and a finished daily stays finished, Wordle-style.
// ---------------------------------------------------------------------------

// id → num for every live daily, set once at boot from /api/incidents (the
// payload ships only days that have arrived). Module-level rather than
// threaded as props because computeStats reads runs from the propless Stats
// modal three components deep.
let schedule = new Map();
export function setSchedule(map) {
  schedule = map;
}
// dev stats seeder only (seed.js): lets fabricated runs count as dailies.
// Session-scoped — a reload rebuilds the schedule from the payload.
export function mergeSchedule(entries) {
  for (const [id, num] of entries) schedule.set(id, num);
}

// This browser's persistent player id, minted ic_-style on first need and
// carried on every /api/guess call: the server's plays log (global
// per-incident stats) keys on (incident, player), so a browser counts once
// per incident however many retries or reloads happen. Client-asserted and
// not a capability — nothing is readable by it; accounts will swap in a
// real user id here and collapse a player's devices.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function getPlayerId() {
  try {
    let id = localStorage.getItem("incidle:player");
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      id = "pl_" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
      localStorage.setItem("incidle:player", id);
    }
    return id;
  } catch {
    return null; // no storage, no logging — the play just goes uncounted
  }
}

// LEGACY UPGRADE (delete once pre-accept-set clients have aged out; shipped
// 2026-07-11). Runs saved before accept-sets hold a scalar r.answerId and no
// solving guess in g. Rewrite the entry in place on first read: readers
// downstream then only ever see the current shape. The old solve verdict
// required guessing the exact answerId, so for solved runs that id *is* the
// missing solving guess. Unfinished legacy runs have no r and pass through —
// they finish under new code and get the new shape naturally.
function upgradeRun(key, run) {
  if (!run?.r || run.r.answerIds) return run;
  run.r = { answerIds: [run.r.answerId], postmortem: run.r.postmortem };
  if (run.s === "solved") run.g = [...(run.g ?? []), run.r.answerIds[0]];
  saveRun(key, run);
  return run;
}

export function loadRun(key) {
  try {
    return upgradeRun(key, JSON.parse(localStorage.getItem(`incidle:run:${key}`)));
  } catch {
    return null;
  }
}
export function saveRun(key, run) {
  try {
    localStorage.setItem(`incidle:run:${key}`, JSON.stringify(run));
  } catch {}
}

// Every daily run on this device — entries whose incident is on the schedule
// — oldest first: the raw material for the personal stats (stats.js). num is
// looked up, not stored, so a run made before its incident was promoted
// counts the moment the schedule includes it.
export function listDailyRuns() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^incidle:run:(ic_[a-z0-9]+)$/);
      const num = m && schedule.get(m[1]);
      if (num == null) continue;
      const run = loadRun(m[1]);
      if (run) out.push({ num, run });
    }
  } catch {}
  return out.sort((a, b) => a.num - b.num);
}

// Custom incidents only exist locally as runs — starting one is what puts it
// in your archive. The schedule complement of listDailyRuns: a promoted
// custom's run stops listing here and shows up under its day instead.
// Newest first; runs predating the t field sort last.
export function listCustomRuns() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^incidle:run:(ic_[a-z0-9]+)$/);
      if (!m || schedule.has(m[1])) continue;
      const run = loadRun(m[1]);
      if (run) out.push({ id: m[1], run });
    }
  } catch {}
  return out.sort((a, b) => (b.run.t ?? 0) - (a.run.t ?? 0));
}
