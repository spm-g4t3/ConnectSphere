# SCRUM-487 — View Every Coordinator's Events

**Story:** View Every Coordinator's Events — Event Coordinator Lead
**Closing subtask:** SCRUM-547 (this document)
**Status as of 13 October 2026:** built and tested; four criteria done and two partial until SCRUM-488 (section 1). The manual walkthrough (section 2) was run by Calven on 13 October and every check passed.

This document is the record of what SCRUM-487 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test class → code**; section 2 walks it end to end for AC3.

The case-by-case mapping is `docs/test-cases/SCRUM-487.md`: 56 cases, each naming
the tests that prove it or saying in bold why none can yet. This document cites it
rather than repeating it.

**The short version, for anyone asked "what changed?":** SCRUM-486 gave the Lead
a plain list of every held event, at `/assigned-events`, so that a reassignment
could be reached by clicking. SCRUM-487 turned that page into the Lead's
coordinator overview: the number of requests waiting in the queue, every
coordinator with their active events counted by status, and the events list
filtered by coordinator and status, with finished events on request. It added no
page, no route the Lead navigates to, and no write. The Lead still changes only
the assignment, from the event's own page, as SCRUM-486 built it.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-540 | The test cases, written before any code: 56 cases across the six criteria, twenty of them traps, and the design decisions D1 to D8 | `16ff5a0` |
| SCRUM-541 | AC2's read: `listCoordinatorOverview` behind `GET /coordinator-overview`, counting through one helper shared with the assignment picker | `fa08d6b` |
| SCRUM-542 | AC3's read: `listAssignedEventsForLead` filtered by coordinator, status and finished events, each validated before any query | `9a3dc25` |
| SCRUM-543 | AC4: the unassigned count at the top of the overview, with its link to the queue | `163d226` |
| SCRUM-544 | The overview screen: the coordinators' table, the filters, the stale-response guard, the dashboard card | `475e9e6` |
| SCRUM-545 | AC5 and AC6 proved: every write on the event page refuses a Lead; the Lead's event page is read-only but for the hand-over | `4ab7b0d` |
| SCRUM-546 | The overview response carries its status labels (D9); the four open cases proved; every cited test name checked | `afa8c82` |
| SCRUM-547 | This document | `afa8c82` |

### Verification as of 13 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm test` in `backend`) | 5310 passing across 109 files |
| Frontend suite (`npm run test:coverage` in `frontend`) | 2338 passing and 1 todo across 104 files; every coverage gate met. SCRUM-487's gated files (`UnassignedCount.jsx`, `CoordinatorWorkloadTable.jsx`, `AssignedEventsFilters.jsx`) and `AssignedEvents.jsx`, which it extended and which stays in `SCRUM486_FILES`, at 100% |
| SCRUM-487's own tests | 62 distinct `SCRUM487_…` titles (a parametrised test counts once), in files of their own (`scrum487…`), beside SCRUM-486's files, which this story left unedited bar the two dashboard sentences in section 4 |
| PGlite | `scrum487OverviewDatabase.test.js` runs the real overview and list reads over Postgres, before and after 052's `reassign_event_request` |
| Live database | No live script covers this story's reads, and none was run (they write to the shared project; the reads here write nothing to check) |
| Test-case document | 56 cases: **53 proved**, **0 not yet implemented**, **3 that cannot be written as specified** (section 4) |
| Manual walkthrough | Passed, checks A to I, by Calven on 13 October 2026 on `afa8c82`, against the shared Supabase project (section 2) |

---

## 1. Acceptance criteria

| AC | Criterion (quoted) | Status |
|---|---|---|
| AC1 | Only the Lead can open the view. Any other user is refused. | **Done** |
| AC2 | It lists every Event Coordinator with their number of active events and the count in each status. Active means Submitted, Under review, Pending clarification, Approved, Safety review, Safety approved or Confirmed. | **Partial**: every coordinator, total and per-status counts, for the five active statuses that exist. Safety review and Safety approved are not in the enum until SCRUM-488 (D4) |
| AC3 | It lists all active events across coordinators, earliest event first, showing the event name, the organiser, the status, the coordinator and the start date. The list can be filtered by coordinator and by status. Completed, Rejected and Cancelled events are hidden unless the Lead asks to include them. | **Partial**: built in full for the statuses that exist; the two safety statuses arrive with SCRUM-488 (D4) |
| AC4 | Unassigned requests are counted at the top, with a link to the queue (SCRUM-486). | **Done** |
| AC5 | The Lead can open any event read-only: its details, its clarification history and its assignment history with the handover notes. The Lead cannot start a review, decide, confirm or cancel. | **Done**. "Cannot confirm" holds because no confirm path exists (D7). The handover notes are built and shown; the team's confirmation of that decision is awaited (D6) |
| AC6 | From this view the Lead can reassign an event (SCRUM-486). An event whose coordinator is absent is reassigned without that coordinator doing anything. | **Done** |

**Tally:** 4 done, 2 partial (AC2, AC3), 0 deferred. AC2 and AC3 become Done when
SCRUM-488 adds `safety_review` and `safety_approved` to `ACTIVE_EVENT_STATUSES`,
with no change here (D4).

**Test cases:** 56; 53 proved; 3 cannot be written as specified: AC2-12 and AC3-18
(the safety statuses, D4) and AC5-11 (confirm, D7).

### Evidence for each criterion

| AC | Code (file, function) | Proved by |
|---|---|---|
| AC1 | `leadOnly` on `GET /coordinator-overview` and `GET /assigned` (`backend/src/routes/eventRequests.js`); `ProtectedRoute allowedRoles={["event_coordinator_lead"]}` on `/assigned-events` (`frontend/src/App.jsx`); the Lead's nav link (`Navigation.jsx`, SCRUM-486) | `SCRUM487_AC1_%s_is_refused_the_coordinator_overview_with_403_and_queries_nothing`, `SCRUM487_AC1_%s_is_refused_the_filtered_list_with_403_and_queries_nothing`, `SCRUM487_AC1_the_coordinator_overview_answers_401_without_a_token` (route); `SCRUM487_AC1_sends_%s_to_unauthorized_and_never_mounts_the_overview`, `SCRUM487_AC1_%s_is_not_offered_the_overview_in_the_nav` (the real `App`) |
| AC2 | `readCoordinatorsAndActiveEvents` and `listCoordinatorOverview` (`eventRequestService.js`); `CoordinatorWorkloadTable.jsx` | `SCRUM487_AC2_lists_every_coordinator_with_a_count_for_every_active_status`, `SCRUM487_AC2_active_events_is_the_sum_of_by_status_and_the_pickers_count`, `SCRUM487_AC2_the_response_names_every_active_then_finished_status_with_its_badge_label` (service); `SCRUM487_AC2_one_row_per_coordinator_with_active_events_and_a_column_per_status`, `SCRUM487_AC2_rows_and_columns_keep_the_servers_order` (screen); SCRUM-486's picker tests, unedited, for the shared helper (`SCRUM486_AC3_lists_every_event_coordinator_with_their_active_count`, `SCRUM486_AC3_counts_only_the_active_statuses_of_the_coordinators_listed`) |
| AC3 | `listAssignedEventsForLead`'s options and `FINISHED_EVENT_STATUSES` (`eventRequestService.js`); `GET /assigned`'s `includeFinished` mapping; `listAssignedEventsForLead(filters)` (`frontend/src/services/eventRequestService.js`); `AssignedEventsFilters.jsx`; the list in `AssignedEvents.jsx` | Section 2, layer by layer |
| AC4 | `UnassignedCount.jsx`, counting `listUnassignedEventRequests` | `SCRUM487_AC4_%s_waiting_reads_%j`, `SCRUM487_AC4_the_count_links_to_the_unassigned_queue`, `SCRUM487_AC4_a_failed_count_is_said_and_the_events_list_still_loads` (screen) |
| AC5 | `coordinatorOnly` on the six writes; `isAssignedCoordinator` gating every holder's action in `CoordinatorRequestDetail.jsx`; `coordinatorOrLead` on the three reads (SCRUM-521) | `SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing` (route, six writes); `SCRUM487_AC5_a_lead_sees_%s_read_only_with_only_the_hand_over_action` (screen, six statuses); SCRUM-486's `SCRUM486_AC6_the_lead_reads_the_history_with_its_notes` |
| AC6 | No new code: the overview's rows link to the event page, whose hand-over SCRUM-486 built; 052's `reassign_event_request` | `SCRUM487_AC6_a_filtered_row_opens_the_events_page` (screen); `SCRUM487_AC6_after_a_lead_hands_a_to_b_the_counts_and_the_filtered_list_move_with_the_event` (PGlite); SCRUM-486's `SCRUM486_AC6_a_lead_who_does_not_hold_the_event_reassigns_it` (PGlite: the holder does nothing) |

---

## 2. Traceability: AC3, end to end

AC3 is the criterion that crosses every layer, so it is the one walked here. Take
the Lead asking for one coordinator's events with finished ones included.

| Layer | Where | What happens | Proved by |
|---|---|---|---|
| Screen | `AssignedEventsFilters.jsx` | The Lead picks a coordinator and ticks "Include completed, rejected and cancelled". The finished statuses are offered only while it is ticked; unticking resets a finished status to "All statuses" | `SCRUM487_AC3_the_status_filter_offers_the_active_statuses_and_the_finished_ones_only_when_included`, `SCRUM487_AC3_unticking_include_finished_resets_a_finished_status`, `SCRUM487_AC3_unticking_include_finished_keeps_an_active_status` |
| Screen | `AssignedEvents.jsx` | Each change reads the list again; an answer that is not the latest is ignored (D11) | `SCRUM487_AC3_choosing_a_coordinator_reads_their_events`, `SCRUM487_AC3_a_stale_answer_never_overwrites_a_newer_one`, `SCRUM487_AC3_a_stale_failure_never_overwrites_a_newer_answer` |
| Frontend service | `listAssignedEventsForLead(filters)` | Sends only the filters that are set, `includeFinished` only as `"true"`; with none, exactly SCRUM-486's request | `SCRUM487_AC3_%s_sends_exactly_those_params`, `SCRUM487_AC3_with_%s_the_list_call_is_scrum486s_with_no_params` |
| Query string → route | `GET /assigned` | `?includeFinished=` is mapped strictly: `true`, `false` or absent, anything else 400; the rest go to the service as they arrive | `SCRUM487_AC3_include_finished_%j_reads_its_statuses`, `SCRUM487_AC3_%s_is_400_and_queries_nothing`, `SCRUM487_AC3_the_query_string_reaches_the_read` |
| Service validation | `listAssignedEventsForLead` | A malformed `coordinatorId`, a status that is neither active nor finished (draft included) or a non-boolean `includeFinished` is a `ValidationError` before any query; a finished status while finished events are hidden is `[]` with no query | `SCRUM487_AC3_%s_is_refused_with_400_before_any_query`, `SCRUM487_AC3_asking_for_%s_while_finished_events_are_hidden_is_empty_and_makes_no_query` |
| The read | `listAssignedEventsForLead` | `.in('status', ACTIVE + FINISHED)` or `.eq('status', s)`; `.not('assigned_coordinator_id', 'is', null)`; `.eq('assigned_coordinator_id', id)`; earliest first, nulls last, then id | `SCRUM487_AC3_a_coordinator_filter_adds_one_eq_on_the_coordinator`, `SCRUM487_AC3_include_finished_adds_exactly_the_three_finished_statuses`, `SCRUM487_AC3_finished_events_are_hidden_unless_asked_for_and_a_draft_never_shows` (fake client); `SCRUM487_AC3_on_a_real_database_the_filters_and_include_finished_select_what_they_say` (PGlite) |
| The response | `GET /assigned` | A bare array, each row with both names and its `statusDisplay` | SCRUM-486's `SCRUM486_AC6_a_lead_reads_every_held_event_with_both_names_and_its_status_display` |
| The list | `AssignedEvents.jsx` | Rows in the server's order; "No events match these filters." when filtered and empty; a 400 said as "Those filters could not be applied." | SCRUM-486's `SCRUM486_AC6_each_row_names_the_event_organiser_coordinator_status_and_start`; `SCRUM487_AC3_with_filters_set_an_empty_list_says_the_filters_found_nothing`, `SCRUM487_AC3_a_refused_filter_is_said_in_the_pages_words` |

**Manual walkthrough.** Run by Calven in the browser on 13 October 2026, on the
SCRUM-487 branch at `afa8c82`, against the shared Supabase project.

| Check | What to see | Result |
|---|---|---|
| A | The Lead dashboard's "Coordinator overview" card says "See every coordinator's events and workload, and filter them, in Assigned Events." and links there | Passed (13 October) |
| B | At the top of Assigned Events, the number of requests waiting, in words, and "Open the Unassigned Queue" leading to the queue | Passed (13 October) |
| C | The Coordinators table: every coordinator, in name order; each status column headed with a word, not a key; each row's status columns add up to its Active events; zeros shown as 0 | Passed (13 October) |
| D | The events list, earliest event first | Passed (13 October) |
| E | The coordinator filter shows only that coordinator's events | Passed (13 October) |
| F | The status filter and "Include completed, rejected and cancelled": finished statuses offered only while ticked; unticking with a finished status chosen resets it to "All statuses" | Passed (13 October) |
| G | Open on a row: the event page has no Start review, decision, cancel, clarification or change-request action; the clarification and assignment histories are shown, the handover note with them; "Hand over to another coordinator" is shown | Passed (13 October) |
| H | Hand the event to another coordinator; back on Assigned Events, the row names the new coordinator and the two coordinators' counts have moved by one | Passed (13 October) |
| I | Signed in as an Event Coordinator, `/assigned-events` is refused | Passed (13 October) |

Check H reassigned a real test event in the shared project, through 052's
`reassign_event_request`, so its new coordinator and its organiser were notified
there (SCRUM-486 AC10), and the event's assignment history now records the Lead's
handover.

---

## 3. Design decisions

Each is argued, with the alternative it rejects. D1 to D8 were written before the
code, in the case document; they are carried here as they were decided.

### D1. Extend SCRUM-486's list, don't rebuild it

SCRUM-486's D12 (revised) built `/assigned-events` as the first slice of this
story's AC3 list, and AC3's own note says the same. So the filters, the finished
option and the counts were added to that read, that route and that page, and with
no options each behaves exactly as SCRUM-486 left it; SCRUM-486's tests of it pass
unedited.

*Rejected: a new overview page.* Two lists of the same events, built twice, able
to disagree about which events are active.

### D2. Filters run on the server

Finished events only grow: every event that completes, is rejected or is
cancelled stays one for good. Filtering in the browser would mean fetching every
finished event on every load to hide most of them.

*Rejected: fetch once and filter in the browser.* Fine for twenty events, wrong
for a list that only grows.

### D3. Per-status counts are a new Lead-only read that shares its counting with the picker

`listCoordinatorOverview` behind `GET /coordinator-overview` counts through
`readCoordinatorsAndActiveEvents`, the helper `listCoordinatorWorkload` (the
assignment picker, SCRUM-486 AC3) now uses too: the same coordinators, the same
events. "N active events" in the picker and a coordinator's total here are one
count. The helper takes its columns from the caller, because SCRUM-486 pins the
picker's select to exactly `assigned_coordinator_id`.

*Rejected: `byStatus` added to `/coordinator-workload`.* SCRUM-486 pins that
response exactly ("an extra key fails: no role, no recommended"): beside a choice,
a name and a number and nothing that reads as advice.

### D4. Safety review and Safety approved are not counted yet

They are not values of `event_request_status` until SCRUM-488, and naming an
unknown enum value in a PostgREST filter fails the whole read (22P02, which
`translateError` leaves untranslated: a 500 for a filter the server built, not a
400 for the caller). Every count, list, filter and column here is built from
`ACTIVE_EVENT_STATUSES`, so adding the two statuses there, which SCRUM-488 owns,
is all it takes. This story did not edit that constant.

*Rejected: naming them now.* It would break every read that uses the constant.

### D5. Unassigned requests are counted, not listed

The list stays held events only; the queue is where an unassigned request is
acted on. The count is the length of the queue's own read,
`listUnassignedEventRequests`.

*Rejected: a count route of its own.* A second definition of "unassigned" beside
the queue it links to. *Rejected: unassigned rows in the list.* Two kinds of row
with different actions.

### D6. The Lead reads handover notes: built, awaiting the team's confirmation

The ticket says "Team decision, to confirm", and as of 13 October 2026 the team
has not confirmed it. It is built: SCRUM-521 put `GET /:id/assignments/review`
behind `coordinatorOrLead` with `includeNotes: true`. Calven is raising it with
the team. If they decide against it, that one route's gate goes back to
`coordinatorOnly`, and AC5-03 changes with it. (The case document first recorded
this as confirmed. Nobody had confirmed it; SCRUM-545 corrected it.)

### D7. "Cannot confirm" holds because no confirm path exists

No API route moves an event to confirmed: `changeEventRequestStatus` is called by
no route, and no function sets `confirmed` from a request. There is nothing to
refuse, so AC5-11 is recorded as not testable, not as a test of an absence. When a
confirm route is built, its story owns the case that the Lead is refused it.

### D8. AC5's "cannot cancel" and SCRUM-539

SCRUM-539's first option would let the Lead cancel an *unassigned* request: the
dead end SCRUM-486 found, where a request nobody holds could be cancelled by
nobody. That does not contradict AC5. AC5 is about the events in this overview,
and every one of them is held (D5): the Lead opens a held event and cannot cancel
it, because `POST /:id/cancel` is `coordinatorOnly` and 045 admits only the
holder (`SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing`). An
unassigned request is in the queue, not here. If SCRUM-539 is built, the Lead's
cancellation is of a different thing, from a different page, and its own cases
say so.

### D9. The overview response carries its status labels

`GET /coordinator-overview` returns `{ statuses, coordinators }`. `statuses` is
`{ status, label, finished }` for every active status, then every finished one,
each label `getStatusDisplay`'s, the same source as every row's `statusDisplay`,
so a column heading and a status badge never give one status two names. The
screen heads the table's columns and fills the status filter from it, the finished
ones only while finished events are included.

Until SCRUM-546 the screen collected each status's word from an event row it had
loaded with that status, and fell back to the raw key (`pending_clarification`)
for a status no row had shown. A heading then depended on what the filters had
fetched, and a status nobody held was named in code. Changing the response cost
nothing: it was new in this story and nothing else read it. The same change took
the finished statuses' list out of the frontend, where `AssignedEventsFilters`
had kept a copy.

The words are the Organiser's ("Requested", "Awaiting your response",
"Planning"), the words already on every badge the Lead sees, here and on the
event page. Coordinator-facing words would be a change to the whole status
display, not this story.

*Rejected: collect labels from rows* (above). *Rejected: a label table in the
frontend*: a second copy of the vocabulary `eventRequestStatus.js` owns, which is
what `statusDisplay` exists to avoid.

### D10. Each of the page's three reads fails on its own

The count, the table and the list are three reads. A failed count says "The number
of waiting requests could not be loaded."; a failed table says "The coordinators'
workload could not be loaded."; and in both cases the rest of the page loads. One
failing read never takes the overview down, because each is useful alone.

Only the list's failure is a `role="alert"`; the other two are polite
`role="status"` messages, with loading words of their own ("Counting the requests
waiting for a coordinator...", "Loading coordinators..."). Two reasons. The list
is what the page is for, and the other two point elsewhere or summarise it. And
SCRUM-486's `AssignedEvents.test.jsx`, left unedited, finds the list's failure as
the page's one alert (`findByRole("alert")`) and its loading as the one
"Loading..."; it mocks only the list, so in those tests the other two reads fail.
A second alert or a second "Loading..." would have failed SCRUM-486's tests for a
reason that had nothing to do with them.

*Rejected: one loading and error state for the page.* A failed count would hide
the list.

### D11. The stale-response guard on the filters

Changing a filter twice in quick succession starts two reads, and they can answer
in either order. Each read checks it is still the latest before writing anything:
the effect's cleanup sets `ignore` when the next read starts. Without it, a slow
answer to the old filters could overwrite the new filters' rows, and the list
would show events the filters on screen say it should not.
`SCRUM487_AC3_a_stale_answer_never_overwrites_a_newer_one` answers the reads out
of order on purpose; removing the guard fails it.

*Rejected: disabling the filters while a read is in flight.* It makes the page
feel stuck and still leaves a refetch racing a navigation.

### D12. The name "Assigned Events" and `/assigned-events` are kept

The overview extends SCRUM-486's page (D1), and its heading says what it shows
("Every coordinator's events and workload."). Renaming the nav link to
"Coordinator overview" would rename SCRUM-485's and SCRUM-486's pinned nav tests
and the documents that name them, on a branch whose base PR (#52) was still in
review when this was decided. #52 was merged into dev on 13 October, so a rename
can now follow as a change of its own.

---

## 4. Known gaps, and technical debt

### Not done, or deferred to another story

| Gap | Detail | Owner |
|---|---|---|
| AC2 and AC3 partial | Safety review and Safety approved are not in the enum (AC2-12, AC3-18, D4) | SCRUM-488 |
| D6 awaiting confirmation | The Lead reads handover notes; built since SCRUM-521, not yet confirmed by the team | Calven, with the team |
| Labels are the Organiser's words | "Awaiting your response" heads a column a Lead reads (D9) | A change to the status display, if wanted |
| No live check of the overview | No `backend/scripts` live script calls `GET /coordinator-overview` or the filtered `GET /assigned`. The reads write nothing, so a live run would prove only the deployed schema; PGlite proves the SQL against the real migrations (`scrum487OverviewDatabase.test.js`) | Optional |
| The filtered list over PGlite uses its own adapter | The adapter in `scrum487OverviewDatabase.test.js` turns `eq`, `in`, `not is null` and `order` into SQL. It is not PostgREST: it proves the filters' meaning, not PostgREST's spelling of them | — |
| The count reads whole rows | `UnassignedCount` reads the queue to count it (D5). Short by nature; a `head` count would need a second definition | — |
| No refetch on focus | The overview reads on mount and on each filter change, not when the tab regains focus, as `AssignedEvents` did in SCRUM-486. A Lead coming back from the event page remounts it | — |

### Technical debt, left

- **`FINISHED_EVENT_STATUSES` lives in the service**, beside `ACTIVE_EVENT_STATUSES`,
  not in `domain/eventRequestStatus.js`, which owns the status vocabulary. Both
  sets belong there; moving them is a change to a file SCRUM-488 and SCRUM-489 are
  editing, so it was not made here.
- **The polite-status choice is tied to SCRUM-486's test selectors** (D10). It is
  also the right semantics, but if those tests change, the reason recorded here
  should be checked rather than assumed.
- **Copied test helpers.** `createFakeClient` is copied into both `scrum487…`
  backend files from SCRUM-486's, which copied its own; the event-request mocks in
  `scrum487LeadReadOnly.test.jsx` are copied from `CoordinatorRequestDetail.test.jsx`.
  Each copy was made so that no file under review in PR #52 changed. There are now
  two PGlite adapters for supabase-js, SCRUM-486's walkthrough's and this story's.
- **`AssignedEvents.jsx` is gated in `SCRUM486_FILES`** while most of its code is
  now SCRUM-487's. The gate is the same 100%, so nothing is lost, but a reader
  following ownership through `vite.config.js` will find it under the older story.

### Process notes

- **Test-first:** SCRUM-540's 56 cases were written and committed before any code,
  and each later subtask marked the cases it proved. The document was corrected
  twice in the open: D6 recorded as confirmed when it was not (SCRUM-545), and one
  cited name that was a family reference rather than a test (SCRUM-546).
- **Teeth checks:** every new test was checked by reverting the line it proves,
  watching it fail, and restoring it, for example the route moved below `GET /:id`,
  `confirmed` dropped from `byStatus`, the stale-response guard removed, the
  route's `includeFinished` guard removed, and a Lead shown Cancel event.
- **Briefs corrected by the code:** the shared helper takes its columns from the
  caller (SCRUM-486 pins the picker's select); 22P02 stays untranslated; two
  dashboard tests pinned the card's sentence, not three; there was no frontend
  service test for the list to keep unchanged.
- **Setup:** SCRUM-540 to SCRUM-542 were written in a separate git worktree, which
  was then removed in favour of one folder and one branch at a time.

---

## 5. Open questions for the team

1. **A coordinator filter with an id that is not a coordinator.** Returns `[]`, not
   404, which would tell anyone which ids are coordinators. **Decided** (SCRUM-542).
2. **Should the counts follow "include finished"?** No: AC2 counts active events,
   beside the picker's active counts. **Decided.**
3. **One status at a time, or several?** One, as a single `status` parameter;
   several can be added without breaking it. **Decided**, open to a later story.
4. **The Lead reads handover notes (D6).** **Open:** built, awaiting the team's
   confirmation.
5. **Safety statuses (D4).** Nothing to change in `FINISHED_EVENT_STATUSES` when
   SCRUM-488 adds them; they are active. **Decided.**
6. **The overview's name and address (D12).** "Assigned Events" at
   `/assigned-events`, kept. **Decided**; now that PR #52 is merged (13 October), a rename can follow as a change of its own.
7. **Status words in the table (D9).** The response carries them, in the
   Organiser's words. **Decided and closed** (SCRUM-546).

---

## Before the examination

- **Be ready for "why is AC2 partial?"** D4 in two sentences: the safety statuses
  do not exist in the database yet, and naming them would break the read; adding
  them to one constant, in SCRUM-488, finishes AC2 and AC3 with no change here.
- **Be ready for "how do you know the counts agree with the picker?"** D3: one
  helper for both, and
  `SCRUM487_AC2_active_events_is_the_sum_of_by_status_and_the_pickers_count`.
- **Be ready for "what stops a Lead approving an event?"** The six writes are
  `coordinatorOnly` (`SCRUM487_AC5_a_lead_is_refused_%s_with_403_and_queries_nothing`),
  and the screen never offers them (`SCRUM487_AC5_a_lead_sees_%s_read_only_with_only_the_hand_over_action`).
