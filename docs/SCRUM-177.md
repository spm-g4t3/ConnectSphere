# SCRUM-177 — Notify Users of Registration Changes

**Story:** Notify Users of Registration Changes
**This section:** SCRUM-235, the notification contract (types, payloads, recipients, destinations)
**Status as of 30 October 2026:** contract built and tested (migration 039). No registration flow or job sends these yet; later subtasks wire them.

The contract is in three places, and they must agree:

- `backend/db/migrations/039_registration_notification_contract.sql`: the types, a row-level check, a dedupe index and the writer `notify_registration_change`.
- `backend/src/domain/registrationNotification.js`: the same types, audiences and causes, for JavaScript callers and tests.
- `frontend/src/services/notificationDisplay.js` and `notificationLink.js`: the wording and the page each one opens.

---

## 1. Types

| Type | New or reused | Written by |
|---|---|---|
| `registration_opened` | new (039) | `notify_registration_change` |
| `registration_closed` | new (039) | `notify_registration_change` |
| `registration_capacity_reached` | new (039) | `notify_registration_change` |
| `registration_place_released` | new (039) | `notify_registration_change` |
| `registration_promoted` | **reused** (037, SCRUM-460), unchanged | `promote_waitlisted_registrations` |

`registration_promoted` already is the waiting-list status change (waitlisted → registered), with its own dedupe on `(registrationId, waitlistedAt)`. Nothing else in the schema changes a waiting-list row's status, apart from the attendee's own leave. So the contract adds no general "waitlist status changed" type.

Every type from 037 is restated unchanged in `notifications_type_known`. Existing rows are untouched. The new check only constrains the four new types.

## 2. Payload

Shared by the four new types. `notify_registration_change` sets these fields, and they override anything the caller passes in `details`:

| Field | Meaning |
|---|---|
| `audience` | `organiser`, `coordinator` or `waitlisted`: why this recipient got it |
| `eventRequestId` | the event; the row's `event_request_id` column is always set too (and is what the API's links use) |
| `eventName` | the event's name when the notice was sent |
| `occurrenceKey` | names one occurrence of the transition (section 4) |

Recipient, read state and timestamp come from the existing columns: `recipient_id`, `read_at` and `created_at`. They aren't repeated in the payload.

The fields specific to each type, passed in `details`:

| Type | Fields | `cause` values (enforced by the writer) |
|---|---|---|
| `registration_opened` | `opensAt`, `closesAt` (null = no closing time), `cause` | `opening_time`, `settings_changed`, `event_confirmed` |
| `registration_closed` | `closedAt`, `cause` | `closing_time`, `switched_off`, `event_started`, `event_not_confirmed` |
| `registration_capacity_reached` | `capacity`, `registeredCount` | none |
| `registration_place_released` | `capacity`, `registeredCount`, `cause` | `withdrawal` |

Times are ISO-8601 instants. **Privacy:** payloads carry counts only. They never carry another attendee's name, id or registration id. A waiting attendee's notice says nothing about other attendees.

## 3. Matrix

"Required" means an acceptance criterion or `docs/requirements.md` asks for it. "Proposed" is our choice where the story leaves it open (requirements §11: the audience is "the team's choice"). Proposed rows need sign-off from someone in the product role.

| Notification | Business transition | Recipients (audience) | Opens for that role | Required or proposed |
|---|---|---|---|---|
| `registration_opened` | The window becomes open: opening time passes, Organiser saves settings that open it, or the event returns to Confirmed | Organiser; assigned Coordinator | Organiser: `/events/:id/registration`. Coordinator: `/event-requests/:id` (shows the counts) | AC1 requires "relevant users"; this audience is **proposed** |
| `registration_opened` | Same, while attendees are queued | Wait-listed attendees (`waitlisted`) | `/registered-events` (their places; the event page is for registered attendees only) | **Proposed**: the queue moves again |
| `registration_closed` | The window becomes closed: closing time passes, switched off, event starts, or the event leaves Confirmed | Organiser; assigned Coordinator | as above | AC1; audience **proposed** |
| `registration_closed` | Same, while attendees are queued | Wait-listed attendees | `/registered-events` | **Proposed**: promotions pause while closed (037) |
| `registration_capacity_reached` | The registered count reaches capacity (a registration, a join that registers, or a promotion) | Organiser; assigned Coordinator | as above | **Required** (AC2). Sending to both, not either one, is proposed |
| `registration_promoted` | A wait-listed attendee is given a place | That attendee | `/registered-events/:id` | **Required** (AC3, requirements §10). Already built |
| `registration_place_released` | A withdrawal leaves a free place that nobody takes (no queue, or registration closed) | Organiser; assigned Coordinator | as above | AC4 requires notifying "affected users"; staff-only and this condition are **proposed** |

**Proposed: not notified**
- The attendee who acts (join, leave, register, withdraw). The page already confirms the action.
- Registered attendees when the window opens or closes. Their place doesn't change.
- Shifts in queue position. They happen on every departure and would be noise.
- A withdrawal whose place is immediately taken by promotion. The promoted attendee hears about it; staff don't, because availability didn't change.
- Anyone with no link to the event (AC6): no broadcast when registration opens.

The coordinator is the *assigned* one, skipped when they are also the Organiser. This follows `notify_registration_schedule_conflict` and the read rule in `event_registration_counts`.

## 4. Writer contract for later subtasks

```sql
select notify_registration_change(
  p_event_request_id,  -- uuid
  p_type,              -- one of the four new types
  p_audiences,         -- text[] subset of the type's allowed audiences
  p_occurrence_key,    -- non-empty text
  p_details            -- jsonb, the type's own fields
);  -- returns how many rows were inserted
```

- It runs in the caller's transaction and takes no lock. Call it after the flow's own writes, under the event row lock the flow already holds. If the flow rolls back, so does the notice.
- It refuses (22023) an unknown type, an audience the type doesn't allow, an empty key or a missing or unknown `cause`. An unknown event gets P0002. It isn't callable by `anon` or `authenticated`.
- `waitlisted` resolves to attendees whose status is `waitlisted` at the time of the call.
- Dedupe: unique on `(recipient_id, event_request_id, type, occurrenceKey)`. Repeating an occurrence inserts nothing, and a new occurrence notifies again.
- The row is also checked by `notifications_registration_change_shape`: the event must be set, the key must be present, and the audience must be allowed for the type.

**Occurrence keys.** These are recommendations. Writers must derive keys from data, so a retry or a second job run produces the same key. UTC text is formatted as in 037: `to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.

| Type | Key |
|---|---|
| `registration_opened` | `opened:<instant it opened>`: `registration_opens_at` for `opening_time`, the transition's clock time otherwise |
| `registration_closed` | `closed:<instant it closed>`: `registration_closes_at` for `closing_time`, `proposed_start` for `event_started`, the transition's clock time otherwise |
| `registration_capacity_reached` | `full:<registered_at of the registration that took the last place>` |
| `registration_place_released` | `released:<instant of the withdrawal>` |

## 5. Open questions

1. Someone in the product role should sign off on every **proposed** row in section 3.
2. When an event is **cancelled**, it leaves Confirmed. Should waiting attendees get `registration_closed` with `event_not_confirmed`, or should cancellation get its own attendee notice? `event_cancelled` currently reaches staff only. Until someone decides, writers should skip `registration_closed` for a cancelled event.
3. The opening/closing job (a later subtask) needs to know that a window *was* open before it reports it closed. That's the job's decision, not the contract's.
