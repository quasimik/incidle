// ---------------------------------------------------------------------------
// SAVED RUNS — one localStorage entry per incident: { s: status, a: actions,
// g: guessed ids in order, t: started-at ms, r: reveal ({ answerId,
// postmortem }, present once the run ends) }, keyed by the daily's number or
// a custom's ic_ id. Saved mid-game too, so a reload or a trip to the archive
// resumes where you were — and a finished daily stays finished, Wordle-style.
// ---------------------------------------------------------------------------
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
