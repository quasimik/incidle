// ---------------------------------------------------------------------------
// SAVED RUNS — one localStorage entry per incident: { s: status, a: actions,
// g: guessed ids in order, t: started-at ms, i: play id (see mintPlayId),
// r: reveal ({ answerId, postmortem }, present once the run ends) }, keyed by
// the daily's number or a custom's ic_ id. Saved mid-game too, so a reload or
// a trip to the archive resumes where you were — and a finished daily stays
// finished, Wordle-style.
// ---------------------------------------------------------------------------

// A random id minted when a play starts and carried on every /api/guess call.
// It exists purely so the server's plays log (global per-incident stats) can
// dedupe: retries and reloads of the same finished play insert once. Not a
// capability — nothing is readable by it. Minted ic_-style (seed-incidents).
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function mintPlayId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "pl_" + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function loadRun(key) {
  try {
    return JSON.parse(localStorage.getItem(`incidle:run:${key}`));
  } catch {
    return null;
  }
}
export function saveRun(key, run) {
  try {
    localStorage.setItem(`incidle:run:${key}`, JSON.stringify(run));
  } catch {}
}

// Every daily run on this device, oldest first — the raw material for the
// personal stats (stats.js).
export function listDailyRuns() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^incidle:run:(\d+)$/);
      if (!m) continue;
      const run = loadRun(m[1]);
      if (run) out.push({ num: Number(m[1]), run });
    }
  } catch {}
  return out.sort((a, b) => a.num - b.num);
}

// Custom incidents only exist locally as runs — starting one is what puts it
// in your archive. Newest first; runs predating the t field sort last.
export function listCustomRuns() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i)?.match(/^incidle:run:(ic_[a-z0-9]+)$/);
      if (!m) continue;
      const run = loadRun(m[1]);
      if (run) out.push({ id: m[1], run });
    }
  } catch {}
  return out.sort((a, b) => (b.run.t ?? 0) - (a.run.t ?? 0));
}
