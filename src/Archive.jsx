import { INCIDENTS } from "./incidents.js";
import { DAILY_EPOCH, dayNumber, addDays, fmtShort } from "./daily.js";
import { loadRun } from "./runs.js";
import { Link } from "./router.jsx";

// Result marker for an archive row, from the saved run (if any).
function runStatus(run) {
  if (!run) return <span className="arch-status">play →</span>;
  if (run.s === "solved") return <span className="arch-status arch-solved">✓ T+{run.a.length}</span>;
  if (run.s === "failed") return <span className="arch-status arch-failed">escalated</span>;
  return <span className="arch-status arch-progress">T+{run.a.length} · in progress</span>;
}

export default function Archive({ today }) {
  const todayNum = Math.max(0, dayNumber(today));
  const days = Array.from({ length: todayNum + 1 }, (_, i) => todayNum - i);
  return (
    <div className="idle-root">
      <header className="hdr">
        <div className="hdr-left">
          <Link className="brand" href="/">INCIDLE</Link>
          <span className="svc">archive</span>
        </div>
        <Link className="hdr-link" href="/">
          today →
        </Link>
      </header>
      <main className="feed">
        <ul className="arch-list">
          {days.map((n) => {
            const inc = INCIDENTS[n % INCIDENTS.length];
            return (
              <li key={n}>
                <Link className="arch-row" href={n === todayNum ? "/" : `/archive/${n + 1}`}>
                  <span className="arch-id">#{n + 1}</span>
                  <span className="arch-date">
                    {n === todayNum ? "today" : fmtShort(addDays(DAILY_EPOCH, n))}
                  </span>
                  <span className={`sev sev-${inc.sev}`}>SEV{inc.sev}</span>
                  <span className="arch-vig">{inc.vignette.replace(/^PAGE — /, "")}</span>
                  {runStatus(loadRun(n + 1))}
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
