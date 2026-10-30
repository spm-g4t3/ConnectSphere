# SCRUM-384: Coordinator screens

Part of SCRUM-379 (AC1, AC2, AC7 on the coordinator side). Three things on the coordinator's screens, plus the one backend change they needed.

## What a coordinator can now do

1. **See what needs attention.** The dashboard has a Needs attention card above My events. It lists one row per reason from `GET /api/event-requests/needs-attention` (SCRUM-383), each row showing the reason, the event name as a link to the event (`/event-requests/<id>`), the event's period in Singapore time and the organiser's name. It reads again when the coordinator returns to the tab, and when something in My events changes an event (so a completed event leaves the list).
2. **Mark an event as completed.** On a Confirmed event that has ended, the assigned coordinator sees a Mark as completed button. It opens a panel with an optional closing notes box, then a confirmation step ("Confirm completion") that shows the notes as they will be sent. Nothing is sent until "Yes, mark as completed". Going back keeps the notes. Before the event has ended, the same coordinator sees "You can mark this event as completed once it has ended (<time> (Singapore time))." instead.
3. **Read the closing notes.** A completed event shows a Closing notes section to coordinators (and the Lead), or "No closing notes were recorded." when there are none. Organisers never see it.

## Where the code is

- `frontend/src/components/CoordinatorAttentionList.jsx`: the Needs attention card. Not the per-event badge from SCRUM-266 and SCRUM-315 (`NeedsAttentionBadge`, `NeedsAttentionReasons`); that is one event's flags, this is the coordinator's to-do list.
- `frontend/src/components/EventCompletionPanel.jsx`: the notes step and the confirmation step.
- `frontend/src/services/eventCompletion.js`: `eventHasEnded`, `canMarkCompleted`, `closingNotesOf`, `completionErrorMessage`, and the 2000 character limit. These are conveniences in front of the database. `complete_event_request` (034) still decides under a row lock.
- `CoordinatorRequestDetail.jsx`: the button, the hint, the completed notice and the Closing notes section. `EventCoordinatorDashboard.jsx` and `MyAssignedEvents.jsx` (a new optional `onEventChanged` prop) do the refresh.
- `eventRequestService.js` (frontend): `completeEventRequest` and `getNeedsAttention`.

## Backend change: the coordinator's reads return `closingNotes`

- `GET /api/event-requests/mine` returns `closingNotes` on every row (`null` when the event has none).
- `GET /api/event-requests/:id/review` (coordinator or Lead) returns it too, through `getEventRequestForCoordinator(id, { withClosingNotes: true })`. The option is off by default, so the other callers of that function (clarifications, change requests, venue suitability, booking requests) do not select the column.
- Nothing an Organiser reads selects `closing_notes`, and `toEventRequest` still does not map it. Tests check both the columns each read selects and the JSON each returns.

## What the screens show for a refusal

- EVENT_FINAL (409): the server's sentence, as written ("This event is completed and can no longer be changed").
- Not ended yet, or no longer Confirmed (409): the coordinator's own wording, without the event id.
- 403, 404, 401, 400, 5xx: a plain sentence; a 5xx says nothing was changed. A request that never reached the server does not claim that, because the event may have been completed.

## Decisions to confirm with Calven

- **Who sees closing notes.** Built as every coordinator and the Lead, because any of them can open any event past draft (`GET /:id/review`). The Needs attention list is narrower (the coordinator's own events). If "coordinators only" should mean the assigned coordinator only, the change is one condition in `getEventRequestForCoordinator` and one in `CoordinatorRequestDetail`.
- **Overlap with the overdue clarification box.** My events already shows its own "Needs attention" box for overdue clarifications (SCRUM-266 and SCRUM-315 work). An overdue clarification now appears there and as a row in the new card. Left alone because that box is not part of this story.
- **Migration 033.** `GET /mine` and `GET /:id/review` now select `closing_notes`, so they need migration 033 in the database. Paste 033 and 034 together when the whole story is done.

## Tests

Test names carry the acceptance criterion they cover.

- Backend: `tests/routes/scrum379CoordinatorReadsClosingNotesRoutes.test.js` (23, which columns each read selects, who is let in, what the JSON carries) and `tests/db/scrum379CoordinatorReadsClosingNotesDatabase.test.js` (10, on the real schema with the clock pinned).
- Frontend: `scrum379EventCompletion.test.js` (helpers, with the end time one second either side), `scrum379EventRequestService.test.js`, `scrum379EventCompletionPanel.test.jsx`, `scrum379CoordinatorAttentionList.test.jsx`, `scrum379CoordinatorCompletion.test.jsx` (who is offered the button by role and status, the full flow, closing notes by role, and the Organiser's list) and `scrum379CoordinatorDashboardAttention.test.jsx` (placement and refresh).
- No test reads the real clock: the frontend pins `Date`, and the database tests pin `event_clock()`.
