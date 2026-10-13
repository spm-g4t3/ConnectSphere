# SCRUM-453 test map

Which test proves which acceptance criterion of SCRUM-453 (Attendee
Dashboard), and what is not proved. Written for SCRUM-458. Paths are under
`frontend/` unless marked `backend/`.

Test names carry the `SCRUM453_ACn` prefix.

| # | Criterion | Test | Result |
|---|---|---|---|
| 1 | Logging in as an Attendee routes to a dedicated dashboard, not another role's view | `tests/auth/attendeeDashboardRoute.test.jsx` (real `App`, `AuthProvider`, `LoginForm`, `Dashboard`: typed login lands on `/dashboard` with `.dashboard--attendee`; spellings `Attendee`, ` ATTENDEE `; restored session; each other role keeps its own dashboard); `tests/components/Dashboard.test.jsx`; `backend/tests/routes/auth.test.js` (login returns `attendee`, a known role) | Proved |
| 2 | Navigation to Browse Open Events (SCRUM-495); own-registrations link deferred | `attendeeDashboardRoute.test.jsx` (nav is Dashboard and Browse Open Events; the dashboard links only to the browse page; other roles are not offered it); `tests/components/Navigation.test.jsx` | Proved since SCRUM-495: the nav and dashboard links open `/open-events` (see `SCRUM-495-test-map.md`) |
| 3 | Only Attendees can access the dashboard; any other role is refused | `attendeeDashboardRoute.test.jsx` (each other role at `/dashboard` gets its own view and no attendee content; unknown, blank, missing role get the fallback; signed out goes to `/login`); `tests/auth/attendeeRouteGuard.test.jsx` (`ProtectedRoute allowedRoles={["attendee"]}` sends every other role, and unknown, blank and missing roles, to `/unauthorized`) | Proved for the dashboard. The guard is proved on a probe route only, because no attendee-only route exists yet |
| - | Existing roles keep their dashboard and nav | `attendeeDashboardRoute.test.jsx` (exact nav links per role; own dashboard per role) | Proved |

## How AC3 is met

`/dashboard` is one shared route and `Dashboard.jsx` picks the view from the
role, so there is no URL on which a non-Attendee can reach the Attendee
dashboard: they get their own. Direct-URL refusal applies to attendee-only
routes, which do not exist until SCRUM-495. That route must be wrapped in
`<ProtectedRoute allowedRoles={["attendee"]}>`.

## Not proved, and why

- **Browse Open Events destination.** Blocked on SCRUM-495. When it lands: set
  `BROWSE_OPEN_EVENTS_PATH` in `components/AttendeeDashboard.jsx`, add the link to
  the `ATTENDEE` list in `components/Navigation.jsx`, register the route with
  `allowedRoles={["attendee"]}`, then replace the `it.todo` and the probe route
  in `attendeeRouteGuard.test.jsx` with tests on the real `App`.
- **Real login.** The frontend tests mock `apiClient`; the backend test mocks
  Supabase. Whether a real Attendee account exists and logs in is a manual check.
- **My registrations.** Deferred until its story is written.
