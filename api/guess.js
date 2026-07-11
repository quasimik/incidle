import { neon } from "@neondatabase/serverless";
import { HOURS } from "../src/rules.js";

// ---------------------------------------------------------------------------
// Server-side verdicts. The incident payloads no longer carry answerIds /
// nearIds / postmortem (see api/incidents.js), so the client can't grade its
// own guesses: every guess lands here, and the reveal ({ answerIds,
// postmortem }) ships only when the run ends — a correct guess, or any
// request marked with the budget's last hour. guessId null asks for the
// reveal alone (an investigate burning the final hour).
//
// answer_ids is an accept-set in descending order of goodness: any member
// solves, and the reveal ships the whole ranked list — the client shows every
// accepted cause, headlining answer_ids[0] as the best one. Ranking and the
// answer-vs-near threshold are post-hoc authoring judgments, not part of the
// story's telling.
//
// key addresses the incident the same way run storage does: a daily's num or
// a custom's ic_ id. This is anti-spoiler, not anti-cheat — anyone can POST
// hour=HOURS and read the answer; the point is that idle clients and the
// network tab never see it.
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const { key, guessId, hour } = req.body ?? {};
  const sql = neon(process.env.DATABASE_URL);
  let rows;
  if (typeof key === "string" && /^ic_[a-z0-9]{8}$/.test(key)) {
    rows = await sql`
      SELECT answer_ids AS "answerIds", near_ids AS "nearIds", postmortem
      FROM incidents WHERE id = ${key}`;
  } else if (Number.isInteger(key) && key > 0) {
    rows = await sql`
      SELECT answer_ids AS "answerIds", near_ids AS "nearIds", postmortem
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
      inc.answerIds.includes(guessId) ? "solve" : inc.nearIds?.includes(guessId) ? "near" : "wrong";
  }
  if (out.verdict === "solve" || (Number.isInteger(hour) && hour >= HOURS)) {
    out.answerIds = inc.answerIds;
    out.postmortem = inc.postmortem;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(out);
}
