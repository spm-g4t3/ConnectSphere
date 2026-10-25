# SCRUM-310: Handle Equipment Lost After Reservation

**Story:** Handle Equipment Lost After Reservation - Technical Support Staff
**Closing subtask:** SCRUM-317 (this document)
**Status as of 25 October 2026:** built and tested; all eight criteria proved (section 1). The live walkthrough (section 2) passed on the shared Supabase project on 25 October 2026, run by SL.

This document is the record of what SCRUM-310 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The examination chain is **user story → acceptance criterion → test case
→ test → code**.

The case-by-case mapping is `docs/test-cases/SCRUM-310.md`: 76 cases, each naming the
tests that prove it. Every test ID is in `docs/test-cases/SCRUM-310-test-ids.md`.

**The short version, for anyone asked "what changed?":** when Technical Support
Staff damage some units, take some out for maintenance, lower the total or retire
a type, the app now checks that change against every reservation of that type that
has not ended. If any would lose its equipment, a list of them appears (event,
period, quantity, coordinator) and nothing is saved until the staff member confirms
that exact list. The oldest reservations keep their equipment. On confirmation the
change is saved and the reservations that no longer fit are flagged as equipment unavailable
in one transaction; their equipment requests go back to Pending review, their
coordinators are told, and the change and each flag record who did it, when and why.
The coordinator sees the affected line on the event record, and a Confirmed event stays
Confirmed but shows under Needs attention with the reason. A change that affects
nothing saves directly.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-311 | `equipment_over_commitment` (020): which reservations a lower usable quantity cannot keep, oldest first, by a sweep over time | not yet committed |
| SCRUM-312 | `POST /api/equipment/:id/change-preview` and its service and validation: the check, read only | not yet committed |
| SCRUM-313 | `apply_equipment_change` (021): the confirmed save, one transaction, refused with the new list if the confirmed list is not the current one; the old silent trigger dropped; `PATCH /:id`, `PATCH /:id/condition` and `POST /:id/retire` use it | not yet committed |
| SCRUM-314 | The confirmation step on the catalogue: the list, Confirm and Go back, the refused-save notice, the retire flow, the double-press guards (`useConfirmedChange`, `EquipmentImpactConfirmation`) | not yet committed |
| SCRUM-315 | The coordinator's side (023): each line's flagged reservations on the event record, the flag's kind (`flag_code`), `needsAttention` reasons on the event reads, the reasons beside the badge | not yet committed |
| SCRUM-316 | Every test named `SCRUM310_ACn_…`, and `scrum316FourChangesDatabase.test.js`: each of the four changes through the whole flow | not yet committed |
| SCRUM-317 | This document, the test-case document and the test ID list | not yet committed |

### Verification as of 25 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npx vitest run --maxWorkers=4` in `backend`) | 8225 passing, 2 todo, across 185 files |
| Frontend suite (`npx vitest run` in `frontend`) | 3990 passing across 167 files; `npm run lint` 0 errors (23 warnings, all the existing `react-hooks/set-state-in-effect` ones) |
| SCRUM-310's own tests | 511 test titles named `SCRUM310_ACn_…` across 21 files (once parameterised cases are expanded there are more runs than titles) |
| PGlite | Three database files run 020, 021 and 023 on a real Postgres over the full migration stack: the calculation, the confirmed save, the flags and the walkthrough from a real loss to the coordinator's views |
| Live database | 020, 021 and 023 applied to the shared Supabase project for the walkthrough (section 2). The release order for others is in section 4 |
| Test-case document | 76 cases: **76 proved**, 0 not yet implemented |

**Teeth checks.** Each new test was checked by breaking the line it proves,
watching it fail, and restoring the file. SCRUM-316's file:

| What was broken | What failed |
|---|---|
| Oldest-first ordering reversed in 020 | 15 of 35 |
| Ended reservations counted in 020 | 1 (the retirement case; the other three changes cannot list an ended reservation that fits alone, and the calculation tests cover it) |
| The flag event written with no user in 023 | 4 |
| The request not returned to Pending review in 023 | 4 |
| 021 flagging an empty list instead of the confirmed one | 12 |

SCRUM-314 and SCRUM-315 were checked the same way as they were built. Three
frontend misses in 314 (cancel not dropping a late answer, a stale error kept on a
plain save, an unreachable guard) were fixed with new tests and by deleting the dead
guard. Two survivors in 315 are equivalent mutants of the one-off backfill.

---

## 1. Acceptance criteria

| AC | Criterion | Cases | Evidence |
|---|---|---|---|
| 1 | The change is checked against reservations that have not ended | AC1-01 to AC1-10 | `equipment_over_commitment` counts held, unended reservations of the type, including those under way and on events of any status; the four changes each reach it |
| 2 | The affected reservations are shown and a confirmation is needed; otherwise nothing is saved | AC2-01 to AC2-11 | The save refuses unless the confirmed list is exactly the current one, and returns the new list; the screen shows the list and saves nothing until Confirm |
| 3 | First come, first served | AC3-01 to AC3-10 | The sweep takes reservations in the order they were made (ties by id); a brute-force comparison over random cases |
| 4 | The change and the flags are one action; requests return to Pending review | AC4-01 to AC4-13 | `apply_equipment_change` saves and flags in one transaction; forced failures change nothing |
| 5 | The coordinator is notified (SCRUM-176) and the event record shows the affected lines | AC5-01 to AC5-11 | The `equipment_flagged` notice per affected event; `equipment_for_event` carries each line's flagged reservations |
| 6 | A Confirmed event stays Confirmed but needs attention | AC6-01 to AC6-07 | No write to the event; `needsAttention` and `attentionReasons` are worked out from live flags |
| 7 | A change that affects nothing saves directly | AC7-01 to AC7-07 | The same function saves with an empty list; the screen skips the list |
| 8 | The change and each flag record the user, time and reason | AC8-01 to AC8-07 | One history row per changed field; one flag event per reservation, with the user and reason |

### Dependencies on other stories

| Story | Status | What this story relies on | Consequence |
|---|---|---|---|
| SCRUM-176 | Done | The `equipment_flagged` notice and its wording in the inbox | AC5's notice is proved here at the database. Its inbox wording is SCRUM-176's own tests. Nothing waits on 176 |
| SCRUM-266 | Done | The Needs attention badge on the coordinator's events | AC6 is proved here for equipment flags. The badge and the venue-booking reason are 266's. Nothing waits on 266 |
| SCRUM-395 | Done | The date-change flow, which flags reservations through the older flagging function | Its flags are shown as "flagged for review", not "equipment unavailable" (D6) |

---

## 2. Traceability: a loss, end to end

1. Technical Support Staff edit a type on the catalogue (damage 6 of 10) and press
   Save. The screen calls `POST /api/equipment/:id/change-preview` (AC1).
2. The service works out the usable figure and calls `equipment_over_commitment`
   (020). It returns the reservations that no longer fit, newest first to lose (AC1, AC3).
3. The screen shows the list with the figures and asks for confirmation. Go back
   saves nothing (AC2).
4. Confirm calls `PATCH /:id/condition` with the list that was shown. The service
   calls `apply_equipment_change` (021).
5. That function locks the type row, recalculates, and compares the list with the
   confirmed one. If they differ it writes nothing and returns the new list; the API
   answers 409 `EQUIPMENT_AFFECTED_CHANGED` and the screen shows the new list (AC2).
6. If they match it saves the change, writes a history row (AC8), flags each
   reservation with the code `equipment_lost` and a flag event with the user and
   reason (AC8), and returns each request to Pending review (AC4). The flag raises
   the existing notice to the event's coordinator (AC5).
7. The coordinator opens the event: the equipment section marks the affected line with
   the period and the reason (AC5). A Confirmed event still reads Confirmed and
   appears under Needs attention with "Equipment unavailable: …" (AC6).
8. A change that affects nothing skips step 3 and saves at step 4 with an empty
   list (AC7).

**Manual walkthrough: passed, 25 October 2026 (SL).** Two events held 3 of 10 units
each; a third request was added while the list was open. Results: damaged 2 saved
directly (AC7); damaged 7 listed the newer event only and Go back saved nothing
(AC1 to AC3); Confirm after the third reservation was refused with the new list,
then saved (AC2); the coordinator saw the reasons beside the badge on My events
and the lines marked on the event record, the Confirmed event stayed Confirmed
(AC5, AC6); both requests were at Pending review (AC4); the history and flag
queries showed the user, time and reason with the note (AC8).

---

## 3. Design decisions

### D1. One database function checks and saves

`apply_equipment_change` recalculates under a row lock on the type and writes in the
same transaction. The check (020) is a separate read-only function so the preview
can use it.

*Rejected: the API doing the check then the save as two calls.* A reservation made
between them would be flagged or missed without anyone confirming it.

### D2. A confirmation is the exact list, not "yes"

The save takes the ids that were shown and refuses unless they equal the current
list. Order and repeats do not matter. A refusal hands back the new list so one more
Confirm completes it.

*Rejected: confirming a count, or a version number on the type.* A count cannot say
which reservations changed; a version would refuse changes that leave the list as it
was.

### D3. First come, first served by the time a reservation was made

The sweep takes reservations in `created_at` order (ties by id) and keeps each one
that fits beside those already kept. A lost reservation takes up no room for later
ones. An already flagged reservation takes part like any other.

*Rejected: the old trigger's rule, which flagged every reservation in an
over-committed period.* It flagged the oldest too and ran without anyone confirming.

### D4. Flag, never release

The reservation is flagged and its request returns to Pending review. The
coordinator decides what happens next (move, reduce or release it through the
existing review actions).

*Rejected: releasing the reservation.* It would delete the coordinator's decision
for them and lose the quantity they need to rebuild.

### D5. The silent trigger is dropped

021 drops `equipment_flag_on_type_unusable`. A plain update of a type now flags
nothing; only `apply_equipment_change` does, so every flag has a confirmation and a
user behind it.

### D6. A flag has a kind: `flag_code`

A reservation is flagged for several reasons (equipment unavailable; the event's date or
time changed; a line edited). `flag_reason` is text for a person, and the first
version told them apart by that text. 023 adds `flag_code` (`equipment_lost` or
null), set where the flag is set, cleared when the flag is cleared (a trigger), and
backfilled once from the two reasons the earlier code wrote.

Needs attention counts **any** flagged, unreleased equipment reservation on a
Confirmed event, because any of them needs the coordinator. The **label** depends on
the code: "Equipment unavailable" only for `equipment_lost`, otherwise "Equipment flagged
for review".

*Rejected: reading the reason text.* A reworded reason would silently change what
the screen calls a flag. *Rejected: counting only `equipment_lost` flags.* A
date-change flag would then not need attention.

### D7. Needs attention is worked out, not stored

`needsAttention` and `attentionReasons` come from the live flags every time the
event is read, so the mark goes the moment the last flag is cleared or released.
Equal reasons are shown once; a venue flag and an equipment flag both appear.

*Rejected: a stored column on the event.* It could drift from the flags and would
need a write to the event, which AC6 forbids.

### D8. The event is never written

Nothing in the flow changes the event's status. A Confirmed event stays Confirmed;
only the equipment request returns to Pending review.

### D9. Retirement is the same flow, with zero usable

Retiring is a change to zero usable units. It lists every held, unended reservation,
and if none, the existing confirm-only step applies. A second retirement is a 409.

### D10. The notice is SCRUM-176's

The flag raises the notice the equipment flow already had. This story adds no new
notice type; it proves the notice fires once per affected event with the reason.

### D11. The label says "unavailable", not "lost"

The ticket's title and AC4 say "equipment lost", meaning the reservation lost its
units. Damage, maintenance, a lower total and a retirement all lead to that, and
only some of them mean the equipment is gone. The screens say **"Equipment
unavailable"** (the confirmation, the coordinator's line and the Needs attention
reasons); the reason text says which change it was. The stored code stays
`equipment_lost`, because it is internal and a rename would need a migration for
no gain. Decided by SL, 25 October 2026, after the walkthrough.

---

## 4. Known gaps, and technical debt

### Not done, or deferred

| Gap | Detail | Owner |
|---|---|---|
| The real PostgREST embed | Checked in the walkthrough: My events showed the reasons beside the badge on the real Supabase project | Closed |
| The inbox wording | The notice's text in the inbox is SCRUM-176's. Not re-tested here | SCRUM-176 |
| A true race | Two staff saving at once is proved by the row lock's presence and by simulating the second save, not by two live connections | none |
| No coordinator filter page | Needs attention is a badge and reasons on the existing lists; a filtered list is SCRUM-266's | none |

### Technical debt, left

- **Three 313 database tests changed** when `flag_equipment_reservations_by` gained a
  fourth argument (`p_code`, default `equipment_lost`): the signature list and the
  forced-failure replacement. They still pin every value they pinned.
- **The older `flag_equipment_reservations`** stays as a wrapper that passes no user
  and no code, because the date-change flow calls it.
- **The one-off backfill** reads the two reasons the earlier code wrote. It is
  re-runnable and recodes nothing that already has a code.

### Release notes

- Paste `020`, `021`, `023` into the live database **in that order**, after whatever
  of the team's migrations (018, 019, 022) live does not have yet. They are numbered
  above dev's highest at the time.
- **Deploy the API in the same window.** After 021 the silent trigger is gone, so an
  old API that saves a damage change would save it with no check and flag nothing.
  A new API before 021 would call functions that do not exist.
- Do not paste anything until the team's release is agreed.

---

## 5. Open questions for the team

1. **Needs attention and the flag's kind (D6).** Any flag counts; the label follows
   the code. **Decided** by SL, 25 October 2026.
2. **Notice per reservation or per event (D10).** Built as one per affected event,
   with the reason. **Open** only if the coordinators want one per reservation.

---

## Before the examination

- **Be ready for "why must the staff member confirm the exact list?"** D2: the list
  can move between the preview and the save (a booking made, a release). Confirming
  "yes" would flag people nobody saw. Evidence:
  `SCRUM310_AC2_a_reservation_made_after_the_preview_makes_the_old_confirmation_stale`
  and `SCRUM310_AC2_a_confirmed_list_with_an_extra_reservation_is_refused`.
- **Be ready for "who loses their equipment?"** D3: the newest. Evidence:
  `SCRUM310_AC3_of_two_overlapping_reservations_the_older_is_kept` and
  `SCRUM310_AC3_the_newer_reservation_is_the_one_that_loses_its_units` (once per change).
- **Be ready for "does the event change?"** D8: never written. Evidence:
  `SCRUM310_AC6_an_event_that_is_%s_keeps_that_status_when_its_equipment_is_flagged`.
- **Be ready for "what if the save half-fails?"** D1: one transaction. Evidence:
  `SCRUM310_AC4_a_forced_failure_while_flagging_changes_nothing`.
