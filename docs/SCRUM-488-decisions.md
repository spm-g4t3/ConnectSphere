# SCRUM-488 — Safety lifecycle decisions (SCRUM-549)

**Story:** Add the Safety Statuses and Transitions — Event Organiser / ConnectSphere Staff
**Subtask:** SCRUM-549, Confirm the safety lifecycle decisions and organiser-facing labels
**Written:** 14 October 2026, from the Jira stories and Confluence page named under *Sources*, and the code at `ae73949` (the head of `dev`).

This is the decision record SCRUM-549 asks for. **No decision here is confirmed.**
Every source calls its decision "to confirm" or lists it as open, and no Jira
comment exists on SCRUM-488, 549, 347 or 490. Nothing in this file may be read as
agreement. Where this file says *working assumption*, SCRUM-488's own text is the
only authority, and implementation follows it until someone with the authority
changes it.

## Sources

| Short name | Where | What it contributes |
|---|---|---|
| **488** | Jira SCRUM-488, AC2, AC5 and *Design decisions* | The transition table, the labels, the three open points |
| **549** | Jira SCRUM-549 | "Until a decision is recorded, implement only the transitions explicitly listed in SCRUM-488." |
| **347** | Jira SCRUM-347, *Reject an Approved Event*; no assignee, To Do, no Week 7 section | AC1: refused "in any other status"; design: "Only Approved events" |
| **363, 395, 370** | Jira, each with a *Week 7 changes* section | What each story assumes about the safety statuses |
| **489, 490** | Jira, the two safety workflow stories | The send-back and the open "reject" question |
| **Confluence** | *Week 7 Impact and Sprint 3 Scope* (SPM space, 6 October), sections 3 and 6 | "Decisions for the team" |
| **requirements** | [requirements.md](./requirements.md), section 6 | The customer's Operational Safety Check, summarised [W7 #6] |

I have not read the customer's Week 7 document itself, only its summary in
`requirements.md` and the quotations in the stories.

## Decision table

| # | Decision | Status | Documented decision owner |
|---|---|---|---|
| D1 | Two separate statuses, with the gate before Confirmed | **Working assumption, awaiting confirmation** | "Team decision, to confirm" (488). No person or role is named. |
| D2 | A safety send-back returns `safety_review` to `approved`, reasons recorded | **Working assumption, awaiting confirmation**; its meaning for "reject the safety arrangement" is an open customer question | The team, through the customer clarification process (Confluence §6). No person named. |
| D3 | Organiser labels "Safety check" and "Safety approved" | **Working assumption, awaiting confirmation** ("Labels to confirm", 488 AC5) | None named. |
| D4 | Whether rejection from a safety status is permitted | **Open. Not permitted until decided.** | SCRUM-347 (488: "left for SCRUM-347 to decide"). 347 has no assignee, so no person owns it. |

### D1. Two statuses, and the gate before Confirmed

**Working assumption.** `safety_review` and `safety_approved` are separate
statuses, and the order is Approved, Safety review, Safety approved, Confirmed.
`Approved → Confirmed` is removed.

Evidence:
- 488 *Design decisions*: "A separate Safety approved status makes the gate
  visible: Confirm can only follow it. The cost is one more status and
  transition. Team decision, to confirm."
- Confluence §6: "Safety statuses: two (Safety review, Safety approved) or one."
  It is listed under *Decisions for the team*.
- Placement: 490 *Design decisions* reads "confirmed arrangements" as an approved
  venue booking and an arranged equipment request, not the Confirmed status. 363
  says "The safety check sits before Confirmed. If the customer means after the
  Confirmed status, only the from-status here and the transition table in
  SCRUM-488 change." Both call it an assumption.
- The customer's wording (requirements §6): the check "runs after venue and
  technical arrangements are confirmed, and before the event can move to
  preparation." It does not say whether "confirmed" is the status.

Not documented: any confirmation that the customer accepts this placement. The
two sub-questions (one status or two; before or after Confirmed) are separate
and are confirmed separately.

If it changes:
- *One status instead of two:* a larger change. The enum values, the two lifecycle
  constraints, the display entries, both active lists, the tests that pin eleven
  statuses, and 489, 490 and 548 all change.
- *Gate after Confirmed:* `ALLOWED_TRANSITIONS`, `event_request_status_allows`
  and the 363 from-status change, as 363 and 490 already say.

### D2. The send-back from Safety review

**Working assumption.** `safety_review → approved` is valid. The reasons go in the
status history's `reason` field.

Evidence:
- 488 AC2: "Safety review → Approved: The Safety Officer sends the event back, with reasons."
- 490 AC7 (request changes) and AC8 (reject the safety arrangement) both end with
  "The status becomes Approved". 490 AC8 adds: "Whether a rejection should end
  the event instead is an open question."
- Confluence §6: "What the customer meant by 'reject the safety arrangement':
  send the event back to planning, or end it. Worth asking through the
  clarification process."
- requirements §6: the outcomes are approve, reject, or request changes; request
  changes "returns the event to the relevant earlier planning stage".

What this decides and what it does not:
- One transition serves both of 490's send-backs. The status history cannot tell
  "request changes" from "reject the safety arrangement". 490 AC9 gives each
  response its own immutable record, and that record is where the difference
  lives.
- "With reasons" is not enforced by the transition layer. The shared status
  function stores a reason when one is given (488 AC4: "the reason where one was
  given"), and a blank reason is stored as null. Requiring one is 490's job: its
  request-changes note and its rejection reason are both required.
- Only the listed rows exist. `safety_approved → approved` happens only through a
  significant change (395). The Safety Officer cannot send an approved event back,
  and a coordinator cannot withdraw a submission (489: "Team decision, to
  confirm"). 490 lists "after approval, arrangements can still change" as an
  open question.

If the customer meant that rejecting the safety arrangement *ends* the event, it
is a different transition (to Rejected or Cancelled) with different owners. It
would be added by a later story, not inferred here.

### D3. Organiser labels

**Working assumption.** `safety_review` shows as "Safety check", and
`safety_approved` as "Safety approved".

Evidence:
- 488 AC5: "Safety review as 'Safety check' and Safety approved as 'Safety
  approved'. Labels to confirm. The organiser never sees an internal status name."
- 489 AC8: "The organiser sees the event as 'Safety check'." 548 repeats both labels.
- Confluence §3: SCRUM-14 and SCRUM-318 stay Done, and "Labels are added by the
  safety statuses story."

Notes:
- The labels are one definition, `ORGANISER_STATUS_LABEL` in
  [eventRequestStatus.js](../backend/src/domain/eventRequestStatus.js). A changed
  word means one line there plus the tests that spell the label out (the SCRUM-487
  overview tests and the SCRUM-323 label table). 548 says its overview reads
  the same labels.
- 488 AC5 says the labels are "used by SCRUM-14", and 489 AC8 cites SCRUM-173.
  Both are Done or notification stories that read the same label, so the cited
  story is a documentation inconsistency, not a conflict in the wording.
- Internal groups are a separate choice, not a decision of this record. 548 suggests
  `UNDER_REVIEW` for `safety_review` and `APPROVED` for `safety_approved`, so no
  new CSS class is needed. That is a suggestion in a sibling subtask, not a
  recorded agreement.

### D4. Rejection from a safety status

**Open.** Until a decision is recorded, `safety_review → rejected` and
`safety_approved → rejected` are **not** valid, and nothing in the code or the
migrations may allow them.

Evidence:
- 488 *Design decisions*: "Whether an event in a safety status can be rejected
  (the Approved to Rejected move in SCRUM-318) is left for SCRUM-347 to decide."
- 347 AC1: the assigned coordinator can reject an event "that is Approved"; "An
  event in any other status is refused with a message stating its status." Its
  design decision is "Only Approved events." It has no Week 7 section and does not
  mention the safety statuses. That is the only text on the point, and it is a
  silence, not a decision.
- Confluence, SCRUM-347 row: "Decide whether an event in a safety status can be
  rejected. Otherwise no change."
- 549: "Coordinate with SCRUM-347 ... Until a decision is recorded, implement only
  the transitions explicitly listed in SCRUM-488."
- 488 AC2: "Every other transition in SCRUM-318 stays as it is", and AC3 refuses any
  other transition.

Why it stays open: 347's current wording would refuse a safety-status event only
as a side effect of how it was written, before the safety statuses existed. That
is not a decision to refuse it, and I have not treated it as one. Neither have I
treated its silence as permission.

If 347 decides to permit it, the change is two entries in `ALLOWED_TRANSITIONS`, a
later migration restating `event_request_status_allows`, 347's AC1 and its
release-arrangements path, and the test matrix. Rejection also carries a
decision, and the decided-status constraints already admit the safety statuses
(SCRUM-550), so no further constraint change is expected.

## What is implemented until a decision changes

Only the six rows of 488 AC2:

| From | To |
|---|---|
| `approved` | `safety_review` |
| `safety_review` | `safety_approved` |
| `safety_review` | `approved` |
| `safety_approved` | `confirmed` (replaces `approved → confirmed`, which is removed) |
| `safety_review`, `safety_approved` | `approved` (a significant change is accepted) |
| `safety_review`, `safety_approved` | `cancelled` |

Every other SCRUM-318 transition stays. Who may perform each one stays in the
story that performs it (488 AC8): 363, 395, 370, 489 and 490.

## Impacts on other stories

| Story (assignee) | Impact | Action needed |
|---|---|---|
| **SCRUM-363** Confirm (David Lee) | AC1's from-status is `safety_approved`, not `approved`. Its Week 7 text already says so. If D1's placement changes, only its from-status and this table change. Confirm is the last of three chains (venue, equipment, safety). | None for 488. 363's AC8 (original) says a changed event "must pass this same check"; the Week 7 section adds the safety check, so read the two together. |
| **SCRUM-395** Significant change (Tay Yu Rae) | Needs `safety_review → approved` and `safety_approved → approved`, which 488 adds. Its Week 7 text says the change "closes a pending safety review". | Question Q5: 490 AC9 lists three outcomes only. How a closed review is recorded is not defined. |
| **SCRUM-370** Cancel (Tay Yu Rae, Done) | Its Week 7 section allows cancelling from the safety statuses, and 488 adds `→ cancelled`. **The code does not yet agree**: `cancel_event_request` in `048_complete_event_cancellation_existing_arrangements.sql` refuses any status outside its five, so it would refuse a safety event with a 55000. | Question Q6. Not changed by 488's subtasks as written. |
| **SCRUM-548** Overview hand-off (David Lee) | Adds both statuses to `ACTIVE_EVENT_STATUSES` and the display entries. It uses D3's labels. | If D1 or D3 changes, 548 changes with it. |
| **SCRUM-489** Submit for check (Tan Zheng Yang Calven) | Needs `approved → safety_review`. It records the coordinator's note in the status history reason. "A submission cannot be withdrawn" is "Team decision, to confirm", which matches D2's table having no withdrawal row. | Q4. |
| **SCRUM-490** Review safety (Tay Yu Rae) | Uses `safety_review → safety_approved` and `safety_review → approved`. Its open questions overlap D2 and D4, and it keeps the request-changes/reject difference in its own response record. It should not rely on the status history for that. | Q2, Q3. |
| **SCRUM-347** Reject (no assignee) | Owns D4, and has nobody assigned to decide it. | Q1. |
| Booking and hold guards | Not in the lifecycle table, but they follow it: `bookingRequestService` and the SQL guards in `030`, `033`, `040` and `051` admit only `approved` and `confirmed`, so no new booking request can be made while an event is in a safety status. Not covered by any 488 subtask; no owner is documented. | Q7. |

## Questions that need a human

The owner column says who the sources point to, not who has agreed to answer.

| # | Question | Needed by |
|---|---|---|
| Q1 | Can the assigned coordinator reject an event in Safety review or Safety approved? Who owns SCRUM-347, since it has no assignee? | SCRUM-347 owner |
| Q2 | When the customer says "reject the safety arrangement", does the event return to planning (Approved) or end? Should we ask through the clarification process? | The team, then the customer |
| Q3 | Are "request changes" and "reject the safety arrangement" the same status change with two different records (490 AC9)? | The team |
| Q4 | Do we keep two statuses (Safety review and Safety approved), with the gate before Confirmed? | The team |
| Q5 | How is a pending safety review closed by a significant change (395) or a cancellation (370)? Is that a fourth outcome of 490's response record? | 395, 370 and 490 assignees |
| Q6 | Should `cancel_event_request` be extended to the safety statuses, and in which story, given SCRUM-370 is Done? | SCRUM-370 assignee and 488 |
| Q7 | Should booking requests be allowed while an event is in a safety status? | The team |
| Q8 | Are "Safety check" and "Safety approved" the labels an organiser should see? | The team |
