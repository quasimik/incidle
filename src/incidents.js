// ---------------------------------------------------------------------------
// INCIDENTS — the daily pool. Wordle-style: day N since DAILY_EPOCH plays
// INCIDENTS[N % length], so everyone gets the same incident on the same local
// calendar day and the pool cycles when the calendar outruns it — add
// incidents faster than the calendar eats them.
//
// The paging vignette and the system topology primer are free. Every action
// after that — revealing an observation or testing a hypothesis (right or
// wrong) — burns one hour of the HOURS budget. Unresolved at T+HOURS, the
// incident escalates.
// Clues are ordered by information gained toward the root cause, not by real
// triage sequence — roughly 10% / 40% / 70% / 95% of the diagnosis is in hand
// after clue 1 / 2 / 3 / 4. Clue 1 fits many causes (incl. the nearIds); each
// later clue eliminates a distractor until clue 4 all but names the mechanism.
// nearIds get a "directionally right" response but still cost the hour.
// topology: what the responder would already know — relevant or apparently
// relevant only, never exhaustive. It shapes the hypothesis space for free.
// ---------------------------------------------------------------------------
export const HOURS = 7; // time budget per incident; one action = one hour

export const INCIDENTS = [
  {
    num: 1,
    sev: 2,
    topology:
      "`checkout-api` fronts the purchase flow and calls `payments-svc` synchronously for card auth against a third-party processor. `payments-svc` and several unrelated services share one Postgres primary capped at 500 connections, each holding its own pool against it. Teams own their services and deploy independently, many times a day.",
    vignette: "PAGE — checkout error rate at 4% and climbing. Users seeing 503s at payment step.",
    clues: [
      "The failures are all 503s from `payments-svc`; every other endpoint in checkout is healthy.",
      "`payments-svc`'s own code hasn't shipped in days, and its logs, CPU, and memory are clean — successful calls are as fast as ever, but a growing share of requests are rejected before they ever run.",
      "Those rejected requests are all stuck waiting to check out a database connection; the worker threads themselves sit idle, not pegged.",
      "Postgres is pinned at 500/500 connections, nearly all `idle in transaction` and held by `promo-svc` — which deployed 25 minutes ago — leaving none for `payments-svc`.",
    ],
    answerId: "connection_pool_exhaustion",
    nearIds: ["bad_code_deploy", "thread_pool_exhaustion"],
    postmortem:
      "`promo-svc` and `payments-svc` share a database. The new coupon path leaked connections (opened transactions, never closed), pinning the pool at max and starving `payments-svc` — which failed while looking perfectly healthy itself. Fix: roll back, add an idle-in-transaction timeout, and give each service its own pool with a hard cap.",
  },
  {
    num: 2,
    sev: 3,
    topology:
      "`product-page` renders server-side from a Postgres read pool, with expensive aggregations cached look-aside in Redis under fixed TTLs. A CDN fronts anonymous traffic and scheduled jobs refresh assorted data on the clock. Redis is the only thing standing between normal traffic and a very expensive query.",
    vignette: "PAGE — database CPU alarms firing in bursts. Product pages crawl for ~30s, recover, then it happens again.",
    clues: [
      "Every burst is pure database saturation — app servers, the network, and Redis's own latency all stay normal; only the DB gets pegged, then it recovers.",
      "The bursts land on a fixed clock grid — :00, :15, :30, :45 — not on traffic peaks, deploys, or any restart or flush.",
      "In each burst the DB runs one expensive query — the top-sellers aggregation — hundreds of times at once, while Redis as a whole stays perfectly healthy.",
      "The `top_sellers` key has a 900-second TTL with no jitter; the instant it expires its hit rate hits zero, and every concurrent request spends the ~8s recompute hammering the DB until one of them repopulates it.",
    ],
    answerId: "cache_stampede",
    nearIds: ["cache_hit_rate_collapse"],
    postmortem:
      "Classic stampede: a popular cache key expires on a fixed TTL, and every concurrent request recomputes the expensive value simultaneously, hammering the database until one write repopulates the key. Fix: TTL jitter, a recompute lock or single-flight, or serve-stale-while-revalidate.",
  },
  {
    num: 3,
    sev: 3,
    topology:
      "`auth` issues short-lived JWTs (15-minute expiry) that each service verifies locally against weekly-rotated signing keys. Verification runs on three pools of long-lived VMs behind a round-robin balancer. A security-hardening pass recently tightened baseline host configs fleet-wide.",
    vignette: "PAGE — 0.7% of API calls failing with 401 invalid token. The same user's token works fine on retry.",
    clues: [
      "The 401s look random — scattered across users, endpoints, and times of day, with no burst or trend that stands out at a glance.",
      "But they aren't user- or token-specific: retries succeed, and every failed verification traces back to host pool C — pools A and B have zero.",
      "Pool C rejects with 'token used before issued': it reads the token's `iat` timestamp as being in the future. The signing keys are valid and identical on all three pools.",
      "`chrony` isn't running on pool C — a hardening script disabled the wrong unit there — so its clocks have drifted ~2s/day for weeks, which is why the 401 rate crept upward instead of spiking.",
    ],
    answerId: "clock_skew",
    nearIds: ["credential_expiry"],
    postmortem:
      "With NTP dead on one pool, its clocks drifted until freshly-issued tokens appeared to come from the future and failed validation — sporadically, because only requests landing on pool C failed. Fix: restore time sync, alert on clock offset directly, and treat 'works on retry' as a load-balancer-shaped clue.",
  },
];
