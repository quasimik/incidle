import { useState, useMemo, useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// ANSWER LIST — fixed taxonomy of root causes. Guesses are selected from this
// list (autocomplete), so alias-matching problems never occur.
// ---------------------------------------------------------------------------
const ANSWERS = [
  { id: "connection-pool-exhaustion", name: "Connection pool exhaustion", aliases: ["connection leak", "leaked connections", "db connections maxed", "pool exhaustion"] },
  { id: "cert-expiry", name: "Expired TLS certificate", aliases: ["cert expiry", "certificate expired", "tls cert", "mtls cert expired"] },
  { id: "cache-stampede", name: "Cache stampede", aliases: ["dogpile", "cache dogpile", "thundering herd on cache"] },
  { id: "retry-storm", name: "Retry storm", aliases: ["retry amplification", "cascading retries"] },
  { id: "memory-leak", name: "Memory leak", aliases: ["oom", "oom kill", "unbounded memory growth"] },
  { id: "hot-partition", name: "Hot partition", aliases: ["hot key", "hot shard", "partition skew", "data skew"] },
  { id: "disk-full", name: "Disk full", aliases: ["no space left on device", "log rotation failure", "full disk"] },
  { id: "stale-dns", name: "Stale DNS cache", aliases: ["dns caching", "dns ttl", "cached dns after failover"] },
  { id: "clock-skew", name: "Clock skew", aliases: ["ntp drift", "time drift", "clock drift"] },
  { id: "n-plus-one", name: "N+1 queries", aliases: ["n plus one", "n+1", "orm query amplification"] },
  { id: "ddos", name: "DDoS attack", aliases: ["denial of service", "volumetric attack"] },
  { id: "bad-migration", name: "Bad database migration", aliases: ["locking migration", "schema migration lock"] },
  { id: "deadlock", name: "Database deadlock", aliases: ["lock contention", "deadlock"] },
  { id: "thread-pool", name: "Thread pool exhaustion", aliases: ["worker starvation", "thread starvation"] },
  { id: "gc-pause", name: "GC pauses", aliases: ["garbage collection", "stop the world"] },
  { id: "network-partition", name: "Network partition", aliases: ["split network", "partition between zones"] },
  { id: "third-party-rate-limit", name: "Third-party rate limiting", aliases: ["429 from provider", "api rate limit"] },
  { id: "expired-api-key", name: "Expired credentials / API key", aliases: ["revoked credentials", "expired api key", "expired token secret"] },
  { id: "dns-outage", name: "DNS provider outage", aliases: ["dns down", "resolver outage"] },
  { id: "queue-backlog", name: "Queue backlog / slow consumer", aliases: ["consumer lag", "queue buildup"] },
  { id: "config-typo", name: "Bad config change", aliases: ["config typo", "misconfiguration"] },
  { id: "feature-flag", name: "Feature flag misfire", aliases: ["flag rollout bug", "bad flag"] },
  { id: "cpu-throttling", name: "CPU throttling", aliases: ["cfs throttling", "cpu limits"] },
  { id: "noisy-neighbor", name: "Noisy neighbor", aliases: ["shared host contention", "co-tenant interference"] },
  { id: "cache-eviction", name: "Cache eviction pressure", aliases: ["redis evictions", "eviction storm"] },
  { id: "split-brain", name: "Split brain", aliases: ["dual primary", "two leaders"] },
  { id: "dependency-outage", name: "Downstream dependency outage", aliases: ["provider outage", "upstream service down"] },
  { id: "bad-deploy", name: "Bad deploy / code regression", aliases: ["bad release", "regression", "buggy deploy"] },
];
const answerById = Object.fromEntries(ANSWERS.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// CASES — vignette free; each wrong guess or investigation reveals a clue.
// Clue order mirrors real triage: symptom → metrics → recent changes → smoking gun.
// nearIds get a "directionally right" response instead of a flat reject.
// ---------------------------------------------------------------------------
const CASES = [
  {
    service: "checkout-api",
    sev: 2,
    start: "03:12",
    vignette: "PAGE — checkout error rate at 4% and climbing. Users seeing 503s at payment step.",
    clues: [
      "All failures are 503s originating from payments-svc. Every other endpoint is healthy.",
      "payments-svc looks fine: CPU and memory normal, zero restarts, latency on successful requests unchanged.",
      "Deploy log: promo-svc shipped 25 minutes ago. Different team. No shared code with payments.",
      "Postgres (payments db): active connections pinned at 500/500. Most are idle-in-transaction — owned by promo-svc.",
      "promo-svc's new coupon-lookup path opens a transaction and returns early on a common branch without releasing it.",
    ],
    answerId: "connection-pool-exhaustion",
    nearIds: ["bad-deploy", "thread-pool"],
    postmortem:
      "promo-svc and payments-svc share a database. The new coupon path leaked connections (opened transactions, never closed), pinning the pool at max and starving payments-svc — which failed while looking perfectly healthy itself. Fix: roll back, add an idle-in-transaction timeout, and give each service its own pool with a hard cap.",
  },
  {
    service: "orders ↔ inventory",
    sev: 1,
    start: "00:01",
    vignette: "PAGE — orders-svc → inventory-svc calls failing 100%. Started at exactly 00:00 UTC.",
    clues: [
      "Failures are TLS handshake errors — requests never reach the application layer. No HTTP status at all.",
      "No deploys in 3 days. No infra changes. Both services pass their own health checks.",
      "It's not just orders-svc: every client of inventory-svc is failing. Its inbound traffic is near zero.",
      "openssl s_client against inventory-svc: certificate NotAfter = today, 00:00 UTC.",
      "The cert-rotation job has been failing silently for 90 days. Its alerts route to a Slack channel that was deleted.",
    ],
    answerId: "cert-expiry",
    nearIds: ["expired-api-key", "config-typo"],
    postmortem:
      "The service's mTLS certificate expired at midnight — hence the perfectly sharp start time, the handshake-layer failures, and the absence of any recent change. Rotation had been broken for months with alerts going nowhere. Fix: renew, alert on cert lifetime remaining (not on job failure alone), and treat sharp midnight onsets as expiry until proven otherwise.",
  },
  {
    service: "product-page",
    sev: 3,
    start: "14:02",
    vignette: "PAGE — database CPU alarms firing in bursts. Product pages crawl for ~30s, recover, then it happens again.",
    clues: [
      "The spikes land exactly on a 15-minute grid: :00, :15, :30, :45.",
      "During each spike the DB runs the same expensive query hundreds of times concurrently — the top-sellers aggregation.",
      "Redis is healthy overall, but the hit rate for one key drops to zero at each spike, then recovers.",
      "The top_sellers key: TTL 900 seconds, no jitter. Recomputing it takes about 8 seconds.",
      "When the key expires, every request misses at once and all of them recompute in parallel until the first write lands.",
    ],
    answerId: "cache-stampede",
    nearIds: ["cache-eviction"],
    postmortem:
      "Classic stampede: a popular cache key expires on a fixed TTL, and every concurrent request recomputes the expensive value simultaneously, hammering the database until one write repopulates the key. Fix: TTL jitter, a recompute lock or single-flight, or serve-stale-while-revalidate.",
  },
  {
    service: "search-svc",
    sev: 2,
    start: "11:47",
    vignette: "PAGE — a 30-second network blip ended 10 minutes ago, but search-svc load is 8× normal and still climbing.",
    clues: [
      "Request rate arriving from clients vastly exceeds user traffic. Actual user traffic is flat.",
      "Client logs: timeouts trigger immediate re-attempts — 3 per call, zero backoff.",
      "Each search call fans out to 4 backend lookups, and those are retried on the same policy.",
      "It's a loop: rising latency → more timeouts → more retries → more load → rising latency. Success rate is falling as load rises.",
      "Load only returns to normal when someone manually disables retries at the gateway.",
    ],
    answerId: "retry-storm",
    nearIds: ["ddos", "thread-pool"],
    postmortem:
      "The blip healed, but naive retries (immediate, no backoff, multiplied by fan-out) amplified residual load into a self-sustaining storm — a system-inflicted DDoS. Fix: exponential backoff with jitter, retry budgets, circuit breakers, and retry only at one layer of the stack.",
  },
  {
    service: "recommendations",
    sev: 3,
    start: "09:20",
    vignette: "PAGE — recommendations pods have been restarting every ~6 hours for two days, with a burst of 500s at each restart.",
    clues: [
      "Every restart has the same exit: OOMKilled, exit code 137.",
      "Memory is a clean sawtooth: linear climb from 800MB to the 4GB limit, then reset on restart.",
      "The climb rate tracks request volume, and the pattern began with Tuesday's deploy.",
      "Heap dump: millions of retained embedding vectors, all reachable from one module-level list.",
      "Tuesday's diff added an in-process 'cache' — a plain dict keyed by user ID, with no eviction and no size bound.",
    ],
    answerId: "memory-leak",
    nearIds: ["gc-pause", "bad-deploy"],
    postmortem:
      "An unbounded in-process cache retained an entry per user forever, so memory grew linearly with traffic until the kernel OOM-killed the pod — the sawtooth is the signature. Fix: bounded cache with eviction (LRU + TTL), and alert on memory slope, not just on level.",
  },
  {
    service: "events-pipeline",
    sev: 2,
    start: "16:33",
    vignette: "PAGE — Kafka consumer lag at 40 minutes and growing, yet overall event throughput is below normal peak.",
    clues: [
      "Lag lives entirely on partition 7 of 32. Every other partition is near zero.",
      "The consumer on partition 7 is pegged at 100% CPU. Adding consumers does nothing — one partition, one consumer, that's the ceiling.",
      "The topic's partition key is user_id.",
      "One single user_id accounts for 61% of all events in the last hour.",
      "It belongs to a new enterprise customer's bulk-import bot — every one of its events hashes to partition 7.",
    ],
    answerId: "hot-partition",
    nearIds: ["queue-backlog", "noisy-neighbor"],
    postmortem:
      "Partitioning by user_id concentrated one heavy producer's entire stream onto a single partition, and a partition is a serial unit — no amount of scaling helps. Fix: composite or salted keys for heavy tenants, per-tenant rate limits, and lag alerts per partition, not per topic.",
  },
  {
    service: "media-uploads",
    sev: 3,
    start: "10:05",
    vignette: "PAGE — about 2% of image uploads are failing. Retries sometimes succeed, which smells like one bad host.",
    clues: [
      "Confirmed: every failure traces to host web-14. The error: 'No space left on device'.",
      "df on web-14: root volume 100% full. Peer hosts sit at ~40%.",
      "du points at /var/log/app: 380GB — one access.log that hasn't rolled in months.",
      "logrotate config exists, but the unit fails at startup: its postrotate script calls a binary removed in the last OS upgrade.",
      "The rot started the week of that upgrade. Disk alerts only fire at 100% — nothing watches the trend.",
    ],
    answerId: "disk-full",
    nearIds: ["config-typo"],
    postmortem:
      "An OS upgrade silently broke logrotate, one host's access log grew for months, and the disk filled — the 2%/sometimes-succeeds pattern is the load balancer routing a fraction of traffic to the one bad host. Fix: rotate and truncate, repair the unit, and alert on disk trend and on logrotate failures, not just at 100%.",
  },
  {
    service: "api-gateway",
    sev: 2,
    start: "07:58",
    vignette: "PAGE — after last night's planned database failover (marked successful), 50% of API requests are erroring.",
    clues: [
      "The errors are connection timeouts — to the old primary's IP address.",
      "The new primary is healthy. App pods that happened to restart after the failover work perfectly.",
      "The failover flipped a DNS record. Old-generation pods are still resolving the retired IP.",
      "The record's TTL is 3600s — yet the errors have persisted well past an hour.",
      "The app runs on the JVM, which by default caches successful DNS lookups forever (networkaddress.cache.ttl = -1).",
    ],
    answerId: "stale-dns",
    nearIds: ["dns-outage", "network-partition"],
    postmortem:
      "The failover was DNS-based, but the JVM's default resolver cache never expires entries, so long-lived pods kept dialing the dead primary regardless of TTL. Restarted pods resolved fresh — hence the clean 50/50 split. Fix: set a sane JVM DNS TTL, prefer connection-string failover or a proxy layer, and make pod recycling part of the failover runbook.",
  },
  {
    service: "auth",
    sev: 3,
    start: "13:41",
    vignette: "PAGE — 0.7% of API calls failing with 401 invalid token. The same user's token works fine on retry.",
    clues: [
      "Every failure was verified on host pool C. Pools A and B have zero.",
      "Rejection reason in logs: 'token used before issued' — the token's iat timestamp is in the future.",
      "Pool C's clocks are 95 seconds behind. JWT validation tolerates 60 seconds of skew.",
      "chrony isn't running on pool C — a hardening script disabled the wrong unit across that pool.",
      "Drift accumulates ~2s/day. The 401 rate has been creeping upward for six weeks and nobody connected the dots.",
    ],
    answerId: "clock-skew",
    nearIds: ["expired-api-key"],
    postmortem:
      "With NTP dead on one pool, its clocks drifted until freshly-issued tokens appeared to come from the future and failed validation — sporadically, because only requests landing on pool C failed. Fix: restore time sync, alert on clock offset directly, and treat 'works on retry' as a load-balancer-shaped clue.",
  },
  {
    service: "orders-api",
    sev: 3,
    start: "10:52",
    vignette: "PAGE — the orders list endpoint's p99 jumped from 180ms to 4.2s after this morning's deploy. DB read QPS is up 40×.",
    clues: [
      "Latency scales with page size: 10 rows is snappy, 100 rows is ~10× slower.",
      "The slow-query log shows nothing slow. Instead: a flood of identical fast queries — SELECT * FROM customers WHERE id = ?.",
      "Tracing one request: 1 query for the orders, then 1 additional query per order to fetch its customer.",
      "This morning's diff refactored the ORM call and dropped the eager-load — includes(:customer) is gone.",
      "Queries per request went from 3 to N+2, where N is the number of rows on the page.",
    ],
    answerId: "n-plus-one",
    nearIds: ["bad-deploy", "bad-migration"],
    postmortem:
      "Removing the eager-load turned one join into a query per row — the textbook N+1. No single query is slow, so the slow log stays quiet while total round-trips explode; latency scaling with page size is the tell. Fix: restore the eager-load, and add a per-request query-count budget to CI.",
  },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + mins + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function matchAnswers(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const scored = ANSWERS.map((a) => {
    const hay = [a.name, ...a.aliases].map((x) => x.toLowerCase());
    const starts = hay.some((x) => x.startsWith(s));
    const inc = hay.some((x) => x.includes(s));
    return { a, score: starts ? 2 : inc ? 1 : 0 };
  }).filter((x) => x.score > 0);
  scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name));
  return scored.slice(0, 7).map((x) => x.a);
}

const TAG = {
  page: { label: "PAGE", cls: "tag-page" },
  clue: { label: "OBSERVED", cls: "tag-clue" },
  reject: { label: "RULED OUT", cls: "tag-reject" },
  near: { label: "CLOSE", cls: "tag-near" },
  resolve: { label: "RESOLVED", cls: "tag-resolve" },
  escalate: { label: "ESCALATED", cls: "tag-escalate" },
};

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------
export default function Incidle() {
  const [caseIdx, setCaseIdx] = useState(0);
  const [feed, setFeed] = useState(() => initialFeed(0));
  const [revealed, setRevealed] = useState(0);
  const [status, setStatus] = useState("active"); // active | solved | failed
  const [query, setQuery] = useState("");
  const [guessedIds, setGuessedIds] = useState([]);
  const [copied, setCopied] = useState(false);
  const feedEndRef = useRef(null);
  const inputRef = useRef(null);

  const c = CASES[caseIdx];
  const maxClues = c.clues.length;
  const suggestions = useMemo(() => matchAnswers(query), [query]);

  function initialFeed(idx) {
    const cs = CASES[idx];
    return [{ type: "page", time: cs.start, text: cs.vignette }];
  }

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed, status]);

  function eventTime(n) {
    return addMinutes(c.start, 4 * n + 3);
  }

  function revealNext(baseFeed) {
    const next = [...baseFeed];
    if (revealed < maxClues) {
      next.push({ type: "clue", time: eventTime(revealed + 1), text: c.clues[revealed] });
      setRevealed(revealed + 1);
      return { feed: next, exhausted: false };
    }
    return { feed: next, exhausted: true };
  }

  function handleInvestigate() {
    if (status !== "active" || revealed >= maxClues) return;
    const { feed: f } = revealNext(feed);
    setFeed(f);
  }

  function handleGuess(ans) {
    if (status !== "active" || !ans || guessedIds.includes(ans.id)) return;
    setQuery("");
    const t = eventTime(revealed + 1);
    if (ans.id === c.answerId) {
      setFeed([
        ...feed,
        { type: "resolve", time: t, text: `Root cause confirmed: ${ans.name}.` },
      ]);
      setStatus("solved");
      return;
    }
    const near = c.nearIds?.includes(ans.id);
    const entry = near
      ? { type: "near", time: t, text: `${ans.name} — directionally right, but name the mechanism. What exactly broke?` }
      : { type: "reject", time: t, text: `Hypothesis rejected: ${ans.name}. Evidence doesn't fit.` };
    const newGuessed = [...guessedIds, ans.id];
    setGuessedIds(newGuessed);

    if (revealed >= maxClues) {
      setFeed([
        ...feed,
        entry,
        { type: "escalate", time: addMinutes(t, 2), text: `Incident escalated. Postmortem identifies: ${answerById[c.answerId].name}.` },
      ]);
      setStatus("failed");
      return;
    }
    const { feed: f } = revealNext([...feed, entry]);
    setFeed(f);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && suggestions.length > 0) handleGuess(suggestions[0]);
  }

  function nextCase() {
    const idx = (caseIdx + 1) % CASES.length;
    setCaseIdx(idx);
    setFeed(initialFeed(idx));
    setRevealed(0);
    setStatus("active");
    setQuery("");
    setGuessedIds([]);
    setCopied(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function shareText() {
    const squares = Array.from({ length: maxClues + 1 }, (_, i) => {
      if (status === "solved") {
        if (i < revealed) return "🟨";
        if (i === revealed) return "🟩";
        return "⬜";
      }
      return i <= maxClues ? "🟥" : "⬜";
    }).join("");
    const verdict = status === "solved" ? `solved after ${revealed} clue${revealed === 1 ? "" : "s"}` : "escalated";
    return `Incidle #${caseIdx + 1} (${c.service}) — ${verdict}\n${squares}`;
  }

  async function copyShare() {
    try {
      await navigator.clipboard.writeText(shareText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  const errRate =
    status === "solved" ? 0.2 : status === "failed" ? 34.8 : 2.4 + revealed * 1.7 + guessedIds.length * 0.9;
  const done = status !== "active";

  return (
    <div className="idle-root">
      <style>{CSS}</style>

      <header className="hdr">
        <div className="hdr-left">
          <span className="brand">INCIDENTDLE</span>
          <span className="case-num">
            incident {caseIdx + 1}/{CASES.length}
          </span>
        </div>
        <div className="hdr-right">
          <span className={`sev sev-${c.sev}`}>SEV{c.sev}</span>
          <span className="svc">{c.service}</span>
          <span className={`err ${status === "solved" ? "err-ok" : ""}`}>
            err {errRate.toFixed(1)}%{status === "active" ? " ▲" : status === "solved" ? " ▼" : " ▲"}
          </span>
        </div>
      </header>

      <div className="budget" aria-label="clue budget">
        {Array.from({ length: maxClues }, (_, i) => (
          <span key={i} className={`pip ${i < revealed ? "pip-burned" : ""} ${done && status === "solved" ? "pip-done" : ""}`} />
        ))}
        <span className="budget-label">
          {status === "active"
            ? `${maxClues - revealed} clue${maxClues - revealed === 1 ? "" : "s"} remaining`
            : status === "solved"
            ? `mitigated after ${revealed} clue${revealed === 1 ? "" : "s"}`
            : "clue budget exhausted"}
        </span>
      </div>

      <main className="feed" aria-live="polite">
        {feed.map((e, i) => (
          <div key={i} className={`entry entry-${e.type}`}>
            <span className="time">{e.time}</span>
            <span className={`tag ${TAG[e.type].cls}`}>{TAG[e.type].label}</span>
            <span className="text">{e.text}</span>
          </div>
        ))}

        {done && (
          <div className="post">
            <div className="post-head">{status === "solved" ? "POSTMORTEM — nice triage" : "POSTMORTEM"}</div>
            <p className="post-body">{c.postmortem}</p>
            <div className="post-actions">
              <button className="btn btn-ghost" onClick={copyShare}>
                {copied ? "copied ✓" : "copy result"}
              </button>
              <button className="btn btn-primary" onClick={nextCase}>
                next incident →
              </button>
            </div>
            <pre className="share-preview">{shareText()}</pre>
          </div>
        )}
        <div ref={feedEndRef} />
      </main>

      {!done && (
        <footer className="dock">
          <div className="combo">
            <input
              ref={inputRef}
              className="combo-input"
              value={query}
              placeholder="Root cause hypothesis… (type to search)"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label="root cause hypothesis"
              autoFocus
            />
            {suggestions.length > 0 && (
              <ul className="combo-list" role="listbox">
                {suggestions.map((a, i) => (
                  <li key={a.id}>
                    <button
                      className={`combo-opt ${i === 0 ? "combo-opt-top" : ""} ${guessedIds.includes(a.id) ? "combo-opt-used" : ""}`}
                      onClick={() => handleGuess(a)}
                      disabled={guessedIds.includes(a.id)}
                    >
                      {a.name}
                      {guessedIds.includes(a.id) && <span className="used-note"> — ruled out</span>}
                      {i === 0 && !guessedIds.includes(a.id) && <span className="enter-hint">↵</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button className="btn btn-secondary" onClick={handleInvestigate} disabled={revealed >= maxClues}>
            investigate <span className="btn-sub">(reveal a clue)</span>
          </button>
        </footer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// styles — dark observability-console look: slate blue base, severity hues.
// ---------------------------------------------------------------------------
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');

.idle-root {
  --bg: #0d1220; --panel: #151c2c; --line: #232d42;
  --text: #d7deea; --muted: #7c8aa0;
  --red: #ff6b6b; --amber: #ffc46b; --cyan: #6bd5e8; --green: #57d993;
  min-height: 100vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
  font-family: 'Inter', system-ui, sans-serif; font-size: 15px;
}
.idle-root * { box-sizing: border-box; }
.idle-root button { font: inherit; cursor: pointer; }
.idle-root :focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }

.hdr {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  flex-wrap: wrap;
}
.hdr-left, .hdr-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-weight: 600; letter-spacing: 0.18em; font-size: 14px;
}
.case-num { color: var(--muted); font-size: 12.5px; }
.svc { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13px; color: var(--cyan); }
.sev {
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; font-weight: 600;
  padding: 2px 7px; border-radius: 4px; letter-spacing: 0.06em;
}
.sev-1 { background: rgba(255,107,107,.18); color: var(--red); border: 1px solid rgba(255,107,107,.45); }
.sev-2 { background: rgba(255,196,107,.15); color: var(--amber); border: 1px solid rgba(255,196,107,.4); }
.sev-3 { background: rgba(107,213,232,.12); color: var(--cyan); border: 1px solid rgba(107,213,232,.35); }
.err { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13px; color: var(--red); }
.err-ok { color: var(--green); }

.budget {
  display: flex; align-items: center; gap: 6px; padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}
.pip { width: 22px; height: 6px; border-radius: 3px; background: var(--line); }
.pip-burned { background: var(--amber); }
.pip-done.pip-burned { background: var(--amber); }
.budget-label { margin-left: 8px; color: var(--muted); font-size: 12.5px; }

.feed { flex: 1; overflow-y: auto; padding: 18px 16px 24px; max-width: 860px; width: 100%; margin: 0 auto; }
.entry {
  display: grid; grid-template-columns: 46px 88px 1fr; gap: 10px; align-items: baseline;
  padding: 9px 10px; border-radius: 6px; margin-bottom: 6px;
  animation: arrive .28s ease-out;
}
@keyframes arrive { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .entry { animation: none; } }
.time { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; color: var(--muted); }
.tag {
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 10.5px; font-weight: 600;
  letter-spacing: .08em; padding: 2px 6px; border-radius: 4px; text-align: center; white-space: nowrap;
}
.tag-page { background: rgba(255,107,107,.16); color: var(--red); }
.tag-clue { background: rgba(107,213,232,.12); color: var(--cyan); }
.tag-reject { background: rgba(124,138,160,.14); color: var(--muted); }
.tag-near { background: rgba(255,196,107,.15); color: var(--amber); }
.tag-resolve { background: rgba(87,217,147,.16); color: var(--green); }
.tag-escalate { background: rgba(255,107,107,.16); color: var(--red); }
.text { line-height: 1.5; }
.entry-page { background: rgba(255,107,107,.06); border: 1px solid rgba(255,107,107,.18); }
.entry-page .text { font-weight: 500; }
.entry-clue { background: var(--panel); border: 1px solid var(--line); }
.entry-clue .text { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13.5px; }
.entry-reject .text { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(255,107,107,.5); }
.entry-near .text { color: var(--amber); }
.entry-resolve { background: rgba(87,217,147,.07); border: 1px solid rgba(87,217,147,.25); }
.entry-resolve .text { color: var(--green); font-weight: 500; }
.entry-escalate { background: rgba(255,107,107,.07); border: 1px solid rgba(255,107,107,.25); }
.entry-escalate .text { color: var(--red); font-weight: 500; }

.post {
  margin-top: 16px; padding: 16px; border-radius: 8px;
  background: var(--panel); border: 1px solid var(--line);
}
.post-head {
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; font-weight: 600;
  letter-spacing: .14em; color: var(--muted); margin-bottom: 8px;
}
.post-body { margin: 0 0 14px; line-height: 1.6; }
.post-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.share-preview {
  margin: 14px 0 0; padding: 10px 12px; border-radius: 6px; background: var(--bg);
  border: 1px solid var(--line); color: var(--muted);
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12.5px; white-space: pre-wrap;
}

.dock {
  display: flex; gap: 10px; padding: 12px 16px 16px; border-top: 1px solid var(--line);
  background: var(--panel); max-width: 860px; width: 100%; margin: 0 auto; align-items: flex-start;
  position: relative;
}
.combo { position: relative; flex: 1; }
.combo-input {
  width: 100%; padding: 11px 13px; border-radius: 7px;
  background: var(--bg); border: 1px solid var(--line); color: var(--text);
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px;
}
.combo-input::placeholder { color: var(--muted); }
.combo-list {
  position: absolute; bottom: calc(100% + 6px); left: 0; right: 0;
  list-style: none; margin: 0; padding: 4px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  box-shadow: 0 -8px 24px rgba(0,0,0,.4); z-index: 10; max-height: 300px; overflow-y: auto;
}
.combo-opt {
  display: flex; justify-content: space-between; align-items: center; width: 100%;
  text-align: left; padding: 9px 11px; border: 0; border-radius: 6px;
  background: transparent; color: var(--text); font-size: 14px;
}
.combo-opt:hover:not(:disabled) { background: rgba(107,213,232,.1); }
.combo-opt-top:not(:disabled) { background: rgba(107,213,232,.07); }
.combo-opt-used { color: var(--muted); cursor: not-allowed; }
.used-note { font-size: 12px; }
.enter-hint { color: var(--muted); font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 12px; }

.btn {
  padding: 11px 16px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); font-size: 14px; font-weight: 500; white-space: nowrap;
}
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-sub { color: var(--muted); font-weight: 400; font-size: 12.5px; }
.btn-secondary:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); }
.btn-primary { background: rgba(87,217,147,.14); border-color: rgba(87,217,147,.4); color: var(--green); }
.btn-primary:hover { background: rgba(87,217,147,.22); }
.btn-ghost:hover { border-color: var(--cyan); color: var(--cyan); }

@media (max-width: 560px) {
  .entry { grid-template-columns: 42px 1fr; }
  .entry .text { grid-column: 1 / -1; }
  .dock { flex-direction: column; }
  .dock .btn { width: 100%; }
}
`;
