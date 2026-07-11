import { neon } from "@neondatabase/serverless";

// ---------------------------------------------------------------------------
// Serves the daily incident pool from Neon (authored via incidents.json +
// scripts/seed-incidents.mjs). Wordle-style: day N since DAILY_EPOCH plays the
// row whose num is N, so everyone gets the same incident on the same local
// calendar day. The num column IS the schedule — a day with no matching num
// shows a "no incident scheduled" page, so keep numbering ahead of the
// calendar.
//
// Only rows with a num are dailies. Custom incidents (num NULL) are reachable
// solely through their unguessable /a/<ic_...> link (api/incident.js) and must
// never ride along here — this payload goes to every visitor at boot, and
// shipping them would let anyone enumerate every secret incident.
//
// Answer-derived fields (answer_id, near_ids, postmortem) deliberately don't
// ship either: the client grades guesses through POST /api/guess, which
// reveals the postmortem only once a run ends. Keep them out of every
// row-shaped payload.
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
    SELECT num, topology, vignette, clues
    FROM incidents
    WHERE num IS NOT NULL
    ORDER BY num`;
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.status(200).json({ incidents: rows });
}
