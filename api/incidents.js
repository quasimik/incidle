import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------------------
// Serves the daily incident pool from Neon (local authoring copy:
// incidents.json). Wordle-style: day N since DAILY_EPOCH plays
// incidents[N % length], so everyone gets the same incident on the same local
// calendar day and the pool cycles when the calendar outruns it — add
// incidents faster than the calendar eats them.
//
// The paging vignette and the system topology primer are free. Every action
// after that — revealing an observation or testing a hypothesis (right or
// wrong) — burns one hour of the HOURS budget. Unresolved at T+HOURS, the
// incident escalates.
// Clues are ordered by information gained toward the root cause, not by real
// triage sequence — roughly 10% / 40% / 70% / 95% of the diagnosis is in hand
// after clue 1 / 2 / 3 / 4. Clue 1 fits many causes (incl. the nearIds); each
// later clue eliminates a distractor until clue 4 all but names the mechanism.
// nearIds get a "directionally right" response but still cost the hour.
// topology: what the responder would already know — relevant or apparently
// relevant only, never exhaustive. It shapes the hypothesis space for free.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT num, sev, topology, vignette, clues,
           answer_id AS "answerId", near_ids AS "nearIds", postmortem
    FROM incidents
    ORDER BY num`;
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ incidents: rows });
}
