# SCRUM-175 — Notify Users of Confirmation, Changes and Cancellation

**Story:** As an Event Organiser, registered Attendee or relevant staff member, I
want to be notified when confirmed event arrangements change so that I have the
latest information.
**Status as of 31 October 2026:** built and tested; AC1-AC4, AC6 and AC7 met here,
AC5 by SCRUM-402 (PR #95, open). 042 is not yet applied on the shared Supabase
project.
**Test cases:** `docs/test-cases/SCRUM-175.md`.

**The short version:** the function that makes each change now sends its notice.
Confirming tells the organiser, and registered attendees on a re-confirmation.
Replacing a confirmed event's booking at a different venue tells registered
attendees. Cancelling tells registered and waitlisted attendees with the
coordinator's message. No attendee notice carries the internal reason.

---

## 1. Delivered

| Sub-task | Delivered | Commit |
|---|---|---|
| SCRUM-218 | Types `event_confirmed` and `event_venue_changed`, widened into the live list (D2); an attendee audience for `event_cancelled`; their wording and links | `97f1ff3` |
| SCRUM-219 | Migration 042: the senders in `confirm_event_request`, `notify_flagged_booking_resolved` and `cancel_event_request` (D3-D5); the PGlite suite. Removed 175's own copy of AC5's type (D1) | `75e650f` |
| SCRUM-220 | Closed with no code: recipients already covered (D7) | — |
| SCRUM-221 | Closed with no code: change detection already covered (D7) | — |
| SCRUM-222 | The reason removed from `event_significant_change_attendee` at the source and in the display (D6) | `2fa52a4` |
| SCRUM-223 | Closed with no code: both cancellation paths already pass the right message (D8) | — |
| SCRUM-224 + 225 | Merged. Two tests for real gaps (AC2-02, AC3-03), the teeth checks, this review and the test cases | not yet committed |

## 2. Acceptance criteria

| AC | Delivered by | Evidence |
|---|---|---|
| AC1: organiser told on confirmation | `confirm_event_request` (042) | AC1-01 to AC1-03 |
| AC2: registered attendees told, where applicable | `confirm_event_request`, re-confirmations only (D4) | AC2-01 to AC2-04 |
| AC3: organiser and attendees told of a date, time or venue change | Date/time: `apply_significant_event_change` (SCRUM-395). Venue: `notify_flagged_booking_resolved` (042) | AC3-01 to AC3-06 |
| AC4: affected staff told | Date/time: SCRUM-395 tells Venue Staff and Technical Support. Cancellation: 013's staff notices, kept in 042 | AC3-06, AC4-01; `cancelEventRequestDatabase` |
| AC5: organiser told of a change request decision | SCRUM-402's `process_change_request` (PR #95) | SCRUM-402's tests; not verifiable here (D1) |
| AC6: told of a reschedule, postponement or cancellation | Reschedule/postponement: SCRUM-395. Cancellation: `cancel_event_request` (042) | AC3-06, AC4-01, AC6-01 to AC6-03 |
| AC7: names the event and change, nothing unauthorised | Attendee payloads carry public details only; display never shows a reason | AC7-01 to AC7-06, T-01 to T-03 |

## 3. Design decisions

### D1. AC5 belongs to SCRUM-402

SCRUM-402 sends `change_request_decided` from `process_change_request` (its 036,
PR #95). 175 had its own type for this; 219 removed it.

*Rejected: two types for one decision.* The organiser would get two notices.

### D2. 042 widens the type list

042 reads the live `notifications_type_known` and adds only the types it lacks,
instead of restating the whole list. 175, 177 and 402 all change the list, so a
restated list drops whichever ran first. T-03 re-runs 042 after adding another
type and checks it survives.

*Rejected: restating the list (AGENTS.md's rule).* With three open branches, the
order they merge would decide which types exist.

### D3. The function that makes the change sends the notice

- `event_confirmed` from `confirm_event_request`, the only path into Confirmed.
- `event_venue_changed` from `notify_flagged_booking_resolved`: only for a
  different venue, and only while the event is Confirmed.
- The attendee `event_cancelled` from `cancel_event_request`.

*Rejected: a trigger on status or bookings.* It could not tell a re-confirmation
or a replacement from other writes, and has no attendee message.

### D4. Attendees hear of re-confirmations only

Registration needs a confirmed event, so nobody is registered on the first
confirmation. Attendees just promoted off the waitlist by 037's trigger are told
too: `registration_promoted` says they have a place, this says what the event now
is. So the notice is written after the status change.

### D5. Cancellation tells the waitlist too

Registered and waitlisted attendees get the coordinator's attendee message, never
the internal reason.

### D6. The reason is removed at the source

`notificationService.js` passes payloads to the client unchanged, so 042 removes
the reason from `event_significant_change_attendee` in SQL, both from new notices
and, in section 6, from rows stored before 042 (re-runnable). The display also
never shows it.

*Rejected: hiding it only in the display.* The reason would still reach the
attendee's browser.

### D7. SCRUM-220 and 221 needed no code

Date and time change only through `apply_significant_event_change` (SCRUM-395),
which already tells the organiser, registered attendees, Venue Staff
(`booking_flagged_event_change`, `booking_request_event_change`) and Technical
Support (`flag_equipment_reservations`). `edit_event_request_details` refuses
confirmed events. `release_venue_booking` (SCRUM-492) works only on Approved
events, so attendees see the new venue list on re-confirmation. Confirmed →
Completed is not in the ACs.

### D8. SCRUM-223 needed no code

A direct cancel passes the attendee message (EventCancellationPanel → route →
service → `cancel_event_request`). SCRUM-402's approval calls
`cancel_event_request` with no attendee message, so attendees get the notice
without one, and calls `apply_significant_event_change` for date changes.

## 4. Known gaps (not fixed)

| Gap | Detail |
|---|---|
| (a) No "postponed" status | A postponement is a date change, covered as rescheduling |
| (b) Ordinary-field approvals | When SCRUM-402 approves only name, description or purpose on a confirmed event, it returns to Approved and attendees are not told. Outside the ACs |
| (c) AC5 unverifiable here | Until PR #95 merges |

## 5. Verification

| Evidence | Result |
|---|---|
| SCRUM-175 suites: backend notices, backend types, frontend display | 13, 11 and 21 passed |
| With SCRUM-395 and SCRUM-489 submission suites (backend) | 4 files, 175 passed, 2 todo |
| Every backend file calling a restated function or checking `flagged_booking_resolved` | 30 files, 1,310 passed, 2 todo |
| Frontend `scrum175NotificationDisplay`, `notificationDisplay`, `notificationLink` | 3 files, 216 passed |
| Teeth checks | 9 breaks, each failing at least one named test; see the test cases |

Commands (inside `backend/` or `frontend/`): `npx vitest run <files>`. CI's
`npm run test:coverage`, lint and build are to run before pushing.

## 6. Deploy

1. Paste `backend/db/migrations/042_event_change_notification_types.sql` into the
   Supabase SQL editor and run it once. It is re-runnable (D2).
2. Tell SCRUM-402's owner (D1; their 036 and 039 widen the list the same way,
   D2) and SCRUM-395's owner (D6: attendee notices no longer carry the reason).
   A later migration that restates `notifications_type_known` whole, as AGENTS.md
   says, must include `event_confirmed` and `event_venue_changed`.
3. Redeploy the API and frontend.
