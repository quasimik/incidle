import { useState, useEffect, useRef } from "react";
import { HOURS } from "./rules.js";
import { Link } from "./router.jsx";
import StatsModal from "./Stats.jsx";

// Shared page bar: ☰ menu (plus the stats/help/about modals it opens), brand
// link, optional sub label, and page-specific controls on the right. Every
// screen renders this so the nav is identical everywhere.
export default function Header({ title = "INCIDLE", sub, right, onHelpDismiss, onOverlayChange, modalsRef }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The how-to-play opens itself once on first visit, then remembers it was
  // seen. Guarded so a blocked localStorage (private mode) just shows the intro.
  const [showHelp, setShowHelp] = useState(() => {
    try { return !localStorage.getItem("incidle:intro-seen"); }
    catch { return true; }
  });
  const [showAbout, setShowAbout] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const menuRef = useRef(null);

  // menu: close on any outside press or Escape
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
    onHelpDismiss?.();
  }

  useEffect(() => {
    if (!showHelp) return;
    const onKey = (e) => e.key === "Escape" && dismissHelp();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHelp]);

  useEffect(() => {
    if (!showAbout) return;
    const onKey = (e) => e.key === "Escape" && setShowAbout(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showAbout]);

  // tell the page a modal is covering it (Game pauses its Enter capture)
  useEffect(() => {
    onOverlayChange?.(showHelp || showAbout || showStats);
  }, [showHelp, showAbout, showStats]);

  // let the page open modals that live here (the postmortem credit → about)
  useEffect(() => {
    if (modalsRef) modalsRef.current = { about: () => setShowAbout(true) };
  }, [modalsRef]);

  return (
    <>
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
                  past incidents
                </Link>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowStats(true);
                  }}
                >
                  stats
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowHelp(true);
                  }}
                >
                  help
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setShowAbout(true);
                  }}
                >
                  about
                </button>
              </nav>
            )}
          </div>
          <Link className="brand" href="/">{title}</Link>
          {sub && <span className="svc">{sub}</span>}
        </div>
        {right}
      </header>

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
              You're on call, and an incident just paged you. Find the root cause before it escalates.
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
              triage →
            </button>
          </div>
        </div>
      )}

      {showStats && <StatsModal onClose={() => setShowStats(false)} />}

      {showAbout && (
        <div className="modal-scrim" onClick={() => setShowAbout(false)}>
          <div
            className="modal about"
            role="dialog"
            aria-modal="true"
            aria-label="About"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="about-spark">✨</div>
            <p className="about-line">made by michael</p>
            <p className="about-line">in foggy san francisco</p>
            <a className="about-link" href="https://mic.hael.me" target="_blank" rel="noopener noreferrer">
              mic.hael.me
            </a>
          </div>
        </div>
      )}
    </>
  );
}
