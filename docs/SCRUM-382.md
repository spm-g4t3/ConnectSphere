# SCRUM-382: The "is this event final?" guard

Part of SCRUM-379 (AC3). A Completed or Cancelled event is final: nothing leads out of either status, and the event, and everything attached to it, becomes read-only.

## What was built

- **The shared check**, `backend/src/domain/finalEvent.js`. `isFinalEventStatus(status)` is true for `completed` and `cancelled` and false for everything else, including a status it does not recognise and a missing one. `assertEventNotFinal(status)` throws the refusal. A test fails if the set of statuses that nothing leads out of (from the transition table) ever differs from the set the check uses.
- **The route guard**, `backend/src/middleware/finalEventGuard.js`. A router is handed a `finalEventGuard`, the same way it is handed `requireAuth`. A route names how to find its event and puts the guard after its role check:

```js
router.post('/:id/clarification', coordinatorOnly, guardEvent, async (req, res) => { ... });
```

- **The refusal**: HTTP 409, body `{ error: "This event is completed and can no longer be changed", code: "EVENT_FINAL", conflicts: [] }`. For a cancelled event the message says "cancelled".

## How the guard behaves

- **After the role check.** A caller who may not use the route gets 403 and learns nothing about the event. Only a permitted caller is told the event is final. (The Safety Officer router checks the role for the whole router, so it is ahead of the guard too.)
- **Only a caller who owns the record is told.** Ten routes answer a caller who does not own the record with a 404 that matches a missing one: the Organiser's `PATCH /:id`, `/:id/submit`, `/:id/reopen`, `/:id/clarification-response` and `/:id/change-requests`, the registration settings `PUT`, the attendee's `withdrawal` and `leave-waitlist`, and `registrations` and `waitlist` on open events. If the guard answered 409 first, any signed-in caller could tell that an event exists and is final. These routes give the guard an `entitled` check (`organisesEvent`, `ownsRegistration`, `isRegisteredFor`). It runs only when the event is final, so a live event still costs the one status read. A caller who fails it goes on to the handler and gets the handler's 404. Routes on shared queues (coordinators, Technical Support, Venue Staff, Safety Officers) are not private to one person, so they tell every permitted caller.
- **One read.** It reads the event's status. For a route that names a booking, a registration or a change request instead of the event, it first reads that record's event id (two small reads).
- **Event not found, or the id is not a usable uuid.** The guard lets the request through, and the handler gives its own 400 or 404. The guard never answers differently about a missing event.
- **A failed read refuses with a 500.** A guard that cannot tell must not let a change through.
- **Reads are never guarded.** A final event stays viewable (AC5).
- **A router built without a guard checks nothing.** That is the default, so the existing route tests, which stub the client and assert on every call, are untouched. `src/app.js` mounts each router's default export, and every default export is built with the real guard.

## The limit, stated plainly

The guard reads the status and then the handler acts, so an event completed in the gap between the two is not caught by the guard. What catches it is each service and database function behind the route, which still apply their own status rules under a row lock. I did not audit every one of those functions for what it does with a Completed or Cancelled event; the guard is the first line, not a proof that none of them can be reached.

## The 46 endpoints that carry the guard

Event requests (`/api/event-requests`), 19:

- `PATCH /:id` (organiser edits a draft)
- `POST /:id/submit`
- `POST /:id/reopen`
- `POST /:id/safety-review`
- `POST /:id/confirm`
- `POST /:id/clarification`
- `POST /:id/clarification/close`
- `PATCH /:id/clarification-response`
- `POST /:id/reassign`
- `POST /:id/assign`
- `POST /:id/start-review`
- `POST /:id/decision`
- `POST /:id/cancel`
- `PATCH /:id/details`
- `POST /:id/complete`
- `POST /:id/rejection` (added when SCRUM-347 landed)
- `POST /:id/significant-change`
- `POST /:id/change-requests`
- `POST /change-requests/:changeRequestId/decision` (event found through the change request)

Equipment lines (`/api/event-requests/:id/equipment`), 3:

- `POST /lines`
- `PATCH /lines/:lineId`
- `DELETE /lines/:lineId`

Equipment review and reservations (`/api/event-requests/:id/equipment-review`), 10:

- `POST /start`
- `POST /take-over`
- `PUT /lines/:lineId/outcome`
- `DELETE /lines/:lineId/outcome`
- `POST /complete`
- `POST /lines/:lineId/reservations`
- `PATCH /reservations/:reservationId`
- `POST /reservations/:reservationId/release`
- `POST /reservations/:reservationId/move`
- `POST /reservations/:reservationId/keep`

Booking requests (`/api/booking-requests`), 5:

- `POST /` (event named in the body as `eventRequestId`)
- `POST /:id/withdraw`
- `POST /:id/release`
- `POST /:id/approve`
- `POST /:id/reject`
- (the last four find the event through the booking)

Flagged bookings (`/api/flagged-bookings`), 2:

- `POST /:id/reinstate`
- `POST /:id/cancel`

Venue holds (`/api/venues`), 1:

- `POST /:id/holds` (event named in the body as `eventRequestId`)

Registrations, 3:

- `POST /api/open-events/:id/registrations`
- `POST /api/open-events/:id/waitlist`
- `POST /api/attendee-events/registrations/:registrationId/withdrawal` (event found through the registration)
- `POST /api/attendee-events/registrations/:registrationId/leave-waitlist` (event found through the registration)
- `PUT /api/registration/events/:id/settings`

Safety review, 1:

- `POST /api/safety-reviews/:eventRequestId/responses`

## Mutating endpoints that are deliberately not guarded

Each is listed with its reason in `tests/routes/scrum379FinalEventCoverage.test.js`:

- sign in and sign out;
- `POST /api/event-requests` (creates a new request, so there is no event to be final);
- `POST /api/event-requests/:id/significant-change-impact` (a preview that writes nothing);
- the equipment catalogue routes (`/api/equipment`, including its change preview), which are about a catalogue item for every event alike;
- `PATCH /api/notifications/:id/read` (the caller's own notification);
- venue routes that are about a venue, not an event: create, edit, retire, and the maintenance block routes.

## On-site assignments

AC3 lists on-site assignment changes. No on-site assignment endpoint exists on `dev` yet. When it is built, its mutating routes will fail `scrum379FinalEventCoverage.test.js` until they carry the guard (or are exempted with a reason), so the rule cannot be missed.

## For anyone adding a mutating route

`tests/routes/scrum379FinalEventCoverage.test.js` walks every router in `src/routes`. A new `POST`, `PUT`, `PATCH` or `DELETE` fails it until it either carries the guard or is added to the exempt list with a reason. To guard a route:

1. Take `finalEventGuard = noopFinalEventGuard` in the router factory (every router already does).
2. Build the guard once: `const guardEvent = finalEventGuard(eventIdFromParam('id'));`. Use `eventIdFromBody('eventRequestId')` when the event is in the body, or `eventIdFromRecord('bookings', 'id')` when the route names a record that carries `event_request_id`.
3. Put it after the role check on the route. If the handler answers 404 to a caller who does not own the record, pass `{ entitled }` as the second argument (see above) so the guard does not answer first.
4. Add the route to the list in the coverage test and to `ROUTES` in `tests/routes/scrum379FinalEventRoutes.test.js`.

## What the screens (SCRUM-384) need

The refusal reaches the browser as `409` with `code: "EVENT_FINAL"` and the sentence in `error`. A screen should show that sentence as it is.

## Tests

- `tests/domain/scrum379FinalEvent.test.js`: the shared check, over every status and over non-status values.
- `tests/middleware/scrum379FinalEventGuard.test.js`: the guard on the real schema, all 11 statuses, and a booking, a registration and a change request attached to completed, cancelled and live events; unusable ids; failed reads; nothing cached.
- `tests/routes/scrum379FinalEventRoutes.test.js`: each of the 46 routes with a completed, a cancelled and a live event; the wrong role (403); signed out (401); an event that does not exist; the ten routes above with a caller who has no part in the event (no 409, same answer as a missing event); a router with no guard.
- `tests/routes/scrum379FinalEventCoverage.test.js`: every mutating route is guarded or exempt, and the guarded list matches the one above.
