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
