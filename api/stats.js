import { neon } from "@neondatabase/serverless";
import { HOURS } from "../src/rules.js";

// ---------------------------------------------------------------------------
// GLOBAL PER-INCIDENT STATS, aggregated from the plays table that api/action.js
// writes when a run ends. key is the incident's ic_ id, like everywhere else
// — so a shared custom's stats are reachable only by whoever holds its link,
// same capability stance as the incident itself, and a promotion (custom
// gains a num) changes nothing here: the plays were id-keyed all along.
//
// The client shows this on the postmortem, after the play ends — solve rate
// before playing would be Wordle-normal, but "most-suspected culprit" is a
// hint, so nothing here ships pre-verdict. Shape:
//   { played, solved, hours: [solves at T+1 … T+HOURS], top: [{id, n}] }
// top ranks every guessed id — correct guesses included, so each member of an
// accept-set is counted under its own name — up to three; ties break
// alphabetically so the cached payload is stable.
//
// Plays logged before the solving guess rode along in guesses (pre
// accept-sets) hold no accepted id when solved; those solves are counted as
// answer_ids[0], which is exact, not a guess — the old verdict required
// guessing the scalar answer_id, and the migration made it answer_ids[0].
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const key = req.query?.key;
  if (!(typeof key === "string" && /^ic_[a-z0-9]{8}$/.test(key))) {
    res.status(400).json({ error: "bad key" });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);
  const [rows, incRows] = await Promise.all([
    sql`SELECT solved, hours, guesses FROM plays WHERE incident_key = ${key}`,
    sql`SELECT answer_ids AS "answerIds" FROM incidents WHERE id = ${key}`,
  ]);
  const answerIds = incRows[0]?.answerIds ?? [];
  const accepted = new Set(answerIds);

  const hours = Array.from({ length: HOURS }, () => 0);
  const counts = new Map();
  const count = (id) => counts.set(id, (counts.get(id) ?? 0) + 1);
  let solved = 0;
  for (const r of rows) {
    if (r.solved) {
      solved++;
      if (r.hours >= 1 && r.hours <= HOURS) hours[r.hours - 1]++;
      if (answerIds.length > 0 && !r.guesses.some((g) => accepted.has(g))) count(answerIds[0]);
    }
    for (const g of r.guesses) count(g);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3);

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  res.status(200).json({
    played: rows.length,
    solved,
    hours,
    top: top.map(([id, n]) => ({ id, n })),
  });
}
