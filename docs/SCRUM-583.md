# SCRUM-583 - Handle an Expired Session - All Users

**Story:** Handle an Expired Session - All Users
**Status of the work:** built and tested. The manual check in `SCRUM-583-manual-test.md` is still to be run.

This records what SCRUM-583 added, how each acceptance criterion is proved, and the
choices made where the story left room.

**Short version.** One response handler on `apiClient` hears every "your session is no
longer valid" and tells `AuthContext`, which clears the stored session and sends the
user to the login page with one message. A new `POST /api/auth/refresh` renews the
session while the user is active. A popup asks "Are you still there?" after 30 minutes
without activity and signs the user out 15 minutes later if nobody answers. The 37
screens and error tables that each worded their own expiry no longer do. No migration.

---

## 1. What changed in the product

| Area | Change |
|---|---|
| `backend/src/routes/auth.js` | New `POST /api/auth/refresh`. Body `{ refresh_token }`, answer `{ session }`. 400 for a missing or non-string token, 401 when Supabase refuses the token, 503 when Supabase could not be asked. `/login` and `/logout` are unchanged. |
| `services/apiClient.js` | Response interceptor: a 401 on a request that carried the stored token reports the session as refused. Login, refresh and logout requests are exempt. |
| `auth/sessionExpiry.js` | The message, the timings, and the channel from `apiClient` to `AuthContext`. |
| `auth/AuthContext.jsx` | `expireSession`, `renewSession`, `endIdleSession`, `sessionExpiredMessage`. Logging out a session the server already dropped (401) now finishes as a log out. |
| `auth/SessionTimeout.jsx` | Renews an active user's session, asks the idle user, signs out the one who does not answer. Mounted once in `App.jsx`. |
| `components/LoginForm.jsx`, `App.jsx`, `App.css` | The message on the login page; redirect to `/login` from unprotected screens; popup styles. |
| 37 `src` files, 32 test files | The per-screen `401: SESSION_EXPIRED` rows, the `SESSION_EXPIRED` constant and their tests are removed. |
| `vite.config.js`, `vitest.config.js` | `AuthContext.jsx`, `SessionTimeout.jsx`, `sessionExpiry.js`, `apiClient.js` and `routes/auth.js` are gated at 100% coverage. |

## 2. Acceptance criteria and the tests that prove them

| AC | Rule | Held by | Tests |
|---|---|---|---|
| AC1 | An expired-session refusal sends the user to login with "Your session expired. Please sign in again."; screens no longer show their own; a wrong password is unaffected | The interceptor, `expireSession`, the notice in `LoginForm`, the redirect in `App.jsx`, and the removed per-screen rows | `scrum583ApiClient401.test.js` (what counts as a refusal, the exemptions, stale and missing tokens); `scrum583AuthContext.test.jsx` (clears storage and state once, wrong password, login error wording unchanged); `scrum583ExpiredSessionFlow.test.jsx` (real App, every role, one message, no screen wording, unprotected screen, deep link) |
| AC2 | An active user's session is renewed before it ends; a failed renewal is AC1 | `SessionTimeout` renews 5 minutes before the token ends (half its life for a very short token); `renewSession` and `/auth/refresh` | `scrum583SessionTimeout.test.jsx` (not early, on time, repeated, retried, refused, unreachable to the end of the token, expired on load, no expiry time); `scrum583AuthContext.test.jsx` (new session stored, role kept, one at a time, signed out or in meanwhile); `scrum583RefreshRoute.test.js` |
| AC3 | After 30 minutes idle a popup asks "Are you still there?"; Yes extends; no answer in 15 minutes signs out with the same message; Log out button | `SessionTimeout` and `endIdleSession` | `scrum583SessionTimeout.test.jsx` (29:59 and 30:00, 14:59 and 15:00, each kind of activity, mouse moves in the popup ignored, Yes, Log out, failed Log out, countdown, sleeping laptop, focus and Tab) |
| AC4 | Signing out clears the stored session; signing in again works | `logout`, `login` | `scrum583AuthContext.test.jsx`, `scrum583ExpiredSessionFlow.test.jsx` (including a straggling request from the old session) |
| AC5 | Every role | Nothing in this work depends on role | `SCRUM583_AC5` in the flow test (all seven roles reach login with one message) and in the timeout test (all roles are asked and signed out) |

Test names follow the repo convention `SCRUM583_AC<n>_<behaviour>`.

## 3. Choices made

- **A 401 only counts when the request carried the token that is stored now.** A slow
  request from before the user signed in again must not sign the new session out.
- **Refresh, login and logout are exempt.** Login's 401 is a wrong password. A refused
  refresh is handled by the code that asked. A 401 on logout means the session was
  already gone, so the log out finishes.
- **401 and 503 from the refresh route mean different things.** 401 is "this session is
  over". 503 is "Supabase could not be asked": the session is kept and the renewal is
  retried every 30 seconds until the token itself ends, then it is AC1. Without this a
  network blip at the wrong minute would sign out a working user.
- **Idle numbers are 30 and 15 minutes** as the story gives them. They are constants in
  `auth/sessionExpiry.js`.
- **Activity is a mouse move, press, key, scroll, touch or wheel.** Background requests
  and renewals do not count. While the popup is open only its two buttons answer it.
- **Yes renews the session and restarts the 30 minutes.** If the server cannot be reached
  it still counts as an answer, and the clock retries the renewal.
- **Deadlines are absolute times checked every second.** A laptop that slept for 40
  minutes shows the popup on waking with 5 minutes left; one that slept for 50 is signed
  out on waking.
- **Idle sign out is an expiry, not a log out.** The same message as AC1 appears, and the
  server is told to end the session (best effort).
- **The popup's Log out button is a normal log out** ("Logged out successfully"), not the
  expiry message.
- **The screens' 401 wording is deleted, not hidden.** A 401 now reaches a screen only as
  an unremarkable failure that is unmounted in the same render, so nothing flashes.
- **`EventConfirmationPanel` still treats a 401 as a block.** Harmless, and it keeps the
  panel safe if a 401 ever arrives without an expiry.

## 4. Limits

- **Unsaved work is lost** when a session ends (out of scope in the story).
- **Each browser tab has its own timer.** Activity in one tab does not keep another from
  asking (out of scope).
- **No "remember me".** The session still lives in `sessionStorage`, so closing the tab
  signs the user out as before.
- **The server does not enforce the idle time.** The Supabase token stays valid until it
  ends; the 30 and 15 minutes are enforced in the browser. A stolen token is not
  invalidated by idleness.

## 5. Manual check

`SCRUM-583-manual-test.md` has the steps. They shorten the timers instead of waiting 30
minutes, and use the real backend and a real Supabase session.
