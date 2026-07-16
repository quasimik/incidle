import { neon } from "@neondatabase/serverless";
import { HOURS } from "../src/rules.js";

// ---------------------------------------------------------------------------
// Every hour-burning move lands here; the response is whatever the move
// yields. The incident payloads carry nothing a player hasn't paid for — no
// answerIds / nearIds / postmortem, and no clue text (see api/incidents.js)
// — so the client can neither grade its own guesses nor show a clue without
// asking:
//
//   { guessId } → { verdict }            a hypothesis test
//   { clue: n } → { clues }              an observation — clues[0..n], a
//                                        prefix so a legacy run can backfill
//                                        every text it has earned in one call
//
// Any move on a run that ends it — a solve, or any request marked with the
// budget's last hour — additionally gets the reveal: { answerIds, postmortem,
// author?, inspiration? } plus the FULL clue list, which the client saves
// into the run so finished runs are self-contained (feed replay and the
// skipped-observations list never ask again). The credits ride the reveal
// rather than the incident payload because the inspiration names the
// real-world outage — a giveaway pre-verdict.
//
// Nothing here checks that hour n was honestly reached — hour, clue index,
// actions and player are all client-asserted. Anti-spoiler, not anti-cheat
// (see the key paragraph below): the point is that unpaid content never
// rides a payload, not that a determined client can't POST for it.
//
// answer_ids is an accept-set in descending order of goodness: any member
// solves, and the reveal ships the whole ranked list — the client shows every
// accepted cause, headlining answer_ids[0] as the best one. Ranking and the
// answer-vs-near threshold are post-hoc authoring judgments, not part of the
// story's telling.
//
// key is the incident's ic_ id — the one identity everywhere (run storage,
// plays rows, /api/stats); a daily's num is schedule metadata, not an
// address. That also closes future days: a future daily's id ships nowhere
// (api/incidents gates the payload), so its answers are unreachable here
// until the day arrives. Within a live incident this is anti-spoiler, not
// anti-cheat — anyone can POST hour=HOURS and read the answer; the point is
// that idle clients and the network tab never see it.
//
// A request that ends the run also logs the play (the raw material for
// GET /api/stats): one row per (incident, player), where player is the
// browser's persistent pl_ id (runs.js). ON CONFLICT DO NOTHING both dedupes
// retries/reloads and means the first finished play wins — a replay that
// still holds the id can't overwrite the honest attempt. Accounts will widen
// player to a user id, collapsing one person's devices. actions and guesses
// arrive as the client's prior hour-by-hour moves and wrong/near ids, and
// the ending move/guess is appended server-side — so the row holds the
// play's complete sequence, observations included, for stats not yet designed
// (explore-vs-exploit slicing like the personal ones). Same trust stance as
// the verdicts — fake plays are POSTable, and at this scale that's fine.
// Logging is best-effort: the reveal must ship even if the insert fails.
// The solving guess is logged like any other: with accept-sets it isn't
// derivable from solved alone, and the crowd line counts each accepted
// member under its own name (api/stats.js).
//
//   CREATE TABLE plays (
//     incident_key text NOT NULL REFERENCES incidents(id),
//     player text NOT NULL,         -- pl_<10 lowercase base36>; user id later
//     solved boolean NOT NULL,
//     hours int NOT NULL,           -- the hour the play ended, 1..HOURS
//     actions text[] NOT NULL,      -- "obs"|"wrong"|"near"|"solve", one per hour
//     guesses text[] NOT NULL,      -- every guessed id, in order (solve last)
//     created_at timestamptz DEFAULT now(),
//     PRIMARY KEY (incident_key, player)
//   );
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const { key, guessId, clue, hour, player, actions, guesses } = req.body ?? {};
  if (!(typeof key === "string" && /^ic_[a-z0-9]{8}$/.test(key))) {
    res.status(400).json({ error: "bad key" });
    return;
  }
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`
    SELECT clues, answer_ids AS "answerIds", near_ids AS "nearIds", postmortem, author, inspiration
    FROM incidents WHERE id = ${key}`;
  if (rows.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const inc = rows[0];
  const out = {};
  if (typeof guessId === "string") {
    out.verdict =
      inc.answerIds.includes(guessId) ? "solve" : inc.nearIds?.includes(guessId) ? "near" : "wrong";
  }
  if (Number.isInteger(clue) && clue >= 0) {
    out.clues = inc.clues.slice(0, clue + 1); // slice caps an over-ask at the full list
  }
  if (out.verdict === "solve" || (Number.isInteger(hour) && hour >= HOURS)) {
    out.clues = inc.clues; // the whole list — the run keeps it once finished
    out.answerIds = inc.answerIds;
    out.postmortem = inc.postmortem;
    if (inc.author) out.author = inc.author;
    if (inc.inspiration) out.inspiration = inc.inspiration;
    if (
      typeof player === "string" &&
      /^pl_[a-z0-9]{10}$/.test(player) &&
      Number.isInteger(hour) &&
      hour >= 1 &&
      hour <= HOURS
    ) {
      const isId = (g) => typeof g === "string" && /^[a-z0-9_]{1,64}$/.test(g);
      const prior = Array.isArray(guesses) ? guesses.filter(isId).slice(0, HOURS) : [];
      const all = out.verdict && isId(guessId) ? [...prior, guessId] : prior;
      // a prior hour can't hold a solve; this request's move ends the play
      const isAct = (a) => a === "obs" || a === "wrong" || a === "near";
      const seq = [
        ...(Array.isArray(actions) ? actions.filter(isAct).slice(0, HOURS - 1) : []),
        out.verdict ?? "obs",
      ];
      try {
        await sql`
          INSERT INTO plays (incident_key, player, solved, hours, actions, guesses)
          VALUES (${key}, ${player}, ${out.verdict === "solve"}, ${hour}, ${seq}, ${all})
          ON CONFLICT DO NOTHING`;
      } catch {}
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
