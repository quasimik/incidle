import { useMemo, useEffect, useState } from "react";
import { HOURS } from "./rules.js";
import { computeStats } from "./stats.js";
import { seedRuns, clearRuns } from "./seed.js";

// dev tools only exist off production — previews and localhost
const DEV = typeof window !== "undefined" && window.location.hostname !== "incidle.com";

const fmt = (n) => (Math.round(n * 10) / 10).toString();

// Personal stats modal (menu → stats), read from this device's localStorage
// when it opens — see stats.js. Headline tiles, then an hour-by-hour stack of
// every finished run's actions, then the waterfall: one share-style row of
// squares per finished daily. All three speak the pip/share color language:
// blue investigated, red guessed wrong, green solved.
export default function StatsModal({ onClose }) {
  const [rev, setRev] = useState(0); // bumped by the dev tools to recompute
  const s = useMemo(() => computeStats(), [rev]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // segment widths are shares of all finished runs (unnormalized: columns
  // thin out as runs end early, which is itself the story)
  const seg = (count, cls, label) =>
    count > 0 && (
      <span
        className={`hourly-seg ${cls}`}
        style={{ width: `${(100 * count) / s.played}%` }}
        title={`${count} ${label}`}
      />
    );

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Stats"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">ON-CALL RECORD</div>
        <div className="stat-grid">
          <div className="stat-cell">
            <div className="stat-num">{s.played}</div>
            <div className="stat-cap">triaged</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">
              {s.played > 0 ? (
                <>{Math.round((100 * s.solved) / s.played)}<span className="stat-unit">%</span></>
              ) : "–"}
            </div>
            <div className="stat-cap">solve rate</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">
              {s.solveTime != null ? (
                <><span className="stat-unit">T+</span>{fmt(s.solveTime)}</>
              ) : "–"}
            </div>
            <div className="stat-cap">solve time</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{s.clues != null ? fmt(s.clues) : "–"}</div>
            <div className="stat-cap">clues</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{s.guesses != null ? fmt(s.guesses) : "–"}</div>
            <div className="stat-cap">guesses</div>
          </div>
        </div>
        <div className="stat-legend">
          <span><i className="leg-dot leg-obs" />info</span>
          <span><i className="leg-dot leg-guess" />wrong</span>
          <span><i className="leg-dot leg-solve" />correct</span>
        </div>

        <div className="stat-head">HOUR BY HOUR</div>
        {s.hours.map((h, i) => (
          <div key={i} className="hourly-row">
            <span className="hourly-label">T+{i + 1}</span>
            <div className="hourly-track">
              {seg(h.obs, "seg-obs", "investigated")}
              {seg(h.guess, "seg-guess", "guessed wrong")}
              {seg(h.solve, "seg-solve", "solved")}
            </div>
          </div>
        ))}

        {s.log.length > 0 && (
          <>
            <div className="stat-head stat-head-log">LOG</div>
            <ul className="wf">
              {s.log.map(({ num, run }) => (
                <li
                  key={num}
                  className="wf-row"
                  aria-label={`#${num}: ${
                    run.s === "solved" ? `resolved at T+${run.a.length}` : "escalated"
                  }`}
                >
                  <span className="wf-id">#{num}</span>
                  {Array.from({ length: HOURS }, (_, i) => (
                    <span
                      key={i}
                      className={`wf-cell ${run.a[i] ? `wf-${run.a[i]}` : ""}`}
                      aria-hidden="true"
                    />
                  ))}
                  <span className="wf-out">
                    {run.s === "solved" ? `T+${run.a.length}` : "escalated"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {DEV && (
          <div className="stat-dev">
            <span className="stat-dev-tag">dev</span>
            <button className="btn btn-ghost" onClick={() => { seedRuns(); setRev(rev + 1); }}>
              seed fake runs
            </button>
            <button className="btn btn-ghost" onClick={() => { clearRuns(); setRev(rev + 1); }}>
              clear all runs
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
