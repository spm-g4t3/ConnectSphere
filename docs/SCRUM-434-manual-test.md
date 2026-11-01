# SCRUM-434 manual test

Restrict Event Access to Related Users (Event Organiser). Run on 29 October 2026
against the 434 branch, local frontend and backend, shared Supabase.

The automated suites prove each rule against the real schema (see
`SCRUM-434.md`, section 3). This record covers what only a person at a browser can
see: the screens, and the live API with real sessions. AC4 (Venue Staff and
Technical Support field limits) has no visible change and is covered by the canary
and allowlist tests, so it is not repeated here. AC1's first half (organisation
view) is descoped, see `SCRUM-434.md`, section 2.

## Setup

- Restart the backend and frontend on the 434 branch so they run the new code.
- Accounts: `organiser@connectsphere.com` (organiser 1), a second organiser
  (`organiser2`, created for this test and deleted afterwards), a coordinator, a
  Venue Staff account and an attendee.
- API calls use the signed-in token from `sessionStorage` (`connectsphere_auth`)
  in the browser console.

## A. Cancelled event, attendee view (AC5)

1. As the assigned coordinator, cancel a Confirmed event that an attendee has
   registered for. Enter an attendee message and an internal reason.
2. As the attendee, open Registered events, then the event.

Expected and seen:

- The page shows "This event has been cancelled." and a "Message from the
  coordinator" heading with the message. Pass.
- The internal reason appears nowhere on the page or in the API response. Pass.
- A cancelled event with no message shows only "This event has been cancelled."
  with no heading or empty paragraph. Pass.
- No withdraw panel and no "no withdrawal deadline" banner on a cancelled event.
  Pass (found and fixed during this test, SCRUM-440).

Known gap, outside this story: the cancelled event stays on the attendee's
Registered events list, because cancelling leaves registrations as they were
(SCRUM-539 and SCRUM-27). Raised on the story.

## B. Role gate on the Organiser write routes (AC6)

`POST /api/event-requests` with an attendee token.

| Caller | Result |
|---|---|
| Attendee | 403, and `select id from event_requests where event_name = 'ZZ role gate test'` returns no rows |
| Venue Staff | 403 |
| Event Coordinator | 403 |
| Event Organiser creating a draft in the app | works as before |

Pass. Before the gate, the attendee call returned 201 and created an event.

## C. Another organiser (AC6)

Organiser 2 requested organiser 1's event and its eight reads: the event, status,
status history, clarification history, decision history, change history, change
requests and assignments.

- Organiser 1's own session returned 200 on all eight (control).
- Organiser 2's session returned 404 on all eight, identical to a made-up id
  (`00000000-0000-0000-0000-000000000000`). Pass: a stranger cannot tell the
  event exists.

## D. Organiser's own history and reopen (AC2, AC3, AC6)

- As organiser 1, an event that had been through a review shows its decision and
  history on screen. Pass.
- As organiser 1, a Rejected event was reopened and became a draft. Pass.
- As organiser 2, reopening organiser 1's Rejected event was refused with 404
  and the event stayed Rejected. Pass.

## Result

A, B, C and D all pass. The one defect found (the withdraw panel on a cancelled
event) was fixed in the same story and has its own test.

## Cleanup

The `organiser2` test account and its profile row are deleted after the run.
