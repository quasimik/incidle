import { useMemo, useEffect } from "react";
import { computeStats } from "./stats.js";

// Personal stats modal (menu → stats): headline tiles plus a Wordle-style
// solve-hour histogram. Everything is read from this device's localStorage
// when the modal opens — see stats.js.
export default function StatsModal({ schedule, onClose }) {
  const s = useMemo(() => computeStats(schedule), [schedule]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rate = s.played > 0 ? Math.round((100 * s.solved) / s.played) : null;
  const peak = Math.max(1, ...s.dist, s.escalated);

  const bar = (count, hot, cls = "") => (
    <div className="dist-track">
      <div
        className={`dist-bar ${cls} ${count === 0 ? "dist-bar-zero" : ""} ${hot ? "dist-bar-today" : ""}`}
        style={count > 0 ? { width: `${Math.max(9, (100 * count) / peak)}%` } : undefined}
      >
        {count}
      </div>
    </div>
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
            <div className="stat-num">{rate ?? "–"}{rate != null && <span className="stat-unit">%</span>}</div>
            <div className="stat-cap">solve rate</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{s.currentStreak}</div>
            <div className="stat-cap">streak</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{s.maxStreak}</div>
            <div className="stat-cap">max streak</div>
          </div>
        </div>

        <div className="dist-head">RESOLVED AT</div>
        {s.dist.map((n, i) => (
          <div key={i} className="dist-row">
            <span className="dist-label">T+{i + 1}</span>
            {bar(n, s.today === i + 1)}
          </div>
        ))}
        <div className="dist-row">
          <span className="dist-label">ESC</span>
          {bar(s.escalated, s.today === "esc", "dist-bar-esc")}
        </div>

        {s.customs > 0 && (
          <div className="stat-specials">
            specials: {s.customsSolved}/{s.customs} solved
          </div>
        )}
      </div>
    </div>
  );
}
