import { neon } from "@neondatabase/serverless";
import { dayNumber, todayStr } from "../src/daily.js";

// ---------------------------------------------------------------------------
// Serves the daily incident pool from Neon (authored via incidents.json +
// scripts/seed-incidents.mjs). Wordle-style: day N since DAILY_EPOCH plays the
// row whose num is N, so everyone gets the same incident on the same SF
// calendar day (the one day boundary — see src/daily.js). The num column IS
// the schedule — a day with no matching num shows a "no incident scheduled"
// page, so keep numbering ahead of the calendar.
//
// Only days that have already arrived ship. Future days stay server-side in
// full — vignette, clues, AND id: the id is the /api/incident + /api/action
// capability, so leaking it would hand out tomorrow's incident and its
// answers. (An incident promoted from a circulating custom is early-playable
// by whoever already holds its link — that's the capability working, not a
// leak.) id rides along for live days because it's the key for everything:
// run storage, /api/action, /api/stats.
//
// Only rows with a num are dailies. Custom incidents (num NULL) are reachable
// solely through their unguessable /a/<ic_...> link (api/incident.js) and must
// never ride along here — this payload goes to every visitor at boot, and
// shipping them would let anyone enumerate every secret incident.
//
// Nothing a player hasn't paid for ships: answer-derived fields (answer_ids,
// near_ids, postmortem) and the clue texts all stay server-side, served by
// POST /api/action as moves spend hours on them. Rows carry clueCount so the
// client knows the budget shape without holding the texts. Keep unpaid
// content out of every row-shaped payload.
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
// Seconds of SF wall-clock left in the day, so the CDN cache expires at the
// flip instead of hiding the new daily for up to an hour past midnight. On a
// DST fall-back day the wall clock undercounts by an hour — the cache just
// expires early, which is harmless.
function secondsToSfMidnight() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value) % 24; // hour24 renders 0 as "24"
  return 86400 - (get("hour") * 3600 + get("minute") * 60 + get("second"));
}

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  const todayNum = dayNumber(todayStr()) + 1; // day #1 is the epoch day
  const rows = await sql`
    SELECT id, num, topology, vignette, jsonb_array_length(clues) AS "clueCount"
    FROM incidents
    WHERE num IS NOT NULL AND num <= ${todayNum}
    ORDER BY num`;
  const maxAge = Math.max(60, Math.min(3600, secondsToSfMidnight()));
  res.setHeader("Cache-Control", `public, s-maxage=${maxAge}`);
  res.status(200).json({ incidents: rows });
}
