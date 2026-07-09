import { useState, useMemo, useRef, useEffect } from "react";
import { buildMatcher } from "./matcher.js";
import { loadRun, saveRun } from "./runs.js";
import { Link } from "./router.jsx";
import { highlight, rich } from "./text.jsx";

export const HOURS = 7; // time budget per incident; one action = one hour

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

// Rebuild a feed from a saved run — the inverse of handleInvestigate /
// handleGuess. "obs" consumes the next clue, "wrong" the next saved guess id.
function rebuildFeed(inc, run, answerById) {
  const feed = [{ type: "page", time: "T+0", text: inc.vignette }];
  let clue = 0;
  let gi = 0;
  run.a.forEach((act, i) => {
    const time = `T+${i + 1}`;
    if (act === "obs") {
      feed.push({ type: "clue", time, text: inc.clues[clue++] });
    } else if (act === "solve") {
      feed.push({ type: "resolve", time, text: answerById[inc.answerId]?.name ?? "" });
    } else {
      const id = run.g[gi++];
      const name = answerById[id]?.name ?? id;
      feed.push(
        inc.nearIds?.includes(id)
          ? { type: "near", time, text: `${name} — directionally right, but not the best answer.` }
          : { type: "reject", time, text: name }
      );
    }
  });
  if (run.s === "failed")
    feed.push({ type: "escalate", time: "", text: `Postmortem identifies: ${answerById[inc.answerId]?.name}.` });
  return feed;
}

export default function Game({ answers, incident: c, title = "INCIDLE", sub, shareTag, shareUrl, storageKey }) {
  const { answerById, matchAnswers } = useMemo(() => buildMatcher(answers), [answers]);
  // resume this incident's saved run — finished or mid-game — if one exists
  const [saved] = useState(() => loadRun(storageKey));
  const [startedAt] = useState(() => saved?.t ?? Date.now());
  const [feed, setFeed] = useState(() =>
    saved ? rebuildFeed(c, saved, answerById) : [{ type: "page", time: "T+0", text: c.vignette }]
  );
  const [actions, setActions] = useState(saved?.a ?? []); // "obs" | "wrong" | "solve" — one per hour burned
  const [status, setStatus] = useState(saved?.s ?? "active"); // active | solved | failed
  const [query, setQuery] = useState("");
  const [guessedIds, setGuessedIds] = useState(saved?.g ?? []);
  const [selIdx, setSelIdx] = useState(0); // highlighted suggestion
  const [inputFocused, setInputFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  // Show the how-to-play once, then remember it was seen. Guarded so a blocked
  // localStorage (private mode) just falls back to showing the intro.
  const [showHelp, setShowHelp] = useState(() => {
    try { return !localStorage.getItem("incidle:intro-seen"); }
    catch { return true; }
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
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
    saveRun(storageKey, { s: status, a: actions, g: guessedIds, t: startedAt });
  }, [storageKey, status, actions, guessedIds, startedAt]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [feed, status]);

  function focusInput() {
    if (CAN_HOVER) inputRef.current?.focus();
  }

  // header menu: close on any outside press or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onPress = (e) => {
      if (!menuRef.current?.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("pointerdown", onPress);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
    const sq = { obs: "🟦", wrong: "🟥", solve: "🟩" };
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
  // one action button: investigate on empty field, guess otherwise
  const investigateMode = query.trim() === "";
  const enterInvestigates = inputFocused && investigateMode && revealed < maxClues;

  return (
    <div className="idle-root">
      <header className="hdr">
        <div className="hdr-left">
          <div className="menu-wrap" ref={menuRef}>
            <button
              className="menu-btn"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              aria-haspopup="true"
              aria-expanded={menuOpen}
            >
              ☰
            </button>
            {menuOpen && (
              <nav className="menu">
                <Link className="menu-item" href="/archive" onClick={() => setMenuOpen(false)}>
                  archive
                </Link>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowHelp(true);
                  }}
                >
                  help
                </button>
              </nav>
            )}
          </div>
          <Link className="brand" href="/">{title}</Link>
          {sub && <span className="svc">{sub}</span>}
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
            <button
              className={`btn action-btn ${investigateMode ? "btn-secondary" : "btn-primary"} ${enterInvestigates ? "btn-armed" : ""}`}
              onClick={() => (investigateMode ? handleInvestigate() : suggestions.length > 0 && pick(suggestions[sel].a))}
              disabled={
                investigateMode
                  ? revealed >= maxClues
                  : suggestions.length === 0 || guessedIds.includes(suggestions[sel].a.id)
              }
            >
              {investigateMode ? "investigate" : "root-cause"}
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
