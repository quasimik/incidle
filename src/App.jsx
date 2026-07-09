import { useState, useEffect } from "react";
import { DAILY_EPOCH, toDateStr, dayNumber, addDays, fmtShort } from "./daily.js";
import { useRoute, navigate, Link } from "./router.jsx";
import Game from "./Game.jsx";
import Archive from "./Archive.jsx";

// Loader shell: the game is unplayable without the answer list and the
// incident pool, so hold at a boot screen until both fetches land (or offer
// a retry if they don't).
export default function Incidle() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const getJson = (url) =>
      fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
    Promise.all([getJson("/api/root-causes"), getJson("/api/incidents")])
      .then(([rc, inc]) => !cancelled && setData({ answers: rc.root_causes, incidents: inc.incidents }))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!data) {
    return (
      <div className="idle-root">
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
  return <App answers={data.answers} incidents={data.incidents} />;
}

// Route → screen. Game is keyed by incident, so navigating between incidents
// remounts it with fresh state (any in-progress run is in localStorage).
function App({ answers, incidents }) {
  const route = useRoute();
  const today = toDateStr(new Date());
  const todayNum = Math.max(0, dayNumber(today));

  if (route.view === "archive")
    return <Archive today={today} dailyCount={incidents.length} />;
  if (route.view === "custom") return <CustomGame answers={answers} id={route.id} />;

  const n = route.view === "day" ? route.num - 1 : todayNum;
  if (n < 0 || n > todayNum) return <RedirectHome />;
  // Day #N plays the row whose num is N — the schedule is the num column
  // itself, so a gap in the numbering is simply a day with no incident.
  const incident = incidents.find((inc) => inc.num === n + 1);
  if (!incident) return <NoIncident num={n + 1} isToday={n === todayNum} />;
  return (
    <Game
      key={`d${n}`}
      answers={answers}
      incident={incident}
      title={`INCIDLE #${n + 1}`}
      sub={n === todayNum ? null : fmtShort(addDays(DAILY_EPOCH, n))}
      shareTag={`incidle #${n + 1}`}
      storageKey={n + 1}
    />
  );
}

// A day with nothing scheduled — empty pool or a gap in the num column —
// gets a real page, not a redirect, so the URL stays inspectable.
function NoIncident({ num, isToday }) {
  return (
    <div className="idle-root">
      <header className="hdr">
        <div className="hdr-left">
          <Link className="brand" href="/">
            {isToday ? "INCIDLE" : `INCIDLE #${num}`}
          </Link>
          {!isToday && <span className="svc">{fmtShort(addDays(DAILY_EPOCH, num - 1))}</span>}
        </div>
        <Link className="hdr-link" href="/archive">
          archive →
        </Link>
      </header>
      <div className="boot">
        <span>{isToday ? "no incident scheduled today." : "no incident scheduled for this day."}</span>
      </div>
    </div>
  );
}

// A custom incident is never in the boot payload (see api/incidents.js), so
// fetch it by id when its link is opened. A bad or deleted id lands on a
// dead-end screen rather than a redirect, so the URL stays inspectable.
function CustomGame({ answers, id }) {
  const [incident, setIncident] = useState(null);
  const [failed, setFailed] = useState(null); // "missing" | "network"
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIncident(null);
    setFailed(null);
    fetch(`/api/incident?id=${id}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? "missing" : "network"))
      )
      .then((d) => !cancelled && setIncident(d.incident))
      .catch((e) => !cancelled && setFailed(e.message === "missing" ? "missing" : "network"));
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (!incident)
    return (
      <div className="idle-root">
        <div className="boot">
          {failed === "missing" ? (
            <>
              <span>no such incident.</span>
              <Link className="btn btn-ghost" href="/">
                today's incident
              </Link>
            </>
          ) : failed ? (
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
  return (
    <Game
      key={id}
      answers={answers}
      incident={incident}
      title={`INCIDLE ${id}`}
      shareTag={`incidle ${id}`}
      shareUrl={`https://incidle.com/a/${id}`}
      storageKey={id}
    />
  );
}

function RedirectHome() {
  useEffect(() => {
    navigate("/", { replace: true });
  }, []);
  return null;
}
