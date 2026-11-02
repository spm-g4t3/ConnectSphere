# SCRUM-583 manual test

Handle an Expired Session - All Users. Run on 30 October 2026 against the 583 branch, local frontend
and backend (port 5000), real Supabase. No migration is needed.

The automated suites prove each rule with a fake clock and a fake network (see
`SCRUM-583.md`, section 2). This record covers what only the real stack can show: a real
Supabase refresh, a real dead token, and the popup on screen. Waiting 30 minutes is
replaced by moving the browser's clock from the console.

## Setup

- Restart the backend and the frontend on the 583 branch.
- Sign in as any account. Keep DevTools open on the Console and Network tabs.
- Console snippets read the session from `sessionStorage` (`connectsphere_auth`,
  `session.access_token`).

## Steps

1. **An expired session goes to login with one message.** In the console:
   `a = JSON.parse(sessionStorage.connectsphere_auth); a.session.access_token = 'dead'; sessionStorage.connectsphere_auth = JSON.stringify(a)`
   then click any link that loads data. Expect: the page goes to `/login`, the notice
   "Your session expired. Please sign in again." is shown once, no screen shows its own
   expiry wording, and `sessionStorage.connectsphere_auth` is gone.
   Result: pass.

2. **The message stays, a wrong password is unchanged.** On that login page enter a wrong
   password. Expect: "Invalid email or password" appears and the expiry notice is still
   there. Reload the page: the notice is gone, as there is nothing left to explain.
   Result: pass.

3. **Signing in again works.** Sign in with the right password. Expect: the dashboard, no
   notice, and the screens load.
   Result: pass.

4. **Repeat step 1 as a second role** (Technical Support, then an Attendee). Expect the
   same result.
   Result: pass.

5. **The session is renewed while active.** Signed in, in the console:
   `a = JSON.parse(sessionStorage.connectsphere_auth); a.session.expires_at = Math.floor(Date.now()/1000) + 240; sessionStorage.connectsphere_auth = JSON.stringify(a); location.reload()`
   Expect: within a few seconds the Network tab shows `POST /api/auth/refresh` with 200,
   and `sessionStorage.connectsphere_auth` holds a new `access_token`, a new
   `refresh_token` and an `expires_at` about an hour away. You stay signed in and the
   role is unchanged.
   Result: pass.

6. **A failed renewal is an expiry.** Repeat step 5's first line, then also set
   `a.session.refresh_token = 'dead'` before saving it and reloading. Expect: the refresh
   answers 401 and you are on `/login` with the notice.
   Result: pass.

7. **The popup appears after 30 minutes idle.** Signed in, with the mouse over DevTools
   and not over the page, run: `real = Date.now.bind(Date); Date.now = () => real() + 31*60*1000`
   Expect: within a second the "Are you still there?" popup appears with about 14:00
   left, and Yes and Log out buttons.
   Result: pass.

8. **Yes extends the session.** Click "Yes, keep me signed in". Expect: `POST
   /api/auth/refresh` 200, the popup closes, and you stay signed in. The popup does not
   come back until another 30 minutes have passed.
   Result: pass.

9. **No answer signs out.** Reload, sign in again, then run the step 7 line with `46`
   instead of `31`. Expect: signed out and sent to `/login` with the expiry notice, and a
   `POST /api/auth/logout` in the Network tab.
   Result: pass.

10. **Log out from the popup.** Repeat step 7, then click "Log out". Expect: signed out,
    "Logged out successfully", and not the expiry notice.
   Result: pass.

11. **Moving the mouse does not answer the popup.** Repeat step 7, then move the mouse
    over the page. Expect: the popup stays.
   Result: pass.

## Result

All 11 steps pass: an expired session goes to login with one message and no screen wording, a wrong password is unchanged, signing in again works for the roles tried, a session is renewed while active and a failed renewal is an expiry, the popup appears after 30 minutes idle, Yes extends the session, no answer signs out with the expiry notice, Log out from the popup shows the logged-out message, and moving the mouse does not answer the popup.
