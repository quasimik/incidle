import { useState, useMemo, useRef, useEffect } from "react";
import { HOURS } from "./rules.js";
import { buildMatcher } from "./matcher.js";
import { loadRun, saveRun } from "./runs.js";
import Header from "./Header.jsx";
import { highlight, rich } from "./text.jsx";

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

// Server-side verdict: the incident payload carries nothing answer-derived,
// so every guess is graded by POST /api/guess (guessId null just fetches the
// reveal — see that file).
async function postGuess(body) {
  const r = await fetch("/api/guess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Rebuild a feed from a saved run — the inverse of handleInvestigate /
// handleGuess. "obs" consumes the next clue, "near"/"wrong"/"solve" the next
// saved guess id — the resolve line names the guess that solved it, which may
// be an accepted answer other than the best one. The rare finished run
// without a reveal renders "…" and no postmortem.
function rebuildFeed(inc, run, answerById) {
  const feed = [{ type: "page", time: "T+0", text: inc.vignette }];
  const bestName = answerById[run.r?.answerIds?.[0]]?.name ?? "…";
  let clue = 0;
  let gi = 0;
  run.a.forEach((act, i) => {
    const time = `T+${i + 1}`;
    if (act === "obs") {
      feed.push({ type: "clue", time, text: inc.clues[clue++] });
    } else if (act === "solve") {
      feed.push({ type: "resolve", time, text: answerById[run.g[gi++]]?.name ?? bestName });
    } else {
      const id = run.g[gi++];
      const name = answerById[id]?.name ?? id;
      feed.push(
        act === "near"
          ? { type: "near", time, text: `${name} — directionally right, but not the best answer.` }
          : { type: "reject", time, text: name }
      );
    }
  });
  if (run.s === "failed")
    feed.push({ type: "escalate", time: "", text: `Postmortem identifies: ${bestName}.` });
  return feed;
}

// A scheduled day plays its incident; a day with nothing scheduled gets the
// same page — identical header, menu and all — over a status-page all-clear.
export default function Game(props) {
  if (!props.incident) return <AllClear title={props.title} sub={props.sub} />;
  return <Run {...props} />;
}

function AllClear({ title, sub }) {
  return (
    <div className="idle-root">
      <Header title={title} sub={sub} />
      <div className="boot">
        <span>no incidents reported.</span>
      </div>
    </div>
  );
}

function Run({ answers, incident: c, title = "INCIDLE", sub, shareTag, shareUrl, storageKey }) {
  const { answerById, matchAnswers } = useMemo(() => buildMatcher(answers), [answers]);
  // resume this incident's saved run — finished or mid-game — if one exists
  const [saved] = useState(() => loadRun(storageKey));
  const [startedAt] = useState(() => saved?.t ?? Date.now());
  // { answerIds, postmortem } — arrives from /api/guess when the run ends;
  // answerIds is every accepted cause in descending order of goodness
  const [reveal, setReveal] = useState(() => saved?.r ?? null);
  const [feed, setFeed] = useState(() =>
    saved ? rebuildFeed(c, saved, answerById) : [{ type: "page", time: "T+0", text: c.vignette }]
  );
  const [actions, setActions] = useState(saved?.a ?? []); // "obs" | "wrong" | "near" | "solve" — one per hour burned
  const [status, setStatus] = useState(saved?.s ?? "active"); // active | solved | failed
  const [query, setQuery] = useState("");
  const [guessedIds, setGuessedIds] = useState(saved?.g ?? []);
  const [selIdx, setSelIdx] = useState(0); // highlighted suggestion
  const [inputFocused, setInputFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false); // a verdict request is in flight
  const [netFail, setNetFail] = useState(false);
  const [overlayUp, setOverlayUp] = useState(false); // a header modal is covering the page
  const feedEndRef = useRef(null);
  const inputRef = useRef(null);
  const lastGuessAt = useRef(0); // absorbs double-enter after a guess submits

  const maxClues = c.clues.length;
  const revealed = actions.filter((a) => a === "obs").length;
  const hoursUsed = actions.length;
  const { items: suggestions, more } = useMemo(() => matchAnswers(query), [query, matchAnswers]);
  const sel = Math.min(selIdx, Math.max(suggestions.length - 1, 0));

  // persist the run after every hour-costing action (and on finish)
  useEffect(() => {
    if (actions.length === 0) return;
    saveRun(storageKey, {
      s: status,
      a: actions,
      g: guessedIds,
      t: startedAt,
      ...(reveal && { r: reveal }),
    });
  }, [storageKey, status, actions, guessedIds, startedAt, reveal]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed, status]);

  function focusInput() {
    if (CAN_HOVER) inputRef.current?.focus();
  }

  // Enter re-captures the search input when focus has drifted to a
  // non-interactive element (e.g. after clicking blank feed space). Real
  // controls keep their own Enter behavior; the input handles its own when
  // already focused.
  useEffect(() => {
    if (status !== "active" || overlayUp) return;
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
  }, [status, overlayUp]);

  function eventTime(n) {
    return `T+${n}`;
  }

  // Commit the reveal that ends a failed run — the budget's last hour.
  function finishEscalate(newFeed, rev) {
    setReveal(rev);
    setFeed([
      ...newFeed,
      { type: "escalate", time: "", text: `Postmortem identifies: ${answerById[rev.answerIds[0]]?.name}.` },
    ]);
    setStatus("failed");
  }

  async function handleInvestigate() {
    if (busy || status !== "active" || revealed >= maxClues) return;
    const hour = actions.length + 1;
    const entry = { type: "clue", time: eventTime(hour), text: c.clues[revealed] };
    if (hour < HOURS) {
      setActions([...actions, "obs"]);
      setFeed([...feed, entry]);
      focusInput(); // a button click shouldn't strand focus off the input
      return;
    }
    // the last hour: clues are local, but the escalation reveal is not
    setNetFail(false);
    setBusy(true);
    try {
      const r = await postGuess({ key: storageKey, hour });
      setActions([...actions, "obs"]);
      finishEscalate([...feed, entry], { answerIds: r.answerIds, postmortem: r.postmortem });
    } catch {
      setNetFail(true); // the hour isn't burned; the button retries
    }
    setBusy(false);
    focusInput();
  }

  async function handleGuess(ans) {
    if (busy || status !== "active" || !ans || guessedIds.includes(ans.id)) return;
    const hour = actions.length + 1;
    setNetFail(false);
    setBusy(true);
    let r;
    try {
      r = await postGuess({ key: storageKey, guessId: ans.id, hour });
    } catch {
      setNetFail(true);
      setBusy(false);
      return; // the hour isn't burned; the typed query survives for a retry
    }
    setBusy(false);
    lastGuessAt.current = Date.now();
    setQuery("");
    setSelIdx(0);
    const t = eventTime(hour);
    setActions([...actions, r.verdict]);
    // every guess lands in g, the solve included — the saved run holds the
    // full sequence, and rebuildFeed names the solving guess from it
    setGuessedIds([...guessedIds, ans.id]);
    if (r.verdict === "solve") {
      setReveal({ answerIds: r.answerIds, postmortem: r.postmortem });
      setFeed([...feed, { type: "resolve", time: t, text: `${ans.name}` }]);
      setStatus("solved");
      return;
    }
    const entry =
      r.verdict === "near"
        ? { type: "near", time: t, text: `${ans.name} — directionally right, but not the best answer.` }
        : { type: "reject", time: t, text: `${ans.name}` };
    if (hour >= HOURS) finishEscalate([...feed, entry], { answerIds: r.answerIds, postmortem: r.postmortem });
    else setFeed([...feed, entry]);
  }

  // One-step guess: picking a suggestion (click / enter / action button)
  // submits it immediately — staging forced a second tap on mobile, after the
  // keyboard had already dismissed and shifted the layout.
  function pick(ans) {
    handleGuess(ans);
    focusInput(); // a button click shouldn't strand focus off the input
  }

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions.length > 0) pick(suggestions[sel].a);
      else if (query.trim() === "" && !e.repeat && Date.now() - lastGuessAt.current > 400) handleInvestigate();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setQuery("");
      setSelIdx(0);
      return;
    }
    // digits are not hotkeys: answer names contain them ("S3", "429s", "N+1"),
    // and picks submit immediately — a mis-hit digit would burn an hour
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelIdx(Math.min(sel + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelIdx(Math.max(sel - 1, 0));
    }
  }

  function shareText() {
    const sq = { obs: "🟦", wrong: "🟥", near: "🟥", solve: "🟩" };
    const squares = actions.map((a) => sq[a]).join("") + "⬜".repeat(HOURS - hoursUsed);
    const verdict = status === "solved" ? `resolved at T+${hoursUsed}` : "escalated!";
    // customs are reachable only by their link, so the share must carry it;
    // dailies stay bare — everyone can find today's on the homepage
    return `💻 ${shareTag}\n${verdict}\n${squares}\n\n${shareUrl ?? "https://incidle.com"}`;
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

  async function shareResult() {
    if (navigator.share) {
      try {
        await navigator.share({ text: shareText() });
      } catch {} // user dismissed the share sheet
    } else {
      copyShare();
    }
  }

  const done = status !== "active";
  // the button only investigates — guesses submit by picking a suggestion
  const enterInvestigates = inputFocused && query.trim() === "" && revealed < maxClues;

  return (
    <div className="idle-root">
      <Header
        title={title}
        sub={sub}
        onHelpDismiss={() => setTimeout(focusInput, 0)} // hand focus back to the input the modal was covering
        onOverlayChange={setOverlayUp}
        right={
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
        }
      />

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
          // every accepted cause, best first — ranking is honest, so the
          // best answer keeps the target treatment and the rest go quieter
          const accepted = (reveal?.answerIds ?? []).map((id) => answerById[id]).filter(Boolean);
          return (
          <div className="post">
            <div className="post-head">POSTMORTEM</div>
            {revealed < maxClues && (
              <details className="unseen">
                <summary className="unseen-summary">
                  {maxClues - revealed} unrevealed observation{maxClues - revealed === 1 ? "" : "s"}
                </summary>
                <ul className="unseen-list">
                  {c.clues.slice(revealed).map((cl, i) => (
                    <li key={i}>{rich(cl)}</li>
                  ))}
                </ul>
              </details>
            )}
            {accepted.map((ans, i) => (
              <div key={ans.id} className={i === 0 ? "callout" : "callout callout-alt"}>
                <span className="callout-icon">{i === 0 ? "🎯" : "✅"}</span>
                <div className="callout-head">{i === 0 ? "Root cause" : "Also accepted"}: {ans.name}</div>
                {ans.description && <p className="callout-body">{rich(ans.description)}</p>}
              </div>
            ))}
            {reveal?.postmortem && <p className="post-body">{rich(reveal.postmortem)}</p>}
            <div className="post-actions">
              <button className="btn btn-ghost" onClick={copyShare}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                {copied ? "copied ✓" : "copy"}
              </button>
              <button className="btn btn-primary" onClick={shareResult}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="18" cy="5" r="3" />
                  <circle cx="6" cy="12" r="3" />
                  <circle cx="18" cy="19" r="3" />
                  <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
                </svg>
                share
              </button>
            </div>
          </div>
          );
        })()}
        <div ref={feedEndRef} />
      </main>

      {!done && (
        <footer className="dock">
          {netFail && (
            <div className="dock-err" role="alert">
              couldn't reach the incident database — that move wasn't counted. try again.
            </div>
          )}
          <div className="dock-row">
            <div className="combo">
              <input
                ref={inputRef}
                className={`combo-input ${
                  !inputFocused ? "combo-input-blurred" : query ? "combo-input-clearable" : ""
                }`}
                value={query}
                placeholder="guess root cause… (type to search)"
                onChange={(e) => {
                  setQuery(e.target.value);
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
              {suggestions.length > 0 && (
                <ul className="combo-list" role="listbox">
                  {suggestions.map((sug, i) => {
                    const used = guessedIds.includes(sug.a.id);
                    return (
                      <li key={sug.a.id}>
                        <button
                          className={`combo-opt ${i === sel ? "combo-opt-sel" : ""} ${used ? "combo-opt-used" : ""}`}
                          onClick={() => pick(sug.a)}
                          disabled={used}
                        >
                          <span className="opt-main">
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
            <span className="dock-or" aria-hidden="true">or</span>
            <button
              className={`btn action-btn btn-secondary ${enterInvestigates ? "btn-armed" : ""}`}
              onClick={handleInvestigate}
              disabled={busy || revealed >= maxClues}
            >
              investigate
              {CAN_HOVER && enterInvestigates ? (
                <kbd className="key">↵</kbd>
              ) : (
                <span className="dot" aria-hidden="true">·</span>
              )}
              <span className="cost-tag" key={hoursUsed} title="every move burns one hour">1 HOUR</span>
            </button>
          </div>
        </footer>
      )}

    </div>
  );
}
