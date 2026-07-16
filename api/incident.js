import { neon } from "@neondatabase/serverless";

// One incident by its ic_ id — how EVERY playable incident loads, daily or
// custom: the boot payload (api/incidents.js) is just the schedule, and the
// client resolves a day's num to its id there before coming here. For customs
// the id is an unguessable capability: whoever holds the /a/<id> link can
// play, and nothing else lists these — see the exclusion note in
// api/incidents.js. A daily's id becomes public the day it arrives.
//
// This is the free part of the game: the paging vignette and the system
// topology primer cost nothing. Every action after that — revealing an
// observation or testing a hypothesis (right or wrong) — burns one hour of
// the HOURS budget, paid through POST /api/action. So answer-derived fields
// and clue texts stay out of this payload (clueCount rides instead, the
// budget's shape without its texts).
// topology: what the responder would already know — relevant or apparently
// relevant only, never exhaustive. It shapes the hypothesis space for free.
// Clues are ordered by information gained toward the root cause, not by real
// triage sequence — roughly 10% / 40% / 70% / 95% of the diagnosis is in hand
// after clue 1 / 2 / 3 / 4. Clue 1 fits many causes (incl. the nearIds); each
// later clue eliminates a distractor until clue 4 all but names the mechanism.
// nearIds get a "directionally right" response but still cost the hour.
//
// Content is immutable once live, so this caches long — unlike the boot
// payload, which flips at SF midnight.
export default async function handler(req, res) {
  const id = String(req.query.id ?? "");
  if (!/^ic_[a-z0-9]{8}$/.test(id)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT id, topology, vignette, jsonb_array_length(clues) AS "clueCount"
    FROM incidents
    WHERE id = ${id}`;
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ incident: rows[0] });
}
