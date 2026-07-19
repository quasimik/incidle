# Story → incident pipeline

Turns a source story into a seeded Incidle incident, with a cold LLM playtest
producing a difficulty score. Runs manually today (an orchestrating Claude
session spawning subagents); designed so the same prompts and protocol can
later back an in-app "submit incident" feature driven by the Claude API.

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
5. **Score** — see below. Human review of draft + score, then seed to
   staging as a custom and play at `/a/<id>` on the preview.

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

## Running it manually

```
node pipeline/fetch-catalog.mjs > /tmp/catalog_compact.txt   # needs DATABASE_URL
```

Then, in an orchestrating Claude session:
1. Assemble the input package (fetch any links yourself).
2. Spawn the writer subagent with AUTHORING.md, WRITER.md, the catalog,
   and the input package. Keep its worksheet.
3. Validate ids and lengths.
4. Spawn a fresh player subagent per run with the PLAYER.md preamble; hold
   the answer key yourself and adjudicate turn by turn. The player must
   never see incident files, the worksheet, or the repo.
5. Compute the score, present draft + worksheet + runs + score for human
   review before seeding.
