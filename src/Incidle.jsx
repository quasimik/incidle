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
// CASES — the paging vignette is free. Every action after that — revealing an
// observation or testing a hypothesis (right or wrong) — burns one hour of the
// HOURS budget. Unresolved at T+HOURS, the incident escalates.
// Clue order mirrors real triage: symptom → metrics → changes → smoking gun.
// nearIds get a "directionally right" response but still cost the hour.
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
    ],
    answerId: "connection-pool-exhaustion",
    nearIds: ["bad-deploy", "thread-pool"],
    postmortem:
      "promo-svc and payments-svc share a database. The new coupon path leaked connections (opened transactions, never closed), pinning the pool at max and starving payments-svc — which failed while looking perfectly healthy itself. Fix: roll back, add an idle-in-transaction timeout, and give each service its own pool with a hard cap.",
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
    ],
    answerId: "cache-stampede",
    nearIds: ["cache-eviction"],
    postmortem:
      "Classic stampede: a popular cache key expires on a fixed TTL, and every concurrent request recomputes the expensive value simultaneously, hammering the database until one write repopulates the key. Fix: TTL jitter, a recompute lock or single-flight, or serve-stale-while-revalidate.",
  },
  {
    service: "auth",
    sev: 3,
    start: "13:41",
    vignette: "PAGE — 0.7% of API calls failing with 401 invalid token. The same user's token works fine on retry.",
    clues: [
      "Every failure was verified on host pool C. Pools A and B have zero.",
      "Rejection reason in logs: 'token used before issued' — the token's iat timestamp is in the future.",
      "chrony isn't running on pool C — a hardening script disabled the wrong unit across that pool.",
      "Drift accumulates ~2s/day. The 401 rate has been creeping upward for six weeks and nobody connected the dots.",
    ],
    answerId: "clock-skew",
    nearIds: ["expired-api-key"],
    postmortem:
      "With NTP dead on one pool, its clocks drifted until freshly-issued tokens appeared to come from the future and failed validation — sporadically, because only requests landing on pool C failed. Fix: restore time sync, alert on clock offset directly, and treat 'works on retry' as a load-balancer-shaped clue.",
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

const HOURS = 7; // time budget per incident; one action = one hour

const TAG = {
  page: { label: "PAGE", cls: "tag-page" },
  clue: { label: "OBSERVED", cls: "tag-clue" },
  reject: { label: "REJECTED", cls: "tag-reject" },
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
  const [actions, setActions] = useState([]); // "obs" | "wrong" | "solve" — one per hour burned
  const [status, setStatus] = useState("active"); // active | solved | failed
  const [query, setQuery] = useState("");
  const [guessedIds, setGuessedIds] = useState([]);
  const [selIdx, setSelIdx] = useState(0); // highlighted suggestion
  const [staged, setStaged] = useState(null); // confirmed pick, awaiting submit
  const [copied, setCopied] = useState(false);
  const feedEndRef = useRef(null);
  const inputRef = useRef(null);

  const c = CASES[caseIdx];
  const maxClues = c.clues.length;
  const revealed = actions.filter((a) => a === "obs").length;
  const hoursUsed = actions.length;
  const suggestions = useMemo(() => matchAnswers(query), [query]);
  const sel = Math.min(selIdx, Math.max(suggestions.length - 1, 0));

  function initialFeed(idx) {
    const cs = CASES[idx];
    return [{ type: "page", time: cs.start, text: cs.vignette }];
  }

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed, status]);

  function eventTime(n) {
    return addMinutes(c.start, 60 * n);
  }

  // Commit an hour-costing action; escalate if it was the budget's last hour.
  function settle(newFeed, newActions) {
    if (newActions.length >= HOURS) {
      setFeed([
        ...newFeed,
        { type: "escalate", time: addMinutes(eventTime(HOURS), 5), text: `Incident escalated at T+${HOURS}. Postmortem identifies: ${answerById[c.answerId].name}.` },
      ]);
      setStatus("failed");
      return;
    }
    setFeed(newFeed);
  }

  function handleInvestigate() {
    if (status !== "active" || revealed >= maxClues) return;
    const newActions = [...actions, "obs"];
    setActions(newActions);
    settle([...feed, { type: "clue", time: eventTime(newActions.length), text: c.clues[revealed] }], newActions);
  }

  // Hotkey: 0 investigates (1-9 confirm suggestions). Window-level so it works
  // regardless of focus; re-registered each render to see fresh state.
  useEffect(() => {
    function onHotkey(e) {
      if (e.key !== "0" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      handleInvestigate();
    }
    window.addEventListener("keydown", onHotkey);
    return () => window.removeEventListener("keydown", onHotkey);
  });

  function handleGuess(ans) {
    if (status !== "active" || !ans || guessedIds.includes(ans.id)) return;
    setQuery("");
    setStaged(null);
    setSelIdx(0);
    const hit = ans.id === c.answerId;
    const newActions = [...actions, hit ? "solve" : "wrong"];
    const t = eventTime(newActions.length);
    setActions(newActions);
    if (hit) {
      setFeed([
        ...feed,
        { type: "resolve", time: t, text: `Root cause confirmed: ${ans.name}. Resolved at T+${newActions.length}.` },
      ]);
      setStatus("solved");
      return;
    }
    const near = c.nearIds?.includes(ans.id);
    const entry = near
      ? { type: "near", time: t, text: `${ans.name} — directionally right, but name the mechanism. What exactly broke?` }
      : { type: "reject", time: t, text: `${ans.name}` };
    setGuessedIds([...guessedIds, ans.id]);
    settle([...feed, entry], newActions);
  }

  // Two-step guess: confirm a suggestion (enter / number / click / arrows+enter)
  // to stage it, then Guess button or a second enter submits it.
  function confirmPick(ans) {
    if (guessedIds.includes(ans.id)) return;
    setStaged(ans);
    setQuery(ans.name);
    setSelIdx(0);
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (staged) handleGuess(staged);
      else if (suggestions.length > 0) confirmPick(suggestions[sel]);
      return;
    }
    if (staged || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelIdx(Math.min(sel + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelIdx(Math.max(sel - 1, 0));
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= suggestions.length) {
      e.preventDefault();
      confirmPick(suggestions[Number(e.key) - 1]);
    }
  }

  function nextCase() {
    const idx = (caseIdx + 1) % CASES.length;
    setCaseIdx(idx);
    setFeed(initialFeed(idx));
    setActions([]);
    setStatus("active");
    setQuery("");
    setGuessedIds([]);
    setSelIdx(0);
    setStaged(null);
    setCopied(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function shareText() {
    const sq = { obs: "🟦", wrong: "🟥", solve: "🟩" };
    const squares = actions.map((a) => sq[a]).join("") + "⬜".repeat(HOURS - hoursUsed);
    const verdict = status === "solved" ? `Resolved at T+${hoursUsed}` : "Escalated!";
    return `💻 Incidle ${caseIdx + 1}\n${verdict}\n${squares}\n\nhttps://incidle.com`;
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
    status === "solved" ? 0.2 : status === "failed" ? 34.8 : 2.4 + hoursUsed * 1.9;
  const done = status !== "active";

  return (
    <div className="idle-root">
      <style>{CSS}</style>

      <header className="hdr">
        <div className="hdr-left">
          <span className="brand">INCIDLE</span>
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

      <div className="budget" aria-label="hour budget">
        {Array.from({ length: HOURS }, (_, i) => (
          <span key={i} className={`pip ${actions[i] ? `pip-${actions[i]}` : ""}`} />
        ))}
        <span className="budget-label">
          {status === "active"
            ? `${HOURS - hoursUsed} hour${HOURS - hoursUsed === 1 ? "" : "s"} until escalation`
            : status === "solved"
            ? `resolved at T+${hoursUsed}`
            : `escalated at T+${HOURS}`}
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
          <button className="btn btn-secondary btn-wide" onClick={handleInvestigate} disabled={revealed >= maxClues}>
            <kbd className="key">0</kbd> Investigate <span className="btn-sub">(reveal a clue)</span>
          </button>
          <div className="dock-row">
            <div className="combo">
              <input
                ref={inputRef}
                className={`combo-input ${staged ? "combo-input-staged" : ""}`}
                value={query}
                placeholder="Guess root cause… (type to search)"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setStaged(null);
                  setSelIdx(0);
                }}
                onKeyDown={onKeyDown}
                aria-label="guess root cause"
                autoFocus
              />
              {!staged && suggestions.length > 0 && (
                <ul className="combo-list" role="listbox">
                  {suggestions.map((a, i) => {
                    const used = guessedIds.includes(a.id);
                    return (
                      <li key={a.id}>
                        <button
                          className={`combo-opt ${i === sel ? "combo-opt-sel" : ""} ${used ? "combo-opt-used" : ""}`}
                          onClick={() => confirmPick(a)}
                          disabled={used}
                        >
                          <span className="opt-main">
                            <kbd className="key">{i + 1}</kbd>
                            {a.name}
                            {used && <span className="used-note"> — rejected</span>}
                          </span>
                          {i === sel && !used && <span className="enter-hint">↵</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <button className="btn btn-primary" onClick={() => staged && handleGuess(staged)} disabled={!staged}>
              Guess{staged ? " ↵" : ""}
            </button>
          </div>
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
.pip-obs { background: var(--cyan); }
.pip-wrong { background: var(--red); }
.pip-solve { background: var(--green); }
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
  display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 28px;
  border-top: 1px solid var(--line);
  background: var(--panel); max-width: 860px; width: 100%; margin: 0 auto;
  position: relative;
}
.dock-row { display: flex; gap: 10px; align-items: flex-start; }
.btn-wide {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
}
.combo { position: relative; flex: 1; }
.combo-input {
  width: 100%; padding: 11px 13px; border-radius: 7px;
  background: var(--bg); border: 1px solid var(--line); color: var(--text);
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px;
}
.combo-input::placeholder { color: var(--muted); }
.combo-input-staged { border-color: rgba(87,217,147,.6); }
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
.combo-opt-sel:not(:disabled) { background: rgba(107,213,232,.07); }
.combo-opt-used { color: var(--muted); cursor: not-allowed; }
.opt-main { display: flex; align-items: center; gap: 9px; }
.key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 19px; height: 19px; padding: 0 4px;
  border-radius: 4px; background: var(--bg);
  border: 1px solid var(--line); border-bottom-width: 3px;
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px;
  color: var(--muted); vertical-align: middle;
}
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
}
`;
