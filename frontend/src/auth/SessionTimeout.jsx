// SessionTimeout.jsx
//
// Renews an active user's session before it ends and asks an idle one whether
// they are still there. One clock, checked against absolute times rather than a
// timeout per deadline, so a sleeping laptop is judged correctly on waking.
// Each tab runs its own copy.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "./AuthContext";
import {
  ANSWER_LIMIT_MS,
  IDLE_LIMIT_MS,
  RENEW_RETRY_MS,
  TICK_MS,
  formatRemaining,
  renewalMargin,
} from "./sessionExpiry";

// What counts as activity. Listened to in the capture phase so a handler that
// stops propagation does not hide it.
const ACTIVITY_EVENTS = ["pointerdown", "mousemove", "keydown", "scroll", "touchstart", "wheel"];

export default function SessionTimeout() {
  const { user, session } = useAuth();

  // Keyed by user, so a different person signing in starts every clock afresh.
  return user && session ? <SessionWatcher key={user.id} /> : null;
}

function SessionWatcher() {
  const { session, renewSession, expireSession, endIdleSession, logout } = useAuth();

  // `asking` is the popup; also a ref so the clock and listeners can read it.
  const [asking, setAsking] = useState(false);
  const [remainingMs, setRemainingMs] = useState(ANSWER_LIMIT_MS);
  const [busy, setBusy] = useState(false);
  const [logoutError, setLogoutError] = useState(null);

  const askingRef = useRef(false);
  const lastActivity = useRef(0);
  const nextRenewAttempt = useRef(0);
  const renewing = useRef(false);
  const opener = useRef(null);
  // The clock reads current values from here, so a renewal never restarts it.
  const latest = useRef({});
  useEffect(() => {
    latest.current = { session, renewSession, expireSession, endIdleSession };
  });

  const tick = useCallback(() => {
    const now = Date.now();
    const { session: current, renewSession: renew, expireSession: expire, endIdleSession: endIdle } = latest.current;

    // A tab that slept through the whole window is signed out on waking, not
    // asked first.
    const answerDeadline = lastActivity.current + IDLE_LIMIT_MS + ANSWER_LIMIT_MS;
    if (now >= answerDeadline) {
      endIdle();
      return;
    }

    if (askingRef.current) {
      setRemainingMs(answerDeadline - now);
      return;
    }

    if (now - lastActivity.current >= IDLE_LIMIT_MS) {
      // Saved now: once the popup is up it has already taken focus.
      opener.current = document.activeElement;
      askingRef.current = true;
      setAsking(true);
      setRemainingMs(answerDeadline - now);
      return;
    }

    // Only an active user is renewed; Yes renews the idle one.
    const expiresAt = Number(current?.expires_at) * 1000;
    if (!Number.isFinite(expiresAt) || renewing.current || now < nextRenewAttempt.current) return;

    const lifetime = Number(current.expires_in) * 1000 || 3600 * 1000;
    if (now < expiresAt - renewalMargin(lifetime)) return;

    renewing.current = true;
    nextRenewAttempt.current = now + RENEW_RETRY_MS;
    renew()
      .then((outcome) => {
        // Unreachable server: keep the session and retry until the token itself ends.
        if (outcome === "unavailable" && Date.now() >= expiresAt) expire();
      })
      .finally(() => {
        renewing.current = false;
      });
  }, []);

  useEffect(() => {
    lastActivity.current = Date.now();

    function onActivity() {
      // While the popup is up only its buttons count.
      if (!askingRef.current) lastActivity.current = Date.now();
    }

    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, onActivity, { capture: true, passive: true }));
    document.addEventListener("visibilitychange", tick);
    const timer = setInterval(tick, TICK_MS);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, onActivity, { capture: true }));
    };
  }, [tick]);

  // Focus goes to the popup when it opens and back when it closes.
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!asking) return undefined;
    return () => {
      const before = opener.current;
      if (before instanceof HTMLElement && document.contains(before)) before.focus();
    };
  }, [asking]);

  // Keeps Tab inside the dialog, as aria-modal promises.
  function keepFocusInside(e) {
    if (e.key !== "Tab") return;
    const buttons = Array.from(dialogRef.current.querySelectorAll("button:not([disabled])"));
    if (buttons.length === 0) {
      e.preventDefault();
      return;
    }
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!dialogRef.current.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  async function stayHere() {
    setBusy(true);
    await renewSession();
    // Any outcome counts as an answer: "unavailable" is retried by the clock.
    lastActivity.current = Date.now();
    askingRef.current = false;
    setAsking(false);
    setBusy(false);
  }

  async function logOut() {
    setBusy(true);
    setLogoutError(null);
    const result = await logout();
    setBusy(false);
    if (!result.success) setLogoutError(result.error);
  }

  if (!asking) return null;

  return (
    <div className="session-timeout__backdrop">
      <div
        className="session-timeout"
        ref={dialogRef}
        onKeyDown={keepFocusInside}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-timeout-title"
        aria-describedby="session-timeout-body"
      >
        <h2 id="session-timeout-title">Are you still there?</h2>
        <p id="session-timeout-body">
          You have been inactive for a while. For your security you will be signed out in{" "}
          <strong>{formatRemaining(remainingMs)}</strong> unless you stay signed in.
        </p>
        {logoutError && <p className="session-timeout__error" role="alert">{logoutError}</p>}
        <div className="session-timeout__actions">
          <button type="button" onClick={stayHere} disabled={busy} autoFocus>
            Yes, keep me signed in
          </button>
          <button type="button" onClick={logOut} disabled={busy}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
