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
- Ubiquitous third-party technology (Postgres, Redis, Sidekiq, New Relic…)
  may keep its real name when it isn't identifying; when it is — or when
  the source is private enough that even the stack narrows it down — swap
  it for something of the same shape (a job queue stays a job queue, an
  APM stays an APM). Same-shaped matters: the mechanism must survive.
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
