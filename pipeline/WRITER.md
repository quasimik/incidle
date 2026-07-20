# Writer addendum: adapting a source story

Read `AUTHORING.md` first — it is the base contract and everything in it
applies. This file adds the rules for turning a *source story* (a real or
fictional incident supplied as input) into an Incidle incident.

## What the source gives you

The source supplies steps 1–2 of the authoring flow: the situation and the
causal chain. Your job starts at "write the causal chain honestly":

- Reconstruct the chain at every altitude from the source. Where the source
  is vague, fill gaps with plausible mechanics — but list every invented
  causal link in your worksheet so a reviewer can check you haven't changed
  what actually happened.
- Preserve the **diagnostic shape**: what the incident looked like from the
  outside versus what it turned out to be is the puzzle. Don't straighten
  the misdirection out of a story whose whole point is that it looked like
  something else.
- Everything else is yours to change: compress, reorder, invent characters,
  telemetry, and color. The incident must stand alone for a player who will
  never see the source.

## Obfuscation

- Invent replacements for anything identifying: companies, products,
  people, team names, internal project/feature names.
- Third-party services default to their **generic type**: "the job queue",
  "the database", "a cache", "our APM" — not Sidekiq, Postgres, Redis,
  New Relic. This is a puzzle rule as much as an obfuscation rule: a real
  product name imports priors the text doesn't control (a reader who knows
  Sidekiq gets "threaded worker pool" for free; one who doesn't gets
  nothing), so difficulty starts varying by stack familiarity instead of
  by the clues. The swap must be same-shaped — the mechanism has to
  survive in the generic description.
- Name a specific product only when it's load-bearing: the mechanism is
  product-specific and a generic swap would be dishonest (a Redis eviction
  quirk, an S3 outage), or the source is public and the named tech is part
  of the recognizable story. Note the exception in your worksheet.
- Keep the swap consistent across all fields, postmortem included.

## Credits

- `attribution` from the input package passes through **verbatim** to the
  incident's `author` field. No attribution in the package → no `author`
  field (house incident). Never invent one.
- `inspiration` only when the input package marks the source **public**
  (a documented, findable incident): `text` names it, `url` if one was
  provided. Private or fictional sources get no `inspiration` — a credit
  that points at nothing is worse than none.

## Calibrating your self-test

Two systematic biases to correct for when you run AUTHORING.md's self-test —
both observed in playtesting:

- **You will overestimate your misdirection.** A cold LLM player discounts
  narrative blame ("support says the vendor is slow") almost entirely and
  reads structure. Weight the topology's *mechanical* description far more
  than the vignette's framing when predicting the cold posterior — a red
  herring that only lives in what characters say is barely a red herring.
- **The topology needs mechanical breadth, not just balanced phrasing.** If
  it only describes the failing subsystem, equal-salience wording can't
  save it: every candidate a reader forms lives in the same neighborhood as
  the answer. Give several catalog rows a real mechanical foothold —
  peer subsystems described at the same depth as the one that breaks.

Your self-test is a prediction; the cold playtest is the measurement. If
they disagree, the playtest wins.

## Revision requests

If the playtest flags your draft, you'll get a diagnosis: the players'
pre-clue candidate rankings, the confidence curve across reveals, and which
clue collapsed it. Make the smallest edits that fix the measured problem —
the story and clue structure survived; only the cold posterior was off.
Return the same output format (full incident JSON + updated worksheet).

## Output

Return two things:

1. **The incident JSON object** — fields per AUTHORING.md, no `id`, no
   `num`, no `sev`.
2. **The worksheet**, for the reviewer (never shown to players):
   - the causal chain, altitude by altitude, with invented links marked
   - candidate discovery: every catalog row that truthfully describes some
     link, and the ranking rationale for the answer/near split
   - the self-test result: candidate spread on topology + vignette alone
   - the obfuscation map (real name → substitute)
