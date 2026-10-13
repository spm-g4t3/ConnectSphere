# ConnectSphere Release 1 — Requirements Summary

A condensed, source-tagged summary of what the customer asked for. Read only the
section for the area you are working on. Where a rule here and the code disagree,
raise it; don't silently pick one.

**Precedence:** Week 7 changes > Week 4 clarifications > Week 2 clarifications > Week 1 briefing.
The customer expects **no further changes for Release 1** [W7].

**Sources:**
- [W1] Week 1 Customer Briefing
- [W4] Week 4 Project Instructions (the 20 core features)
- [W7 #n] Week 7 Customer Changes
- [C2] Week 2 clarifications
- [C4] Week 4 clarifications

## 1. Product and roles
ConnectSphere replaces email, spreadsheets and shared calendars with one platform for event requests,
venue booking, equipment and attendee registration [W1 §2]. The core problems it solves:
- double-booked venues and equipment;
- too little setup or turnaround time between events;
- changes that never reach the affected staff;
- not knowing who changed what, and when.

| Role | Key | Does |
|---|---|---|
| Event Organiser (external) | `event_organiser` | Creates, drafts and submits requests. After submission, changes only through the Coordinator [C4]. |
| Event Coordinator | `event_coordinator` | Reviews, clarifies, approves or rejects; books venues; records equipment; confirms or cancels. Edits **only events assigned to them**; may view others [C4][W7 #5]. |
| Event Coordinator Lead | `event_coordinator_lead` | Sees the unassigned queue, assigns and reassigns, sees all assignments and active events [W7 #5]. |
| Venue Staff | `venue_staff` | Venue catalogue (create, edit, delete), blocks, booking decisions, tentative holds [C4][W7]. |
| Technical Support Staff | `technical_support_staff` | Equipment catalogue and status, availability checks, request review, reservations [W4][C4]. |
| Safety Officer | `safety_officer` | Operational Safety Check: approve, reject or request changes [W7 #6]. |
| Attendee (external) | `attendee` | Views events, registers, checks status, withdraws [W4]. |

- **Accounts and roles:**
  - One user may hold several roles [C4].
  - There is no admin role, self-registration or organisation onboarding; assume users and organisations already exist in the DB [C4].
- **Visibility:**
  - Organisers see only their own organisation's events, never unrelated clients' events [W1 §8b][C4].
  - Attendees never see internal planning data [W1 §8b].
- **Not in Release 1:** export/print, the maintenance workflow, reports, recurring events, attachments [W4][C4].

## 2. End-to-end workflow [W1 §5, as changed by W7]
1. Draft
2. Submit
3. **Lead assigns a Coordinator** (from the unassigned queue)
4. Review and clarification
5. Approve or reject
6. Venue search and suitability
7. Venue booking request, then Venue Staff decide
8. Equipment request, then Tech Support review and reserve
9. **Operational Safety Check**
10. Preparation
11. Confirm
12. Registration
13. Changes
14. Delivery
15. Completed

Features must work together across this flow. For example, bookings and reservations follow the event's dates,
and changes ripple to bookings, equipment, registration and notifications [W4].

## 3. Cross-cutting rules (apply everywhere)
- **Changes flag, never destroy.** Changes that affect arrangements flag them for review and notify staff.
  - Nothing is auto-cancelled or un-booked; the Coordinator decides and records the outcome [C2][C4][W7 #1, #2].
- **Significant changes** are date, time, attendance, venue and equipment; all other edits are ordinary [C4]. The team may add more fields if a story needs them [C4].
- **After Confirmed:** fields lock. Changes go through a change request, and a major change can return the event to planning [C4].
- **Auditability:** important actions record who, what and when [W1 §8f]. Coordinator and Organiser can view change history [C4].
- **Notifications:**
  - The channel is the team's choice; in-app is fine [C2].
  - Cover submission, assignment, clarification, approve/reject, booking decisions, equipment outcome, confirmation, significant changes, cancellation and registration updates [W4][W1 §6].
  - Reminders for incomplete arrangements, with configurable frequency [C4].
- **Conflicts** are first come, first served. Cross-department negotiation happens offline [C2].

## 4. E1 Access and Identity — SCRUM-92, 434, 444, 453, 485
- Access depends on role **and** relationship to the event (owner, assigned coordinator), not role alone [W4].
- A Coordinator can view unassigned events for planning but not edit them [C4].
- After reassignment, the previous coordinator keeps view-only access [C4].

## 5. E2 Event Request — SCRUM-10, 14, 412, 420, 427
- **Minimum fields** [C4]: name, purpose, description, date and time, expected attendance, venue requirements, accessibility, equipment, layout, registration needs.
  - Venue and equipment requirements come from the catalogues [C4].
  - Other mandatory fields are the team's choice.
- **Drafts** can be saved and edited, stay distinct from submitted requests, and have no expiry by default [W4][C4].
- **No submission time limit:** a request can be submitted however far ahead of, or close to, the event [C4].
- **After submission**, the Organiser cannot edit directly. Edits and withdrawal are requested via the Coordinator [C4].
- **Clarification** is a sub-state of review, not a separate lifecycle stage [C4].
  - The Organiser amends only through the clarification flow.
  - The Coordinator decides whether a resubmission is needed [C4].
- **Accessibility needs:** wheelchair access, special seating, mobility arrangements [C2].

## 6. E3 Review, coordination and lifecycle — SCRUM-11, 19, 162, 318, 327, 347, 355, 363, 370, 379, 387, 395, 402, 486–490
**Statuses.** The customer's lifecycle is Draft, Submitted, Under Review/Planning, Approved, Confirmed, Completed, Cancelled, Rejected [C2][C4].
- Code statuses: `draft`, `submitted`, `under_review`, `pending_clarification`, `approved`, `confirmed`, `completed`, `rejected`, `cancelled`.
- Safety statuses are added by SCRUM-488.
- **Approved** means there is enough information to plan. **Confirmed** means every essential arrangement has been approved [C4].
- **Confirmation** requires every essential arrangement the event needs (venue, equipment, …) to be approved [C4].
  - If an essential requirement can't be met, the event is **rejected**, not left pending [C2].
- **Rejected** can be revised and resubmitted [C4]. **Cancelled** is final; a similar event needs a new request [C4].
- **Confirmed → planning** is allowed after a major change reviewed by the Coordinator [C4].
- **Cancellation:** the event's venue and equipment reservations no longer stay committed, subject to business rules [W1 §4].

**Coordinator assignment** [W7 #5 supersedes C2/C4 "auto-assigned"]
- New submissions are **not** auto-assigned. They wait in an unassigned queue that the Lead sees.
- The Lead reviews basic event information, assigns a Coordinator and reassigns when needed.
- There is at most one Coordinator per event, and a Coordinator cannot decline [C4].
- Coordinators manage only their assigned events. The Lead sees all assignments and active events.
- Assignment and reassignment notify the relevant users.

**Operational Safety Check** [W7 #6]
- Runs after venue and technical arrangements are confirmed, and before the event can move to preparation.
- The Safety Officer considers:
  - attendance against capacity and layout;
  - emergency access and accessibility;
  - equipment placement and crowd movement;
  - known venue restrictions.
- Possible outcomes:
  - **approve**;
  - **reject** the safety arrangement;
  - **request changes**, which returns the event to the relevant earlier planning stage, where venue or technical arrangements may need re-review.
- Assume the Safety Officer always responds.

**Change requests** [W4][C4]
- The Organiser requests changes after submission; one request may cover several fields.
- The Coordinator reviews and processes it.
- Significant changes send the affected arrangements back for review.

## 7. E4 Venue Management — SCRUM-15, 17, 178, 484, 493
- **Catalogue:** location, capacity, facilities, accessibility, supported layouts and operating hours, all maintained by Venue Staff [W4][C4].
  - Layouts include classroom, theatre, boardroom, banquet and exhibition [W1].
- **Setup and turnaround time** [W7 #1]:
  - Each venue has a configurable setup time and turnaround time.
  - Occupancy = start − setup → end + turnaround. Example: 10:00–12:00 with 30/45 min occupies 09:30–12:45.
  - Applies to availability **and** conflict detection.
  - Existing bookings that now clash are flagged, never silently removed.
- **Blocks / unavailability** [W7 #2]:
  - Venue Staff can mark a venue unavailable (maintenance, equipment failure, renovation, safety, other), **even over existing bookings**.
  - Affected bookings are flagged and their Coordinators told.
  - The event is not cancelled and keeps its data; the Coordinator can search for and request a replacement venue.
- **Changes to a booked event's venue:** Venue Staff can't cancel or alter one themselves; the Coordinator initiates [C4 14 Sep].
- **Venue attributes changed after booking:** the booking may be flagged; the Coordinator decides the follow-up [C4].
- **Calendar:** shows bookings and recorded unavailability. Single or per-venue view, team's choice [W4][C4].

## 8. E5 Venue Booking — SCRUM-20, 188, 243, 258, 266, 491, 492
- **Search** by date, time, attendance, location, capacity, accessibility, layout and facilities. Strict or close-match filtering is the team's choice [W4][C4].
- **Suitability** covers capacity, required facilities, accessibility and layout [W4][C4].
  - It is **advisory**: the Coordinator makes the final judgement [C4].
- **Multiple venues per event** [W7 #3 supersedes C4 "one venue per event"]:
  - An event can have several venue bookings.
  - Each is checked independently for suitability, availability and conflicts.
  - Changing or cancelling one does not remove the others unless explicitly required.
- **Booking request** carries the event timing and venue requirements; it is sent by the assigned Coordinator [W4][C4].
- **Approval:** Venue Staff approve or reject, giving a free-text reason [C4].
  - Suggesting an alternative venue is optional [C4].
  - A resubmitted booking is recorded as a new booking (audit) [C4].
- **Conflicts:** **confirmed** bookings block availability [C4].
  - Pending requests that clash with each other are allowed, and resolved outside the system first come, first served; the team may propose better [C4].
- **Tentative holds** [W7 #4]:
  - Each hold has an expiry date and time.
  - On expiry the venue becomes available again.
  - The Coordinator is informed before or at expiry.
  - An expired hold is never treated as a confirmed booking.

## 9. E6 Equipment and Tech Support — SCRUM-21, 23, 28, 275, 284, 290, 300, 310
- **Catalogue:** type, description, quantity, location and status, maintained by Tech Support. Tracking by total quantity or per unit is the team's choice [W1][C4].
- **Requirements:** the Coordinator records type, quantity and technical needs [W4].
  - Lines can be added or removed any time before confirmation; Tech Support re-checks them [C4].
- **Availability:** equipment committed to an overlapping event, or marked damaged or under maintenance, is not available [W4].
- **Reservation:** reduces the quantity available to overlapping events and stays tied to its event [W4].
- **Essential before confirmation:** if required equipment can't be supplied, the event is rejected [C2].

## 10. E7 Attendee Registration — SCRUM-22, 24, 27, 478, 494, 495
- Registration opens once the event is confirmed. The Organiser controls the timing, can extend the period, and closes it manually [C4].
- First come, first served, plus a waiting list.
  - Waiting-list attendees are notified when a place opens [C2][C4].
- **Capacity limits** are at the Organiser's discretion and may be under or over venue capacity [C4 14 Sep].
- Attendees register, view their status and withdraw [W4]. Attendees need an account; accounts already exist [C4].
- Organisers and Coordinators view registrations for events they manage [W4].

## 11. E8 Notifications — SCRUM-172–177
- See §3. Delivery to only the relevant users or to all stakeholders is the team's choice [C4].
- Every workflow step that changes someone's work should notify them. Assignment, booking decisions, hold expiry, flagged bookings and safety outcomes are explicitly required [W4][W7].

## 12. Non-functional [W1 §7–8][W4]
- Desktop- and mobile-friendly.
- Clear status and outstanding actions for every role.
- Common operations complete in reasonable time; no numeric benchmarks are given [C2].
- **Consistency:** never show contradictory dates, bookings, availability or registration status.
- **Testing:** tests trace to stories and acceptance criteria and cover normal, boundary, conflict and failure cases.
  - Aim for 100% coverage, or state why not [W4].
