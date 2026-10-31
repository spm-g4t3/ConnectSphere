# SCRUM-383: The Needs attention endpoint

Part of SCRUM-379 (AC7). A coordinator's Needs attention list: the events assigned to them that need action, one item per reason.

## The endpoint

`GET /api/event-requests/needs-attention` (coordinator role). A bare array, `[]` when nothing needs attention (never 404). Statuses: 200, 401 signed out, 403 wrong role, 500 anything untyped. The list is narrowed to the caller from the token; a coordinator id in the query string is ignored. It is declared before `GET /:id`, otherwise Express reads `needs-attention` as an id. Read only, so the final-event guard does not apply.

Each item:

```json
{
  "id": "<eventId>:EQUIPMENT_NOT_READY:0",
  "code": "EQUIPMENT_NOT_READY",
  "reason": "Equipment request: Pending review",
  "eventRequestId": "<eventId>",
  "eventName": "IS212 Industry Night",
  "status": "confirmed",
  "proposedStart": "2030-06-15T09:00:00+00:00",
  "proposedEnd": "2030-06-15T11:00:00+00:00",
  "organiserName": "Olivia Organiser",
  "link": "/event-requests/<eventId>"
}
```

`id` is stable (event, reason code, and which of that kind) so a screen can use it as a key. `link` is the screen that opens the event. Times are instants; the screen shows them in Singapore time.

## What puts an event on the list

The rules and wording are in `backend/src/domain/coordinatorAttentionList.js`; the list is built by `listNeedsAttention` in `services/eventRequestService.js`.

An event with several reasons appears once per reason, in this order, and the list is earliest event start first (an event with no start last, then event id).

| Code | Event status | Reason shown |
|---|---|---|
| MARK_COMPLETED | Confirmed, end time reached | Mark as completed |
| NOT_CONFIRMED | Approved, end time reached | Not confirmed; cancel |
| CLARIFICATION_OVERDUE | Pending clarification, reply-by date passed | Clarification overdue: reply was due YYYY-MM-DD |
| VENUE_NOT_READY | Confirmed, a venue readiness item not met | No valid venue booking / Venue booking flagged for review / Venue booking: (the readiness wording) |
| EQUIPMENT_NOT_READY | Confirmed, an equipment request not arranged | Equipment request: Pending review / Under review / Cannot be fully arranged |
| EQUIPMENT_FLAGGED | Confirmed, a flagged equipment reservation not released | Equipment unavailable: (reason) or Equipment flagged for review: (reason) |

- **Ended** means the end time is at or before the server time, the same instant `complete_event_request` starts to accept the event. An event is on the list as Mark as completed exactly when it can be completed.
- **Overdue** is worked out from the reply-by date (SCRUM-162 stores the date but no overdue flag). The date is a Singapore date, so a clarification due on the 15th is still open until midnight Singapore time and overdue from the first second of the 16th.
- **Readiness** comes from `event_readiness` (SCRUM-363), asked with "no equipment confirmed" true. Only its venue and equipment items count. The date item ("the start has passed") and the no-equipment confirmation are not conditions a Confirmed event can lose, so they never list an event.
- **Equipment flags** reuse the wording the My events list already uses (`attentionReasons`), so the two never disagree.
- Nothing is stored. The list is worked out from the data as it is now, so an item goes the moment the thing is done: completing, cancelling, approving the booking, arranging the equipment, releasing the flagged reservation.

## Decisions to confirm with Calven

1. **Safety check events.** AC7 names Approved events that ended without being confirmed. An event still in the safety check (`safety_review`, `safety_approved`) whose end has passed is not named, so it is not listed. If it should be, add the two statuses to `NEEDS_ATTENTION_STATUSES` and the NOT_CONFIRMED rule.
2. **"Visible to coordinators only".** Built as: each coordinator sees the events assigned to them. If every coordinator should see every event's items, remove the assigned-coordinator filter. The Lead role is refused at the route, like the other coordinator-only reads.
3. **Overdue clarification.** No flag exists, so it is worked out from the reply-by date. If a flag is added later, replace `clarificationIsOverdue`.

## Limits

- Event-ended items are exact to the second, but the list is a read, not a push: a screen sees a change when it next asks.
- The readiness check is one database call per Confirmed event on the list's page. A coordinator's own Confirmed events are few; if that changes, readiness for many events can move into one function.
- A failed readiness read fails the whole call (500) rather than returning a list with a reason missing.

## Tests

- `tests/domain/scrum379CoordinatorAttentionList.test.js`: the rules with no database or clock (end boundary and offsets, Singapore date, wording, ordering).
- `tests/db/scrum379NeedsAttentionDatabase.test.js`: the real schema with a fixed `now`: every source, one second either side of each boundary, every booking and equipment status, several reasons for one event, other coordinators' events, every excluded status, order and ties, an item going away when it is resolved, input validation, failures, and that listing writes nothing.
- `tests/routes/scrum379NeedsAttentionRoutes.test.js`: the HTTP contract: shape, token scoping, empty list, path order, 401 / 403 for every other role, 500 without leaking the database message.

The shared test client (`tests/fixtures/pgliteSupabaseClient.js`) now compares `in(...)` lists as text, so an enum column such as `status` can be filtered with a list.
