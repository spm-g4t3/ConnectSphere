# SCRUM-434 - Restrict Event Access to Related Users - Event Organizer

**Story:** Restrict Event Access to Related Users - Event Organizer
**Scope decision:** AC1's organisation-wide view is not built (section 2). Every other criterion is covered.

This records what SCRUM-434 changed, how each acceptance criterion is proved, and
what was left out on purpose.

**Short version.** Almost everything the story asks for already held, because the
Organiser, coordinator, Venue Staff, Technical Support and Attendee reads were each
built owner-scoped or field-limited in earlier stories. The one real gap was AC5:
an Attendee who opened a cancelled event got "not available" and could not see the
coordinator's message. That is fixed. The rest of the work is tests that pin the
rules, so that a later change cannot widen them without a test failing.

---

## 1. What changed in the product

| Area | Change |
|---|---|
| `attendeeEventService.getAttendeeEvent` | A cancelled event the Attendee is registered for now answers `{ state: 'cancelled', eventName, message }`. `message` is the coordinator's optional `attendee_message`, or `null`. The internal `cancellation_reason` is never read. |
| `AttendeeEventInformation.jsx` | Shows "This event has been cancelled." and, when there is one, "Message from the coordinator" (line breaks kept). The generic "not currently confirmed" text no longer applies to cancelled. |
| `routes/eventRequests.js` | `POST /`, `PATCH /:id`, `POST /:id/submit`, `PATCH /:id/clarification-response` and `POST /:id/change-requests` are now Organiser only. Before, any signed-in account could create an event request, edit a draft, submit it or raise a change; only the ownership check stopped it touching someone else's. A venue staff or attendee account could put its own event into the Lead's queue. They now get 403. |
| `App.css` | One rule, `.attendee-event-information__message`, so the message keeps its line breaks. |

No migration and no new route. The one change to who can write is the Organiser-only gate above.

## 2. Descoped: AC1, the organisation-wide view

AC1 reads: the Organiser "views all event requests from their organisation, but
changes only their own". Nothing in the project requirements asks for organisation
scoping; the Week 1 briefing only limits what an Organiser may see. Building it
would need an organisation on the profile, a new query and a new screen, for a
rule nobody has asked us to meet. Decision: not built.

The second half ("changes only their own") already holds and is tested (AC8).
Subtask SCRUM-435 (the organisation-scoped query) is closed as not needed.

## 3. Acceptance criteria and the tests that prove them

| AC | Rule | Held by | Tests |
|---|---|---|---|
| AC1 | Change only own | Ownership check in every Organiser route and `reopen_event_request` | `scrum434EventAccessRoutes.test.js` (every Organiser route is 404 for a stranger), AC8 block below |
| AC2 | Organiser reads full history of own events | Five existing reads: status, clarification, decision, change history, change requests, and assignments (without handover notes) | `scrum434AccessMatrixDatabase.test.js`, AC2 block, against the real schema |
| AC3 | Organiser reopens own Rejected request | `POST /:id/reopen` and `reopen_event_request` (SCRUM-355) | Access matrix, AC3 block: owner reopens; another Organiser gets 404; every other role gets 42501; non-rejected statuses refused; row unchanged on every refusal |
| AC4 | Venue Staff and Technical Support see only what their requests need | Field-limited selects and SQL functions | `scrum434EquipmentEventFieldsDatabase.test.js` (canary text in every private column never appears in the equipment queue or review), `scrum434EventFieldAllowlist.test.js` (the event columns Venue Staff and booking services select are an allowlist) |
| AC5 | Attendee sees attendee-facing information only; cancelled shows the coordinator's message and never the reason | `getAttendeeEvent` (explicit projections, pinned by SCRUM-24 tests) and the new cancelled branch | `scrum434AttendeeCancelledEvent.test.js` (route), `scrum434AttendeeCancelledEventDatabase.test.js` (real schema), `scrum434AttendeeCancelledEvent.test.jsx` (screen), `scrum434AttendeeFieldsDatabase.test.js` (canary text in every private column never reaches the attendee, in every status, and the answer has exactly the attendee-facing keys), `scrum434EventFieldAllowlist.test.js` (the attendee select strings may only name attendee-facing columns) |
| AC6 | Enforced by the backend | Role gates and ownership checks live in routes, services and SQL, not the screen. The five Organiser write routes now carry the role gate (section 1) | Access matrix, AC6 block: six non-owner relationships by the four history reads, the event read and the change-request read. `scrum434EventAccessRoutes.test.js`: every non-Organiser role gets 403 and no query on the five writes, 404 on reads that are not theirs, another Organiser gets 404, 401 with no token, and the Organiser still creates |
| AC7 | One role per account | `profiles` has a single `role` column and one row per account | Access matrix, AC7 block |
| AC8 | A refused attempt changes no data | Refusals raise before any write | Access matrix, AC8 block: a snapshot of eight tables is identical after each refused attempt; route tests assert no insert, update or rpc call |

Test names follow the repo convention `SCRUM434_AC<n>_<behaviour>`.

## 4. Findings worth knowing

- **The Organiser write routes had no role gate (fixed here).** Found by listing every
  route in `routes/` with its gate. The Organiser's reads stay ungated on purpose:
  they are scoped to the caller's id, so a stranger gets a 404. The route test file
  `eventRequests.test.js` signed in with a role-less stub, so its default is now an
  Organiser stub (`signedInAsOrganiser`); the role-less stub stays for the gate tests
  that rely on it.

- **Every coordinator reads a submitted event's clarification history**, not only the
  assigned one. This is deliberate (the coordinators share one queue, SCRUM-486) and
  is pinned in the access matrix so a change to it is visible.
- **`submit_event_request` does not check the caller owns the event.** The route does,
  first, by reading the event through `getEventRequestForOrganiser`. The route test
  covers it. Anything that calls the function from somewhere else must do the same.
- **The Organiser never receives handover notes.** `GET /:id/assignments` reads with
  `includeNotes: false`; the notes belong to `/assignments/review`, which refuses an
  Organiser. Pinned in the access matrix.
- **`docs/requirements.md` still says "One user may hold several roles".** AC7 and
  SCRUM-485 AC2 say one role per account, and the schema does the latter. The
  requirements line is stale; it was not edited here.
- **Week 9 clarification** says a coordinator "will have access to his own assigned
  events", while the code lets any coordinator open any submitted event for review.
  That is outside the Organiser story and is raised with Calven separately.

## 5. Subtasks

| Subtask | Outcome |
|---|---|
| SCRUM-435 | Not built (AC1 descoped, section 2) |
| SCRUM-436 | No combined endpoint. The five history reads exist and are tested together |
| SCRUM-437 | Reopen already wired to N30 (SCRUM-355); access tests added |
| SCRUM-438 | Venue Staff and Technical Support field limits pinned |
| SCRUM-439 | Attendee answers pinned: exact keys per state, canary text never returned, select strings allowlisted. The projections themselves were already explicit |
| SCRUM-440 | Cancelled-event coordinator message, built |
| SCRUM-441 | Backend enforcement tested role by relationship |
| SCRUM-442 | Refused-access tests for every role and relationship combination |
| SCRUM-443 | AC review: this document |
