# SCRUM-379: Mark an Event Completed

Status: SCRUM-380 to SCRUM-386 built. The acceptance criteria to test list is in `docs/SCRUM-386.md`.

## What exists now

- **Migration 033** (SCRUM-380): `event_requests.closing_notes`, with two checks: only a Completed row may hold notes, and notes are non-blank and at most 2000 characters.
- **Migration 034** (SCRUM-381): `complete_event_request(event, coordinator, closing_notes)`, one transaction, API role only. Adds the change-request outcome `event_completed`.
- **Final-event guard** (SCRUM-382, see `docs/SCRUM-382.md`): a Completed or Cancelled event is refused by every endpoint that changes an event or something attached to it. This is what makes AC3's read-only rule hold.
- **Needs attention list** (SCRUM-383, see `docs/SCRUM-383.md`): `GET /api/event-requests/needs-attention`, one item per reason (AC7).
- `POST /api/event-requests/:id/complete` (coordinator role). Body: `{ closingNotes? }`. Returns the event with `closingNotes` for the calling coordinator.
- **Completed events stay readable** (SCRUM-385, AC5): the organiser's arrangements read and screen now show the kept venue and arranged equipment for a Completed event as well as a Confirmed one. Every history read was already open past Completed.
- **Coordinator screens** (SCRUM-384, see `docs/SCRUM-384.md`): Needs attention beside My events, Mark as completed with a confirmation step, and closing notes on a completed event. The coordinator's own reads of an event (`GET /mine`, `GET /:id/review`) now return `closingNotes`.

## What the function does, in order

1. Locks the event row.
2. Refuses a caller who is not the assigned coordinator (42501).
3. Refuses any status other than Confirmed (55000), naming the status.
4. Refuses an event whose end time has not passed, or that has none (55000).
5. Moves the status through `change_event_request_status`, which writes the status history row (who, when).
6. Saves the closing notes (trimmed, blank stored as null).
7. Closes outstanding and in-progress change requests with the outcome `event_completed`.

Each refusal changes nothing. A forced failure in step 7 rolls back steps 5 and 6 and the equipment release (tested).

## Decisions

- **Equipment release is not called by the function.** The trigger `event_requests_release_equipment_on_completed` (baseline 06) already releases an event's live reservations with the reason "event completed" when the status becomes completed. It runs in the same transaction, so the function relies on it. The release is a system release (no person on the reservation row), the same as on cancellation.
- **The venue booking is kept.** The function does not call `release_event_arrangements`, which would release it.
- **Registration needs no write.** `register_for_event` already refuses any event that is not Confirmed.
- **"Ended" means the end time is at or before the server clock**, read after the row lock is held. An event with no end time cannot be completed.
- **Time zones.** Event times are `timestamptz`, so "ended" compares two instants. Singapore time (UTC+8, no daylight saving) is how times are shown, not how they are stored or compared. Tests cover end times written with five different offsets (+08:00, UTC, -08:00, +14:00, -12:00) and four session time zones, one second either side of the clock.
- **The clock is injectable.** The end-time check reads `event_clock()` (migration 034), which returns `clock_timestamp()` in production and is not callable by client roles. The database tests replace it with a fixed instant (`2030-06-15T17:00:00Z`) and write every event end time as a fixed instant relative to it, so no test reads the real clock, sleeps or uses random values. Two guards keep this honest: a test fails if the function body ever calls `clock_timestamp()`, `now()` or `current_timestamp` directly, and a separate test checks that the unpinned `event_clock()` really is the live clock.
- **Closing notes never reach organisers.** `toEventRequest` lists its fields by name and does not include them; only the completion response adds `closingNotes`. A test reads an organiser's view of a completed event that has notes and checks they are absent.
- **Only the assigned coordinator completes.** The Lead role is refused at the route unless they also hold the coordinator role, the same as other coordinator-only actions.

## Not done yet

- Nothing left to build. Migrations 033 and 034 need applying to Supabase and a manual run (see `docs/SCRUM-384.md`).
- Who sees the closing notes: built as every coordinator and the Lead (the same people who can open an event through `GET /:id/review`), never an Organiser. Calven to confirm; see `docs/SCRUM-384.md`.
- Change request outcome wording: `frontend/src/services/changeRequestOutcome.js` labels `event_completed` as "Closed, event completed" for both the Organiser's list and the coordinator's panel. It no longer reads as Rejected.

## Migration numbers

033 and 034. 027 and 028 are already taken by other stories, so these two were the next free numbers. Nothing else refers to the numbers, so renumber freely if another story lands on them first.
