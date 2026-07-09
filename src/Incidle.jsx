import { useState, useMemo, useRef, useEffect } from "react";
import uFuzzy from "@leeoniya/ufuzzy";

// ---------------------------------------------------------------------------
// CASES — the paging vignette and the stack primer are free. Every action
// after that — revealing an observation or testing a hypothesis (right or
// wrong) — burns one hour of the HOURS budget. Unresolved at T+HOURS, the
// incident escalates.
// Clue order mirrors real triage: symptom → metrics → changes → smoking gun.
// nearIds get a "directionally right" response but still cost the hour.
// stack: what the responder would already know — relevant or apparently
// relevant only, never exhaustive. It shapes the hypothesis space for free.
// ---------------------------------------------------------------------------
const CASES = [
  {
    service: "checkout-api",
    sev: 2,
    vignette: "PAGE — checkout error rate at 4% and climbing. Users seeing 503s at payment step.",
    stack:
      "`checkout-api` fronts the purchase flow and calls `payments-svc` for card auth against a third-party processor. Several backend services share one Postgres primary (`max_connections` 500). Sessions live in Redis. Teams deploy independently, many times a day.",
    clues: [
      "All failures are 503s originating from `payments-svc`. Every other endpoint is healthy.",
      "`payments-svc` looks fine: CPU and memory normal, zero restarts, latency on successful requests unchanged.",
      "Deploy log: `promo-svc` shipped 25 minutes ago. Different team. No shared code with payments.",
      "Postgres (payments db): active connections pinned at 500/500. Most are `idle in transaction` — owned by `promo-svc`.",
    ],
    answerId: "connection_pool_exhaustion",
    nearIds: ["bad_code_deploy", "thread_pool_exhaustion"],
    postmortem:
      "`promo-svc` and `payments-svc` share a database. The new coupon path leaked connections (opened transactions, never closed), pinning the pool at max and starving `payments-svc` — which failed while looking perfectly healthy itself. Fix: roll back, add an idle-in-transaction timeout, and give each service its own pool with a hard cap.",
  },
  {
    service: "product-page",
    sev: 3,
    vignette: "PAGE — database CPU alarms firing in bursts. Product pages crawl for ~30s, recover, then it happens again.",
    stack:
      "`product-page` renders server-side off a Postgres read pool. Expensive aggregations are cached look-aside in Redis with TTLs. A CDN caches full pages for anonymous traffic, and assorted cron jobs run housekeeping on fixed schedules.",
    clues: [
      "The spikes land exactly on a 15-minute grid: :00, :15, :30, :45.",
      "During each spike the DB runs the same expensive query hundreds of times concurrently — the top-sellers aggregation.",
      "Redis is healthy overall, but the hit rate for one key drops to zero at each spike, then recovers.",
      "The `top_sellers` key: TTL 900 seconds, no jitter. Recomputing it takes about 8 seconds.",
    ],
    answerId: "cache_stampede",
    nearIds: ["cache_hit_rate_collapse"],
    postmortem:
      "Classic stampede: a popular cache key expires on a fixed TTL, and every concurrent request recomputes the expensive value simultaneously, hammering the database until one write repopulates the key. Fix: TTL jitter, a recompute lock or single-flight, or serve-stale-while-revalidate.",
  },
  {
    service: "auth",
    sev: 3,
    vignette: "PAGE — 0.7% of API calls failing with 401 invalid token. The same user's token works fine on retry.",
    stack:
      "auth issues short-lived signed tokens (JWT, 15-minute expiry) that services verify locally against weekly-rotated keys. Verification runs on three pools of long-lived VMs behind a round-robin balancer. A security-hardening pass tightened baseline host configs recently.",
    clues: [
      "Every failure was verified on host pool C. Pools A and B have zero.",
      "Rejection reason in logs: 'token used before issued' — the token's `iat` timestamp is in the future.",
      "`chrony` isn't running on pool C — a hardening script disabled the wrong unit across that pool.",
      "Drift accumulates ~2s/day. The 401 rate has been creeping upward for six weeks and nobody connected the dots.",
    ],
    answerId: "clock_skew",
    nearIds: ["credential_expiry"],
    postmortem:
      "With NTP dead on one pool, its clocks drifted until freshly-issued tokens appeared to come from the future and failed validation — sporadically, because only requests landing on pool C failed. Fix: restore time sync, alert on clock offset directly, and treat 'works on retry' as a load-balancer-shaped clue.",
  },
];

// ---------------------------------------------------------------------------
// ANSWER LIST — fixed taxonomy of root causes, fetched at runtime from
// /api/root-causes (Neon Postgres; same shape the old JSON file had).
// Guesses are selected from this list (autocomplete), so alias-matching
// problems never occur. Each entry: id, name, aliases, description, tags
// (sorted important-first; tags[0] is the primary group, and an `external`
// first tag marks causes outside the team's control), plus four diagnostic
// axes (detection_signal, onset_shape, correlation, blast_radius) that are
// deliberately not wired into gameplay yet.
// ---------------------------------------------------------------------------
// Fuzzy matching via uFuzzy: single-error typo tolerance within terms,
// out-of-order terms. Haystack rows are each answer's name, each alias, and
// each tag, all mapped back to the answer; best-ranked row wins per answer.
// Indexing tags makes a whole category queryable at once — e.g. "external"
// surfaces every external cause (vendor outage, cloud provider outage, …).
const uf = new uFuzzy({ intraMode: 1, intraIns: 1, intraSub: 1, intraTrn: 1, intraDel: 1 });

// Only the first HOTKEYS matches are shown, each with a number-key shortcut;
// any beyond that collapse into a "-- N more --" hint. The list stays short and
// every visible option is pressable — narrow the query to surface the rest.
const HOTKEYS = 6;

function buildMatcher(answers) {
  const answerById = Object.fromEntries(answers.map((a) => [a.id, a]));
  const hay = [];
  const hayAns = []; // parallel to hay: { a, hit, kind } — hit null on name rows
  for (const a of answers) {
    hay.push(a.name);
    hayAns.push({ a, hit: null, kind: "name" });
    for (const al of a.aliases) {
      hay.push(al);
      hayAns.push({ a, hit: al, kind: "alias" });
    }
    for (const t of a.tags) {
      hay.push(t);
      hayAns.push({ a, hit: t, kind: "tag" });
    }
  }

  // Returns { items, more }: items is up to HOTKEYS matches, each
  // { a, hit, kind, ranges } — kind is "name" | "alias" | "tag", ranges are
  // [from,to) pairs into the matched string (name / alias / tag); more is the
  // count of further distinct matches, shown only as a "-- N more --" hint.
  // Two tiers so tags stay lower-priority: name/alias rows fill slots first
  // (in uFuzzy's rank order), then tag rows take any that remain. A tag hit
  // thus never displaces a name/alias match, and only appears when there's
  // room — and answers that match both surface via their name/alias.
  function matchAnswers(q) {
    const s = q.trim();
    if (!s) return { items: [], more: 0 };
    const [idxs, info, order] = uf.search(hay, s, 3);
    if (!idxs || idxs.length === 0) return { items: [], more: 0 };
    const ordered = order ?? idxs.map((_, i) => i);
    const all = [];
    const seen = new Set();
    for (const tier of [["name", "alias"], ["tag"]]) {
      for (const oi of ordered) {
        const hi = info ? info.idx[oi] : idxs[oi];
        const { a, hit, kind } = hayAns[hi];
        if (!tier.includes(kind) || seen.has(a.id)) continue;
        seen.add(a.id);
        all.push({ a, hit, kind, ranges: info ? info.ranges[oi] : null });
      }
    }
    return { items: all.slice(0, HOTKEYS), more: Math.max(0, all.length - HOTKEYS) };
  }

  return { answerById, matchAnswers };
}

// wrap matched ranges in <mark>
function highlight(text, ranges) {
  if (!ranges || ranges.length === 0) return text;
  const out = [];
  let pos = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] > pos) out.push(text.slice(pos, ranges[i]));
    out.push(<mark key={i}>{text.slice(ranges[i], ranges[i + 1])}</mark>);
    pos = ranges[i + 1];
  }
  out.push(text.slice(pos));
  return out;
}

// `code` spans in feed text — odd-index segments sit inside backticks.
function rich(text) {
  return text.split("`").map((seg, i) => (i % 2 ? <code key={i}>{seg}</code> : seg));
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
// Loader shell: the game is unplayable without the answer list, so hold at a
// boot screen until the fetch lands (or offer a retry if it doesn't).
export default function Incidle() {
  const [answers, setAnswers] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch("/api/root-causes")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setAnswers(d.root_causes))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!answers) {
    return (
      <div className="idle-root">
        <style>{CSS}</style>
        <div className="boot">
          {failed ? (
            <>
              <span>couldn't reach the incident database.</span>
              <button className="btn btn-ghost" onClick={() => setAttempt(attempt + 1)}>
                retry
              </button>
            </>
          ) : (
            <span>connecting…</span>
          )}
        </div>
      </div>
    );
  }
  return <Game answers={answers} />;
}

function Game({ answers }) {
  const { answerById, matchAnswers } = useMemo(() => buildMatcher(answers), [answers]);
  const [caseIdx, setCaseIdx] = useState(0);
  const [feed, setFeed] = useState(() => initialFeed(0));
  const [actions, setActions] = useState([]); // "obs" | "wrong" | "solve" — one per hour burned
  const [status, setStatus] = useState("active"); // active | solved | failed
  const [query, setQuery] = useState("");
  const [guessedIds, setGuessedIds] = useState([]);
  const [selIdx, setSelIdx] = useState(0); // highlighted suggestion
  const [staged, setStaged] = useState(null); // confirmed pick, awaiting submit
  const [inputFocused, setInputFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const feedEndRef = useRef(null);
  const inputRef = useRef(null);
  const lastGuessAt = useRef(0); // absorbs double-enter after a guess submits

  const c = CASES[caseIdx];
  const maxClues = c.clues.length;
  const revealed = actions.filter((a) => a === "obs").length;
  const hoursUsed = actions.length;
  const { items: suggestions, more } = useMemo(() => matchAnswers(query), [query, matchAnswers]);
  const sel = Math.min(selIdx, Math.max(suggestions.length - 1, 0));

  function initialFeed(idx) {
    const cs = CASES[idx];
    return [{ type: "page", time: "T+0", text: cs.vignette }];
  }

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed, status]);

  function eventTime(n) {
    return `T+${n}`;
  }

  // Commit an hour-costing action; escalate if it was the budget's last hour.
  function settle(newFeed, newActions) {
    if (newActions.length >= HOURS) {
      setFeed([
        ...newFeed,
        { type: "escalate", time: "", text: `Postmortem identifies: ${answerById[c.answerId].name}.` },
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


  function handleGuess(ans) {
    if (status !== "active" || !ans || guessedIds.includes(ans.id)) return;
    lastGuessAt.current = Date.now();
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
        { type: "resolve", time: t, text: `Root cause confirmed: ${ans.name}.` },
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
    inputRef.current?.focus(); // keep enter-to-submit working after a click
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (staged) handleGuess(staged);
      else if (suggestions.length > 0) confirmPick(suggestions[sel].a);
      else if (query.trim() === "" && !e.repeat && Date.now() - lastGuessAt.current > 400) handleInvestigate();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setStaged(null);
      setSelIdx(0);
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
      confirmPick(suggestions[Number(e.key) - 1].a);
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
    const verdict = status === "solved" ? `resolved at T+${hoursUsed}` : "escalated!";
    return `💻 incidle ${caseIdx + 1}\n${verdict}\n${squares}\n\nhttps://incidle.com`;
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
  // one action button: investigate on empty field, guess otherwise
  const investigateMode = !staged && query.trim() === "";
  const enterInvestigates = inputFocused && investigateMode && revealed < maxClues;

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
        <div className="post post-sys">
          <div className="post-head">SYSTEM | {c.service}</div>
          <p className="post-body">{rich(c.stack)}</p>
        </div>

        {feed.map((e, i) => (
          <div key={i} className={`entry entry-${e.type}`}>
            <span className="time">{e.time}</span>
            <span className={`tag ${TAG[e.type].cls}`}>{TAG[e.type].label}</span>
            <span className="text">{rich(e.text)}</span>
          </div>
        ))}

        {done && (() => {
          const ans = answerById[c.answerId];
          return (
          <div className="post">
            <div className="post-head">POSTMORTEM</div>
            {ans.description && (
              <div className="callout">
                <span className="callout-icon">🎯</span>
                <div className="callout-head">Root cause: {ans.name}</div>
                <p className="callout-body">{rich(ans.description)}</p>
              </div>
            )}
            <p className="post-body">{rich(c.postmortem)}</p>
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
          );
        })()}
        <div ref={feedEndRef} />
      </main>

      {!done && (
        <footer className="dock">
          <div className="dock-row">
            <div className="combo">
              <input
                ref={inputRef}
                className={`combo-input ${staged ? "combo-input-staged" : ""}`}
                value={query}
                placeholder="guess root cause… (type to search)"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setStaged(null);
                  setSelIdx(0);
                }}
                onKeyDown={onKeyDown}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                aria-label="guess root cause"
                autoFocus
              />
              {!staged && suggestions.length > 0 && (
                <ul className="combo-list" role="listbox">
                  {suggestions.map((sug, i) => {
                    const used = guessedIds.includes(sug.a.id);
                    return (
                      <li key={sug.a.id}>
                        <button
                          className={`combo-opt ${i === sel ? "combo-opt-sel" : ""} ${used ? "combo-opt-used" : ""}`}
                          onClick={() => confirmPick(sug.a)}
                          disabled={used}
                        >
                          <span className="opt-main">
                            <kbd className="key">{i + 1}</kbd>
                            <span>{sug.kind === "name" ? highlight(sug.a.name, sug.ranges) : sug.a.name}</span>
                            {sug.kind === "alias" && (
                              <span className="alias-hit">{highlight(sug.hit, sug.ranges)}</span>
                            )}
                            {sug.kind === "tag" && (
                              <span className="tag-hit">{highlight(sug.hit, sug.ranges)}</span>
                            )}
                            {used && <span className="used-note"> — rejected</span>}
                          </span>
                          {i === sel && !used && <span className="enter-hint">↵</span>}
                        </button>
                      </li>
                    );
                  })}
                  {more > 0 && (
                    <li className="combo-more" aria-hidden="true">
                      -- {more} more --
                    </li>
                  )}
                </ul>
              )}
            </div>
            <button
              className={`btn action-btn ${investigateMode ? "btn-secondary" : "btn-primary"} ${enterInvestigates ? "btn-armed" : ""}`}
              onClick={() => (investigateMode ? handleInvestigate() : staged && handleGuess(staged))}
              disabled={investigateMode ? revealed >= maxClues : !staged}
            >
              {investigateMode ? "investigate" : "root-cause"}
              {(enterInvestigates || staged) && <kbd className="key">↵</kbd>}
              <span className="cost-tag" key={hoursUsed} title="every move burns one hour">1 HOUR</span>
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
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500&display=swap');

.idle-root {
  --bg: #0d1220; --panel: #151c2c; --line: #232d42;
  --text: #d7deea; --muted: #7c8aa0;
  --red: #ff6b6b; --amber: #ffc46b; --cyan: #6bd5e8; --green: #57d993;
  min-height: 100vh; display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
  font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 14px;
}
.idle-root * { box-sizing: border-box; }
.idle-root button, .idle-root input { font: inherit; }
.idle-root button { cursor: pointer; }
.idle-root :focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }

.hdr {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  flex-wrap: wrap;
}
.hdr-left, .hdr-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { font-weight: 600; letter-spacing: 0.18em; font-size: 14px; }
.case-num { color: var(--muted); font-size: 12.5px; }
.svc { font-size: 12.5px; color: var(--cyan); }
.sev {
  font-size: 11px; font-weight: 600;
  padding: 2px 7px; border-radius: 4px; letter-spacing: 0.06em;
}
.sev-1 { background: rgba(255,107,107,.18); color: var(--red); border: 1px solid rgba(255,107,107,.45); }
.sev-2 { background: rgba(255,196,107,.15); color: var(--amber); border: 1px solid rgba(255,196,107,.4); }
.sev-3 { background: rgba(107,213,232,.12); color: var(--cyan); border: 1px solid rgba(107,213,232,.35); }
.err { font-size: 12.5px; color: var(--red); }
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

.boot {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 14px;
  color: var(--muted);
}

.feed { flex: 1; overflow-y: auto; padding: 18px 16px 24px; max-width: 860px; width: 100%; margin: 0 auto; }
.entry {
  display: grid; grid-template-columns: 26px 88px 1fr; gap: 10px; align-items: baseline;
  padding: 9px 10px; border-radius: 6px; margin-bottom: 6px;
  animation: arrive .28s ease-out;
}
@keyframes arrive { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .entry, .cost-tag { animation: none; } }
.time { font-size: 12.5px; color: var(--muted); }
.tag {
  font-size: 11px; font-weight: 600;
  letter-spacing: .08em; padding: 2px 6px; border-radius: 4px; text-align: center; white-space: nowrap;
}
.tag-page { background: rgba(255,196,107,.15); color: var(--amber); }
.tag-clue { background: rgba(107,213,232,.15); color: var(--cyan); }
.tag-reject { background: rgba(255,107,107,.09); color: rgba(255,107,107,.7); }
.tag-near { background: rgba(255,196,107,.15); color: var(--amber); }
.tag-resolve { background: rgba(87,217,147,.15); color: var(--green); }
.tag-escalate { background: rgba(255,107,107,.15); color: var(--red); }
.text { line-height: 1.55; }
.text code, .post-body code {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  color: var(--cyan); background: rgba(107,213,232,.08);
  padding: 1px 4px; border-radius: 4px;
}
.post-body code { font-size: .9em; }
.entry-page { background: rgba(255,196,107,.05); border: 1px solid rgba(255,196,107,.16); }
.entry-page .text { font-weight: 500; }
.entry-clue { background: rgba(107,213,232,.05); border: 1px solid rgba(107,213,232,.16); }
.entry-reject { background: rgba(255,107,107,.03); border: 1px solid rgba(255,107,107,.1); }
.entry-reject .text { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(255,107,107,.5); }
.entry-near { background: rgba(255,196,107,.05); border: 1px solid rgba(255,196,107,.16); }
.entry-near .text { color: var(--amber); }
.entry-resolve { background: rgba(87,217,147,.07); border: 1px solid rgba(87,217,147,.25); }
.entry-resolve .text { color: var(--green); font-weight: 500; }
.entry-escalate { background: rgba(255,107,107,.07); border: 1px solid rgba(255,107,107,.25); }
.entry-escalate .text { color: var(--red); font-weight: 500; }

.post {
  margin-top: 0; padding: 16px; border-radius: 8px;
  background: var(--panel); border: 1px solid var(--line);
}
.post-head {
  font-size: 12.5px; font-weight: 600;
  letter-spacing: .14em; color: var(--muted); margin-bottom: 8px; text-transform: uppercase;
}
.post-body {
  margin: 0 0 14px; line-height: 1.55;
  font-family: 'Inter', system-ui, sans-serif; font-size: 15px;
}
.post-sys { margin: 0 0 6px; }
.post-sys .post-body { margin: 0; color: var(--muted); }
.callout {
  display: grid; grid-template-columns: auto 1fr; column-gap: 11px; row-gap: 7px;
  margin: 16px 0px; padding: 13px 15px; border-radius: 6px;
  background: var(--bg); border: 1px solid rgba(107,213,232,.28);
  border-left: 3px solid var(--cyan);
  box-shadow: inset 0 1px 3px rgba(0,0,0,.35);
}
.callout-icon { grid-row: 1; align-self: center; font-size: 19px; line-height: 1; }
.callout-head {
  grid-column: 2; align-self: center;
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 11px; font-weight: 700; letter-spacing: .1em;
  text-transform: uppercase; color: var(--cyan);
}
.callout-body {
  grid-column: 2;
  margin: 0; line-height: 1.55; font-size: 14px;
  font-family: 'Inter', system-ui, sans-serif; color: var(--text);
}
.post-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.share-preview {
  margin: 14px 0 0; padding: 10px 12px; border-radius: 6px; background: var(--bg);
  border: 1px solid var(--line); color: var(--muted);
  font-size: 12.5px; white-space: pre-wrap;
}

.dock {
  display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 28px;
  border-top: 1px solid var(--line);
  background: var(--panel); max-width: 860px; width: 100%; margin: 0 auto;
  position: relative;
}
.dock-row { display: flex; gap: 10px; align-items: flex-start; }
.cost-tag {
  font-size: 11px;
  font-weight: 600; letter-spacing: .08em; color: var(--amber);
  animation: cost-pulse .55s ease-out;
}
@keyframes cost-pulse { from { color: #fff; text-shadow: 0 0 12px rgba(255,196,107,.9); } }
.action-btn {
  min-width: 152px; display: flex; align-items: center; justify-content: center; gap: 8px;
}
.combo { position: relative; flex: 1; }
.combo-input {
  width: 100%; padding: 11px 13px; border-radius: 7px;
  background: var(--bg); border: 1px solid var(--line); color: var(--text);
  font-size: 14px;
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
  font-size: 11px;
  color: var(--muted); vertical-align: middle;
}
.combo-more {
  color: var(--muted); font-size: 11.5px; letter-spacing: 0.08em; line-height: 19px;
  /* match a result row's height (9px pad + 19px content) and left-align with the
     label column: combo-opt padding-left (11px) + .key box (19px) + gap (9px) */
  padding: 9px 11px 9px calc(11px + 19px + 9px);
}
.combo-opt mark { background: none; color: var(--cyan); font-weight: 600; }
.alias-hit { color: var(--muted); font-size: 12.5px; }
.alias-hit::before { content: "· "; }
.tag-hit { color: var(--muted); font-size: 12.5px; }
.tag-hit::before { content: "#"; opacity: 0.55; }
.used-note { font-size: 12.5px; }
.enter-hint { color: var(--muted); font-size: 12.5px; }

.btn {
  padding: 11px 16px; border-radius: 7px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); font-size: 14px; font-weight: 500; white-space: nowrap;
}
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-secondary:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); }
.btn-armed {
  border-color: var(--amber); color: var(--amber);
  box-shadow: 0 0 10px rgba(255,196,107,.18);
}
.btn-armed .key { color: var(--amber); border-color: rgba(255,196,107,.45); }
.btn-primary .key { color: var(--green); border-color: rgba(87,217,147,.45); }
.btn-primary { background: rgba(87,217,147,.14); border-color: rgba(87,217,147,.4); color: var(--green); }
.btn-primary:hover { background: rgba(87,217,147,.22); }
.btn-ghost:hover { border-color: var(--cyan); color: var(--cyan); }

@media (max-width: 560px) {
  .entry { grid-template-columns: 42px 1fr; }
  .entry .text { grid-column: 1 / -1; }
}
`;
