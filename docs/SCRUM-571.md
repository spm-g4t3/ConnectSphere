# SCRUM-571 — Freed Venues Return Conflicting Requests to Pending

**Story:** As an Event Coordinator whose venue request is Conflicting, I want it to
go back to Pending when the booking it clashed with is cancelled, so that I know my
request can still be approved.
**Origin:** D11 in SCRUM-492's review: only a release freed Conflicting requests.
**Status as of 27 October 2026:** built and tested; all four criteria met. 038 is
not yet applied on the shared Supabase project.
**Test cases:** `docs/test-cases/SCRUM-571.md` (14 cases, 8 of them traps).

**The short version:** whenever a booking stops occupying its venue (released, its
event cancelled or rejected, or, if flagged, cancelled or replaced), other events'
Conflicting requests it alone blocked go back to Pending, and their coordinators
are told. One shared SQL function does this for every path, under the venue lock.

---

## 1. Delivered

| Sub-task | Delivered | Commit |
|---|---|---|
| ST1 | Migration 038: `return_freed_conflicting_requests`, and the four functions that now call it. The PGlite suite. The SCRUM-266 lock-order test changed (D3) | `702f7ab` |
| ST2 | The `booking_request_conflict_cleared` notice says "no longer holds the venue" (D5). Its display test; SCRUM-492's two display tests updated to the new wording | `1e17a9a` |
| ST3 | This review and the test-case document; D11 in `docs/SCRUM-492.md` marked resolved | not yet committed |

## 2. Acceptance criteria

| AC | Met | Proved by |
|---|---|---|
| AC1: cancelling an event frees requests | Yes | AC1-01 to AC1-05: `SCRUM571_AC1_cancelling_an_event_with_%s_booking_frees_the_conflicting_request`, `…_an_event_with_bookings_at_two_venues_…`, `…_the_cancelled_events_own_pending_and_conflicting_requests_are_withdrawn`, `…_a_freed_request_with_no_coordinator_…`, `SCRUM571_AC1_the_conflict_cleared_notice_does_not_say_released` |
| AC2: cancelling a flagged booking frees requests | Yes | AC2-01 to AC2-03: `SCRUM571_AC2_cancel_flagged_booking_by_%s_frees_the_conflicting_request`, `…_approving_a_replacement_at_another_venue_…`, `…_a_refused_cancel_flagged_booking_%s_moves_nothing` |
| AC3: "only with" is SCRUM-492 AC4's rule | Yes | AC3-01, AC3-02: `SCRUM571_AC3_%s_frees_a_request_behind_only_an_expired_hold`, `SCRUM571_AC3_%s_leaves_a_conflicting_request_outside_setup_and_turnaround`; and AC4's cases, since the rule is one shared check |
| AC4: still blocked stays Conflicting, no notice | Yes | AC4-01 to AC4-03: `SCRUM571_AC4_%s_leaves_a_request_another_approved_booking_blocks`, `…_a_venue_block_covers`, `…_another_events_active_hold_covers`, each through both paths |

## 3. Design decisions

### D1. Already partly delivered

SCRUM-347's migration 027 (PR #85, merged) had already made
`release_event_arrangements` free Conflicting requests on cancellation and
rejection. So AC1's behaviour pre-dated this story, but as a copy of SCRUM-492's
rule, and without the venue lock. This story replaced that copy (D2) and added the
lock (D3). AC2 was new.

*Rejected: closing AC1 as already done.* The copy had no venue lock, and a third
copy for AC2 would make three rules to keep in step.

### D2. One shared function

`return_freed_conflicting_requests(booking id)` re-checks and moves the requests,
and sends the notices. Its callers: `release_venue_booking` (release),
`release_event_arrangements` (cancellation and rejection), `cancel_flagged_booking`,
and `decide_booking_request` step 14 (a replacement approved).

*Rejected: keeping copies in each function.* The rule would drift; the teeth check
shows one removed re-check now fails SCRUM-571's and SCRUM-492's traps together.

### D3. The venue lock

Every path takes `decide_booking_request`'s venue lock (`for no key update`) before
re-checking occupancy. So an approval can't slip in between the check and the move
to Pending. `release_event_arrangements` and `cancel_flagged_booking` lock in
event → venue → booking order. SCRUM-266's (077) premise, "no venue lock: cancelling
only frees occupancy", no longer holds, so its lock-order test now checks
event → venue → booking (case D3-01).

*Rejected: no lock.* A request could return to Pending just as another booking was
approved over it.

### D4. The replacement path is included

When Venue Staff approve a replacement, the flagged booking is cancelled (SCRUM-266),
so its old slot frees requests too. Team decision; AC2 is read as covering it.

*Rejected: only the explicit cancel.* The old slot would be free but its requests
would stay Conflicting: D11's gap again.

### D5. Neutral wording

The notice now says "{event} no longer holds the venue", because it no longer only
follows a release. The type and payload are unchanged.

*Rejected: a new notice type per path.* Same meaning for the coordinator, and a new
type means restating `notifications_type_known`.

### D6. Rejection gets it too

Rejecting an approved event (SCRUM-347) goes through the same shared release, so it
frees requests the same way. This is not in the ACs; it follows from D1 and D2.

*Rejected: excluding rejection.* It would need its own path around the shared
release, for no user benefit.

## 4. Known gaps (not fixed)

| Gap | Detail |
|---|---|
| (a) Rejection lock order | `reject_approved_event` (029) locks its bookings before the venue. A rejection and an approval at the same venue at the same moment can deadlock. Postgres aborts one, the data stays correct, and the user retries |
| (b) Replacement lock order | In the replacement path the second venue is locked after the first in the order the request arrives, not by id. Two opposite replacements at once could deadlock the same way |
| (c) Locks untested | PGlite runs one connection, so the locks themselves are untested. Only their order in the source is checked (D3-01) |
| (d) Flaky test on dev | `SCRUM355_AC6_AC8_the_request_keeps_its_id_and_every_history_across_two_rounds` (`backend/tests/db/reopenEventRequestDatabase.test.js`) fails about half the time on dev, with or without 038. Two status-history rows come back in the wrong order, probably because their timestamps tie. Outside this story; to raise separately |

## 5. Verification

| Evidence | Result |
|---|---|
| Backend `npm run test:coverage` | 8,557 passed, plus the one intermittent failure (d) |
| SCRUM-571, SCRUM-266, SCRUM-492 and SCRUM-347 database suites | 165 passed. The SCRUM-492 and SCRUM-347 suites are unmodified |
| Frontend `npm run test:coverage` | 4,170 passed, every gate met. Lint 0 errors. Build passes |
| Without 038 | 4 SCRUM-571 tests fail: both AC2 cancels, the replacement, and the expired hold via the flagged cancel. The AC1 tests pass because of 027 (D1) |

Teeth checks, each reverted afterwards:

1. Removing the freeing call from `cancel_flagged_booking` fails 3 tests: the two
   AC2 cancels and the expired-hold AC3 test through that path.
2. Removing the occupancy re-check from the shared function fails all 6 SCRUM-571
   AC4 traps and 4 SCRUM-492 AC4 traps.
3. Restoring "released the venue" fails
   `SCRUM571_AC1_the_conflict_cleared_notice_does_not_say_released`.

## 6. Deploy

1. Paste `backend/db/migrations/038_freed_venues_return_conflicting_requests.sql`
   into the Supabase SQL editor and run it.
2. Run the schema fingerprint check as `backend/db/migrations/AGENTS.md` describes:
   run `backend/scripts/schema-fingerprint.sql` in the SQL editor and export the
   CSV, then inside `backend/` run
   `node scripts/schema-fingerprint.js build baseline <built.csv>` and
   `node scripts/schema-fingerprint.js diff <built.csv> <live.csv> --ignore extension`.
   Expect only the known live-only leftovers.
3. Redeploy the API.
