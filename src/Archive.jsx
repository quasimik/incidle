import { DAILY_EPOCH, dayNumber, addDays, fmtShort } from "./daily.js";
import { loadRun, listCustomRuns } from "./runs.js";
import { Link } from "./router.jsx";
import Header from "./Header.jsx";

// Result marker for an archive row, from the saved run (if any). Rows show
// only what localStorage knows — never the incident itself, so an unplayed
// day gives nothing away.
function runStatus(run) {
  if (!run) return <span className="arch-status">play →</span>;
  if (run.s === "solved") return <span className="arch-status arch-solved">✓ T+{run.a.length}</span>;
  if (run.s === "failed") return <span className="arch-status arch-failed">escalated</span>;
  return <span className="arch-status arch-progress">T+{run.a.length} · in progress</span>;
}

export default function Archive({ today, incidents }) {
  const todayNum = Math.max(0, dayNumber(today));
  // runs are keyed by incident id (runs.js), so a day's status needs its id
  const idByNum = new Map(incidents.map((inc) => [inc.num, inc.id]));
  // no dailies scheduled → no calendar rows to offer
  const days =
    incidents.length > 0 ? Array.from({ length: todayNum + 1 }, (_, i) => todayNum - i) : [];
  // customs appear here the moment a run for them exists locally
  const customs = listCustomRuns();
  return (
    <div className="idle-root">
      <Header
        sub="past incidents"
        right={
          <Link className="hdr-link" href="/">
            today →
          </Link>
        }
      />
      <main className="feed">
        {days.length > 0 && (
          <ul className="arch-list">
            {days.map((n) => (
              <li key={n}>
                <Link className="arch-row" href={n === todayNum ? "/" : `/a/${n + 1}`}>
                  <span className="arch-id">#{n + 1}</span>
                  <span className="arch-date">
                    {n === todayNum ? "today" : fmtShort(addDays(DAILY_EPOCH, n))}
                  </span>
                  {runStatus(idByNum.has(n + 1) ? loadRun(idByNum.get(n + 1)) : null)}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {customs.length > 0 && (
          <>
            <div className="arch-sect">specials</div>
            <ul className="arch-list">
              {customs.map(({ id, run }) => (
                <li key={id}>
                  <Link className="arch-row" href={`/a/${id}`}>
                    <span className="arch-id">{id}</span>
                    {runStatus(run)}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {days.length === 0 && customs.length === 0 && (
          <div className="arch-empty">no incidents reported.</div>
        )}
      </main>
    </div>
  );
}
