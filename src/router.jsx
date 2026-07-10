import { useMemo, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// ROUTES — real paths via the History API. Vercel rewrites every request that
// doesn't match a file or function to /index.html (see vercel.json), so a
// fresh load of /a/2 still boots the SPA; the client then renders from
// location.pathname.
//   /             today's daily
//   /archive      played incidents
//   /a/<n>        a past daily by number (1..today's)
//   /a/<ic_...>   a custom incident by its share id
// ---------------------------------------------------------------------------
export function parsePath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/archive") return { view: "archive" };
  const m = p.match(/^\/(?:a|archive)\/([^/]+)$/);
  if (m && /^\d+$/.test(m[1])) return { view: "day", num: Number(m[1]) };
  if (m && /^ic_[a-z0-9]+$/.test(m[1])) return { view: "custom", id: m[1] };
  return { view: "today" };
}

// Links minted before the History-API switch were hash routes (#/archive/2),
// and day links briefly lived at /archive/<n> before moving to /a/<n>;
// translate both to current paths before first render so they keep working.
export function upgradeLegacyUrl() {
  const hash = window.location.hash.match(/^#(\/.*)$/);
  if (hash) window.history.replaceState(null, "", hash[1]);
  const old = window.location.pathname.match(/^\/archive\/(\d+)\/*$/);
  if (old) window.history.replaceState(null, "", `/a/${old[1]}`);
}

export function navigate(to, { replace = false } = {}) {
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// useSyncExternalStore re-reads the snapshot when it subscribes, so a
// navigate() fired from a child's effect — before this hook's listener is
// attached — can't be missed (a plain state-plus-listener version stranded
// out-of-range day URLs on a blank RedirectHome).
function subscribe(cb) {
  window.addEventListener("popstate", cb);
  return () => window.removeEventListener("popstate", cb);
}

export function useRoute() {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return useMemo(() => parsePath(pathname), [pathname]);
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
