# SCRUM-539 — A Request Waiting in the Lead's Unassigned Queue Can Be Cancelled by Nobody

**Story:** A request waiting in the Lead's unassigned queue can be cancelled by nobody (Task, E3) — Event Coordinator Lead
**Closing subtask:** SCRUM-581 (this document)
**Status as of 23 October 2026:** built and tested; all seven criteria done (section 1). The click-through passed: every check passed, as reported by Calven on 23 October 2026.

This document is the record of what SCRUM-539 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC1.

The case-by-case mapping is `docs/test-cases/SCRUM-539.md`: 27 cases, each naming
the tests that prove it. It also holds the design decisions D1 to D9 in full, with
the alternatives rejected. This document cites it rather than repeating it.

**The short version, for anyone asked "what changed?":** a request waiting in the
Lead's unassigned queue can now be cancelled by the Event Coordinator Lead, from
its queue row, with a reason and who initiated it, after a preview of anything the
cancellation releases. The Organiser is told. The Lead still cannot cancel an event
someone holds; a coordinator who tries to cancel an unassigned request is told it
waits for the Lead. Organiser self-withdrawal (SCRUM-427) is not built, by the
customer's decision (D9).

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-576 | The test cases, written before any code: 27 cases across the seven criteria, seven of them traps, and the design decisions D1 to D9 | `f2cd371` |
| SCRUM-577 | Migration 013: `cancel_event_request` and `event_cancellation_impact_preview` widened to the Lead for a submitted request nobody holds, with the PGlite suite | `f2cd371` |
| SCRUM-578 | `POST /:id/cancel` and `GET /:id/cancellation-impact` behind `coordinatorOrLead`; the one SCRUM-487 row moved by design; the route tests | `f2cd371` |
| SCRUM-579 | The Lead's cancel panel on the unassigned queue (`UnassignedRequestCancelPanel.jsx`), the row's Cancel request button, the `SCRUM539_FILES` gate | `61386ea` |
| SCRUM-580 | The sweep: every test named `SCRUM539_ACn_…`, the screen's teeth checks, the case document at 27 of 27 | `61386ea` |
| Merge of dev | SCRUM-355 (PR #80): its migrations 012, 014 and 015 around ours | `0c0b3ed` |
| SCRUM-581 | This document; the reopen test (AC1-04, AC1-05); the notes on SCRUM-486 and SCRUM-487 | this commit |

A SCRUM-572 timeout fix for `schemaFingerprint.test.js` rode in `61386ea` (not a
commit of its own). Dev's `59f87f4` (SCRUM-355) fixed the same timeout at the
`describe`; after the merge ours was removed, so the file is dev's.

### Verification as of 23 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | 7496 passing and 2 todo across 173 files, after the merge of dev. At `4ca89db` before the story: not recorded. After SCRUM-577 and SCRUM-578: 7440 and 2 todo across 170 |
| Frontend suite (`npm run test:coverage` in `frontend`) | 3731 passing across 162 files, after the merge; every coverage gate met. At `4ca89db`: not recorded. After SCRUM-579: 3699 across 159. `npm run lint` 0 errors (23 warnings, none in a file this story touched); `npm run build` passes |
| SCRUM-539's gate | `SCRUM539_FILES` in `frontend/vite.config.js`: `UnassignedRequestCancelPanel.jsx` at 100% statements, branches, functions and lines. `UnassignedQueue.jsx`, which gained the row button, stays in `SCRUM486_FILES` at 100% |
| SCRUM-539's own tests | 55 titles once parametrised cases are expanded, every one named `SCRUM539_ACn_…`: 23 in `scrum539LeadCancelDatabase.test.js`, 10 in `scrum539LeadCancelRoutes.test.js`, 16 in `scrum539LeadCancelPanel.test.jsx`, 5 in `UnassignedQueue.test.jsx`, 1 in `EventCancellationPanel.test.jsx` |
| PGlite | `scrum539LeadCancelDatabase.test.js` runs 013 on the full schema (`createSchemaDb()`: the baseline, then every migration, 012 to 015 included) |
| Live database | 013 applied by Calven to the shared Supabase project on 22 October 2026. No live script was run by us |
| Test-case document | 27 cases: **27 proved**, 0 not yet implemented, 0 that cannot be written as specified |
| Click-through | Passed: every check passed, as reported by Calven on 23 October 2026 |

**Teeth checks**: each test was checked by breaking the line it proves, watching
it fail, and restoring the file.

| AC | What was broken | What failed |
|---|---|---|
| AC1 | The Lead passed as `change_event_request_status`'s expected coordinator (013:111) | Six: the AC1-01 history test, AC1-04, both AC2 tests, AC5-02 and AC5-03, each by 40001 |
| AC1 | `release_event_arrangements` skipped on the Lead's path (013:123) | AC1-04's helper-built test and, after the merge, the reopen test |
| AC1 | The panel's client-side reason and initiator check | `SCRUM539_AC1_%s_shows_the_message_and_calls_nothing` (a blank reason; no initiator) |
| AC1 | `!confirmed` dropped from Cancel request's `disabled` | `SCRUM539_AC1_cancel_waits_for_the_box_then_sends_the_trimmed_reason_and_initiator_only` |
| AC2 | The queue's `onCancelled` → `closePanel(message)` made a no-op | `SCRUM539_AC2_a_cancel_returns_to_the_queue_says_so_and_the_row_is_gone` |
| AC3 | The Lead-on-a-held-event check removed (013:62) | Both AC3-01 cases and AC5-01 |
| AC3 | The panel's 403 message | Both "assigned since" tests (cancel and preview) |
| AC4 | The "waiting for the Lead" check removed (013:56) | AC4-01 and the no-profile unassigned case |
| AC5 | `'cancelled'` dropped from the Lead's exemption (013:70) | AC5-03 (it became 403) |
| AC5 | The panel's 409 message | `SCRUM539_AC5_a_409_from_the_cancel_says_it_is_no_longer_waiting` |
| AC6 | Not broken separately: the coordinator's path is the existing suites, passing unmodified | — |
| AC7 | Not broken separately: every refusal test asserts an unchanged snapshot, so each mutation above that turned a refusal into a write failed on it | — |

---

## 1. Acceptance criteria

| AC | Criterion (in substance) | Status |
|---|---|---|
| AC1 | The Lead can cancel a request that is Submitted and has no coordinator. A non-blank reason and an initiator are required. The request becomes Cancelled; the reason, initiator, the Lead as canceller and the time are recorded, and the status history names the Lead. | **Done** |
| AC2 | The request leaves the unassigned queue, and the Event Organiser is notified with the reason. | **Done** |
| AC3 | The Lead cannot cancel an event that has a coordinator. The attempt is refused and nothing changes. | **Done** |
| AC4 | Nobody but a Lead can cancel an unassigned request. A coordinator is told the request is waiting for the Event Coordinator Lead. | **Done** |
| AC5 | A cancellation that races an assignment has exactly one winner. The loser is refused and nothing is half-done. | **Done**; each race is run as its two orders in sequence (section 4) |
| AC6 | The assigned coordinator's cancellation (SCRUM-370, SCRUM-561) is unchanged. | **Done** |
| AC7 | A refused attempt leaves all data unchanged. | **Done** |

**Tally:** 7 done, 0 partial, 0 deferred.

**Test cases:** 27; 27 proved.

### Evidence for each criterion

| AC | Code (file, line) | Proved by |
|---|---|---|
| AC1 | 013's caller matrix (`013:52–72`); the expected coordinator is the holder (`013:111`); the release on both paths (`013:123`); `POST /:id/cancel` (`eventRequests.js:1008`); `UnassignedRequestCancelPanel.jsx` | `SCRUM539_AC1_a_lead_cancels_and_is_recorded_as_the_canceller_with_one_history_row`, `SCRUM539_AC1_a_lead_cancel_releases_the_bookings_hold_and_equipment_and_tells_their_staff`, `SCRUM539_AC1_a_request_reopened_through_reopen_event_request_keeps_its_bookings_and_the_lead_preview_and_cancel_release_them` (PGlite); `SCRUM539_AC1_a_lead_cancels_and_the_caller_comes_from_the_token` (route); `SCRUM539_AC1_cancel_waits_for_the_box_then_sends_the_trimmed_reason_and_initiator_only` (screen) |
| AC2 | The Organiser's notice (unchanged, baseline); the queue's filter (submitted, no coordinator); `UnassignedQueue.jsx:104` | `SCRUM539_AC2_the_organiser_gets_exactly_one_notice_with_the_reason`, `SCRUM539_AC2_the_cancelled_request_leaves_the_unassigned_queue` (PGlite); `SCRUM539_AC2_a_cancel_returns_to_the_queue_says_so_and_the_row_is_gone` (screen) |
| AC3 | `013:62` (cancel); `013:253` (preview) | `SCRUM539_AC3_a_lead_is_refused_a_held_%s_event_with_42501_and_nothing_changes`, `SCRUM539_AC3_a_lead_is_refused_the_preview_of_a_held_event_with_42501` (PGlite); `SCRUM539_AC3_a_lead_reaches_cancel_and_the_database_refuses_a_held_event_with_403` (route) |
| AC4 | `013:56`; `coordinatorOrLead` on both routes (`eventRequests.js:215`, `:633`, `:1008`) | `SCRUM539_AC4_a_coordinator_is_told_the_request_waits_for_the_lead_with_55000`, `SCRUM539_AC4_a_lead_is_refused_a_draft_with_42501` (PGlite); `SCRUM539_AC4_%s_is_refused_with_403_and_queries_nothing`, `SCRUM539_AC4_a_coordinator_on_an_unassigned_request_gets_409` (route) |
| AC5 | The row lock both functions take; `013:70` (a cancelled request falls through to the status check, `013:76`) | `SCRUM539_AC5_assigned_first_the_lead_cancel_is_refused_and_the_assignment_stands`, `SCRUM539_AC5_cancelled_first_the_assignment_is_refused_with_55000_and_the_cancel_stands`, `SCRUM539_AC5_a_second_lead_cancel_is_refused_with_55000_not_403` (PGlite) |
| AC6 | The holder's path through 013, unchanged but for the expected-coordinator argument | `SCRUM539_AC6_the_assigned_coordinator_still_cancels_their_held_event`, `SCRUM539_AC6_a_coordinator_who_no_longer_holds_the_event_is_still_refused` (PGlite); the existing cancel suites unmodified; `SCRUM539_AC4_the_coordinators_cancel_form_keeps_its_403_text` (screen) |
| AC7 | — | Every refusal test's before-and-after snapshot; `SCRUM539_AC7_cancel_and_preview_stay_closed_to_the_client_roles` (grants) |

---

## 2. Traceability: AC1, end to end

**User story** → **AC1** → **test cases** AC1-01 to AC1-07
(`docs/test-cases/SCRUM-539.md`) → **test classes** (the files below) → **code**.
Take the Lead cancelling a submitted request nobody holds, from the queue.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `UnassignedQueue.jsx:152` (the row's Cancel request), `:98` (the panel in place of the list) | One panel at a time; opening one clears the last confirmation | `SCRUM539_AC1_every_row_offers_cancel_beside_assign`, `SCRUM539_AC2_cancel_request_opens_the_cancel_form_for_that_row` |
| Screen | `UnassignedRequestCancelPanel.jsx:48` (`handlePreview`), `:50` (the client check), `:59` (the preview), `:67` (`handleCancel`), `:71` (the cancel), `:150` (Cancel request disabled until confirmed) | A reason and an initiator, a preview of what is released, a confirmation, then the cancel with the trimmed reason and the initiator only, no attendee message | `SCRUM539_AC1_the_preview_is_asked_for_this_request_and_its_counts_are_shown`, `SCRUM539_AC1_cancel_waits_for_the_box_then_sends_the_trimmed_reason_and_initiator_only` |
| Frontend service | `cancelEventRequest` and `getEventCancellationImpact` (`frontend/src/services/eventRequestService.js:206`, `:186`) | Unchanged; the coordinator's own calls | — |
| Route | `POST /:id/cancel` (`backend/src/routes/eventRequests.js:1008`), `GET /:id/cancellation-impact` (`:633`), `coordinatorOrLead` (`:215`) | The Lead is let through; every other role but a coordinator is 403 with no query; the caller is the token's | `SCRUM539_AC1_a_lead_cancels_and_the_caller_comes_from_the_token`, `SCRUM539_AC1_a_lead_reaches_the_preview`, `SCRUM539_AC4_%s_is_refused_with_403_and_queries_nothing` |
| Service | `cancelEventRequest` and `getEventCancellationImpact` (`backend/src/services/eventRequestService.js:1283`, `:1263`) | Unchanged: validation, one rpc each, `translateError` | The existing `eventCancellationService.test.js` |
| SQL: who | `cancel_event_request` (`013:5`), the caller matrix (`013:52–72`) | Under the row lock: submitted, no coordinator and not a Lead is 55000 naming the Lead (`:56`); a Lead on a held event is 42501 (`:62`); the holder check, with the Lead exempt for submitted and cancelled requests (`:70`) | The AC3, AC4 and AC5 PGlite cases |
| SQL: what | `013:111` (the expected coordinator is the holder, null on the Lead's path), `013:123` (the release, on both paths) | The status change and its history row, the cancellation columns, the bookings, holds and equipment released, the notices | `SCRUM539_AC1_a_lead_cancels_and_is_recorded_as_the_canceller_with_one_history_row`, `SCRUM539_AC1_a_lead_cancel_releases_the_bookings_hold_and_equipment_and_tells_their_staff` |
| SQL: the preview | `event_cancellation_impact_preview` (`013:219`), the Lead's rule (`013:253`) | The holder still holding the coordinator role, or a Lead for a submitted request nobody holds; the existing refusal message | `SCRUM539_AC1_a_lead_previews_what_cancelling_an_unassigned_request_releases` |
| The queue | `UnassignedQueue.jsx:104` | "{event} was cancelled. The organiser has been told." The list is re-read and the row is gone | `SCRUM539_AC2_a_cancel_returns_to_the_queue_says_so_and_the_row_is_gone` |

**What each refusal becomes on screen**, keyed on the status, never the server's
text (`UnassignedRequestCancelPanel.jsx:16`):

| Response | The panel says | Why it happens |
|---|---|---|
| 403 | "A coordinator has been assigned to this request since you opened it, so only they can cancel it now. Go back to the queue to see where it stands." | Another Lead assigned it first (AC3, AC5-01); from the cancel or the preview |
| 409 | "This request is no longer waiting in the queue. It may already have been cancelled or assigned. Go back to the queue to see where it stands." | Another Lead cancelled it first (AC5-03), or it left Submitted |
| 400 | "Enter a cancellation reason and select who initiated it." | A reason or initiator the server refused |
| 401 | "Your session has expired. Please sign in again." | — |
| 404 | "This event request no longer exists." | — |
| Anything else | "The request could not be cancelled. No changes have been made; try again." | — |

A coordinator who tries to cancel an unassigned request directly gets the
function's 55000, "… is waiting for the Event Coordinator Lead to assign it a
coordinator; only the Lead can cancel it", which arrives as 409
(`SCRUM539_AC4_a_coordinator_on_an_unassigned_request_gets_409`). No coordinator
screen offers it: their event screen never shows an unassigned request.

**Click-through.** Run by Calven in the browser against the shared Supabase
project after 013 was applied. Every check passed, as reported by Calven on 23
October 2026; the results were reported as a whole, not check by check, so none is
listed here.

---

## 3. Design decisions

Each is argued in full, with the alternative rejected, in
`docs/test-cases/SCRUM-539.md` ("Design decisions"). The summaries below point there.

### D1. Widen `cancel_event_request`; don't add a Lead function

One function, so the status change, the record, the release and the notices cannot
drift between two copies, as SCRUM-486 widened `reassign_event_request`. *Rejected:
a Lead-only function*, a second copy of the release and notices.

### D2. The outgoing holder is the expected coordinator

013 passes `v_request.assigned_coordinator_id`, read under the lock, to
`change_event_request_status` (013:111): null on the Lead's path, so the guard is
skipped; the caller on the holder's path, as before. *Rejected: passing the Lead*
(every Lead cancel would be 40001) and *passing null always* (the holder's path
loses its guard).

### D3. Only Submitted and unassigned

`event_requests_assigned_when_submitted` admits no coordinator only in draft,
submitted and cancelled, so submitted is the one cancellable status a request
nobody holds can be in. The Lead never cancels a held event.

### D4. The refusal says the right reason

A coordinator on an unassigned request is told it waits for the Lead (55000, 409),
as `start_event_review` does since SCRUM-486 AC8 (the SCRUM-517 precedent); a Lead
on a held event is told the holder cancels it. *Rejected: one 42501 for
everything*, true but pointing at the wrong person.

### D5. Widen the routes; don't add new ones

Both routes become `coordinatorOrLead` and the database decides, as
`POST /:id/reassign` does. *Rejected: Lead-only routes* to the same function.

### D6. The Lead gets the preview, on the same rule

A request rejected, reopened and resubmitted waits unassigned with its bookings
and holds. Since the merge of dev this is the app's own path, through SCRUM-355's
`reopen_event_request` (015), proved by
`SCRUM539_AC1_a_request_reopened_through_reopen_event_request_keeps_its_bookings_and_the_lead_preview_and_cancel_release_them`.
*Rejected: no preview for the Lead*, who would release bookings blind.

### D7. The Lead's form sits on the unassigned queue

The coordinator's form less the attendee message (a request nobody holds has no
attendees), opened in place of the list as Assign is, with status-keyed errors.
*Rejected: the coordinator's event screen*, built for the holder.

### D8. The notices are the existing ones

The Organiser, and the staff whose arrangements are released. *Rejected: telling
every Lead*: no source asks for it. Open question 1.

### D9. Organiser self-withdrawal (SCRUM-427) is not built — **answered by the requirements**

Organisers request withdrawal through ConnectSphere (Week 4 clarification; Week 9
Q&A row 11), which the initiator "the organiser's request" records. *Rejected:
building SCRUM-427 alongside*.

### D10. The migration is 013

012 was taken twice on other branches: SCRUM-575's open PR #79
(`012_overnight_operating_hours.sql`) and SCRUM-355's merged
`012_event_request_decision_history.sql`. 013 runs after dev's 012 and before 014,
in the name order every suite builds the schema in (`loadSchema.js`). The restate
order for `cancel_event_request` is now this story (013), then SCRUM-571, then
SCRUM-28, each restating from the one before.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC5's races are run in sequence | PGlite has one connection, so each race is its two orders run one after the other (the SCRUM-486 D13 precedent). The real concurrency is argued from the row lock both functions take, not tested | — |
| No live script covers the Lead's cancel | The click-through and PGlite are the evidence | Optional |
| SCRUM-571 restates `cancel_event_request` next | It must restate from 013, not from the baseline, or the Lead's path is silently lost: the latest migration that defines a function wins | SCRUM-571 (Terence) |

### Technical debt, left

- **`backend/src/routes/eventRequests.js` stays ungated**, as it always was; the
  routes' behaviour is pinned by the route tests.
- **Lint's 23 warnings are pre-existing**; none is in a file this story touched.
- **The preview's refusal message** still says "Only the coordinator assigned to
  this event can preview its cancellation" when a coordinator previews an
  unassigned request. Kept on purpose: `eventCancellationImpactPreviewDatabase.test.js`
  pins it, and the screen keys on the status.

### Process notes

- **Test-first:** SCRUM-576's 27 cases were written before any code; AC5-03 was
  watched failing before 013 existed.
- **One existing test row moved by design:** `POST /:id/cancel` left
  `SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing` for
  `SCRUM539_AC3_a_lead_reaches_cancel_and_the_database_refuses_a_held_event_with_403`,
  with a comment where it was. SCRUM-487 AC5 still holds; the database enforces it.
- **Migration numbering:** if PR #79 merges as it is, dev will have two migrations
  numbered 012. That is for SCRUM-575 to renumber, and it is why this story is 013.
- **The fingerprint timeout:** this story's fix was superseded by dev's `59f87f4`,
  and removed after the merge so the file matches dev.
- **Restated verbatim:** 013's `cancel_event_request` differs from the baseline's
  only in the caller matrix, one declaration, a parameter comment and the expected
  coordinator, so SCRUM-571's diff from it stays readable.

---

## 5. Open questions for the team

1. **Should other Leads be told of a cancellation (D8)?** Built as no.
2. **Should SCRUM-427 be closed as Won't Do (D9)?** Calven moves Jira statuses.

---

## Before the examination

- **Be ready for "why the Lead and not the Organiser?"** D9: the customer had
  Organisers request withdrawal through ConnectSphere (Week 4; Week 9 Q&A row 11),
  so a person at ConnectSphere cancels it, and for a request nobody holds that is
  the Lead. The initiator records whose idea it was. Evidence:
  `SCRUM539_AC1_a_lead_cancels_and_is_recorded_as_the_canceller_with_one_history_row`.
- **Be ready for "why widen the one function instead of writing a new one?"** D1:
  the release and the notices live in `cancel_event_request`; a second function
  would be a second copy to keep in step. Evidence: the existing cancel suites pass
  unmodified (AC6-01) and `SCRUM539_AC6_the_assigned_coordinator_still_cancels_their_held_event`.
- **Be ready for "what stops the Lead cancelling a held event?"** AC3: 013:62
  refuses a Lead whenever the event has a coordinator (42501, 403), under the row
  lock, whatever the route lets through. Evidence:
  `SCRUM539_AC3_a_lead_is_refused_a_held_%s_event_with_42501_and_nothing_changes`
  and `SCRUM539_AC3_a_lead_reaches_cancel_and_the_database_refuses_a_held_event_with_403`.
- **Be ready for "why does a coordinator get 409, not 403?"** D4: 403 would say the
  request is someone else's, when it is nobody's; 409 says it is not in a state they
  can act on, and the message names the Lead, as `start_event_review` does (the
  SCRUM-517 precedent). Evidence:
  `SCRUM539_AC4_a_coordinator_is_told_the_request_waits_for_the_lead_with_55000`.
- **Be ready for "what if the Lead cancels while another Lead assigns?"** AC5:
  both functions lock the event row first, so they take turns; the second meets the
  first's result and is refused (403 if assigned, 409 if cancelled). PGlite runs the
  two orders in sequence. Evidence:
  `SCRUM539_AC5_assigned_first_the_lead_cancel_is_refused_and_the_assignment_stands`,
  `SCRUM539_AC5_cancelled_first_the_assignment_is_refused_with_55000_and_the_cancel_stands`.
- **Be ready for "why does the Lead need a preview if nothing is assigned yet?"**
  D6: unassigned does not mean empty. A rejected request reopened through
  SCRUM-355's `reopen_event_request` and resubmitted keeps its bookings and holds,
  and cancelling releases them. Evidence:
  `SCRUM539_AC1_a_request_reopened_through_reopen_event_request_keeps_its_bookings_and_the_lead_preview_and_cancel_release_them`.
