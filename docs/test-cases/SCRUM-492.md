# SCRUM-492 — Test Cases

**Story:** Release One Venue from a Multi-Venue Event — Event Coordinator
**Subtask:** SCRUM-563 (this document)
**Schema:** `088_booking_released_status.sql` and `089_release_venue_booking.sql` (SCRUM-564 to SCRUM-566), after SCRUM-266's 076 to 078.
**Status:** complete as of 18 October 2026 (SCRUM-569's sweep): **51 of 51 cases proved**, 0 not yet implemented, 0 that cannot be written. The review is `docs/SCRUM-492.md`.
**Written:** 18 October 2026, **before the code.** Every case describes what will be built. None is implemented yet; each **Implemented by** says so, and the subtask that writes its tests fills it in.
**Marked:** 18 October 2026, SCRUM-564 to SCRUM-566: every case their tests prove names them. The cases themselves are unchanged.
**Marked:** 18 October 2026, the trigger fix-up: AC6-02 widened to a release from any status but approved; D6 says so.
**Marked:** 18 October 2026, SCRUM-567 and SCRUM-568: the screen's cases and the proofs of what was already built (AC3-02, AC3-03, AC5, AC8-03, AC8-04).

This document is the written layer between SCRUM-492's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**. It is also where this story's decisions are
argued, with the alternatives rejected: the code's comments say why in a line or
two and point here (AGENTS.md).

---

## How case IDs relate to test names

Each case has a short stable ID (`AC4-02`) and an **Implemented by** column naming
every test that proves it. New tests are named `SCRUM492_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum492ReleaseVenueBookingDatabase.test.js` | What the database does: the refusals and their SQLSTATEs, what is written and what is not, the trigger, the conflicting requests freed; and (SCRUM-568) search, the calendar, a new request, 266's cancel and 253's withdraw after a release |
| svc | `backend/tests/services/scrum492…` (fake client) | What the service refuses before the database, and how each SQLSTATE and hint becomes an error |
| route | `backend/tests/routes/scrum492…` (fake client) | The gate, status codes, the caller from the token, the body |
| domain | `backend/tests/domain/…` | The Released status and its display |
| display | `frontend/tests/services/scrum492NotificationDisplay.test.js`, `scrum492BookingRequestService.test.js` | The two notices' wording, brought forward from SCRUM-567 because SCRUM-172's every-type test reads 089's list |
| screen | `frontend/tests/components/scrum492EventVenueBookings.test.jsx`, `scrum492CoordinatorVenueBookings.test.jsx` | What the coordinator sees (SCRUM-567) |

Which subtask writes each: SCRUM-564 (AC2's status, AC6's record and the trigger),
SCRUM-565 (AC1, AC2, AC6's notice, AC7), SCRUM-566 (AC4), SCRUM-567 (every screen
case), SCRUM-568 (AC3's search and calendar, AC5, AC8), SCRUM-569 (anything still
open).

---

## The story

> **USER STORY:** As an Event Coordinator, I want to release one of my event's
> venues without touching the others, so that a venue I no longer need is free
> for other events.

### Acceptance criteria

Quoted from the ticket.

1. Only the assigned coordinator of an Approved event can release one of its
   approved venue bookings, giving a required reason. Anyone else, an event in any
   other status, or a booking that is not approved is refused with a message
   stating why.
2. Releasing sets that booking to Released. The event's other bookings are not
   touched and stay approved.
3. The venue's occupied period is free at once: it shows as available in search
   and on the calendar.
4. Pending requests for other events that were marked Conflicting only because of
   this booking return to Pending, and their coordinators are notified. To
   confirm.
5. The coordinator can then raise a new booking request for another venue
   (SCRUM-243).
6. The released booking is kept, with who released it, when and why. Bookings are
   never deleted. Venue Staff are notified (SCRUM-174).
7. Releasing a booking does not change the event's status.
8. A flagged booking is still resolved through SCRUM-266, and a pending request is
   still withdrawn through SCRUM-253.

### Design decisions, from the ticket

- Approved events only. After confirmation, changing a venue is a significant
  change (SCRUM-395), so this action is not offered on a Confirmed event. (D2.)
- The venue is the event's own choice, so the action is the coordinator's and not
  Venue Staff's. Team decision, to confirm. (D1.)
- Technical note: add Released to the booking statuses and to the conflict rules,
  so a released booking never blocks. (D4, D10.)

---

## Design decisions

### D1. Only the assigned coordinator releases; Venue Staff cannot

Week 7 change 3 gives the action to the coordinator, and `docs/requirements.md` §7
settles who may change a booked venue: "Venue Staff can't cancel or alter one
themselves; the Coordinator initiates" [C4 14 Sep]. `release_venue_booking` admits
the event's `assigned_coordinator_id` and nobody else, a null caller refused
explicitly (018), and the route is `coordinatorOnly`, so a Lead is refused too.

*Rejected: letting Venue Staff release.* They approve or reject requests;
cancelling an approved one on the coordinator's behalf contradicts C4. (SCRUM-266
lets Venue Staff cancel a *flagged* booking, which is a different thing: a venue
change Venue Staff caused.)

### D2. Approved events only

An event in Safety review, Safety approved or Confirmed is refused (PT409
`EVENT_NOT_APPROVED`, naming the status). After confirmation a venue change is a
significant change (SCRUM-395). In a safety status it would change what the Safety
Officer is reviewing or has approved. When the Safety Officer asks for changes the
event returns to Approved (073), so release is available exactly when it is
needed. Every other status (draft to pending clarification, completed, rejected,
cancelled) has no approved booking to release in practice, and is refused the same
way.

*Rejected: allowing it in the safety statuses.* The approval would then cover a
venue the event no longer has.

### D3. Approved bookings only

A flagged booking is resolved through SCRUM-266 (`cancel_flagged_booking`, 077),
which records the flag it resolves. A pending or conflicting request is withdrawn
through SCRUM-253 (`withdraw_booking_request`). Each refusal is PT409
`BOOKING_NOT_APPROVED`, and its message names the right route: "resolve it from
Flagged bookings", or "withdraw it instead". Released, cancelled, rejected and
withdrawn bookings hold nothing to release.

*Rejected: one action for every live booking.* It would duplicate 266's and 253's
rules and records, and a flagged booking released here would lose its resolution
record.

### D4. A new `released` status, not `cancelled`

`cancelled` is what event cancellation (370) and flag resolution (077) write. Why a
venue stopped being held must be readable from the status: the coordinator chose
to give it up, while the event goes ahead. 088 appends `released` to
`booking_status`, alone, because an enum value cannot be used in the transaction
that adds it (065's reason).

*Rejected: reusing `cancelled`.* A cancelled booking would then mean three
different things, told apart only by which other table has a row.

### D5. The record is three columns on `bookings`

`released_by`, `released_at` and `release_reason`, set together and only on a
released booking (constraints `bookings_release_paired`,
`bookings_release_matches_status`, `bookings_release_reason_length`). A booking is
released at most once and never comes back (D6), so the record is one-to-one with
the booking, as the decision columns (066) are.

*Rejected: `booking_resolutions` (076).* It records flag resolutions, copies the
flag's columns, and its outcome check would have to be restated. *Rejected: a
`booking_releases` table.* A join for a one-to-one fact.

### D6. A release is final

`refuse_decided_booking_change()` (076's trigger function, restated in 089) allows
`approved → released`, and nothing out of `released`. Once `released_at` is set,
any change to the release columns, or any status change, is refused (42501); and a
booking in any status but `approved` cannot become `released` (42501), so the
database refuses a release from pending, conflicting or withdrawn, not only the
function. Both rules run before the trigger's "undecided rows pass" return, because
an approved booking need not be decided: approvals older than 066, and rows the live check
scripts insert as approved, have `decided_at` null. A coordinator who wants the
venue back raises a new request (AC5).

### D7. Releasing the event's last approved booking is allowed

The title says multi-venue, but no criterion forbids it. The event stays Approved
(AC7). `event_readiness` (075) then shows "No venue booking", so the event cannot
reach the safety check until a new booking is approved.

*Rejected: refusing the last booking.* It would force a coordinator to keep a venue
they do not want. Team question (open question 2).

### D8. AC4's rule: "only because of this booking"

After the release, under the venue lock (`for no key update`, as
`decide_booking_request` step 5 takes it), take every other event's request at the
same venue whose padded period overlaps the released booking's
(`pending_request_overlaps`, 066), filtered to `conflicting` and locked in id order
(078 step 12's order). For each, ask `venue_occupancy_conflicts` (040) for its own
period, padded, with its own event's holds excluded. If nothing occupies it now, it
goes back to `pending` and its coordinator is told. If anything still does (another
approved or flagged booking, a block, another event's active hold), it stays
Conflicting. The venue lock is the one approval takes, so an approval cannot race
the check.

*Rejected: reverting every overlapping conflicting request.* Wrong when another
booking still blocks it. *Rejected: storing which booking made a request
conflicting.* 066 does not, and the occupancy check already answers the question.
The ticket says "To confirm": built as worded, team to confirm (open question 3).

### D9. Who is told

Every Venue Staff member gets `booking_released` (AC6): one notice per
`profiles.role = 'venue_staff'`, the pattern 052 uses for Leads. This does not wait
for SCRUM-174 (PR #69, not merged): Venue Staff already have an inbox, mounted on
their dashboard by SCRUM-172. Each coordinator whose request D8 frees gets
`booking_request_conflict_cleared`. Both types are added to
`notifications_type_known` by reading the live constraint and adding ours (076's
pattern), so types other branches added on the live database are kept.

### D10. Nothing that reads bookings changes

Every reader uses an allow-list of statuses, and none includes `released`, so a
released booking stops counting everywhere at once (AC3, AC5):

- occupancy: `venue_occupancy_conflicts` (040:289) counts `approved` and
  `flagged_for_review` only; venue search (`available_venue_ids`, used by
  `venueService.js`) and the calendar (`venueCalendarService.js`) both read it;
- creating a request: `create_booking_request`'s one-live-request rule (078:374)
  is `pending`, `conflicting`, `approved`, `flagged_for_review`;
- readiness and cancellation: `event_readiness` (075:281) and
  `cancel_event_request` (075:106) use the same live set.

So 492 restates none of them.

### D11. A gap noted, not fixed

Cancelling an event (370) or a flagged booking (077) also frees a venue, but leaves
other events' requests Conflicting. After 492 only a release clears them. Open
question 4; now tracked as SCRUM-571 (backlog story, created 18 October 2026).

---

## Case tables

### AC1 — only the assigned coordinator, only an Approved event, only an approved booking

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | An Approved event held by A, with an approved booking | A releases it with a reason | Allowed (AC2 and AC6 say what is written) | Proved (pglite): `SCRUM492_AC1_the_assigned_coordinator_releases_an_approved_booking` |
| AC1-02 **(trap)** | The same | Another coordinator, a Lead, Venue Staff, the organiser, a null caller release it | 42501 "only the coordinator assigned to event request … can release its venue bookings" | Proved (pglite): `SCRUM492_AC1_%s_is_refused_with_42501_and_nothing_is_written` (another coordinator, a Lead, Venue Staff, the organiser, a user with no profile, a null caller) |
| AC1-03 **(trap)** | An approved booking on an event held by A, in each status but Approved: safety review, safety approved, confirmed, and the others | A releases it | PT409 `EVENT_NOT_APPROVED`, the message naming the status | Proved (pglite): `SCRUM492_AC1_an_event_that_is_%s_is_refused_with_event_not_approved` (all ten other statuses) |
| AC1-04 **(trap)** | A flagged booking | A releases it | PT409 `BOOKING_NOT_APPROVED`, the message pointing to Flagged bookings (SCRUM-266) | Proved (pglite): `SCRUM492_AC1_a_flagged_booking_is_refused_and_pointed_to_flagged_bookings` |
| AC1-05 **(trap)** | A pending request; a conflicting request | A releases it | PT409 `BOOKING_NOT_APPROVED`, the message pointing to Withdraw (SCRUM-253) | Proved (pglite): `SCRUM492_AC1_a_%s_request_is_refused_and_pointed_to_withdraw` |
| AC1-06 | A released, a cancelled, a rejected, a withdrawn booking | A releases it | PT409 `BOOKING_NOT_APPROVED`, naming its status | Proved (pglite): `SCRUM492_AC1_a_%s_booking_is_refused_naming_its_status` |
| AC1-07 **(trap)** | — | The reason is null, empty, or only whitespace | 22023 (400) | Proved (pglite): `SCRUM492_AC1_a_reason_that_is_%s_is_refused_with_22023` (null, empty, spaces); (svc) `SCRUM492_AC1_%s_is_refused_with_400_before_any_rpc` (any whitespace) |
| AC1-08 | — | A reason of 1,000 characters after trimming; of 1,001 | Accepted; refused 23514 (400) | Proved (pglite): `SCRUM492_AC1_a_reason_of_1001_characters_is_refused_with_23514_and_1000_is_accepted`; (svc) `SCRUM492_AC2_a_release_is_one_rpc_with_the_caller_and_the_trimmed_reason` |
| AC1-09 | — | No such booking | P0002 (404) | Proved (pglite): `SCRUM492_AC1_an_unknown_booking_is_refused_with_p0002` |
| AC1-10 **(trap)** | After every refusal in AC1-02 to AC1-09 | Read the booking, the event's other bookings, the event and the notifications | Unchanged: nothing written, no notification | Proved (pglite): every refusal above compares a snapshot of the event, its bookings and the notification count before and after |
| AC1-11 | A Lead, Venue Staff, every other role; no token | `POST /booking-requests/:id/release` | 403 from `coordinatorOnly`, nothing queried; 401 without a token | Proved (route): `SCRUM492_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing`, `SCRUM492_AC1_the_release_answers_401_without_a_token` |
| AC1-12 **(trap)** | A coordinator | The body carries `coordinatorId` or `releasedBy` | The caller is the token's user; the body's ids are ignored | Proved (route): `SCRUM492_AC1_the_caller_is_the_tokens_user_and_the_bodys_ids_are_ignored` |
| AC1-13 | — | A malformed id; a missing, blank, non-text or over-long reason | 400 from the service, no rpc | Proved (svc): `SCRUM492_AC1_%s_is_refused_with_400_before_any_rpc`, `SCRUM492_AC1_an_input_of_%j_is_refused_with_400_before_any_rpc`; (route) `SCRUM492_AC1_%s_is_400_and_queries_nothing` |
| AC1-14 | — | The function answers PT409 with each hint; 40001 | 409 with `code` `EVENT_NOT_APPROVED`, `BOOKING_NOT_APPROVED`; 409 `BOOKING_CHANGED` | Proved (svc): `SCRUM492_AC1_the_functions_%s_arrives_as_a_409_with_that_code`, `SCRUM492_AC1_the_functions_%s_arrives_as_its_status`; (route) `SCRUM492_AC1_a_%s_refusal_is_a_409_with_its_code`, `SCRUM492_AC1_the_functions_%s_is_a_%s` |
| AC1-15 | The coordinator's event page | Open it as A while Approved; as a Lead; as B; in other statuses; on a booking that is not approved | Release offered only to A, only while Approved, only on an approved booking (a convenience: AC1-02 to AC1-06 are the gate) | Proved (screen): `SCRUM492_AC1_the_assigned_coordinator_of_an_approved_event_is_offered_it`, `SCRUM492_AC1_%s_is_not_offered_it`, `SCRUM492_AC1_an_event_that_is_%s_offers_no_release` (the page); `SCRUM492_AC2_lists_this_events_approved_and_released_bookings_in_the_servers_order`, `SCRUM492_AC6_a_released_booking_shows_when_and_why_and_no_button` (only an approved booking has the button); `SCRUM492_AC1_confirm_is_disabled_while_the_reason_is_blank`, `SCRUM492_AC1_a_%s_is_shown_with_the_booking`, `SCRUM492_AC1_a_409_%s_is_said_and_the_list_refetches`, `SCRUM492_AC1_a_double_click_sends_once_and_every_release_waits`; (display) `SCRUM492_AC1_%s_reads_in_the_coordinators_words` |

### AC2 — the booking becomes Released; the others stay approved

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 **(trap)** | An event with three approved bookings at three venues | A releases one | The other two are unchanged, column for column (status, decision columns, times) | Proved (pglite): `SCRUM492_AC2_releasing_one_of_three_leaves_the_other_two_unchanged` |
| AC2-02 | An approved, decided booking | A releases it | Status `released`; `decided_by`, `decided_at`, `decision_reason` unchanged | Proved (pglite): `SCRUM492_AC2_releasing_one_of_three_leaves_the_other_two_unchanged` |
| AC2-03 **(trap)** | The event's only approved booking | A releases it | Allowed (D7); the event stays Approved | Proved (pglite): `SCRUM492_AC2_the_last_approved_booking_can_be_released_and_the_event_stays_approved` |
| AC2-04 **(trap)** | An approved booking with `decided_at` null (older than 066, or written directly) | A releases it | Released; and final, as AC6-02 | Proved (pglite): `SCRUM492_AC2_an_undecided_approved_booking_is_released_and_stays_final` |
| AC2-05 | — | `BOOKING_STATUS`, its display | `RELEASED: 'released'`, last, matching the enum after 088; label "Released", group `RELEASED` | Proved (domain): `SCRUM492_AC2_released_is_a_booking_status_last_in_the_enum_order`, `SCRUM492_AC2_released_reads_as_released_in_its_own_group`, `SCRUM17_AC3_booking_statuses_match_the_sql_enum` |
| AC2-06 | A release | The API's answer | 200 with `booking` (camelCase, `statusDisplay` "Released", the release fields) and `returnedToPending` | Proved (svc): `SCRUM492_AC2_the_answer_is_the_released_booking_and_the_requests_returned_to_pending`, `SCRUM492_AC2_%s_is_an_error_not_a_success`; (route) `SCRUM492_AC2_the_holder_releases_and_gets_the_booking_and_the_requests_returned_to_pending` |
| AC2-07 | A released booking | `GET /booking-requests/mine` | The row carries `releasedAt` and `releaseReason` | Proved (route): `SCRUM492_AC2_a_released_booking_in_the_list_carries_when_and_why` |
| AC2-08 | The coordinator's event page | After a release | The booking shows Released; the others are unchanged | Proved (screen): `SCRUM492_AC2_only_the_chosen_booking_is_sent_with_the_reason_trimmed_then_the_list_refetches`, `SCRUM492_AC2_a_release_reloads_venue_suitability_and_the_parent_and_keeps_its_notice` |

### AC3 — the occupied period is free at once

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | An approved booking, released | `venue_occupancy_conflicts` for its period | No booking row: nothing occupies it | Proved (pglite): `SCRUM492_AC3_the_released_period_has_no_occupant` |
| AC3-02 | The same | Venue search for the period | The venue is available | Proved (pglite): `SCRUM492_AC3_search_offers_the_released_venue_again` (`available_venue_ids`, which venue search calls) |
| AC3-03 | The same | The venue calendar for the day | The released booking is not shown as booked | Proved (pglite): `SCRUM492_AC3_the_calendars_read_shows_no_released_booking` (the calendar's own unpadded read); SCRUM-178's `SCRUM178_AC3_bookings_query_is_an_allow_list_of_approved_and_flagged` pins that the calendar reads bookings only through it |

### AC4 — Conflicting requests freed by this release return to Pending

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 **(trap)** | Event E's request at the venue, overlapping, marked Conflicting by this booking's approval; nothing else occupies its period | A releases the booking | E's request is `pending`; one `booking_request_conflict_cleared` notice to E's coordinator, naming the released booking; its id in `returnedToPending` | Proved (pglite): `SCRUM492_AC4_a_request_blocked_only_by_the_released_booking_returns_to_pending`, `SCRUM492_AC4_of_two_requests_only_the_one_nothing_else_blocks_returns_to_pending`; (svc) `SCRUM492_AC4_an_answer_with_no_list_returns_none_to_pending` |
| AC4-02 **(trap)** | As AC4-01, and another event's approved booking also occupies E's period | A releases | E's request stays `conflicting`; no notice | Proved (pglite): `SCRUM492_AC4_a_request_still_blocked_by_another_approved_booking_stays_conflicting`, `SCRUM492_AC4_of_two_requests_only_the_one_nothing_else_blocks_returns_to_pending` |
| AC4-03 | As AC4-01, and a venue block covers E's period | A releases | Stays `conflicting`; no notice | Proved (pglite): `SCRUM492_AC4_a_request_still_covered_by_a_block_stays_conflicting` |
| AC4-04 | As AC4-01, and another event's active hold covers E's period | A releases | Stays `conflicting`; no notice | Proved (pglite): `SCRUM492_AC4_a_request_still_covered_by_another_events_hold_stays_conflicting` |
| AC4-05 | A conflicting request at a different venue | A releases | Untouched | Proved (pglite): `SCRUM492_AC4_a_conflicting_request_%s_is_untouched` (at a different venue) |
| AC4-06 | A conflicting request at the same venue whose period does not overlap the released one | A releases | Untouched | Proved (pglite): `SCRUM492_AC4_a_conflicting_request_%s_is_untouched` (same venue, no overlap) |
| AC4-07 | A pending request overlapping the released booking | A releases | Still `pending`; no notice | Proved (pglite): `SCRUM492_AC4_a_pending_request_is_untouched` |
| AC4-08 | As AC4-01, E has no coordinator | A releases | `pending`; no notice | Proved (pglite): `SCRUM492_AC4_a_freed_request_with_no_coordinator_returns_to_pending_and_nobody_is_told` |
| AC4-09 | A request AC4-01 returned to Pending | Venue Staff approve it | Approved: nothing occupies it | Proved (pglite): `SCRUM492_AC4_a_freed_request_can_then_be_approved` |
| AC4-10 | A `booking_request_conflict_cleared` notice | The coordinator's notifications | Shown in words | Proved (display): `SCRUM492_AC4_says_the_request_is_pending_again_and_which_event_released_the_venue`, `SCRUM492_AC4_with_no_released_event_name_it_says_another_event_instead`; SCRUM-172's `SCRUM172_AC6_every_known_type_has_wording` |

### AC5 — a new request can follow

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | A released booking at venue V | A raises a new request for V, same period | Created, pending: the released booking is not a live request (D10) | Proved (pglite): `SCRUM492_AC5_after_a_release_the_same_venue_and_period_can_be_requested_again` |
| AC5-02 | The same | A raises a request for another venue | Created, pending | Proved (pglite): `SCRUM492_AC5_after_a_release_another_venue_can_be_requested` |

### AC6 — the record is kept; Venue Staff are told

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 | A release with "  Moving to Hall B  " | Read the booking | `released_by` A, `released_at` set, `release_reason` "Moving to Hall B" (trimmed) | Proved (pglite): `SCRUM492_AC6_the_release_is_recorded_trimmed_with_who_and_when` |
| AC6-02 **(trap)** | A released booking, decided or not; a pending, conflicting, withdrawn or rejected one | Update its status back to `approved`, or to anything; change any release column; clear them; write `released` with the three columns onto a booking that is not approved | Refused, 42501; the row unchanged | Proved (pglite): `SCRUM492_AC6_a_released_booking_cannot_be_%s`, `SCRUM492_AC2_an_undecided_approved_booking_is_released_and_stays_final`, `SCRUM492_AC6_only_an_approved_booking_can_become_released_%s` |
| AC6-03 | — | Write a released status without the columns, the columns without the status, a reason with spaces around it, or of 1,001 characters | Refused by the constraints (23514) | Proved (pglite): `SCRUM492_AC6_the_constraints_refuse_%s` |
| AC6-04 | A release | Count the bookings | The released booking is still there: nothing is deleted | Proved (pglite): `SCRUM492_AC6_the_release_is_recorded_trimmed_with_who_and_when` (the booking count is unchanged) |
| AC6-05 **(trap)** | Two Venue Staff, a Lead, other coordinators | A releases | One `booking_released` notice to each Venue Staff member, none to anyone else; the payload names the event, venue, period, who and why | Proved (pglite): `SCRUM492_AC6_every_venue_staff_member_is_told_and_nobody_else` |
| AC6-06 **(trap)** | The live list holds a type no dev migration adds (`booking_request_submitted`, SCRUM-174's) | Apply 089 | `booking_released`, `booking_request_conflict_cleared` and that type are all allowed | Proved (pglite): `SCRUM492_AC6_the_type_list_keeps_a_live_only_type_and_accepts_both_new_ones` |
| AC6-07 | 088 and 089 applied | Apply each again | No error; one function, one trigger, one constraint of each name | Proved (pglite): `SCRUM492_AC6_088_and_089_are_safe_to_run_twice` |
| AC6-08 | A `booking_released` notice | Venue Staff's inbox | Shown in words | Proved (display): `SCRUM492_AC6_names_the_venue_the_event_the_period_who_and_why`, `SCRUM492_AC6_with_no_payload_it_still_reads_as_a_release`; SCRUM-172's `SCRUM172_AC6_every_known_type_has_wording` |

### AC7 — the event's status does not change

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 **(trap)** | An Approved event | A releases one of its bookings, or its last | The event is still Approved; no status history row is written | Proved (pglite): `SCRUM492_AC7_the_event_is_unchanged_by_a_release`, `SCRUM492_AC2_the_last_approved_booking_can_be_released_and_the_event_stays_approved`. This stack has no status history table (021); 089 writes nothing to event_requests |

### AC8 — flagged and pending are still handled where they were

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | A flagged booking | Release it | Refused (AC1-04) | Proved (pglite): `SCRUM492_AC1_a_flagged_booking_is_refused_and_pointed_to_flagged_bookings` |
| AC8-02 | A pending request | Release it | Refused (AC1-05) | Proved (pglite): `SCRUM492_AC1_a_%s_request_is_refused_and_pointed_to_withdraw` |
| AC8-03 | A flagged booking | `cancel_flagged_booking` | Still cancels it, as SCRUM-266 built it | Proved (pglite): `SCRUM492_AC8_a_flagged_booking_is_refused_release_and_still_cancelled_through_scrum266` |
| AC8-04 | A pending request | `withdraw_booking_request` | Still withdraws it, as SCRUM-253 built it | Proved (pglite): `SCRUM492_AC8_a_pending_request_is_refused_release_and_still_withdrawn_through_scrum253` |

---

## Open questions

1. **Venue Staff cannot release (D1).** The ticket's design decision, "team
   decision, to confirm"; requirements §7 [C4 14 Sep] supports it.
2. **Releasing the last approved booking is allowed (D7).** Team to confirm.
3. **AC4's rule (D8).** The ticket says "To confirm"; built as worded.
4. **Cancellation does not free Conflicting requests (D11).** Should event
   cancellation (370) and flagged-booking cancellation (077) also return the
   requests they free to Pending? Now tracked as SCRUM-571 (backlog story, created 18 October 2026).

---

## What cannot be tested as written

- **The approve-versus-release race.** An approval and a release at the same venue
  take turns on the venue lock, so an approval cannot slip in between the release
  and AC4's check. PGlite is one connection, so two transactions never overlap.

---

## Tally

51 cases, counted from the tables: 0 proved; 51 not yet implemented (ten of them,
AC1-15, AC2-08, AC3-02, AC3-03, AC4-10, AC5-01, AC5-02, AC6-08, AC8-03 and AC8-04,
marked for SCRUM-567 or SCRUM-568); 0 that cannot be written as specified. Sixteen
are traps. After SCRUM-564 to SCRUM-566: **41 proved**; 10 not yet
implemented (the same ten, for SCRUM-567 and SCRUM-568). Then AC4-10 and AC6-08's
wording was brought forward (SCRUM-172's every-type test needs it): **43 proved**; 8
not yet implemented (AC1-15, AC2-08, AC3-02, AC3-03, AC5-01, AC5-02, AC8-03, AC8-04). After SCRUM-567 and
SCRUM-568: **51 proved**; 0 not yet implemented; 0 that cannot be written.

| Section | Cases |
|---|---|
| AC1 | 15 |
| AC2 | 8 |
| AC3 | 3 |
| AC4 | 10 |
| AC5 | 2 |
| AC6 | 8 |
| AC7 | 1 |
| AC8 | 4 |
