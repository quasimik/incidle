import { useState, useEffect } from "react";

// ---------------------------------------------------------------------------
// ROUTES — real paths via the History API. Vercel rewrites every request that
// doesn't match a file or function to /index.html (see vercel.json), so a
// fresh load of /archive/2 still boots the SPA; the client then renders from
// location.pathname.
//   /             today's daily
//   /archive      past dailies
//   /archive/<n>  a past daily by number (1..today's)
// ---------------------------------------------------------------------------
export function parsePath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/archive") return { view: "archive" };
  const m = p.match(/^\/archive\/(\d+)$/);
  if (m) return { view: "day", num: Number(m[1]) };
  return { view: "today" };
}

// Links minted before the History-API switch were hash routes (#/archive/2);
// translate them to real paths before first render so they keep working.
export function upgradeLegacyHash() {
  const m = window.location.hash.match(/^#(\/.*)$/);
  if (m) window.history.replaceState(null, "", m[1]);
}

export function navigate(to, { replace = false } = {}) {
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute() {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

// <a> that navigates client-side; modified clicks (new tab, etc.) fall
// through to the browser.
export function Link({ href, onClick, ...rest }) {
  function handleClick(e) {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={handleClick} {...rest} />;
}
