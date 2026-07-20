# Story → incident pipeline

Turns a source story into a seeded Incidle incident, with a cold LLM playtest
producing a difficulty score.

**The orchestrator is code, not a model.** The pipeline is a deterministic
state machine (`run.mjs`) making Claude API calls to exactly two model roles —
one writer conversation, K fresh player conversations. Validation,
adjudication, scoring, the revision trigger, and the iteration cap are all
plain code: the players' strict per-turn JSON makes adjudication string
comparison, and the revision "diagnosis" is templated from their structured
output. This keeps the measurement instrument fixed (the only nondeterminism
is in the two roles being measured) and keeps untrusted submitted stories
confined to string-templating — no overseer agent reading them with tools.
The same state machine can be run by hand in a Claude session with subagents
(the manual mode below); either way it's the same protocol, so today's manual
runs and a future in-app "submit incident" feature share one code path.

## Stages

1. **Input package** — assembled by the orchestrator:
   - `source`: the incident, as prose, a named public incident, or a
     hyperlink (the orchestrator fetches links and inlines the content —
     the writer never browses).
   - `attribution` (optional): `{ "text": "handle", "url": "…" }`, passed
     through verbatim to the incident's `author` field. Absent → house.
   - `public`: whether the source incident is publicly documented. Only
     public sources get an `inspiration` credit.
2. **Writer** — one Claude instance (recommended: **Opus**; craft and
   information-discipline judgment are the bottleneck). Instructions =
   `AUTHORING.md` + `pipeline/WRITER.md` + the compact catalog + the input
   package. Outputs the incident JSON plus a worksheet (causal chain,
   candidate discovery, ranking rationale, invented details).
3. **Validation** — orchestrator checks answer/near ids against the catalog
   and field lengths against the ranges in AUTHORING.md.
4. **Player** — one Claude instance per run (recommended: **Sonnet**, fixed
   across all incidents so scores stay comparable; it stands in for a strong
   player, and it's cheap enough to run K times). Protocol in
   `pipeline/PLAYER.md`: the player sees the rules, the full compact catalog
   (81 rows ≈ 3.5k tokens — no autocomplete simulation needed), topology +
   vignette, then takes one action per turn; the orchestrator adjudicates
   with the real game rules and reveals only what the action earns.
5. **Score** — see below.
6. **Revision loop** — if the playtest leak-flags the draft or difficulty is
   out of band, send the writer (same conversation, context intact) a
   diagnosis templated from the players' structured output: pre-clue top-3s,
   the confidence curve, which clue collapsed it. The writer makes minimal
   edits (per WRITER.md → Revision requests); re-validate and re-playtest
   with **fresh** players (never ones who saw the previous version). Cap at
   2 cycles; a draft still failing goes to human review, not iteration 3.
7. Human review of draft + worksheet + score, then seed to staging as a
   custom and play at `/a/<id>` on the preview.

## Scoring

Per run, the game's own cost model: each clue reveal or wrong/near guess
burns 1 hour of the 7-hour budget; a correct guess (any member of
`answerIds`) solves.

- **Run score** = hours burned before the solve (0–6); DNF (budget
  exhausted) = 7.
- **Difficulty** = mean run score over K runs (default K = 3; K = 2
  acceptable for manual pilots).
- **Leak flag** = any run whose declared top candidate before the first
  clue reveal is an accepted answer. This is the live version of
  AUTHORING.md's self-test; a leak fails the draft regardless of score.
- Also record per run: the verdict sequence (share-squares shape) and the
  declared top-3 after each reveal (the posterior curve — shows *which*
  clue collapses it).

Interpretation (to be calibrated against the live set): ≲2 easy, 3–5 the
sweet spot, 6 brutal, 7 broken-or-diabolical. A low score with no leak flag
can still be fine — some incidents are meant to be gettable.

## Running it

The primary path is the code orchestrator (needs `DATABASE_URL` for the
catalog and Claude API credentials — `ANTHROPIC_API_KEY` or an `ant auth
login` profile):

```
set -a && source .env.local && set +a
node pipeline/run.mjs job.json            # --runs 3 --max-revisions 2 --out pipeline/out
```

`job.json` is the input package:

```json
{
  "sourceFile": "sample_input.md",        // or "sourceText": "…"
  "attribution": { "text": "handle", "url": "https://…" },   // optional
  "public": false,                        // true → writer may add inspiration
  "inspiration": { "text": "…", "url": "https://…" }         // optional, public only
}
```

Output lands in `pipeline/out/<slug>/` (gitignored): `incident.json`,
`worksheet.md`, `runs.json`, `report.md`. Models: writer `claude-opus-4-8`,
player `claude-sonnet-5` — the player model is deliberately fixed so
difficulty scores stay comparable across incidents; don't casually upgrade it.

**Manual mode** — the same state machine executed by hand in a Claude
session (useful when iterating on the prompts themselves):
1. Assemble the input package (fetch any links yourself).
2. Spawn the writer subagent with AUTHORING.md, WRITER.md, the catalog,
   and the input package. Keep its worksheet, and keep the agent — a
   revision goes back to the *same* writer with its context intact.
3. Validate ids and lengths.
4. Spawn a fresh player subagent per run with the PLAYER.md preamble; hold
   the answer key yourself and adjudicate turn by turn, exactly by the
   rules — paste clues verbatim, never paraphrase. The player must never
   see incident files, the worksheet, or the repo.
5. Compute the score; on leak/out-of-band, run the revision loop (fresh
   players, cap 2); present draft + worksheet + runs + score for human
   review before seeding.
