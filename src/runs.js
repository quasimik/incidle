// ---------------------------------------------------------------------------
// SAVED RUNS — one localStorage entry per incident: { s: status, a: actions,
// g: guessed ids in order }, keyed by the daily's number. Saved mid-game too,
// so a reload or a trip to the archive resumes where you were — and a
// finished daily stays finished, Wordle-style.
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
