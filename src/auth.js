import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// NEON AUTH — managed Better Auth living alongside the incident database;
// users land in the neon_auth schema there. The client talks straight to the
// auth service's URL (public, baked into the bundle at build time), so
// there's no /api route on our side. Signing in is optional: the game plays
// anonymously, an account just gives runs somewhere to live later.
//
// The SDK is ~400 kB minified — nearly twice the rest of the app — so it's
// dynamic-imported into its own chunk: the game paints without it and the
// session check follows right behind.
// ---------------------------------------------------------------------------
let clientPromise = null;
function client() {
  clientPromise ??= import("@neondatabase/neon-js/auth").then((m) =>
    m.createAuthClient(import.meta.env.VITE_NEON_AUTH_URL)
  );
  return clientPromise;
}

// The SDK throws AuthApiError on rejected requests (bad password, wrong
// credentials) rather than returning { error }, so every call is normalized
// to the { data, error } shape callers expect — never a rejected promise.
const norm = (promise) => promise.then((res) => res ?? {}, (e) => ({ error: e }));

export const auth = {
  getSession: () => norm(client().then((c) => c.getSession())),
  signInEmail: (opts) => norm(client().then((c) => c.signIn.email(opts))),
  signUpEmail: (opts) => norm(client().then((c) => c.signUp.email(opts))),
  signInGoogle: (opts) =>
    norm(client().then((c) => c.signIn.social({ provider: "google", ...opts }))),
  signOut: () => norm(client().then((c) => c.signOut())),
};

// undefined while the first getSession is in flight, null when signed out —
// callers that only care about "signed in?" can treat both as false.
export function useUser() {
  const [user, setUser] = useState(undefined);
  const refresh = useCallback(() => {
    auth
      .getSession()
      .then(({ data }) => setUser(data?.user ?? null))
      .catch(() => setUser(null));
  }, []);
  useEffect(refresh, [refresh]);
  return [user, refresh];
}
