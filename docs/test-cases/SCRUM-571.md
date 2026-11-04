# SCRUM-571 — Test Cases

**Story:** Freed venues return other events' Conflicting requests to Pending — Event Coordinator
**Schema:** `038_freed_venues_return_conflicting_requests.sql`
**Status:** every case proved (27 October 2026). The review is `docs/SCRUM-571.md`.

> As an Event Coordinator whose venue request is Conflicting, I want it to go back
> to Pending when the booking it clashed with is cancelled, so that I know my
> request can still be approved.

1. **AC1:** When an event is cancelled (SCRUM-370), each other event's Conflicting
   request that clashed only with one of its approved or flagged bookings returns
   to Pending, and its coordinator is notified.
2. **AC2:** The same applies when a flagged booking is cancelled (SCRUM-266).
3. **AC3:** "Only with" uses SCRUM-492 AC4's rule: nothing else (a booking, a block
   or an active hold) still occupies the request's period.
4. **AC4:** Requests still blocked by something else stay Conflicting, and nobody
   is notified.

## Layers

| Short | File |
|---|---|
| pglite | `backend/tests/db/scrum571FreedVenuesDatabase.test.js` (real Postgres, baseline plus every migration) |
| display | `frontend/tests/services/scrum571NotificationDisplay.test.js` |
| source | `backend/tests/db/cancelFlaggedBookingDatabase.test.js` (reads the function's source) |

## Rules the cases depend on

- **The fixture.** Another event's request R (13:00-17:00) is made Conflicting by
  booking B (13:00-14:00) at the same venue. With 30 minutes' setup and 45 minutes'
  turnaround, B occupies 12:30-14:45.
- **"Freed"** means R is `pending` and R's coordinator has exactly one
  `booking_request_conflict_cleared` notice, naming B and B's event.
- **"Stays Conflicting"** means R is `conflicting` and has no such notice.
- **Both paths.** Every AC3 and AC4 case runs twice: once by cancelling B's event,
  once by cancelling B as a flagged booking. Neither path may skip the re-check.
- An expired hold never counts as a booking (AGENTS.md), even before the expiry
  job has marked it.

`%s` names are `it.each`; the variants are in brackets.

## Cases

| ID | AC | Layer | Set-up → expected | Test |
|---|---|---|---|---|
| AC1-01 | AC1 | pglite | B approved or flagged; cancel B's event → B `cancelled`, R freed | `SCRUM571_AC1_cancelling_an_event_with_%s_booking_frees_the_conflicting_request` (an_approved, a_flagged) |
| AC1-02 | AC1 | pglite | B's event has bookings at two venues, each blocking a request; cancel it → both requests freed, each notice naming its own booking | `SCRUM571_AC1_an_event_with_bookings_at_two_venues_frees_the_conflicting_requests_at_each` |
| AC1-03 (trap) | AC1 | pglite | The cancelled event's own pending and conflicting requests → `withdrawn`, not returned to Pending; no notice | `SCRUM571_AC1_the_cancelled_events_own_pending_and_conflicting_requests_are_withdrawn` |
| AC1-04 | AC1 | pglite | R's event is in the Lead's queue with no coordinator; cancel B's event → R `pending`, nobody notified | `SCRUM571_AC1_a_freed_request_with_no_coordinator_returns_to_pending_and_nobody_is_told` |
| AC1-05 (trap) | AC1, AC2 | display | The notice names the event that held the venue and says the request is pending again, without the word "released" (it now follows a cancellation too, D5) | `SCRUM571_AC1_the_conflict_cleared_notice_does_not_say_released` |
| AC2-01 | AC2 | pglite | B flagged; `cancel_flagged_booking` by B's coordinator or by Venue Staff → R freed | `SCRUM571_AC2_cancel_flagged_booking_by_%s_frees_the_conflicting_request` (the_events_coordinator, Venue_Staff) |
| AC2-02 | AC2 | pglite | B flagged; Venue Staff approve its replacement at another venue → B `cancelled`, R freed (D4) | `SCRUM571_AC2_approving_a_replacement_at_another_venue_frees_the_conflicting_request_on_the_old_slot` |
| AC2-03 (trap) | AC2 | pglite | A refused cancel: by another coordinator (42501), or of a booking that is only approved (PT409) → B unchanged, R stays Conflicting | `SCRUM571_AC2_a_refused_cancel_flagged_booking_%s_moves_nothing` (by_another_coordinator, for_a_booking_that_is_not_flagged) |
| AC3-01 (trap) | AC3 | pglite | Another event's hold over R's period has expired but is still marked active; free B → R freed | `SCRUM571_AC3_%s_frees_a_request_behind_only_an_expired_hold` (cancelling_the_event, cancelling_the_flagged_booking) |
| AC3-02 (trap) | AC3 | pglite | A second conflicting request R2 (15:30-16:30, occupying 15:00-17:15) does not overlap B's 12:30-14:45; free B → R2 stays Conflicting (only freed requests B actually blocked) | `SCRUM571_AC3_%s_leaves_a_conflicting_request_outside_setup_and_turnaround` (both paths) |
| AC4-01 (trap) | AC4 | pglite | A third event's approved booking (15:30-17:00) also occupies R's period; free B → stays Conflicting | `SCRUM571_AC4_%s_leaves_a_request_another_approved_booking_blocks` (both paths) |
| AC4-02 (trap) | AC4 | pglite | A venue block (16:00-17:00) covers part of R's period; free B → stays Conflicting | `SCRUM571_AC4_%s_leaves_a_request_a_venue_block_covers` (both paths) |
| AC4-03 (trap) | AC4 | pglite | Another event's active hold (16:00-17:00, expires in 2 days); free B → stays Conflicting | `SCRUM571_AC4_%s_leaves_a_request_another_events_active_hold_covers` (both paths) |
| D3-01 | D3 | source | `cancel_flagged_booking` locks the event, then the venue (`for no key update`), then the booking, before writing the resolution | `SCRUM266_AC3_cancelling_locks_the_event_then_the_venue_then_the_booking` (changed; was `…_then_the_booking_and_never_the_venue`) |

## Regression: the other callers of the shared function

038 moves SCRUM-492's release and SCRUM-347's rejection onto the same function
(D2). Their suites run unmodified and pass:

| Path | Tests |
|---|---|
| Release (SCRUM-492) | `SCRUM492_AC4_a_request_blocked_only_by_the_released_booking_returns_to_pending`, `SCRUM492_AC4_a_request_still_blocked_by_another_approved_booking_stays_conflicting`, `SCRUM492_AC4_a_request_still_covered_by_a_block_stays_conflicting`, `SCRUM492_AC4_a_request_still_covered_by_another_events_hold_stays_conflicting` |
| Rejection (SCRUM-347, D6) | `SCRUM347_AC4_a_rejection_returns_their_request_to_pending_and_tells_their_coordinator`, `SCRUM347_AC4_a_request_something_else_still_blocks_stays_conflicting`, `SCRUM347_AC4_cancelling_an_event_frees_them_too` |

The two SCRUM-492 display tests were updated for the new wording (D5);
their names are unchanged.

## Teeth checks (each reverted)

| Break | Fails |
|---|---|
| Remove the freeing call from `cancel_flagged_booking` | 3: both AC2-01 variants and AC3-01's flagged-cancel variant |
| Remove the occupancy re-check from the shared function | All 6 AC4 variants and 4 SCRUM-492 AC4 traps |
| Restore "released the venue" in the notice | AC1-05 |
| Run without 038 | 4: both AC2-01 variants, AC2-02 and AC3-01's flagged-cancel variant. AC1 passes because SCRUM-347's 027 already freed requests on cancellation (D1) |
