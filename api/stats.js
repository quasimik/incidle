import { neon } from "@neondatabase/serverless";
import { HOURS } from "../src/rules.js";

// ---------------------------------------------------------------------------
// GLOBAL PER-INCIDENT STATS, aggregated from the plays table that api/guess.js
// writes when a run ends. key addresses the incident like everywhere else: a
// daily's num or a custom's ic_ id — so a shared custom's stats are reachable
// only by whoever holds its link, same capability stance as the incident
// itself.
//
// The client shows this on the postmortem, after the play ends — solve rate
// before playing would be Wordle-normal, but "most-suspected culprit" is a
// hint, so nothing here ships pre-verdict. Shape:
//   { played, solved, hours: [solves at T+1 … T+HOURS], topWrong: {id, n}|null }
// topWrong is the most-guessed non-answer id (the crowd's favorite red
// herring); ties break alphabetically so the cached payload is stable.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const key = req.query?.key;
  if (!(typeof key === "string" && (/^ic_[a-z0-9]{8}$/.test(key) || /^[1-9]\d{0,5}$/.test(key)))) {
    res.status(400).json({ error: "bad key" });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`SELECT solved, hours, guesses FROM plays WHERE incident_key = ${key}`;

  const hours = Array.from({ length: HOURS }, () => 0);
  const wrong = new Map();
  let solved = 0;
  for (const r of rows) {
    if (r.solved) {
      solved++;
      if (r.hours >= 1 && r.hours <= HOURS) hours[r.hours - 1]++;
    }
    for (const g of r.guesses) wrong.set(g, (wrong.get(g) ?? 0) + 1);
  }
  const top = [...wrong.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];

  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  res.status(200).json({
    played: rows.length,
    solved,
    hours,
    topWrong: top ? { id: top[0], n: top[1] } : null,
  });
}
