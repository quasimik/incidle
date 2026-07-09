import { useState, useEffect } from "react";
import { INCIDENTS } from "./incidents.js";
import { DAILY_EPOCH, toDateStr, dayNumber, addDays, fmtShort } from "./daily.js";
import { useRoute, navigate } from "./router.jsx";
import Game from "./Game.jsx";
import Archive from "./Archive.jsx";

// Loader shell: the game is unplayable without the answer list, so hold at a
// boot screen until the fetch lands (or offer a retry if it doesn't).
export default function Incidle() {
  const [answers, setAnswers] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetch("/api/root-causes")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => !cancelled && setAnswers(d.root_causes))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!answers) {
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
  return <App answers={answers} />;
}

// Route → screen. Game is keyed by incident, so navigating between incidents
// remounts it with fresh state (any in-progress run is in localStorage).
function App({ answers }) {
  const route = useRoute();
  const today = toDateStr(new Date());
  const todayNum = Math.max(0, dayNumber(today));

  if (route.view === "archive") return <Archive today={today} />;

  const n = route.view === "day" ? route.num - 1 : todayNum;
  if (n >= 0 && n <= todayNum)
    return (
      <Game
        key={`d${n}`}
        answers={answers}
        incident={INCIDENTS[n % INCIDENTS.length]}
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
