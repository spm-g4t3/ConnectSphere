// sessionExpiry.js
//
// The expiry message, the idle and renewal timings, and the channel apiClient
// uses to tell AuthContext a session was refused (apiClient cannot import
// AuthContext, which imports it).

/** The one message a user sees on the login page after any expiry. */
export const SESSION_EXPIRED_MESSAGE = "Your session expired. Please sign in again.";

const MINUTE = 60 * 1000;

/** How long without activity before "Are you still there?" appears. */
export const IDLE_LIMIT_MS = 30 * MINUTE;

/** How long the popup waits for an answer before signing the user out. */
export const ANSWER_LIMIT_MS = 15 * MINUTE;

/** How long before the access token ends the session is renewed (see renewalMargin). */
export const RENEW_BEFORE_MS = 5 * MINUTE;

/** How often the clocks are checked. Deadlines are absolute times, so a sleeping laptop catches up on the next check. */
export const TICK_MS = 1000;

/** How long to wait before retrying a renewal the server could not answer. */
export const RENEW_RETRY_MS = 30 * 1000;

/** Requests whose 401 is not an expiry: a wrong password, a refused renewal (its caller handles it), a logout of a dead session. */
export const AUTH_PATHS_EXEMPT_FROM_EXPIRY = ["/auth/login", "/auth/refresh", "/auth/logout"];

/** Half the token's life at most, so a short token is not renewed the moment it is issued. */
export function renewalMargin(lifetimeMs) {
  return Math.min(RENEW_BEFORE_MS, lifetimeMs / 2);
}

/** m:ss for the popup's countdown, rounded up so it never shows 0:00 early. */
export function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

const listeners = new Set();

/** Subscribe to "the current session was refused". Returns the unsubscribe. */
export function onSessionRefused(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by apiClient when a request made with `token` came back 401. */
export function reportSessionRefused(token) {
  listeners.forEach((listener) => listener(token));
}
