# Incidle authoring guide

How to write an incident. Lives on the `authoring` branch; `incidents.json`
stays untracked — the authoring workbench, not the product. The reader of
this guide is an LLM writer;
drafts are playtested by an LLM player who gets the incident cold, in game
order. Where the guide says "you", it means the writer.

## The game, from the author's chair

- The player sees **topology + vignette free**, then has a budget of
  **7 hours** (`HOURS`, `src/rules.js`): revealing a clue costs 1, a wrong or
  near guess costs 1. With the conventional 4 clues, revealing everything
  leaves 3 guesses.
- **Guessing is autocomplete over the fixed 81-cause catalog**
  (`incident_root_causes.json`). uFuzzy (`src/matcher.js`) matches each
  cause's name + aliases + tags, typo-tolerant and out-of-order. Whatever
  vocabulary the incident text plants is what players type into the box —
  the search surface is part of the puzzle.
- Any member of `answerIds` solves; `nearIds` return "directionally right,
  but not the best answer"; anything else is wrong. The reveal headlines
  `answerIds[0]` as the *best* answer (not a canonical one), lists the rest
  as "Also accepted", then shows the postmortem.

## Fields

Author in `incidents.json` at the repo root. A new entry carries **no `id`**
(the seeder mints one and writes it back; never change a minted id — shared
`/a/<id>` links must keep working) and **no `num`** (customs are reachable
only at `/a/<id>`, the playtest slot; only dailies get a `num`).

- `topology` — the system, described before anything broke.
- `vignette` — the incident as first reported.
- `clues` — 4 by convention; the budget math is tuned for 4.
- `answerIds` — the accept-set, ranked best-first.
- `nearIds` — truthful-but-not-best labels.
- `postmortem` — the payoff screen.
- `author` — **guest contributions only**: `{ "text": "handle", "url": "https://…" }`
  (url optional), rendered as "guest contribution by <handle>". Omit for
  house-written incidents.
- `inspiration` — optional `{ "text": "the 2024 CrowdStrike outage", "url": "https://…" }`.
- No `sev` — the field is dead.

Seed with `set -a && source .env.local && set +a && node scripts/seed-incidents.mjs`;
it validates every answer/near id against the catalog before writing.

### Length (words, measured from the live set)

| field      | range  |
|------------|--------|
| topology   | 20–40  |
| vignette   | 10–40  |
| each clue  | 15–60  |
| postmortem | 40–125 |

Terse telemetry-style incidents sit at the low ends; character-driven ones
at the high ends. Pick a register and keep every field consistent with it.
Treat the high ends as ceilings — density beats length.

## The flow: story first

1. **Seed from a situation, not a catalog row** — a system, a character, an
   incident that made you wince or laugh. Don't write toward a predetermined
   answer, and don't pick answers for catalog coverage. Repeat answers are
   fine: two memory-leak incidents with different stories are two puzzles.
2. **Write the causal chain honestly** — decide what actually happened at
   every altitude, from the typo to the outage.
3. **Discover candidates cold** — enumerate every catalog row that truthfully
   describes *some link* of the chain.
4. **Rank and threshold** — `answerIds` is everyone who deserves full credit,
   best first; the remaining truthful labels become `nearIds`. Rubric: a
   player naming a true label at the wrong altitude scores ≥ near. Accept-set
   size is an output of this step, not a dial.
5. **Sharp edges are catalog feedback** — if the threshold feels arbitrary,
   or a truthful guess has no decent row to land on, fix the catalog, not
   the story.
6. **Commit to where the process lands**, even if it isn't where the story
   idea started.

## Information discipline

"Don't give away the answer" is about information, not word-matching. The
test is the posterior: after reading the pre-decisive text (topology,
vignette, early clues), what distribution over catalog rows does a
knowledgeable reader hold?

- **Name the answer's mechanism openly — among peers.** The topology should
  mention it at the same specificity as several other mechanisms, any of
  which could plausibly be tonight's cause. Write as a neutral engineer
  describing the system before it broke; the narrator doesn't know what
  fails.
- **The two classic failures are one failure: differential salience.** One
  unusually specific mechanism in a generic topology points at itself
  (Chekhov's gun). Scrubbing the answer's domain while naming everything
  else leaks by conspicuous absence (synonym-hunting). Balance, don't scrub.
- **Autocomplete form of the same rule:** catalog vocabulary is fine when it
  seeds several candidates; banned when only the answer's row would surface
  in the search box. Compounds count ("health checks" ~ "Auto-healing").
- **Self-test:** run candidate discovery on topology + vignette alone. You
  want a genuine spread, with the answer not ranked first before the clues
  have done their work. The cold playtest is the live version of this test —
  a player who solves from the free text alone found a leak.
- **The decisive clue is exempt** — usually the last one. Its job is to
  collapse the posterior.

## Narrative

- **Engaging is the invariant; structure is free.** From a full character
  frame (player as outside contractor, conflicting human accounts) down to
  a single quoted Slack message in a telemetry-driven incident — every
  dosage is valid.
- **No formulas.** Any repeated pattern becomes exploitable meta: if the
  confident character is always wrong, players solve the storytelling
  instead of the evidence. Vary who's right, what shape the clues take,
  where the decisive fact hides. (This is also why this guide has no
  template incident — don't converge on one.)
- **Characters are fallible, not required liars.** Sincere false statements
  are allowed; the drafting test is *could this person believe this from
  where they sit?* No unreliability quota in either direction.
- **A vignette that poses a paradox pulls harder than a symptom report**
  ("works on retry", "nothing shipped — deploys are frozen").
- **The postmortem is the payoff screen.** Explain the mechanism, decode why
  the evidence looked like something else, and give remediation a real team
  would take. It should teach something true.

## Pre-seed checklist

- [ ] Candidate discovery done cold; every truthful label is an answer or
      a near
- [ ] `answerIds` ranked best-first; the split survives the wrong-altitude
      rubric
- [ ] Topology + vignette alone yields a candidate spread; answer not
      conspicuous by presence *or* absence
- [ ] No differential autocomplete overlap in the pre-decisive text
- [ ] Field lengths inside the measured ranges, register consistent
- [ ] Postmortem covers mechanism + signature + remediation
- [ ] No `sev`; `author` only if a guest wrote it; `inspiration` if there
      is one
- [ ] Cold playtest by an LLM player (game order, no answers visible), then
      seeded to staging and played end-to-end at `/a/<id>` on the preview
