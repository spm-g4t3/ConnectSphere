# SCRUM-492 — Release One Venue from a Multi-Venue Event

**Story:** Release One Venue from a Multi-Venue Event — Event Coordinator
**Closing subtask:** SCRUM-570 (this document)
**Status as of 18 October 2026:** built and tested; all eight criteria done (section 1). The manual walkthrough (section 2) passed: all checks passed, as reported by Calven on 18 October 2026.

This document is the record of what SCRUM-492 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for the release.

The case-by-case mapping is `docs/test-cases/SCRUM-492.md`: 51 cases, each naming
the tests that prove it. It also holds the design decisions D1 to D11 in full,
with the alternatives rejected. This document cites it rather than repeating it.

**The short version, for anyone asked "what changed?":** the assigned coordinator
of an Approved event now sees a "Venue bookings" section on the event's page: each
approved booking with a Release action, and each released one with when and why.
Releasing asks for a reason, frees only that venue, and leaves the event Approved
and its other bookings as they were. Every Venue Staff member is told. Another
event's request that this booking alone had made Conflicting goes back to Pending,
and its coordinator is told. The released booking is kept, with who released it,
when and why, and the database refuses to undo it. The story does not change a
Confirmed event's venue (a significant change, SCRUM-395), resolve a flagged
booking (SCRUM-266), or withdraw a pending request (SCRUM-253): each of those is
refused here and pointed to its own action.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-563 | The test cases, written before any code: 51 cases across the eight criteria, sixteen of them traps, and the design decisions D1 to D11 | `c468c3a` |
| SCRUM-564 | The Released status (088) and its record: three columns, three constraints, and the restated trigger that keeps a release final (089) | `c468c3a` |
| SCRUM-565 | `release_venue_booking` (089), the service `releaseVenueBooking`, `POST /booking-requests/:id/release` (`coordinatorOnly`), the release fields on `/mine`, the Venue Staff notice | `c468c3a` |
| SCRUM-566 | Conflicting requests this release alone blocked return to Pending, and their coordinators are told | `c468c3a` |
| Fix-up (trigger) | Only an approved booking can become released, decided or not, refused by the trigger itself | `c468c3a` |
| SCRUM-567 | The Venue bookings section and its Release action (`EventVenueBookings.jsx`), the frontend call and its messages, the `SCRUM492_FILES` gate; the two notices' wording, brought forward into 564–566 | `0fc9ee8` (wording in `c468c3a`) |
| SCRUM-568 | Proofs of what was already built: search, the calendar, a new request, SCRUM-266's cancel and SCRUM-253's withdraw after a release (tests only) | `0fc9ee8` |
| SCRUM-569 | The sweep: every new test named `SCRUM492_ACn_…`, a teeth check on record for every criterion, the gates, every cited name checked | this commit |
| SCRUM-570 | This document | this commit |

### Verification as of 18 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | 7060 passing across 156 files (6945 across 152 before the story) |
| Frontend suite (`npm run test:coverage` in `frontend`) | 3236 passing across 137 files (3174 across 133 before); every coverage gate met; `npm run lint` 0 errors; `npm run build` passes |
| SCRUM-492's gate | `SCRUM492_FILES` in `frontend/vite.config.js`: `EventVenueBookings.jsx` at 100% statements, branches, functions and lines. `releaseErrorMessage` sits in `bookingRequestErrors.js`, already at 100% in `SCRUM254_FILES`. No backend gate: like SCRUM-489, the story adds no backend source file of its own (its edits sit in shared files), and `src/domain/bookingStatus.js`, which it extends, is already gated at 100% in `backend/vitest.config.js` |
| SCRUM-492's own tests | 175 test titles once parametrised cases are expanded, every one named `SCRUM492_ACn_…`: 113 in four backend files, 62 in four frontend files |
| PGlite | `scrum492ReleaseVenueBookingDatabase.test.js` runs 088 and 089 on a real Postgres over SCRUM-266's stack, with 077 and 078: refusals, writes, the trigger, the freed requests, and SCRUM-568's proofs |
| Live database | 088 and 089 were applied by Calven to the shared Supabase project. No live script was run by us; none covers the release (section 4) |
| Test-case document | 51 cases: **51 proved**, 0 not yet implemented, 0 that cannot be written as specified |
| Manual walkthrough | Passed: all checks passed, as reported by Calven on 18 October 2026, on the shared Supabase project (section 2) |

**Teeth checks**, one or more per criterion: each test was checked by breaking the
line it proves, watching it fail, and restoring the file.

| AC | What was broken | What failed |
|---|---|---|
| AC1 | The holder check removed from 089 (step 3); the route's `coordinatorOnly` removed; the screen's `status === "approved"` condition dropped | The 42501 refusals; every gate case; every other-status case on the page |
| AC2 | The update aimed at the event's first approved booking, not the chosen one; the screen sending the first row's id; the Released label changed | The three-bookings test; the chosen-booking test (second of three); the display test |
| AC3 | An in-memory copy of 040 counting `released` as an occupant | The occupancy, search and calendar tests, and the AC4 frees |
| AC4 | The occupancy re-check removed from 089 step 9 | The four still-blocked cases |
| AC5 | An in-memory copy of 078 treating `released` as a live request | The same-venue-again test |
| AC6 | The release-final rule disabled; the "only from approved" rule disabled; the notice sent to Leads; the notice's headline replaced | The new-reason and new-releaser cases and AC2-04; pending, conflicting and withdrawn; the Venue Staff test; the wording tests and SCRUM-172's every-type test |
| AC7 | A write to the event added to the release | The event-unchanged test |
| AC8 | `('flagged_for_review', 'cancelled')` removed from 089's restated trigger | The cancel-through-SCRUM-266 test |

---

## 1. Acceptance criteria

| AC | Criterion (quoted) | Status |
|---|---|---|
| AC1 | Only the assigned coordinator of an Approved event can release one of its approved venue bookings, giving a required reason. Anyone else, an event in any other status, or a booking that is not approved is refused with a message stating why. | **Done** |
| AC2 | Releasing sets that booking to Released. The event's other bookings are not touched and stay approved. | **Done** |
| AC3 | The venue's occupied period is free at once: it shows as available in search and on the calendar. | **Done** |
| AC4 | Pending requests for other events that were marked Conflicting only because of this booking return to Pending, and their coordinators are notified. To confirm. | **Done**, as worded; the rule (D8) awaits the team's confirmation |
| AC5 | The coordinator can then raise a new booking request for another venue (SCRUM-243). | **Done** |
| AC6 | The released booking is kept, with who released it, when and why. Bookings are never deleted. Venue Staff are notified (SCRUM-174). | **Done** |
| AC7 | Releasing a booking does not change the event's status. | **Done** |
| AC8 | A flagged booking is still resolved through SCRUM-266, and a pending request is still withdrawn through SCRUM-253. | **Done** |

**Tally:** 8 done, 0 partial, 0 deferred.

**Test cases:** 51; 51 proved.

### Evidence for each criterion

| AC | Code (file, function) | Proved by |
|---|---|---|
| AC1 | `coordinatorOnly` on `POST /:id/release` (`backend/src/routes/bookingRequests.js:184`); `validateReleaseBooking` (`backend/src/validation/bookingRequestValidation.js:332`); 089 steps 1 to 6 (`089_release_venue_booking.sql:211–291`); the page's gate (`CoordinatorRequestDetail.jsx:991`) | `SCRUM492_AC1_%s_is_refused_with_42501_and_nothing_is_written`, `SCRUM492_AC1_an_event_that_is_%s_is_refused_with_event_not_approved`, `SCRUM492_AC1_a_flagged_booking_is_refused_and_pointed_to_flagged_bookings`, `SCRUM492_AC1_a_%s_request_is_refused_and_pointed_to_withdraw`, `SCRUM492_AC1_a_reason_that_is_%s_is_refused_with_22023` (PGlite); `SCRUM492_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing`, `SCRUM492_AC1_the_caller_is_the_tokens_user_and_the_bodys_ids_are_ignored` (route); `SCRUM492_AC1_an_event_that_is_%s_offers_no_release` (screen) |
| AC2 | 089 step 7, the guarded update (`089:293–306`); 088 (`088:6`); `RELEASED` (`backend/src/domain/bookingStatus.js:30`, display at `:105`); `EventVenueBookings.jsx:157` | `SCRUM492_AC2_releasing_one_of_three_leaves_the_other_two_unchanged`, `SCRUM492_AC2_the_last_approved_booking_can_be_released_and_the_event_stays_approved`, `SCRUM492_AC2_an_undecided_approved_booking_is_released_and_stays_final` (PGlite); `SCRUM492_AC2_only_the_chosen_booking_is_sent_with_the_reason_trimmed_then_the_list_refetches` (screen) |
| AC3 | No new code: `venue_occupancy_conflicts` (040:289) counts approved and flagged only; search (`available_venue_ids`, 040:375) and the calendar (`venueCalendarService.js:269`) read it | `SCRUM492_AC3_the_released_period_has_no_occupant`, `SCRUM492_AC3_search_offers_the_released_venue_again`, `SCRUM492_AC3_the_calendars_read_shows_no_released_booking` (PGlite) |
| AC4 | 089 steps 8 and 9 (`089:308–358`): `pending_request_overlaps` (066), then `venue_occupancy_conflicts` per candidate | `SCRUM492_AC4_a_request_blocked_only_by_the_released_booking_returns_to_pending`, `SCRUM492_AC4_of_two_requests_only_the_one_nothing_else_blocks_returns_to_pending`, `SCRUM492_AC4_a_request_still_covered_by_a_block_stays_conflicting`, `SCRUM492_AC4_a_request_still_covered_by_another_events_hold_stays_conflicting` (PGlite); `SCRUM492_AC4_with_%s_returned_to_pending_the_notice_says_%s` (screen) |
| AC5 | No new code: `create_booking_request`'s live-request rule (078:374) leaves released out | `SCRUM492_AC5_after_a_release_the_same_venue_and_period_can_be_requested_again`, `SCRUM492_AC5_after_a_release_another_venue_can_be_requested` (PGlite) |
| AC6 | The columns and constraints (`089:98–121`); the trigger (`089:131–184`); the Venue Staff notice (`089:360–378`); its wording (`frontend/src/services/notificationDisplay.js:225`) | `SCRUM492_AC6_the_release_is_recorded_trimmed_with_who_and_when`, `SCRUM492_AC6_a_released_booking_cannot_be_%s`, `SCRUM492_AC6_only_an_approved_booking_can_become_released_%s`, `SCRUM492_AC6_every_venue_staff_member_is_told_and_nobody_else`, `SCRUM492_AC6_the_type_list_keeps_a_live_only_type_and_accepts_both_new_ones` (PGlite); `SCRUM492_AC6_a_released_booking_shows_when_and_why_and_no_button` (screen) |
| AC7 | Nothing in 089 writes to `event_requests` | `SCRUM492_AC7_the_event_is_unchanged_by_a_release` (PGlite) |
| AC8 | No new code: 089's refusals point to each action; 077 and 066's `withdraw_booking_request` are unchanged | `SCRUM492_AC8_a_flagged_booking_is_refused_release_and_still_cancelled_through_scrum266`, `SCRUM492_AC8_a_pending_request_is_refused_release_and_still_withdrawn_through_scrum253` (PGlite) |

---

## 2. Traceability: the release, end to end

The release crosses every layer, so it is the one walked here. **User story** →
**AC1, AC2, AC4, AC6** → **test cases** AC1-01 to AC1-15, AC2-01 to AC2-08,
AC4-01 to AC4-10, AC6-01 to AC6-08 (`docs/test-cases/SCRUM-492.md`) → **test
classes** (the files below) → **code**. Take the assigned coordinator of an
Approved event releasing one of its approved bookings.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `CoordinatorRequestDetail.jsx:991` | The section is mounted only for the holder while the event is Approved | `SCRUM492_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_it`, `SCRUM492_AC1_%s_is_not_offered_it`, `SCRUM492_AC1_an_event_that_is_%s_offers_no_release` (`scrum492CoordinatorVenueBookings.test.jsx`) |
| Screen | `EventVenueBookings.jsx:42` (`ReleaseForm`), `:149` (`handleConfirm`) | Release opens a form; Confirm stays disabled while the reason is blank; the trimmed reason is sent for that booking only; a ref keeps it to one request at a time | `SCRUM492_AC1_confirm_is_disabled_while_the_reason_is_blank`, `SCRUM492_AC2_only_the_chosen_booking_is_sent_with_the_reason_trimmed_then_the_list_refetches`, `SCRUM492_AC1_a_double_click_sends_once_and_every_release_waits` (`scrum492EventVenueBookings.test.jsx`) |
| Frontend service | `releaseVenueBooking` (`frontend/src/services/bookingRequestService.js:111`) | `POST /booking-requests/:id/release` with `{ reason }`; a refusal reaches the section unchanged | `SCRUM492_AC2_releasing_posts_the_reason_to_the_bookings_release_route`, `SCRUM492_AC1_a_refusal_reaches_the_caller_unchanged` (`scrum492BookingRequestService.test.js`) |
| Route | `POST /:id/release` (`backend/src/routes/bookingRequests.js:184`), `coordinatorOnly` (`:59`) | Every other role, a Lead and Venue Staff included, is a 403 with no query; the caller is the token's user, never the body's | `SCRUM492_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing`, `SCRUM492_AC1_the_caller_is_the_tokens_user_and_the_bodys_ids_are_ignored` (`scrum492ReleaseVenueBookingRoutes.test.js`) |
| Service | `releaseVenueBooking` (`backend/src/services/bookingRequestService.js:954`), `validateReleaseBooking` (`bookingRequestValidation.js:332`) | Caller, id and reason checked before any rpc (400 with `details`); one rpc; the answer through `toReleasedBooking` (`:922`) with `statusDisplay` and the release fields | `SCRUM492_AC1_%s_is_refused_with_400_before_any_rpc`, `SCRUM492_AC2_a_release_is_one_rpc_with_the_caller_and_the_trimmed_reason`, `SCRUM492_AC2_the_answer_is_the_released_booking_and_the_requests_returned_to_pending` (`scrum492ReleaseVenueBooking.test.js`) |
| Translator | `translateError` (`bookingRequestService.js:113`) | 42501 → 403, P0002 → 404, 22023 and 23514 → 400, 40001 → 409 `BOOKING_CHANGED` (`:139`), PT409 → 409 with the hint as `code` (`:143`) | `SCRUM492_AC1_the_functions_%s_arrives_as_its_status`, `SCRUM492_AC1_the_functions_%s_arrives_as_a_409_with_that_code` |
| SQL: checks | `release_venue_booking` (`089_release_venue_booking.sql:194`), steps 1 to 6 (`:211–291`) | Reason required; the event locked, then the venue (`for no key update`, `:264`), then the booking; the holder only (42501); Approved only (`EVENT_NOT_APPROVED`); an approved booking only (`BOOKING_NOT_APPROVED`, pointing a flag to Flagged bookings and a request to Withdraw) | The AC1 PGlite cases above (`scrum492ReleaseVenueBookingDatabase.test.js`) |
| SQL: the release | step 7 (`089:293–306`) | `status = 'released'` with who, when and the trimmed reason, guarded on `status = 'approved'`; no row is 40001 | `SCRUM492_AC1_the_assigned_coordinator_releases_an_approved_booking`, `SCRUM492_AC2_releasing_one_of_three_leaves_the_other_two_unchanged` |
| SQL: the freed requests | steps 8 and 9 (`089:308–358`) | Other events' Conflicting requests overlapping it, locked in id order; each that nothing occupies now (`venue_occupancy_conflicts`, `:331`) goes to Pending, and its coordinator is told | The AC4 PGlite cases |
| SQL: the notice | step 10 (`089:360–378`) | One `booking_released` notice per Venue Staff member | `SCRUM492_AC6_every_venue_staff_member_is_told_and_nobody_else` |
| SQL: the record | constraints (`089:98–121`), trigger (`089:131–184`) | The three columns set together, only on a released booking; once released, nothing changes; and only an approved booking can become released (`:144`) | `SCRUM492_AC6_the_constraints_refuse_%s`, `SCRUM492_AC6_a_released_booking_cannot_be_%s`, `SCRUM492_AC6_only_an_approved_booking_can_become_released_%s` |
| The page | `EventVenueBookings.jsx` | "… was released. Venue Staff have been told.", with "N other event's request is no longer blocked." when any were freed; the list refetches; Venue suitability reloads | `SCRUM492_AC4_with_%s_returned_to_pending_the_notice_says_%s`, `SCRUM492_AC2_a_release_reloads_venue_suitability_and_the_parent_and_keeps_its_notice` |

**What each refusal becomes on screen**, keyed on the status and the code, never
the server's text (`releaseErrorMessage`, `frontend/src/services/bookingRequestErrors.js:234`):

| Response | The section says | Where |
|---|---|---|
| 400 | "Give a reason of up to 1,000 characters." | On the booking |
| 401 | "Your session has expired. Please sign in again." | On the booking |
| 403 | "Only the coordinator assigned to this event can release its venues." | On the booking |
| 404 | "This booking no longer exists." | On the booking |
| 409 `EVENT_NOT_APPROVED` | "Venues can be released only while the event is Approved." | Above the list, which refetches |
| 409 `BOOKING_NOT_APPROVED` | "This booking is no longer approved. The list has been refreshed." | Above the list, which refetches |
| 409 `BOOKING_CHANGED` | "This booking changed while you were releasing it. The list has been refreshed." | Above the list, which refetches |
| Anything else | "The venue could not be released. Please try again." | On the booking (any other 409 above the list) |

Proved by `SCRUM492_AC1_%s_reads_in_the_coordinators_words`,
`SCRUM492_AC1_a_%s_is_shown_with_the_booking` and
`SCRUM492_AC1_a_409_%s_is_said_and_the_list_refetches`.

**Manual walkthrough.** Run by Calven in the browser on 18 October 2026, against
the shared Supabase project after 088 and 089 were applied, following
`scrum-492-click-through.md`, Parts 1 to 3. All checks passed, as reported by
Calven on 18 October 2026; the results were reported as a whole, not check by
check, so none is listed here. Check J (a Conflicting request back to Pending)
was optional; AC4 is proved by the PGlite tests above either way.

---

## 3. Design decisions

Each is argued in full, with the alternatives rejected, in
`docs/test-cases/SCRUM-492.md` ("Design decisions"). The summaries below point
there.

### D1. Only the assigned coordinator releases; Venue Staff cannot — **answered by the requirements**

The ticket marks it "team decision, to confirm", but `docs/requirements.md` §7
already settles it: "Venue Staff can't cancel or alter one themselves; the
Coordinator initiates" [C4 14 Sep]. The route is `coordinatorOnly`, so a Lead is
refused too, and 089 admits the event's `assigned_coordinator_id` alone.

### D2. Approved events only

Safety review, Safety approved and Confirmed are refused: a venue change there
would change what the Safety Officer reviewed, or is a significant change
(SCRUM-395). A Safety Officer asking for changes returns the event to Approved
(073), so release is there when it is needed.

### D3. Approved bookings only

A flagged booking is resolved through SCRUM-266 and a request is withdrawn
through SCRUM-253; each refusal names the right action, so neither's rules or
records are duplicated.

### D4. A new `released` status, not `cancelled`

`cancelled` is written by event cancellation and flag resolution; why a venue
stopped being held must be readable from the status alone. 088 adds the value in
a file of its own, because an enum value cannot be used in the transaction that
adds it.

### D5. The record is three columns on `bookings`

A booking is released at most once and never comes back, so who, when and why
are one-to-one with it, as the decision columns are. Neither `booking_resolutions`
nor a new table.

### D6. A release is final

089's trigger refuses any change to a released booking, and refuses a release
from any status but approved; both rules run whether or not the booking was
decided, because older approvals have `decided_at` null. The way back is a new
request (AC5).

### D7. Releasing the event's last approved booking is allowed — **open**

No criterion forbids it. The event stays Approved, and `event_readiness` then
shows "No venue booking", so it cannot reach the safety check without a new
approved booking.

### D8. AC4's rule: "only because of this booking" — **open**

Under the venue lock, every other event's Conflicting request overlapping the
released booking is asked again through `venue_occupancy_conflicts`; only those
nothing occupies now go back to Pending. Built as the ticket words it; the ticket
says "To confirm".

### D9. Who is told

Every Venue Staff member gets `booking_released`; each freed request's coordinator
gets `booking_request_conflict_cleared`. Both types are merged into the live
`notifications_type_known`, so types other branches added there are kept.

### D10. Nothing that reads bookings changes

Occupancy, search, the calendar, `create_booking_request`, `event_readiness` and
`cancel_event_request` all use allow-lists that leave `released` out, so a
released booking stops counting everywhere at once. None was restated.

### D11. Cancellation does not free Conflicting requests — **resolved by SCRUM-571 (migration 038)**

Cancelling an event or a flagged booking also frees a venue, but leaves other
events' requests Conflicting. Only a release clears them. Recorded, not fixed here;
now tracked as SCRUM-571 (backlog story, created 18 October 2026).

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| D11 | Cancelling an event (370, `cancel_event_request`) or a flagged booking (077, `cancel_flagged_booking`) frees the venue but leaves other events' Conflicting requests as they were; only a release returns them to Pending. Now tracked as SCRUM-571 (backlog story, created 18 October 2026) | Resolved by SCRUM-571 (migration 038) |
| No releaser name on the card | `/mine` carries `releasedAt` and `releaseReason` but not who released it, so a released booking reads "Released on {date}: {reason}". The name is stored (`released_by`) and shown to Venue Staff in the notice (`releasedByName`) | A later change to `/mine`, if wanted |
| Whitespace-only reasons | SQL `btrim` trims spaces only, so the database alone would accept a reason of only tabs or newlines; the service refuses any whitespace-only reason before the rpc. The same as 077 | — |
| The approve-versus-release race | An approval and a release at the same venue take turns on the venue lock (`089:264`, the lock `decide_booking_request` takes), so an approval cannot slip in between the release and AC4's check. PGlite is one connection, so two transactions never overlap and this is untested | — |
| No live script covers the release | The click-through and PGlite are the evidence | Optional |
| The type list on the live database | 089 merges its types into the live constraint, so it keeps others'. A later migration that restates a fixed list without `booking_released` and `booking_request_conflict_cleared` would drop them, and every release would then fail with 23514 while any Venue Staff member exists: the hazard SCRUM-489 met in its click-through | Whoever writes the next type-list migration (AGENTS.md) |

### Technical debt, left

- **`notifications_booking_decision_needs_booking`** (066) lists only 066's three
  decision types. 089's two notices both set `booking_id`, but the constraint does
  not require it of them; extending it would mean restating 066's list.
- **The section is not keyed on `venueVersion`.** A release bumps `venueVersion`
  to reload Venue suitability; keying the section on it would remount the section
  and lose its own "was released" notice. It is keyed on the event's id and dates.
- **AC7's PGlite proof compares the event row**, column for column. The stack has
  no status-history table (021), so "no history row" is shown by nothing in 089
  writing to `event_requests`, not by reading a history table.
- **Hard-coded migration lists in older tests.** Five tests named the statuses
  added after 027 one by one, so adding `released` meant extending each (process
  notes). The next booking status will meet them again.

### Process notes

- **Test-first:** SCRUM-563's 51 cases were written before any code; each later
  subtask marked the cases it proved.
- **Five existing tests extended, not loosened**, each still pinning every value:
  `SCRUM17_AC3_booking_statuses_match_the_sql_enum` (088 added to the files its
  helper reads, which listed only 027 and 065); the `SCRUM250` pinned status list
  (`released` appended, as SCRUM-261 appended `conflicting`);
  `bookingRequestStatusesMigration.test.js` (the enum as 027 leaves it now also
  leaves out `RELEASED`); `bookingStatusDefaultMigration.test.js` (runs 088 before
  inserting every status); `SCRUM255_returns_the_requests_with_event_venue_and_period`
  (the `/mine` row gains `releasedAt` and `releaseReason`). Each was raised and
  approved before it was changed.
- **The wording was brought forward from SCRUM-567.** SCRUM-172's
  `SCRUM172_AC6_every_known_type_has_wording` reads the latest migration's type
  list, so 089's two types needed their wording, and two fixture entries in that
  file, in the same change.
- **The trigger fix-up.** The first 089 let a direct `pending → released` update
  through on an undecided booking, because the trigger returns early for those.
  The release came only from the function, but the answer for an examiner should
  be "the database refuses it". The trigger now refuses a release from any status
  but approved, decided or not.
- **Flaky timeouts under load:** `SCRUM484_AC6_latest_block_definitions_supersede_013_to_015`,
  `SCRUM15_AC2_the_javascript_roles_match_the_sql_enum` and, during SCRUM-569's
  docs-only run, `SCRUM258_AC3_075_is_the_latest_definition_of_cancel_event_request_and_event_readiness`
  each timed out once in a full backend run and passed alone and in the next full run; a frontend
  `SCRUM172_AC7` scroll test failed once the same way. None touches this story's code.
- **PR review, fixed and deferred:** fixed: a 409 `EVENT_NOT_APPROVED` or a 403 from
  Release now also tells the page the event is stale (`onStale`, as
  SafetyCheckSubmissionPanel does), and Released has its own status class rather than
  unknown's. Deferred: the textarea's `maxLength` counts the untrimmed text in UTF-16
  units while the counter counts trimmed code points, which can only be stricter than
  the server (FlaggedBookingReasonForm does the same); cancellation leaving requests
  Conflicting is D11, resolved by SCRUM-571 (migration 038); `/mine` erroring before 089 runs is a deploy order note, and 089 is already
  live.
- **Briefs corrected by the code:** the enum test did not read every migration;
  the calendar has no status filter of its own; the search suite stops at 033, so
  the search proof lives in this story's PGlite suite; the list mapper needs
  embedded rows, so the release answer uses `toDecidedBookingRequest`.

---

## 5. Open questions for the team

1. **Releasing the last approved booking (D7).** Should a coordinator be allowed to
   leave an Approved event with no venue? **Open**; built as allowed.
2. **AC4's rule (D8).** Is "nothing else occupies its period now" the right reading
   of "only because of this booking"? **Open**; the ticket says "To confirm".
3. **Cancellation and Conflicting requests (D11).** Should cancelling an event or a
   flagged booking also return the requests it frees to Pending? **Resolved** by SCRUM-571 (migration 038).
4. **Venue Staff cannot release (D1).** **Decided** by requirements §7 [C4 14 Sep].

---

## Before the examination

- **Be ready for "why Released, and not Cancelled?"** D4: `cancelled` already means
  two things (the event was called off; a flagged booking was resolved), and a
  third would make the status unreadable without other tables. Released says the
  coordinator gave the venue up while the event goes ahead. Evidence: 088, and
  `SCRUM492_AC2_released_is_a_booking_status_last_in_the_enum_order`.
- **Be ready for "why only the coordinator?"** D1: requirements §7 [C4 14 Sep]
  says the Coordinator initiates venue changes and Venue Staff cannot cancel one
  themselves. The gate is twice: `coordinatorOnly` on the route, and the holder
  check inside 089 (step 3), which refuses a Lead, Venue Staff and a null caller
  with 42501. Evidence: `SCRUM492_AC1_%s_is_refused_with_42501_and_nothing_is_written`
  and `SCRUM492_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing`.
- **Be ready for "how do you decide 'only because of this booking'?"** D8: nothing
  records which booking made a request Conflicting, so 089 asks the question again.
  For each overlapping Conflicting request, it calls the same
  `venue_occupancy_conflicts` approval uses; empty means nothing else blocks it.
  Evidence: `SCRUM492_AC4_of_two_requests_only_the_one_nothing_else_blocks_returns_to_pending`,
  and the block and hold cases.
- **Be ready for "what stops a release being undone?"** D6: the trigger, not the
  function. Once `released_at` is set, any status change or change to the release
  columns is refused with 42501; and nothing but an approved booking can become
  released, decided or not. The constraints keep the three columns together.
  Evidence: `SCRUM492_AC6_a_released_booking_cannot_be_%s` and
  `SCRUM492_AC6_only_an_approved_booking_can_become_released_%s`.
- **Be ready for "why didn't `create_booking_request` change?"** D10: its
  one-live-request rule (078:374) and the occupancy check (040:289) are allow-lists
  that leave `released` out, so the coordinator can ask for the same venue again at
  once. Evidence: `SCRUM492_AC5_after_a_release_the_same_venue_and_period_can_be_requested_again`.
- **Be ready for "what if Venue Staff approve another request at that venue at the
  same moment?"** The venue lock: the release takes it (`for no key update`) before
  touching the booking, as an approval does, so the two take turns and the freed
  requests are judged against what is really there. PGlite cannot run two
  transactions at once, so this is argued, not tested (section 4).
- **Be ready for "can it break a Confirmed event?"** D2: the release is refused
  unless the event is Approved (`EVENT_NOT_APPROVED`), and the event's status never
  changes (AC7). Evidence: `SCRUM492_AC1_an_event_that_is_%s_is_refused_with_event_not_approved`
  and `SCRUM492_AC7_the_event_is_unchanged_by_a_release`.
