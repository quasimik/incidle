import { useState, useEffect } from "react";
import { DAILY_EPOCH, todayStr, dayNumber, addDays, fmtShort } from "./daily.js";
import { useRoute, navigate, Link } from "./router.jsx";
import { setSchedule } from "./runs.js";
import Game from "./Game.jsx";
import Archive from "./Archive.jsx";

// Loader shell: the game is unplayable without the answer list and the daily
// schedule, so hold at a boot screen until both fetches land (or offer a
// retry if they don't). Incident content isn't in either — LoadedGame fetches
// it by id once a route needs it.
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
      .then(([rc, inc]) => {
        if (cancelled) return;
        // runs.js resolves which saved runs are dailies through this map
        setSchedule(new Map(inc.incidents.map((i) => [i.id, i.num])));
        setData({ answers: rc.root_causes, incidents: inc.incidents });
      })
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
  const today = todayStr();
  const todayNum = Math.max(0, dayNumber(today));

  if (route.view === "archive")
    return <Archive today={today} incidents={incidents} />;
  if (route.view === "custom") {
    // An incident promoted from custom to daily keeps answering its old
    // /a/<ic_...> link forever — but once it's live, send the visitor to the
    // day URL so they see (and share) it as the daily it now is.
    const promoted = incidents.find((inc) => inc.id === route.id);
    if (promoted) return <RedirectTo path={`/a/${promoted.num}`} />;
    return (
      <LoadedGame
        key={route.id}
        answers={answers}
        id={route.id}
        sub={route.id}
        shareTag={`incidle ${route.id}`}
        shareUrl={`https://incidle.com/a/${route.id}`}
      />
    );
  }

  const n = route.view === "day" ? route.num - 1 : todayNum;
  if (n < 0 || n > todayNum) return <RedirectTo path="/" />;
  // Day #N plays the row whose num is N — the schedule is the num column
  // itself, so a gap in the numbering is simply a day with no incident, which
  // Game renders as an all-clear page (a real page, not a redirect, so the
  // URL stays inspectable).
  const id = incidents.find((inc) => inc.num === n + 1)?.id;
  const sub = n === todayNum ? null : fmtShort(addDays(DAILY_EPOCH, n));
  if (!id)
    return (
      <Game
        key={`d${n}`}
        answers={answers}
        incident={null}
        title={n === todayNum ? "INCIDLE" : `INCIDLE #${n + 1}`}
        sub={sub}
        shareTag={`incidle #${n + 1}`}
      />
    );
  return (
    <LoadedGame
      key={`d${n}`}
      answers={answers}
      id={id}
      title={`INCIDLE #${n + 1}`}
      sub={sub}
      shareTag={`incidle #${n + 1}`}
    />
  );
}

// Every playable incident, daily or custom, loads by id from /api/incident
// when its route is opened — the boot payload is just the schedule and
// carries no content. A bad or deleted id lands on a dead-end screen rather
// than a redirect, so the URL stays inspectable.
function LoadedGame({ answers, id, ...gameProps }) {
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
  return <Game answers={answers} incident={incident} storageKey={id} {...gameProps} />;
}

function RedirectTo({ path }) {
  useEffect(() => {
    navigate(path, { replace: true });
  }, [path]);
  return null;
}
