# SCRUM-495 test map

Which test proves which acceptance criterion of SCRUM-495 (Browse Open Events
- Attendee), and what is not proved. Written for SCRUM-532. Paths are under
`backend/` or `frontend/` as marked.

Test names carry the `SCRUM495_ACn` prefix where the criterion is the subject.

| # | Criterion | Test | Result |
|---|---|---|---|
| 1 | Only Attendees can open the list; any other role is refused | backend `tests/routes/openEvents.test.js` (`SCRUM495_AC1`: every `ROLE` value but attendee, an unknown role and a null role get 403 with no read; no token and a rejected token get 401, on the list and on `/:id`); frontend `tests/auth/attendeeDashboardRoute.test.jsx` (every other role, including `event_coordinator_lead` and `safety_officer`, at `/open-events` and at an event's URL goes to `/unauthorized` with nothing fetched; signed out goes to `/login`; the Attendee role in three spellings gets in); `tests/db/openEventRegistrationStateDatabase.test.js` (`SCRUM495_AC1_*`: `open_event_registration_state` refuses a non-attendee or unknown account with 42501 and is not executable by anon or authenticated) | Proved |
| 2 | Only Confirmed events with registration on, open now, not yet started | backend `openEvents.test.js` (`SCRUM495_AC2`) and `tests/domain/registrationWindow.test.js` | Proved against a stand-in client that applies the filters; see below |
| 2a | Off, not yet open, closed, already started are left out | backend `openEvents.test.js` (each condition; window [opens, closes) and start > now to the millisecond, at `Z` and `+08:00`, on the list and on the details URL; the server's own time zone changed to four zones) | Proved |
| 3 | Row shows name, date, start and end, and places left or "No limit" or "Full" | frontend `tests/components/BrowseOpenEvents.test.jsx`, `tests/services/openEventDisplay.test.js` (always Singapore time, with the device zone set to Singapore, New York and Kiritimati) | Proved |
| 3a | Full is listed, "Full", cannot be registered for | backend `SCRUM495_AC3` (still listed); frontend `BrowseOpenEvents.test.jsx` (Full mark), `BrowseEventDetails.test.jsx` (Register disabled) | Proved |
| 4 | Sorted by start, earliest first; already started not listed | backend `SCRUM495_AC4` (by instant across offsets, ties by id); frontend keeps the server's order; `SCRUM495_AC4_lists_every_open_event_when_more_than_one_page_is_open` (the list is read in pages of 1,000, so the API's row cap cannot cut it short) | Proved |
| 5 | Selecting an event opens its description and the same details, with Register | frontend `BrowseEventDetails.test.jsx`, `attendeeDashboardRoute.test.jsx` (`SCRUM495_AC5`: the page opened from a row shows the same date, places and Registered; description kept as text, markup not run) | Proved. Register itself: see blocker |
| 6 | Already registered shows "Registered", no duplicate | backend `SCRUM495_AC6` (the caller's own registration only; withdrawn and cancelled do not count); frontend (Registered badge, disabled "Already registered") | Proved for display. Duplicate refusal is SCRUM-22's |
| 7 | Empty list says so | frontend `BrowseOpenEvents.test.jsx` (`No events are currently open for registration.`); backend 200 `[]` | Proved |
| 8 | No internal planning information | backend `SCRUM495_AC8` (exact allowed keys; secrets in the row never appear; internal columns not selected); frontend (no venue, coordinator or notes shown even if sent) | Proved |
| 9 | Back to Approved: gone, registrations kept | backend `SCRUM495_AC9` (list and details drop it, registrations untouched, none read while Approved); frontend (`BrowseEventDetails.test.jsx`, `BrowseOpenEvents.test.jsx`: refresh removes it, Register withdrawn) | Proved |
| 9a | Reconfirmed: returns only when otherwise eligible | backend `SCRUM495_AC9` (still out if off, closed, not open or started); frontend (returns with its Registered state) | Proved |
| - | Availability and Registered refresh after submission or a stale-state error | frontend `BrowseEventDetails.test.jsx` (refresh after success, "filled up" after a lost race, already registered, event gone, refresh failing, overlapping reads) and `BrowseOpenEvents.test.jsx` | Proved with a stand-in for SCRUM-22 |

## Design decisions (implemented; the team still has to confirm)

The story lists three decisions as "to confirm". The code follows each one as
written, so changing any of them is a code change, not a configuration one.

| Decision | What the code does | Where it is fixed | Pinned by |
|---|---|---|---|
| The list leaves out the venue (SCRUM-24 shows it only to registered attendees) | The service selects an allowlist of columns with no venue; the response has no venue key, for the list or the details | `COLUMNS` in `backend/src/services/openEventService.js` | backend `SCRUM495_AC8` (exact keys, no venue leak); frontend shows no venue even if one is sent |
| The organiser's description is shown to attendees | `description` is selected and returned on the list and the details, shown as plain text | `COLUMNS` and the row mapping in `openEventService.js` | backend `openEvents.test.js` (details return `description`); frontend `BrowseEventDetails.test.jsx` and `attendeeDashboardRoute.test.jsx` `SCRUM495_AC5` (markup is not run) |
| Only events open now are listed, not ones opening later | The window is [opens, closes) and the start must be in the future; an event whose registration has not opened is left out | `backend/src/domain/registrationWindow.js` | backend `SCRUM495_AC2`, `registrationWindow.test.js` |

If the team decides otherwise, the venue and description rows change the
selected columns and the allowlist test together; the third changes
`registrationWindow.js`.

## Not proved

- **Register through SCRUM-22 (criterion 5, 6 and the refresh after
  submission).** SCRUM-22 has no route, service or table. The page takes
  `onRegister(eventId)` and the tests drive it with a stand-in. Wiring the real
  call, and checking how SCRUM-22 reports a full event or a duplicate, is
  outstanding.
- **A real database.** SCRUM-494's columns (`registration_enabled`,
  `registration_opens_at`, `registration_closes_at`, `registration_capacity` on
  `event_requests`) and a `registrations` table (`event_request_id`,
  `attendee_id`, `status`, with `registered` holding a place) are assumed.
  Neither exists. The backend tests use a stand-in Supabase client that applies
  the same filters; nothing has run against Postgres or PostgREST.
- **Significant change (SCRUM-395).** Returning an event to Approved is
  simulated by changing its status.
- **Real login.** An Attendee account in Supabase is a manual check.
