import { neon } from "@neondatabase/serverless";
import { HOURS } from "../src/rules.js";

// ---------------------------------------------------------------------------
// Server-side verdicts. The incident payloads no longer carry answerId /
// nearIds / postmortem (see api/incidents.js), so the client can't grade its
// own guesses: every guess lands here, and the reveal ({ answerId,
// postmortem }) ships only when the run ends — a correct guess, or any
// request marked with the budget's last hour. guessId null asks for the
// reveal alone (an investigate burning the final hour).
//
// key addresses the incident the same way run storage does: a daily's num or
// a custom's ic_ id. This is anti-spoiler, not anti-cheat — anyone can POST
// hour=HOURS and read the answer; the point is that idle clients and the
// network tab never see it.
//
// A request that ends the run also logs the play (the raw material for
// GET /api/stats): one row per (incident, player), where player is the
// browser's persistent pl_ id (runs.js). ON CONFLICT DO NOTHING both dedupes
// retries/reloads and means the first finished play wins — a replay that
// still holds the id can't overwrite the honest attempt. Accounts will widen
// player to a user id, collapsing one person's devices. guesses is the
// client's prior wrong/near ids, with this request's guess appended
// server-side when it isn't the solve. Same trust stance as the verdicts —
// fake plays are POSTable, and at this scale that's fine. Logging is
// best-effort: the reveal must ship even if the insert fails.
//
//   CREATE TABLE plays (
//     incident_key text NOT NULL,   -- '3' or 'ic_...'
//     player text NOT NULL,         -- pl_<10 lowercase base36>; user id later
//     solved boolean NOT NULL,
//     hours int NOT NULL,           -- the hour the play ended, 1..HOURS
//     guesses text[] NOT NULL,      -- wrong + near ids, in order
//     created_at timestamptz DEFAULT now(),
//     PRIMARY KEY (incident_key, player)
//   );
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const { key, guessId, hour, player, guesses } = req.body ?? {};
  const sql = neon(process.env.DATABASE_URL);
  let rows;
  if (typeof key === "string" && /^ic_[a-z0-9]{8}$/.test(key)) {
    rows = await sql`
      SELECT answer_id AS "answerId", near_ids AS "nearIds", postmortem
      FROM incidents WHERE id = ${key}`;
  } else if (Number.isInteger(key) && key > 0) {
    rows = await sql`
      SELECT answer_id AS "answerId", near_ids AS "nearIds", postmortem
      FROM incidents WHERE num = ${key}`;
  } else {
    res.status(400).json({ error: "bad key" });
    return;
  }
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const inc = rows[0];
  const out = {};
  if (typeof guessId === "string") {
    out.verdict =
      guessId === inc.answerId ? "solve" : inc.nearIds?.includes(guessId) ? "near" : "wrong";
  }
  if (out.verdict === "solve" || (Number.isInteger(hour) && hour >= HOURS)) {
    out.answerId = inc.answerId;
    out.postmortem = inc.postmortem;
    if (
      typeof player === "string" &&
      /^pl_[a-z0-9]{10}$/.test(player) &&
      Number.isInteger(hour) &&
      hour >= 1 &&
      hour <= HOURS
    ) {
      const isId = (g) => typeof g === "string" && /^[a-z0-9_]{1,64}$/.test(g);
      const prior = Array.isArray(guesses) ? guesses.filter(isId).slice(0, HOURS) : [];
      const all =
        out.verdict && out.verdict !== "solve" && isId(guessId) ? [...prior, guessId] : prior;
      try {
        await sql`
          INSERT INTO plays (incident_key, player, solved, hours, guesses)
          VALUES (${String(key)}, ${player}, ${out.verdict === "solve"}, ${hour}, ${all})
          ON CONFLICT DO NOTHING`;
      } catch {}
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
