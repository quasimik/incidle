import { useState, useEffect } from "react";
import { DAILY_EPOCH, toDateStr, dayNumber, addDays, fmtShort } from "./daily.js";
import { useRoute, navigate } from "./router.jsx";
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

  if (route.view === "archive") return <Archive today={today} incidents={incidents} />;

  const n = route.view === "day" ? route.num - 1 : todayNum;
  if (n >= 0 && n <= todayNum)
    return (
      <Game
        key={`d${n}`}
        answers={answers}
        incident={incidents[n % incidents.length]}
        title={`INCIDLE #${n + 1}`}
        sub={n === todayNum ? null : fmtShort(addDays(DAILY_EPOCH, n))}
        shareTag={`incidle #${n + 1}`}
        storageKey={n + 1}
      />
    );
  return <RedirectHome />;
}

function RedirectHome() {
  useEffect(() => {
    navigate("/", { replace: true });
  }, []);
  return null;
}
