import { useState, useEffect } from "react";
import { auth } from "./auth.js";

// Log-in / account modal (menu → log in). Google hands the tab to the
// OAuth flow and Neon Auth redirects back to the page the user left; email +
// password settles in place. `user` is the signed-in user or null/undefined;
// onChange asks the parent to re-fetch the session after anything here
// changes it.
export default function AccountModal({ user, onClose, onChange }) {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function google() {
    setErr(null);
    setBusy(true);
    const { error } = await auth.signInGoogle({ callbackURL: window.location.href });
    // on success the browser is already navigating away
    if (error) {
      setErr(error.message || "log-in failed — try again");
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } =
      mode === "signup"
        ? await auth.signUpEmail({
            name: email.split("@")[0] || "player",
            email,
            password,
          })
        : await auth.signInEmail({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message || "log-in failed — try again");
      return;
    }
    onChange();
    onClose();
  }

  async function signOut() {
    await auth.signOut();
    onChange();
    onClose();
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal acct"
        role="dialog"
        aria-modal="true"
        aria-label={user ? "Account" : "Log in"}
        onClick={(e) => e.stopPropagation()}
      >
        {user ? (
          <>
            <div className="modal-head">ACCOUNT</div>
            <p className="acct-user">
              logged in as <b>{user.email}</b>
            </p>
            <button className="btn btn-ghost modal-btn" onClick={signOut}>
              log out
            </button>
          </>
        ) : (
          <>
            <div className="modal-head">{mode === "signup" ? "CREATE ACCOUNT" : "LOG IN"}</div>
            <button className="btn btn-ghost modal-btn" onClick={google} disabled={busy}>
              continue with google
            </button>
            <div className="acct-or">or</div>
            <form className="acct-form" onSubmit={submit}>
              <input
                className="acct-input"
                type="email"
                placeholder="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <div className="acct-pw">
                <input
                  className="acct-input"
                  type={showPw ? "text" : "password"}
                  placeholder="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="acct-pw-btn"
                  onClick={() => setShowPw(!showPw)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? "hide" : "show"}
                </button>
              </div>
              <button className="btn btn-primary modal-btn" type="submit" disabled={busy}>
                {mode === "signup" ? "create account" : "log in"}
              </button>
            </form>
            {err && <p className="acct-err">{err}</p>}
            <p className="acct-switch">
              {mode === "signup" ? "already have an account? " : "no account? "}
              <button
                type="button"
                className="acct-switch-btn"
                onClick={() => {
                  setMode(mode === "signup" ? "signin" : "signup");
                  setErr(null);
                }}
              >
                {mode === "signup" ? "log in" : "create one"}
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
