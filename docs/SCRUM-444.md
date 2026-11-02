# SCRUM-444 — Restrict Coordinator Actions to the Assigned Coordinator (Event Coordinator)

**Story:** Restrict Coordinator Actions to the Assigned Coordinator (E1) — Event Coordinator
**Closing subtask:** SCRUM-452 (this document)
**Status as of 2 November 2026:** built and tested; AC1 to AC6 done (section 1). The click-through passed in full, as reported by Calven on 2 November 2026.
**Migrations:** 055 (reassign is the Lead's) and 056 (the clarification request checks its caller), both applied by Calven with their checks returning `true`.

This document is the record of what SCRUM-444 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC1 and AC3.

The case-by-case mapping is `docs/test-cases/SCRUM-444.md`: 46 cases, four of them
on the screen, each naming the tests that prove it. This document cites it rather
than repeating it.

**The short version, for anyone asked "what changed?":**

- A coordinator now reads only the events they hold; the Event Coordinator Lead
  reads all. Anyone else gets the same 404 a missing event gets, and the screen
  says "This event isn't available to you."
- The review queue lists only the caller's own events. It used to list every
  coordinator's.
- Only the Lead hands an event over (055). The holder's "Hand over" button,
  `GET /coordinators` and the holder's picker are gone.
- After a handover the previous holder is a non-holder like any other: no view, no
  action (AC4).
- The clarification request now checks its caller inside the function (056), as
  every other coordinator action already did.
- The actions were already guarded: every one refuses a coordinator who does not
  hold the event, and the access matrix proves it action by action.

---

## Sources

The story's Jira text is quoted in `docs/test-cases/SCRUM-444.md`. The lines that
drive it, word for word (typos are the originals'):

- **Week 7 Customer Changes, "Addition of Event Coordinator Lead Role":**
  "ConnectSphere has introduced a new internal role, the Event Coordinator Lead,
  who is responsible for overseeing incoming event requests and assigning them to
  individual Event Coordinators. Newly submitted event requests should no longer be
  assigned directly to an Event Coordinator. Instead, they first enter an unassigned
  queue that can be viewed by the Event Coordinator Lead. The Lead can review basic
  event information, assign a suitable Event Coordinator, and reassign events where
  necessary. Event Coordinators should only be able to manage events assigned to
  them, while the Event Coordinator Lead should be able to view all coordinator
  assignments and active events under their supervision. Relevant users should be
  notified when assignments or reassignments occur."
- **Customer Briefing (Week 1), "Coordinator Assignment":** "Events can be assigned
  to an Event Coordinator responsible for managing the planning process.
  Reassignment may be required when staff responsibilities or availability change."
  It names nobody, which is why SCRUM-327 and SCRUM-486 let the holder hand over.
- **Week 9 Q&A, sheet G3-5, row 16** (Gyaltsen, G3). Q: "With the Addition of Event
  Coordinator Lead Role, is it possible for the event coordinator to view the list
  of unassigned events and the events assigned to other coordinators". A: "The lead
  should have access to all the unassigned/assigned event for allocation. The
  co-ordinator will have access to his own assigned events."
- **Week 9 Q&A, sheet G3-5, row 18** (Sreya, G3). Q: "Is the reassignment of
  coordinators now handled by Event Coordinator Lead role instead of offline
  agreement by coordinators?" A: "yes, it is now manually assigned by the lead and
  no more system auto-assignment of co-ordinator"
- **Week 9 Q&A, sheet G3-5, row 26** (Shanise, G5). Q: "For the Event Coordinator
  Lead, are they able to reassign events after venue and teachnical arrangements are
  comfirmed ?" A: "Yes, the lead should be able to reassign."

**Scenario 2, by the Week 7 guide.** SCRUM-486 AC6 ("the holder may hand over")
was right when written and is Done. The Week 9 answers change the rule, so
SCRUM-486 stays Done and SCRUM-444 carries the change: 055, the Lead-only route and
screen, and the renamed tests (section 5). AC4 was rewritten from "view-only" to
"no access", because row 16 says a coordinator has access to his own assigned
events, and after a handover the event is no longer his.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-445 | The reads: `assertCoordinatorMayRead` and `requireHistoryReader` built on it; the helper on `/:id/review`, `/:id/assignments/review`, `/:id/readiness`, `/:id/change-requests/review`, the equipment read and the clarification history; the 404 worded with the id as typed; `GET /queue` narrowed to the caller; a malformed id a 400 on every read | `70e101f`, `f894bf1` |
| SCRUM-446, SCRUM-447 | The action audit: every AC2 action as a non-holder, in `scrum444AccessMatrixDatabase.test.js`, each with a control row for the holder; "on-site support assignments" recorded as having no code to guard (AC2-09); 056 for the one action that had no caller check of its own | `70e101f`, `f894bf1` |
| SCRUM-448 | Reassign is the Lead's: 055, `POST /:id/reassign` behind `leadOnly`, `canReassign` the Lead's on the screen, the handover panel's words, and `GET /coordinators` and `listCoordinators` removed | `70e101f`, `f894bf1` |
| SCRUM-449 | Closing notes: a non-holder cannot complete an event with notes, and cannot read them through `/:id/review` | `70e101f`, `f894bf1` |
| SCRUM-450, SCRUM-451 | The access matrix and the handover tests: the Lead hands A's event to B; A is refused every read and every action; B reads it and acts | `70e101f`, `f894bf1` |
| SCRUM-452 | This document; the Week 9 citations corrected to sheet G3-5's rows | this change |
| Merge of dev | SCRUM-588 and SCRUM-591 (the UI standard for Technical Support Staff and the Safety Officer), among others. No conflict, and no migration that restates `reassign_event_request` or `request_event_clarification_with_fields` | `a222975` |

### Verification as of 2 November 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | At `74c45a3`, before the story: 10,173 passing, 17 skipped and 2 todo across 246 files, 2 files skipped (run on 2 November 2026 from a worktree of that commit). After the merge (`a222975`): 10,314 passing, 17 skipped and 2 todo across 249 files, 2 files skipped. Through the story: 10,299 after brief 1, 10,301 after its fix-up, 10,314 after brief 2 |
| Frontend suite (`npm run test:coverage` in `frontend`) | At `74c45a3`: 4,849 passing and 1 failing across 208 files, run the same way. The failure, `SCRUM178_AC4_opens_on_the_week_view_and_requests_monday_to_monday`, is SCRUM-178's and passes after the merge. After the merge: 5,011 passing across 213 files. After brief 2, before the merge: 4,845 across 208. `npm run lint` 0 errors and 25 warnings, none in a file 444 touched; `npm run build` passes |
| Gates | Every frontend gate at 100%, `SCRUM486_FILES` (`frontend/vite.config.js:121`, with `EventRequestReviewPage.jsx`) and `SCRUM487_FILES` (`:134`) among them; the backend's per-story thresholds met |
| PGlite | `scrum444AccessMatrixDatabase.test.js`, 73 tests, on the full schema (`createSchemaDb()`: the baseline, then every migration to 056). Statuses are reached through the real workflow functions; only a Confirmed event that has ended is seeded. The renamed PGlite cases sit in five more files (section 5) |
| Live database | Before 055, `reassign_event_request` had one overload and the holder-or-Lead message: `1 \| true` (checked 1 November 2026). Before 056, `request_event_clarification_with_fields` had one overload and no caller check: `1 \| true`. 055 and 056 applied by Calven; each check returned `true`. No live script was run by us |
| Test-case document | 46 cases: **45 proved** and one recorded (AC2-09: no code to guard); 0 not yet implemented, 0 that cannot be written as specified. 10 are traps; 4 cases are on the screen |
| Click-through | Passed in full, as reported by Calven on 2 November 2026, with two coordinators and the Lead: the other coordinator gets "isn't available"; only the Lead hands over; the previous holder loses access; the new holder asks for clarification; the Organiser and the Lead are unaffected |

**Teeth checks**: each guard was broken in memory, the tests run, and the file
restored from the in-memory copy and compared byte for byte (never `git checkout`).
12 in all: 6 in brief 1, 2 in its fix-up, 4 in brief 2. The counts are the
`SCRUM444_` tests that failed, as each round's report gave them.

| AC | What was broken | What failed | Round |
|---|---|---|---|
| AC1 | The helper's holder condition, so any coordinator passes (`eventRequestService.js:1875`) | 28 `SCRUM444_` tests: every non-holder and previous-holder read, the clarification refusals, the closing notes | Brief 1 |
| AC1 | The helper's Lead branch removed (`:1874`) | 8: every Lead read, and the walkthrough | Brief 1 |
| AC1 | `/queue`'s filter back to "anyone holds it" (`:2000`) | 5: the queue's route, service, PGlite and handover tests | Brief 1 |
| AC1 | The clarification history back to "any coordinator past draft" (`:1833`) | 7 | Brief 1 |
| AC1 | `GET /:id`'s id check removed (`eventRequests.js:793`) | 2: the malformed id, and `GET /coordinators` (500, not 400) | Fix-up |
| AC1 | The helper ignoring the id as typed (`eventRequestService.js:1876`) | 1: `SCRUM444_AC1_a_non_holder_gets_the_id_back_as_typed_like_a_missing_event` | Fix-up |
| AC1 | The id check removed from `/:id/status-history` | 1: its row of `SCRUM444_AC1_%s_refuses_a_malformed_id_with_400_before_any_read` (500, not 400) | Brief 2 |
| AC2 | 056's caller check removed (`056:37–46`) | 3: both access-matrix rows for the clarification request and `SCRUM444_AC2_the_clarification_request_refuses_a_non_holder_with_42501_in_sql` (40001, not 42501) | Brief 2 |
| AC3 | 055's Lead condition back to "the holder or a Lead" (`055:46`) | 3: `SCRUM444_AC3_the_holder_cannot_reassign`, `…_the_holder_is_refused_reassign_with_42501_and_nothing_changes`, `…_055_changes_only_the_callers_check` | Brief 1 |
| AC3 | `leadOnly` on `POST /:id/reassign` back to `coordinatorOrLead` (`eventRequests.js:950`) | 3: the holder and any coordinator refused by the gate | Brief 1 |
| AC3 | `canReassign` back to "the holder or a Lead" (`CoordinatorRequestDetail.jsx:270`) | 1: `SCRUM444_AC3_only_the_lead_is_offered_the_handover` | Brief 2 |
| AC4 | The 404 message back to the old words (`EventRequestReviewPage.jsx:38`) | 1: `SCRUM444_AC4_a_404_says_the_event_isnt_available_to_you` | Brief 2 |

The line numbers are today's; brief 1's checks ran before the fix-up moved some
lines by a few.

---

## 1. Acceptance criteria

| AC | Criterion (in substance) | Status |
|---|---|---|
| AC1 | A coordinator views only the events assigned to them, including their clarification history. The Lead views every event. | **Done** |
| AC2 | Only the assigned coordinator starts review, requests clarification, approves or rejects, rejects an approved event, edits, applies a significant change, processes change requests, submits for the safety check, confirms, cancels, marks completed, releases a booking, and manages equipment lines, venue booking requests and on-site support assignments. | **Done**; on-site support has no code yet (AC2-09) |
| AC3 | Only the Lead assigns and reassigns; a coordinator cannot reassign their own events. | **Done** |
| AC4 | After a reassignment the previous coordinator can no longer view or act on the event. | **Done** |
| AC5 | Only coordinators add closing notes on completed events. | **Done** |
| AC6 | A refused attempt leaves all data unchanged. | **Done** |

**Tally:** 6 done, 0 partial, 0 deferred.

**Test cases:** 46; 45 proved, 1 recorded.

### Evidence for each criterion

| AC | Proved by | Click-through |
|---|---|---|
| AC1 | `SCRUM444_AC1_another_coordinator_gets_the_missing_ids_404_on_%s` (route, six reads); `SCRUM444_AC1_the_queue_lists_only_the_callers_events` (PGlite); `SCRUM444_AC4_a_404_says_the_event_isnt_available_to_you` (page) | The other coordinator gets "isn't available"; the Lead is unaffected |
| AC2 | `SCRUM444_AC2_another_coordinator_cannot_%s_and_nothing_changes` with its control `SCRUM444_AC2_the_holder_can_%s_from_the_same_state` (PGlite, 19 actions each); `SCRUM444_AC2_the_clarification_request_refuses_a_non_holder_with_42501_in_sql` | The new holder asks for clarification |
| AC3 | `SCRUM444_AC3_the_holder_is_refused_reassign_with_42501_and_nothing_changes`, `SCRUM444_AC3_055_changes_only_the_callers_check` (PGlite); `SCRUM444_AC3_a_coordinator_is_refused_reassign_with_403_and_queries_nothing` (route); `SCRUM444_AC3_only_the_lead_is_offered_the_handover` (screen) | Only the Lead hands over |
| AC4 | `SCRUM444_AC4_after_a_handover_the_previous_holder_cannot_%s` (PGlite, 19); `SCRUM444_AC4_the_previous_holder_gets_the_missing_ids_404_on_%s` (route, six); `SCRUM444_AC4_after_a_lead_hands_a_to_b_a_is_refused_and_b_reviews_and_decides` (over HTTP) | The previous holder loses access |
| AC5 | `SCRUM444_AC5_a_non_holder_cannot_complete_the_event_with_notes` (PGlite); `SCRUM444_AC5_a_non_holder_cannot_read_the_closing_notes` (route) | — |
| AC6 | `expectRefused` in the PGlite file: every refusal compares the event, its histories, change requests, bookings, equipment and every notification before and after | The Organiser is unaffected |

---

## 2. Traceability

### AC1, end to end

**User story** → **AC1** → **test cases** AC1-01 to AC1-16
(`docs/test-cases/SCRUM-444.md`) → **test classes**
`scrum444CoordinatorReadsRoutes.test.js`, `scrum444CoordinatorReadRule.test.js`,
`scrum444AccessMatrixDatabase.test.js`, `EventRequestReviewPage.test.jsx`, and the
renamed cases (section 5) → **code**. Take another coordinator opening an event
they do not hold.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `EventRequestReviewPage.jsx:38` | A 404 reads "This event isn't available to you. It may have been handed over to another coordinator, or it may no longer exist.", keyed on the status, never the server's text | `SCRUM444_AC4_a_404_says_the_event_isnt_available_to_you` |
| Route: the id | `requirePlausibleEventId` (`backend/src/routes/eventRequests.js:158`), first in every read under `/:id` | A malformed id is a 400 before any read (D10) | `SCRUM444_AC1_%s_refuses_a_malformed_id_with_400_before_any_read` |
| Route: the gate | `coordinatorOrLead` (`:232`) on `/:id/review` (`:666`) | Anyone but a coordinator or the Lead is 403 before the read | `SCRUM444_AC1_other_roles_are_answered_on_%s_as_before` |
| The read | `getEventRequestForCoordinator` (`eventRequestService.js:1725`), unchanged | One row by id; a draft is a missing id's 404 | `SCRUM444_AC1_a_draft_is_404_on_%s` |
| The rule | `assertCoordinatorMayRead` (`eventRequestService.js:1873`): the Lead passes (`:1874`), the holder passes (`:1875`), anyone else a missing id's `NotFoundError`, with the id as typed (`:1876`) | 404, the same body as a missing id's | `SCRUM444_AC1_another_coordinator_gets_the_missing_ids_404_on_%s`, `SCRUM444_AC1_a_non_holder_gets_the_id_back_as_typed_like_a_missing_event` |
| Every caller | `/:id/change-requests/review` (`eventRequests.js:614`), `/:id/review` (`:669`), `/:id/assignments/review` (`:755`), `/:id/readiness` (`:774`), the equipment read (`eventEquipment.js:99`) | The same rule on every coordinator read | `SCRUM444_AC1_the_holder_reads_%s`, `SCRUM444_AC1_the_lead_reads_%s` |
| The histories | `requireHistoryReader` (`eventRequestService.js:1884`): the Organiser, then a draft refused, then the rule (`:1890`); used by the clarification (`:1833`), decision (`:1905`) and change (`:3064`) histories | The clarification history is the holder's and the Lead's now, as the other two already were | `SCRUM444_AC1_an_unassigned_coordinator_is_refused_the_clarification_history` |
| The queue | `listEventRequestsForReview(coordinatorId)` (`eventRequestService.js:1988`): the caller required (`:1991`), filtered to them (`:2000`); the route passes `req.user.id` (`eventRequests.js:286`) | Only the caller's events in the queue's statuses, oldest first | `SCRUM444_AC1_the_queue_lists_only_the_callers_events`, `SCRUM444_AC1_the_queue_is_filtered_to_the_caller_with_the_same_statuses_and_order` |

### AC3, end to end

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `canReassign` (`CoordinatorRequestDetail.jsx:268–270`): someone holds it, not cancelled, and `isLead` | The button is the Lead's alone | `SCRUM444_AC3_only_the_lead_is_offered_the_handover` |
| Route | `POST /:id/reassign` behind `leadOnly` (`eventRequests.js:950`, the gate at `:228`) | A coordinator, the holder included, is 403 before the function | `SCRUM444_AC3_a_coordinator_is_refused_reassign_with_403_and_queries_nothing` |
| SQL | `reassign_event_request` (`055:10`): the Lead looked up under `for share` (`055:39–44`), anyone else refused (`055:46–47`), before the status list (`055:61`) | 42501, "only the Event Coordinator Lead can hand over event request …"; nothing changes | `SCRUM444_AC3_the_holder_is_refused_reassign_with_42501_and_nothing_changes`, `SCRUM444_AC3_%s_is_refused_reassign_with_42501` |

### What each refusal becomes

| Refusal | Answer | Screen |
|---|---|---|
| A read by a non-holder, or of a draft or a missing id | 404, "Event request <id as typed> not found" | "This event isn't available to you. …" (`EventRequestReviewPage.jsx:38`) |
| A write by a non-holder | 403 from 42501, the function's refusal (D6); the clarification request is refused first by its service, also 403 | Each screen's own 403 words; the handover panel's is "You cannot hand this event over. Only the Event Coordinator Lead can do that." (`ReassignEventPanel.jsx:56`) |
| A handover by anyone but the Lead | 403 from `leadOnly`, before the function | The button is not offered (AC3) |
| A malformed id on a read | 400, `[{ field: 'id', message: 'must be a valid id' }]` | — |

---

## 3. Design decisions

D1 to D6 were decided with Calven on 1 November 2026; D7 to D10 are the briefs'.

### D1. A read by a non-holder is a 404 — **decided with Calven, 1 November 2026**

The same `NotFoundError` a missing id gets (`eventRequestService.js:1876`), as
SCRUM-434 answers foreign events. *Rejected: 403*, which confirms the event exists.

### D2. The previous holder gets no access — **decided with Calven, 1 November 2026**

After a handover A is a non-holder like any other (AC4). *Rejected: view-only
through the assignment history*, against row 16: a coordinator has access to his
own assigned events, and the event is no longer his.

### D3. The queue is narrowed — **decided with Calven, 1 November 2026**

`GET /queue` lists only the caller's events (`eventRequestService.js:2000`).
*Rejected: removing it*: it is still the coordinator's worklist of events awaiting
a decision, beside "My events".

### D4. Reassign is the Lead's alone — **decided with Calven, 1 November 2026**

055, `leadOnly` and `canReassign` (section 2). *Rejected: keeping SCRUM-486 AC6*,
the holder's handover, which rows 16 and 18 reverse.

### D5. `GET /coordinators` is removed — **decided with Calven, 1 November 2026**

Its only caller was the holder's picker; the Lead's reads `GET /coordinator-workload`
(SCRUM-519). *Rejected: keeping a staff list* no screen reads.

### D6. A non-holder's write keeps its 403 or 42501 — **decided with Calven, 1 November 2026**

Only reads are 404. This is the split SCRUM-434 also chose. *Rejected: mapping 42501
to 404 on writes*, which would rewrite other stories' answers and tests.

### D7. One route-level helper; the coordinator read is unchanged

`assertCoordinatorMayRead` is called after `getEventRequestForCoordinator` by each
read route (section 2), never inside it. The read's other callers are writes
(`eventRequestService.js`, `bookingRequestService.js`, `venueSuitabilityService.js`),
already refused by their SQL function or `assertCheckable`; narrowing the read
would turn their 42501 and 403 into 404s.

### D8. 056 checks the caller inside the function (AGENTS.md:16)

`request_event_clarification_with_fields` reads and locks the event, then refuses a
null caller, a non-holder or a holder without the coordinator role (`056:29–46`),
before its inputs and status. Before 056 a non-holder met only
`change_event_request_status`'s guard, 40001. *Rejected: relying on the route
alone*; the service's 403 still answers first over HTTP.

### D9. The 404 echoes the id as typed

Postgres matches a uuid in any case, so an existing event typed in capitals is
found. The refusal names the id as requested (`requestedId`, `:1873`), as a missing
id's does; the stored lowercase id would give the event away.

### D10. A malformed id is a 400 on every read

`requirePlausibleEventId` (`eventRequests.js:158`) before any read under `/:id`,
where Postgres's 22P02 used to arrive as a 500. `GET /coordinators`, removed, now
falls through to `GET /:id` and is this 400.

---

## 4. Known gaps and accepted answers

| Gap | Detail | Owner |
|---|---|---|
| 403 on a write, 404 on a read | D6: a write by a non-holder confirms the id exists. The reads that already allowed only the holder (registrations, flagged bookings, the cancellation preview, venue suitability) answer 403 or 42501 too | Accepted (D6) |
| Answers that changed | `GET /:id/change-requests/review` reads the event first, so a missing id is a 404 where it was `200 []`; the equipment read's missing-id message is now `Event request <id> not found`, where it was `Event request not found`; a draft's equipment is a 404 where any coordinator could read it; `GET /:id` and the other reads answer a malformed id 400 where it was a 500 | Accepted |
| A flaky frontend test | `SCRUM583_AC1_no_screen_adds_its_own_expiry_wording` failed once in a full run ("Target cannot be null or undefined") and passed alone; 3 of 3 passed in brief 2. It touches no 444 code | SCRUM-583 |
| One 400 message differs | `/:id/change-requests/review` keeps 402's "eventRequestId must be a valid id"; every other read says "Invalid event request id". Both are 400 | Accepted; 402's tests pin it |
| The handover panel's words | Brief 2 changed `ReassignEventPanel.jsx`'s intro and 403 messages, which SCRUM-586 is aligning to the UI standard. Tell Terence | SCRUM-586 |
| On-site support assignments | AC2 names them; dev has no route, function or table, so nothing guards them yet (AC2-09) | Its story |
| 055's header | Cites "Week 9 Q&A" without the sheet and row. 055 is live, so it was not edited | Accepted |

---

## 5. For the team

- **`reassign_event_request`.** Any later restate starts from 055, not the baseline.
- **`request_event_clarification_with_fields`.** Any later restate starts from 056,
  not 011, and keeps its caller check at the top.
- **A new coordinator read** must call `assertCoordinatorMayRead` after its read,
  with `req.params.id`, and `requirePlausibleEventId` before it.
- **Tests renamed from other stories,** each `SCRUM444_…` and flipped, never
  loosened; the full old → new list is the "Changed by design" section of
  `docs/test-cases/SCRUM-444.md`. 42 rows: 16 backend, 2 more backend for 056
  (`eventClarificationDatabase.test.js`), and 24 frontend. By story: SCRUM-486 (15),
  SCRUM-45, SCRUM-332 and SCRUM-379 (3 each), SCRUM-21 (2), and one each from
  SCRUM-19, 188, 254, 266, 331, 334, 347, 355, 395, 402, 434, 478, 525 and 561, plus
  two tests that had no story prefix (a clarification test in each of the PGlite
  and service files). The 14 tests of `GET /coordinators` and
  `listCoordinators` went with them (D5).

---

## Before the examination

- **Be ready for "where does it say only the Lead reassigns?"** Week 7 gives the
  Lead "reassign events where necessary", and row 18 answers "yes" to reassignment
  being handled by the Lead instead of the coordinators: "now manually assigned by
  the lead". Evidence: `SCRUM444_AC3_the_holder_is_refused_reassign_with_42501_and_nothing_changes`
  and `SCRUM444_AC3_only_the_lead_is_offered_the_handover`.
- **Be ready for "isn't handing over part of managing your own event?"** Row 18's
  "instead of": allocating an event to a coordinator is the Lead's, as the first
  assignment already was (SCRUM-486). Managing is what happens inside the event,
  which stays the holder's. Evidence: `SCRUM444_AC2_the_holder_can_%s_from_the_same_state`.
- **Be ready for "why 404 and not 403 on a read?"** D1: a 403 confirms the event
  exists; a 404 identical to a missing id's, id as typed, does not. Evidence:
  `SCRUM444_AC1_another_coordinator_gets_the_missing_ids_404_on_%s` and
  `SCRUM444_AC1_a_non_holder_gets_the_id_back_as_typed_like_a_missing_event`.
- **Be ready for "what happens to the old coordinator after a handover?"** AC4 and
  row 16: no access at all, every read a 404 and every action refused. Evidence:
  `SCRUM444_AC4_the_previous_holder_gets_the_missing_ids_404_on_%s` and
  `SCRUM444_AC4_after_a_handover_the_previous_holder_cannot_%s`.
- **Be ready for "why were the actions already guarded, and how do you know?"**
  Each action's function compares the caller with `assigned_coordinator_id` under
  the row lock (SCRUM-332's rule). The matrix proves it for all 19, each with a
  holder control so the refusal is about the caller, not the state; the one gap,
  the clarification request, is 056. Evidence:
  `SCRUM444_AC2_another_coordinator_cannot_%s_and_nothing_changes` and
  `SCRUM444_AC2_the_holder_can_%s_from_the_same_state`.
- **Be ready for "why did you change other people's tests?"** Scenario 2: the
  customer changed the rule, so the old tests were tests of the old rule. Each was
  renamed `SCRUM444_…` and flipped, never loosened, and listed old → new.
  Evidence: the "Changed by design" section of `docs/test-cases/SCRUM-444.md`.
