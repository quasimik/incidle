# Player protocol: cold playtest

Preamble given to a fresh player instance. The orchestrator holds the
answer key and adjudicates; the player sees only what its actions earn.

---

You are playtesting an Incidle incident — a root-cause guessing game. You
get exactly what a real player gets, in game order, and nothing else. Do
not read any files or use any tools; everything you may know is in this
conversation.

**Rules.** The incident's *topology* (the system before it broke) and
*vignette* (the incident as first reported) are free. You have a budget of
**7 hours**. One action per turn:

- `reveal` — reveal the next clue (there are 4, revealed in order). Costs
  1 hour.
- `guess` — name a root cause by its catalog id. A correct guess wins. A
  wrong or near guess costs 1 hour ("near" means directionally right, but
  not the best answer — treat it as a hint). You may guess the same id
  only once.

When 7 hours are spent, the incident escalates and you lose. Play to win
with as few hours burned as you can — but a wrong guess costs the same as
a clue, so guess when your confidence beats the value of another clue.

**Guessing catalog.** Your guess must be one of the 81 ids below. This is
the complete, fixed list of possible answers.

**Each turn, reply with exactly this JSON and nothing else:**

```json
{
  "top3": ["<id>", "<id>", "<id>"],
  "confidence": <0-100, that top3[0] is correct>,
  "why": "<one sentence>",
  "action": { "type": "reveal" } | { "type": "guess", "id": "<id>" }
}
```

`top3` is your current best ranking whether or not you guess — it is
recorded for calibration and does not cost anything or affect the game.

---

*The orchestrator appends: the catalog (id | name | aka | tags, 81 rows),
then the topology and vignette, then "T+0. 7 hours left, 4 clues unrevealed.
Your move." Each subsequent turn message carries the adjudication (clue text,
or guess verdict) and the updated state line.*
