import { useState, useMemo, useRef, useEffect } from "react";
import uFuzzy from "@leeoniya/ufuzzy";

// ---------------------------------------------------------------------------
// CASES — the paging vignette and the system topology primer are free. Every action
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
const CASES = [
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

// Touch devices get no auto-focus or programmatic refocus of the search input:
// popping the on-screen keyboard uninvited costs half the viewport.
const CAN_HOVER =
  typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches;

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
  // Show the how-to-play once, then remember it was seen. Guarded so a blocked
  // localStorage (private mode) just falls back to showing the intro.
  const [showHelp, setShowHelp] = useState(() => {
    try { return !localStorage.getItem("incidle:intro-seen"); }
    catch { return true; }
  });
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

  function focusInput() {
    if (CAN_HOVER) inputRef.current?.focus();
  }

  function dismissHelp() {
    setShowHelp(false);
    try { localStorage.setItem("incidle:intro-seen", "1"); } catch {}
    // hand focus back to the search input the modal was covering
    setTimeout(focusInput, 0);
  }

  useEffect(() => {
    if (!showHelp) return;
    const onKey = (e) => e.key === "Escape" && dismissHelp();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHelp]);

  // Enter re-captures the search input when focus has drifted to a
  // non-interactive element (e.g. after clicking blank feed space). Real
  // controls keep their own Enter behavior; the input handles its own when
  // already focused.
  useEffect(() => {
    if (status !== "active" || showHelp) return;
    const onKey = (e) => {
      if (e.key !== "Enter") return;
      const el = inputRef.current;
      if (!el || document.activeElement === el) return;
      const active = document.activeElement;
      if (active && /^(INPUT|BUTTON|TEXTAREA|SELECT|A)$/.test(active.tagName)) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, showHelp]);

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
    focusInput(); // a button click shouldn't strand focus off the input
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
        { type: "resolve", time: t, text: `${ans.name}` },
      ]);
      setStatus("solved");
      return;
    }
    const near = c.nearIds?.includes(ans.id);
    const entry = near
      ? { type: "near", time: t, text: `${ans.name} — directionally right, but not the best answer.` }
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
    focusInput(); // keep enter-to-submit working after a click
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
    setTimeout(focusInput, 50);
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

  const done = status !== "active";
  // one action button: investigate on empty field, guess otherwise
  const investigateMode = !staged && query.trim() === "";
  const enterInvestigates = inputFocused && investigateMode && revealed < maxClues;

  return (
    <div className="idle-root">
      <style>{CSS}</style>

      <header className="hdr">
        <div className="hdr-left">
          <span className="brand">INCIDLE {c.num}</span>
          <span className={`sev sev-${c.sev}`}>SEV{c.sev}</span>
          <button
            className="help-btn"
            onClick={() => setShowHelp(true)}
            aria-label="How to play"
            title="How to play"
          >
            ?
          </button>
        </div>
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
      </header>

      <main className="feed" aria-live="polite">
        <div className="post post-sys">
          <div className="post-head">SYSTEM TOPOLOGY</div>
          <p className="post-body">{rich(c.topology)}</p>
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
                className={`combo-input ${staged ? "combo-input-staged" : ""} ${
                  !inputFocused ? "combo-input-blurred" : query ? "combo-input-clearable" : ""
                }`}
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
                autoFocus={CAN_HOVER}
              />
              {!inputFocused ? (
                <kbd className="key combo-focus-hint" aria-hidden="true">↵</kbd>
              ) : query ? (
                <span className="combo-clear-hint" aria-hidden="true">
                  <kbd className="key">esc</kbd> clear
                </span>
              ) : null}
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
              {CAN_HOVER && (enterInvestigates || staged) ? (
                <kbd className="key">↵</kbd>
              ) : (
                <span className="dot" aria-hidden="true">·</span>
              )}
              <span className="cost-tag" key={hoursUsed} title="every move burns one hour">1 HOUR</span>
            </button>
          </div>
        </footer>
      )}

      {showHelp && (
        <div className="modal-scrim" onClick={dismissHelp}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="How to play"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">HOW TO PLAY</div>
            <p className="modal-lede">
              You're on call. An incident just paged you—find the root cause before it escalates.
            </p>
            <ul className="modal-steps">
              <li>
                <span className="step-icon">🔍</span>
                <div>
                  <b className="hl-amber">Investigate</b> to reveal the next observation.
                </div>
              </li>
              <li>
                <span className="step-icon">🎯</span>
                <div>
                  <b className="hl-green">Root-cause</b> it by naming the culprit.
                </div>
              </li>
              <li>
                <span className="step-icon">⏳</span>
                <div>
                  Every move (both <b className="hl-amber">investigate</b> and{" "}
                  <b className="hl-green">root-cause</b>) burns{" "}
                    <b>1&nbsp;hour</b>. At T+{HOURS} the incident escalates.
                </div>
              </li>
            </ul>
            <button className="btn btn-primary modal-btn" onClick={dismissHelp} autoFocus>
              start triage →
            </button>
          </div>
        </div>
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
  /* dvh tracks the collapsing mobile URL bar; the feed scrolls internally so
     the dock stays pinned to the real bottom of the screen */
  height: 100vh; height: 100dvh; display: flex; flex-direction: column;
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
.hdr-left { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { font-weight: 600; letter-spacing: 0.18em; font-size: 14px; }
.help-btn {
  width: 21px; height: 21px; padding: 0; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid var(--line); color: var(--muted);
  font-size: 12px; line-height: 1;
}
.help-btn:hover { border-color: var(--cyan); color: var(--cyan); }
.svc { font-size: 12.5px; color: var(--cyan); }
.sev {
  font-size: 11px; font-weight: 600;
  padding: 2px 7px; border-radius: 4px; letter-spacing: 0.06em;
}
.sev-1 { background: rgba(255,107,107,.18); color: var(--red); border: 1px solid rgba(255,107,107,.45); }
.sev-2 { background: rgba(255,196,107,.15); color: var(--amber); border: 1px solid rgba(255,196,107,.4); }
.sev-3 { background: rgba(107,213,232,.12); color: var(--cyan); border: 1px solid rgba(107,213,232,.35); }

.budget { display: flex; align-items: center; gap: 6px; }
.pip { width: 22px; height: 6px; border-radius: 3px; background: var(--line); }
.pip-obs { background: var(--cyan); }
.pip-wrong { background: var(--red); }
.pip-solve { background: var(--green); }
.budget-label { margin-left: 8px; color: var(--muted); font-size: 12.5px; }

.boot {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 14px;
  color: var(--muted);
}

.feed { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 16px 24px; max-width: 860px; width: 100%; margin: 0 auto; }
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

.modal-scrim {
  position: fixed; inset: 0; z-index: 50; padding: 20px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(6,9,16,.72); backdrop-filter: blur(2px);
  animation: fade .2s ease-out;
}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
.modal {
  width: 100%; max-width: 460px; max-height: 100%; overflow-y: auto;
  padding: 22px 22px 20px;
  border-radius: 10px; background: var(--panel); border: 1px solid var(--line);
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
  animation: modal-in .24s ease-out;
}
@keyframes modal-in {
  from { opacity: 0; transform: translateY(8px) scale(.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .modal-scrim, .modal { animation: none; }
}
.modal-head {
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 12px; font-weight: 700; letter-spacing: .16em;
  text-transform: uppercase; color: var(--cyan); margin-bottom: 12px;
}
.modal-lede {
  margin: 0 0 18px; line-height: 1.55; font-size: 15px;
  font-family: 'Inter', system-ui, sans-serif;
}
.modal-steps {
  list-style: none; margin: 0 0 20px; padding: 0;
  display: flex; flex-direction: column; gap: 14px;
}
.modal-steps li {
  display: grid; grid-template-columns: auto 1fr; column-gap: 12px; align-items: start;
}
/* Match the icon's line box to the text's first line (14px × 1.5 = 21px) so the
   emoji centers on the first line no matter how many lines the step wraps to. */
.step-icon { font-size: 18px; line-height: 21px; }
.modal-steps div {
  line-height: 21px; font-size: 14px;
  font-family: 'Inter', system-ui, sans-serif; color: var(--text);
}
.modal-steps b { font-weight: 600; }
.hl-amber { color: var(--amber); }
.hl-green { color: var(--green); }
.modal-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; }

.dock {
  display: flex; flex-direction: column; gap: 10px; padding: 12px 16px 28px;
  padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom)));
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
.action-btn .dot { opacity: .5; }
.combo { position: relative; flex: 1; }
.combo-input {
  width: 100%; padding: 11px 13px; border-radius: 7px;
  background: var(--bg); border: 1px solid var(--line); color: var(--text);
  font-size: 14px;
}
.combo-input::placeholder { color: var(--muted); }
.combo-input-staged { border-color: rgba(87,217,147,.6); }
.combo-input-blurred { padding-right: 38px; } /* room for the ↵ refocus hint */
.combo-input-clearable { padding-right: 82px; } /* room for the "esc clear" hint */
.combo-focus-hint, .combo-clear-hint {
  position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
  pointer-events: none; color: var(--muted);
}
.combo-clear-hint {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px;
}
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
  /* single-row header: brand + sev left, pips right; the label is redundant
     with the unfilled pips, so it drops to screen-reader-only */
  .hdr { padding: 8px 12px; }
  .hdr-left { gap: 8px; }
  .brand { letter-spacing: 0.12em; }
  .budget { gap: 5px; }
  .pip { width: 12px; }
  .budget-label {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap;
  }
  .feed { padding: 12px 12px 16px; }
  .entry { padding: 8px 9px; margin-bottom: 4px; }
  .post { padding: 13px 14px; }
  .callout { padding: 11px 12px; }
  .dock {
    gap: 8px; padding: 8px 12px;
    padding-bottom: max(16px, calc(10px + env(safe-area-inset-bottom)));
  }
  .dock-row { gap: 8px; }
  /* input on its own row, action button full-width beneath it */
  .dock-row { flex-wrap: wrap; }
  .combo { flex: 1 1 100%; }
  .action-btn { flex: 1; min-width: 0; }
  .combo-input { font-size: 16px; } /* <16px triggers iOS focus-zoom */
  .combo-list { max-height: min(300px, 38dvh); } /* stay clear of the keyboard */
  /* one-line suggestion rows: the alias/tag hit gives way (ellipsis) before
     anything wraps; the name and the rejected-note hold their ground */
  .opt-main { min-width: 0; overflow: hidden; white-space: nowrap; }
  .opt-main > span { flex-shrink: 0; }
  .opt-main .alias-hit, .opt-main .tag-hit {
    flex-shrink: 1; overflow: hidden; text-overflow: ellipsis;
  }
}

/* Touch devices: keyboard hints (enter / esc / number keys) are dead weight. */
@media (hover: none) {
  .combo-focus-hint, .combo-clear-hint, .enter-hint,
  .combo-opt .key { display: none; }
  .combo-input-blurred { padding-right: 13px; }
  .combo-input-clearable { padding-right: 13px; }
  .combo-more { padding-left: 11px; }
  .combo-opt { padding-top: 11px; padding-bottom: 11px; } /* bigger tap targets */
}
`;
