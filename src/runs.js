// ---------------------------------------------------------------------------
// SAVED RUNS — one localStorage entry per incident: { s: status, a: actions,
// g: guessed ids in order, t: started-at ms, r: reveal ({ answerId,
// postmortem }, present once the run ends) }, keyed by the daily's number or
// a custom's ic_ id. Saved mid-game too, so a reload or a trip to the archive
// resumes where you were — and a finished daily stays finished, Wordle-style.
// ---------------------------------------------------------------------------

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
