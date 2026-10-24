# SCRUM-387 — Test Cases

**Story:** Edit Event Information (E3) — Event Coordinator
**Subtask:** SCRUM-393 (this document)
**Schema:** `022_coordinator_edits_event_details.sql` (SCRUM-388), on top of 016's `notifications_type_known` list, 015's `reopen_event_request` and SCRUM-395's `event_change_history`.
**Written:** 25 October 2026. The brief asked for this document before the code; it was written after the migration, the field module and the routes had been drafted in the same session, and before their tests. Every case below was then proved by the tests SCRUM-389 and SCRUM-390 wrote.

This document is the written layer between SCRUM-387's acceptance criteria and the
Vitest files that implement them. The chain is **user story → acceptance criteria
→ test case → test class → code**. It is also where this story's decisions are
argued, with the alternatives rejected: the code's comments say why in a line or
two and point here (AGENTS.md).

---

## How case IDs relate to test names

Each case has a short stable ID (`AC3-01`) and an **Implemented by** column naming
every test that proves it. New tests are named `SCRUM387_ACn_…`. A case not yet
proved says so in bold. Traps, the places this story breaks if nobody tests them,
are marked **(trap)**.

| Short | File | Proves |
|---|---|---|
| pglite | `backend/tests/db/scrum387EditEventDetailsDatabase.test.js` | What `edit_event_request_details` does, on the full schema (`createSchemaDb()`), with statuses reached through the real workflow functions where they exist: who may edit what in which status, what is written and notified, and that a refusal changes nothing |
| route | `backend/tests/routes/scrum387EditEventDetailsRoutes.test.js` (fake client) | The gate on `PATCH /:id/details`, the caller from the token, the status and `code` each refusal arrives as, and who may read `GET /:id/change-history` |
| domain | `backend/tests/domain/eventDetailField.test.js` | The field and status lists against the built schema |
| validation | `backend/tests/validation/eventDetailsEditValidation.test.js` | SCRUM-10's field rules applied to an edit, every fault listed together |
| existing | `significantEventChangeDatabase.test.js`, `scrum489EquipmentArrangedDatabase.test.js` | That 022 leaves SCRUM-395's and SCRUM-489's paths as they were |

Which subtask writes each: SCRUM-389 (domain, and the pglite D2 case), SCRUM-390
(validation, route, and the rest of pglite).

---

## The story

> **USER STORY:** As the Event Coordinator assigned to an event, I want to edit its
> information directly, so that small corrections do not need the Organiser to
> raise a change request.

### Acceptance criteria

From the ticket and the brief, in substance.

1. Only the coordinator assigned to the event can edit it.
2. Under review and Pending clarification, any field can be edited. A request
   reopened after a rejection that still holds arrangements from before has its
   significant fields refused, with a message saying what it holds.
3. Approved, Safety review and Safety approved allow the ordinary fields only (name,
   purpose, description). A significant field is refused, pointing to the
   significant change process (SCRUM-395).
4. A Confirmed event refuses every edit.
5. Every other status is refused, with a message naming the status.
6. The values are held to SCRUM-10's rules, and every fault is listed together.
7. Each changed field is recorded (field, old value, new value, coordinator, time,
   reason) and the history can be read newest first by the Organiser, the assigned
   coordinator and the Lead.
8. The Organiser is notified.
9. A value that changed since the form was opened is refused.

---

## Case tables

Every refusal in the pglite file goes through `expectRefused`, which compares the
event row, its change history and its notifications before and after: a refusal
changes nothing.

### AC1 — only the assigned coordinator

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC1-01 | Under review, held by a coordinator | Another coordinator edits | 42501 (403); nothing changes | Proved (pglite): `SCRUM387_AC1_%s_is_refused_with_42501_and_nothing_changes` (another_coordinator) |
| AC1-02 | The same | The Lead edits | 42501 | Proved (pglite): the same test (the_Lead) |
| AC1-03 | The same | The event's Organiser; another Organiser | 42501 | Proved (pglite): the same test (the_organiser, another_organiser) |
| AC1-04 | The same | A null caller | 42501 | Proved (pglite): the same test (a_null_caller) |
| AC1-05 | Under review, then reassigned to another coordinator | The first coordinator edits | 42501; the new holder can edit | Proved (pglite): `SCRUM387_AC1_a_coordinator_reassigned_away_is_refused_with_42501` |
| AC1-06 **(trap)** | Confirmed; Draft | A stranger edits | 42501, not a message naming the status: the caller is checked before the status, so a stranger learns nothing about the event | Proved (pglite): `SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message` |
| AC1-07 | 022 applied | The grants | `edit_event_request_details`, `event_detail_value` and `refuse_event_change_history_mutation` not executable by anon or authenticated | Proved (pglite): `SCRUM387_AC1_the_functions_stay_closed_to_the_client_roles` |
| AC1-08 | Through the API | An Organiser, a Lead, Venue Staff, Technical Support, an Attendee, a Safety Officer, no role; no token | 403 at the gate, 401 without a token; nothing queried | Proved (route): `SCRUM387_AC1_%s_is_refused_with_403_by_the_gate_and_queries_nothing`, `SCRUM387_AC1_the_edit_answers_401_without_a_token` |
| AC1-09 | Through the API | The body names another coordinator | The function gets the token's user | Proved (route): `SCRUM387_AC1_the_caller_is_the_tokens_user_and_the_body_is_sent_normalised` |
| AC1-10 | Through the API | The function answers 42501; P0002 | 403; 404 | Proved (route): `SCRUM387_AC1_the_functions_%s_is_a_%s` |

### AC2 — any field in review; not while old arrangements are held

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC2-01 | Under review | Each of the nine fields, one per save | Saved; `changedFields` names it | Proved (pglite): `SCRUM387_AC2_%s_is_editable_under_review` (nine); (domain) `SCRUM387_AC2_names_a_real_event_requests_column_for_every_field` |
| AC2-02 | Pending clarification | Each of the nine fields | Saved; the status stays Pending clarification | Proved (pglite): `SCRUM387_AC2_%s_is_editable_pending_clarification` (nine) |
| AC2-03 | Approved with an approved booking, rejected, reopened with `reopen_event_request` (015), resubmitted, assigned, under review | A significant field | PT409 `EVENT_HOLDS_ARRANGEMENTS` (409), the message naming "1 venue bookings"; nothing changes | Proved (pglite): `SCRUM387_AC2_a_reopened_request_with_%s_refuses_a_significant_edit_and_names_it` (a_leftover_booking); (route) `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` (AC2) |
| AC2-04 **(trap)** | The same, holding only a venue hold | A significant field | Refused the same way, naming "1 venue holds": a hold is an arrangement too | Proved (pglite): the same test (a_leftover_hold) |
| AC2-05 | As AC2-03 | An ordinary field | Saved: the old arrangements are not touched by a name or description | Proved (pglite): `SCRUM387_AC2_a_reopened_request_still_takes_an_ordinary_edit` |
| AC2-06 **(trap)** | Under review, no arrangements | The start and end move | No equipment reservation flagged, no `equipment_request_changed` notice: 06's period triggers find nothing to act on | Proved (pglite): `SCRUM387_AC2_a_period_change_in_review_flags_no_equipment_and_tells_no_one_else` |
| AC2-07 | Through the API | A valid edit | 200 with the event, its `statusDisplay` and `changedFields` | Proved (route): `SCRUM387_AC2_the_coordinator_gets_the_event_back_with_the_fields_it_changed` |

### AC3 — ordinary fields only in planning and the safety check

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC3-01 | Approved (through `decide_event_request`); Safety review; Safety approved | Name, purpose and description in one save | Saved; the status unchanged | Proved (pglite): `SCRUM387_AC3_an_ordinary_edit_is_allowed_while_%s` (three) |
| AC3-02 | The same | Expected attendance | PT409 `SIGNIFICANT_CHANGE_REQUIRED` (409), the message pointing to the significant change process | Proved (pglite): `SCRUM387_AC3_a_significant_edit_is_refused_while_%s` (three); (route) `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` (AC3) |
| AC3-03 **(trap)** | Approved | A name and venue requirements in one save | Refused whole: the name is not written either | Proved (pglite): `SCRUM387_AC3_a_mixed_save_in_planning_is_refused_whole` |
| AC3-04 | — | The lists | Three ordinary, six significant, nine in all; the five editable statuses are real statuses | Proved (domain): `SCRUM387_AC3_splits_the_nine_fields_into_three_ordinary_and_six_significant`, `SCRUM387_AC3_the_status_lists_are_real_statuses_with_review_inside_planning`; (pglite) `SCRUM387_AC7_the_field_list_is_the_one_the_domain_module_names` refuses each significant field in Approved |

### AC4 — Confirmed refuses everything

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC4-01 **(trap)** | Confirmed | The event name | PT409 `EVENT_CONFIRMED` (409), the message pointing to the significant change process, which returns it to Approved; nothing changes | Proved (pglite): `SCRUM387_AC4_a_confirmed_event_refuses_even_an_ordinary_field`; (route) `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` (AC4) |

### AC5 — every other status

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC5-01 | Submitted (assigned, review not started); Rejected; Cancelled; Completed | The holder edits the name | PT409 `EVENT_STATUS_NOT_ALLOWED` (409), the message naming the status | Proved (pglite): `SCRUM387_AC5_an_event_that_is_%s_is_refused_naming_its_status` (four); (route) `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` (AC5) |
| AC5-02 | Draft | Anyone edits | 42501: a draft has no coordinator (015 clears it), so every caller is a stranger (AC1-06) | Proved (pglite): `SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message` (draft) |

### AC6 — SCRUM-10's rules, every fault together

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC6-01 **(trap)** | — | A blank name, an unknown field, a past start, attendance 0, a missing and a mistyped expected value, a blank reason | One 400 listing every one of them; nothing queried | Proved (validation): `SCRUM387_AC6_lists_every_fault_together`; (route) `SCRUM387_AC6_every_fault_is_listed_in_one_400_and_nothing_is_queried` |
| AC6-02 | Under review | Only an end before the stored start; an end before a start sent with it | 22023 (400) from the function, naming proposedEnd; the validator's own fault when both are sent | Proved (pglite): `SCRUM387_AC6_an_end_before_the_stored_start_is_refused_with_22023`; (validation) `SCRUM387_AC6_an_end_before_a_start_sent_with_it_is_refused` |
| AC6-03 | Under review | Every value equal to the stored one (the start written in +08:00, the purpose padded) | 22023 "No changes" | Proved (pglite): `SCRUM387_AC6_a_save_with_no_real_change_is_refused_with_22023` |
| AC6-04 | Under review | An unknown field; no field | 22023 | Proved (pglite): `SCRUM387_AC6_%s_is_refused_with_22023` (an_unknown_field, no_field_at_all); (validation) `SCRUM387_AC6_%s_is_refused` (no_changes_object, an_empty_changes_object) |
| AC6-05 | Under review | No reason; a blank one; one that is not text; 4,001 characters | 22023 (pglite); a `reason` fault (validation). 4,000 characters, counted as code points, is accepted | Proved (pglite): `SCRUM387_AC6_%s_is_refused_with_22023` (three reasons); (validation) `SCRUM387_AC6_%s_is_refused` (a_reason_over_4000_characters), `SCRUM387_AC6_a_reason_that_is_not_text_is_refused`, `SCRUM387_AC6_a_reason_of_exactly_4000_characters_is_accepted` |
| AC6-06 | — | Clearing the name, which submission requires | A fault on eventName; an optional field may be cleared with null | Proved (validation): `SCRUM387_AC6_a_field_submission_requires_cannot_be_cleared`, `SCRUM387_AC6_returns_the_changes_normalised_and_the_reason_trimmed` (description null) |
| AC6-07 | Under review | A changed field with no expected value | 22023 (pglite); an `expected.<field>` fault (validation) | Proved (pglite): `SCRUM387_AC6_%s_is_refused_with_22023` (a_field_with_no_expected_value); (validation) `SCRUM387_AC6_%s_is_refused` (no_expected_object) |
| AC6-08 | Through the API | The function answers 22023 | 400 with its message | Proved (route): `SCRUM387_AC6_the_functions_%s_is_a_400_with_its_message` |
| AC6-09 | — | Padded values and reason | Sent to the function trimmed | Proved (validation): `SCRUM387_AC6_returns_the_changes_normalised_and_the_reason_trimmed`; (route) `SCRUM387_AC1_the_caller_is_the_tokens_user_and_the_body_is_sent_normalised` |

### AC7 — the change history

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC7-01 | Under review | Purpose and attendance changed, description sent unchanged | Two rows: field, typed old and new values, the coordinator, the trimmed reason, `source = 'direct_edit'`, a time. None for description | Proved (pglite): `SCRUM387_AC7_one_row_per_changed_field_with_old_new_who_why_and_source` |
| AC7-02 **(trap)** | Approved | A significant change through `apply_significant_event_change` (SCRUM-395, unchanged) | Its rows read `source = 'significant_change'`: the column's default fills 395's insert | Proved (pglite): `SCRUM387_AC7_a_significant_changes_rows_are_still_written_as_significant_change`; (domain) `SCRUM387_AC7_the_history_sources_are_the_three_022_declares` |
| AC7-03 | Through the API | The Organiser; the assigned coordinator; the Lead read `GET /:id/change-history` | 200, newest first (`changed_at` desc, then `id` desc), with the editor's name; a field filled in or cleared reads null on its empty side; an event never edited reads `[]`; a failed read is a 500, not `[]` | Proved (route): `SCRUM387_AC7_the_organiser_reads_the_history_newest_first_with_names`, `SCRUM387_AC7_%s_reads_the_history`, `SCRUM387_AC7_a_field_filled_in_or_cleared_reads_null_on_the_empty_side`, `SCRUM387_AC7_an_event_never_edited_has_an_empty_history`, `SCRUM387_AC7_a_failed_read_is_not_reported_as_an_empty_history` |
| AC7-04 | Through the API | Another Organiser, an unassigned coordinator, a Safety Officer, Venue Staff | 404, as a missing id | Proved (route): `SCRUM387_AC7_%s_gets_a_404` |
| AC7-05 **(trap)** | A history row | Update it; delete it | 42501 from the trigger; the row unchanged | Proved (pglite): `SCRUM387_AC7_a_history_row_cannot_be_%s` |
| AC7-06 | Under review | All nine fields in one save | All nine named in `changedFields`; each significant one refused in Approved; every name accepted by `event_change_history_field_known` | Proved (pglite): `SCRUM387_AC7_the_field_list_is_the_one_the_domain_module_names`; (domain) `SCRUM387_AC7_every_field_is_a_name_the_change_history_accepts` |

### AC8 — the Organiser is told

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC8-01 | Under review | Two fields in one save | One `event_details_changed` notice, to the Organiser, carrying the event, its new name, the reason, the changed fields and the status | Proved (pglite): `SCRUM387_AC8_one_notice_to_the_organiser_per_save_with_the_fields_and_reason` |
| AC8-02 | Safety review | An ordinary edit | No notice to any Safety Officer; the Organiser's one | Proved (pglite): `SCRUM387_AC8_an_edit_in_safety_review_tells_no_safety_officer` |

### AC9 — a value changed since the form opened

| Case | Preconditions | Action | Expected result | Implemented by |
|---|---|---|---|---|
| AC9-01 | Under review | The expected purpose is not the stored one | PT409 `EVENT_CHANGED_SINCE_OPENED` (409), naming purpose; nothing written | Proved (pglite): `SCRUM387_AC9_a_stale_value_is_refused_with_409_and_nothing_written`; (route) `SCRUM387_%s_%s_is_a_409_with_its_code_and_message` (AC9) |
| AC9-02 **(trap)** | Pending clarification, the form opened | The Organiser's clarification reply amends the purpose, then the coordinator saves | Refused as stale; the Organiser's words stand | Proved (pglite): `SCRUM387_AC9_an_organisers_amendment_after_the_form_opened_makes_the_save_stale` |
| AC9-03 | Under review | The expected start is the stored instant written in +08:00 | Not stale: values are compared typed, not as text | Proved (pglite): `SCRUM387_AC9_the_same_instant_in_another_zone_is_not_stale` |
| AC9-04 | — | An expected start that is not a date; an expected purpose that is not text | A fault on each `expected.<field>`; a valid expected instant sent trimmed | Proved (validation): `SCRUM387_AC9_each_expected_value_is_checked_as_its_field_is_typed` |

---

## Design decisions

### D1. One function does the whole save

`edit_event_request_details` (022) locks the row, checks the caller, the status and
the expected values, writes the fields, the history rows and the notice, in one
transaction. *Rejected: checks in Express, then an update*: the checks would read
a row another save could change before the write.

### D2. One field list, kept in step by a test

`backend/src/domain/eventDetailField.js` names the nine fields; the function holds
the same nine as its column map. The pglite case AC7-06 sends every field the module
names to the function and checks the significant ones are refused in planning;
AC6-04 sends one it does not know. *Rejected: reading the list from the database at
run time*: one more query on every save for a list that changes with a migration.

### D3. The status matrix

| Status | Ordinary | Significant |
|---|---|---|
| Under review, Pending clarification | Yes | Yes, unless arrangements are held (D4) |
| Approved, Safety review, Safety approved | Yes | No: SCRUM-395 |
| Confirmed | No (D9) | No: SCRUM-395 |
| Anything else | No | No |

The safety statuses allow ordinary edits: a name or description does not change
what the Safety Officer reviews.

### D4. Leftover arrangements refuse significant edits

A request rejected after arrangements were made, then reopened (015 releases
nothing) and resubmitted, can be under review while still holding them. Moving its
date or attendance would leave them describing another event. The function counts
the five kinds of arrangement `event_cancellation_impact_preview` (013) counts as
still held (approved or flagged bookings, pending or conflicting booking requests,
active holds, equipment requests not cancelled, equipment reservations not
released) and names each kind it finds. Equipment is counted too: 06's
`equipment_notify_event_period_changed` would otherwise fire on a review-time edit.
*Rejected: releasing them*: changes flag and notify, and never un-book (AGENTS.md).

### D5. A reason is required, 1 to 4,000 characters

Checked in the validator and again in the function, counted in code points.

### D6. Reuse `event_change_history`

SCRUM-395's table, widened to accept the ordinary field names. *Rejected: a second
history table*: the Organiser would read two histories for one event.

### D7. The history read rule is `getEventDecisionHistory`'s

The Organiser, and once past draft a Lead or the assigned coordinator; anyone else
404. Both reads share `requireHistoryReader`.

### D8. One notice per save

`event_details_changed`, to the Organiser, naming every field the save changed.
*Rejected: one per field*: a five-field save would be five notices.

### D9. Confirmed refuses even ordinary fields

A confirmed event is what has been announced; any change goes through SCRUM-395,
which returns it to Approved.

### D10. No Safety Officer notice

Ordinary fields are all a safety status allows, and they do not change what is
reviewed.

### D11. A new route, `PATCH /:id/details`, coordinatorOnly

Not a branch of the Organiser's `PATCH /:id`, so each owner's rules sit on their
own URL. The function checks the caller again under the lock.

### D12. Compare-and-set, refused with 409

The form sends the value it showed for each field it changes (`expected`). The
function compares them with the stored values under the lock, typed through
`event_detail_value` (instants as instants, attendance as a number, text trimmed
with blank as null), and refuses a stale one, naming it.

### D13. Append-only history with a source

A trigger refuses update and delete on `event_change_history`. A `source` column
(`significant_change`, the default, so 395's insert is unchanged; `direct_edit`;
`change_request`, reserved for SCRUM-402) says which path wrote each row.

---

## What cannot be tested as written

- **Two saves racing.** PGlite is one connection, so AC9's cases run their two
  writes in sequence. The row lock and the compare-and-set under it are the
  argument.

---

## Tally

45 cases, counted from the tables: **45 proved**; 0 not yet implemented; 0 that
cannot be written as specified. Nine are traps.

| Section | Cases |
|---|---|
| AC1 | 10 |
| AC2 | 7 |
| AC3 | 4 |
| AC4 | 1 |
| AC5 | 2 |
| AC6 | 9 |
| AC7 | 6 |
| AC8 | 2 |
| AC9 | 4 |
