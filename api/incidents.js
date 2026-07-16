import { neon } from "@neondatabase/serverless";
import { dayNumber, todayStr } from "../src/daily.js";

// ---------------------------------------------------------------------------
// Serves the daily SCHEDULE — {id, num} per arrived day, nothing else — from
// Neon (authored via incidents.json + scripts/seed-incidents.mjs).
// Wordle-style: day N since DAILY_EPOCH plays the row whose num is N, so
// everyone gets the same incident on the same SF calendar day (the one day
// boundary — see src/daily.js). The num column IS the schedule — a day with
// no matching num shows a "no incident scheduled" page, so keep numbering
// ahead of the calendar.
//
// No incident content rides here: everything playable (daily or custom)
// loads by id from GET /api/incident, which caches long because content is
// immutable once live — this payload changes at every SF midnight, so keeping
// it content-free keeps it tiny and stops it growing with the archive.
//
// Only days that have already arrived ship. Future days stay server-side in
// full, id included: the id is the /api/incident + /api/action capability, so
// leaking it would hand out tomorrow's incident and its answers. (An incident
// promoted from a circulating custom is early-playable by whoever already
// holds its link — that's the capability working, not a leak.)
//
// Only rows with a num are dailies. Custom incidents (num NULL) are reachable
// solely through their unguessable /a/<ic_...> link and must never ride along
// here — this payload goes to every visitor at boot, and shipping them would
// let anyone enumerate every secret incident.
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
    SELECT id, num
    FROM incidents
    WHERE num IS NOT NULL AND num <= ${todayNum}
    ORDER BY num`;
  const maxAge = Math.max(60, Math.min(3600, secondsToSfMidnight()));
  res.setHeader("Cache-Control", `public, s-maxage=${maxAge}`);
  res.status(200).json({ incidents: rows });
}
