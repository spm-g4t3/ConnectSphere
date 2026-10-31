# SCRUM-177 — Notify Users of Registration Changes

**Story:** Notify Users of Registration Changes
**Subtasks so far:** SCRUM-235, the notification contract (migration 039). SCRUM-236, the handlers and transition rules (migration 040). SCRUM-238, recipient resolution (migration 041). SCRUM-237, the opening/closing job (migration 042). SCRUM-239, the flows wired in (migration 043).
**Status as of 30 October 2026:** contract, handlers, recipients, the job and the flows are built and tested against the schema (PGlite). Migrations 039–043 haven't been applied to live Supabase, and the two-session race test (`waitingListConcurrency.realdb.test.js`) hasn't been run against them.

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
| `registration_closed` | `closedAt`, `cause` | `closing_time`, `switched_off`, `settings_changed` (040: the opening time was moved later), `event_started`, `event_not_confirmed` |
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
  p_details,           -- jsonb, the type's own fields
  p_exclude_recipient_id  -- uuid or null (041): the actor, never told
);  -- returns how many rows were inserted
```

- It runs in the caller's transaction and takes no lock. Call it after the flow's own writes, under the event row lock the flow already holds. If the flow rolls back, so does the notice.
- It refuses (22023) an unknown type, an audience the type doesn't allow, an empty key or a missing or unknown `cause`. An unknown event gets P0002. It isn't callable by `anon` or `authenticated`.
- `waitlisted` resolves to attendees whose status is `waitlisted` at the time of the call.
- Dedupe: unique on `(recipient_id, event_request_id, type, occurrenceKey)`. Repeating an occurrence inserts nothing, and a new occurrence notifies again.
- The row is also checked by `notifications_registration_change_shape`: the event must be set, the key must be present, and the audience must be allowed for the type.

**Occurrence keys.** Since 042, window notices use `opened:<n>` / `closed:<n>`, where `n` is the event's `registration_notice_state.window_generation` after the transition. That makes the key stable: a retry of a rolled-back transition reuses it, and a reopening always gets a new one, whatever the dates. Capacity notices still use `full:` / `released:` plus the UTC instant of the transition. The recorded state already stops a repeat, so the key is a second guard.

## 5. Handlers and transition rules (SCRUM-236, migration 040)

The scheduler and the flows use the same handlers. A flow should never call `notify_registration_change` directly.

```sql
select announce_registration_window(p_event_request_id, p_cause);   -- p_cause: null | 'settings_changed' | 'event_confirmed'
select announce_registration_capacity(p_event_request_id, p_cause); -- p_cause: 'registration' | 'promotion' | 'withdrawal' | 'settings_changed'
-- each returns how many notices it sent
```

Each handler locks the event row, then compares the live state with the state last announced in `registration_notice_state`. Anything is sent only when the two differ, and the new state is recorded in the same transaction. This is why:
- **a refused operation sends nothing.** It rolls back or changes no state.
- **an unchanged save sends nothing.** The state is the same.
- **a repeated call, or the job running again, sends nothing.** The state was already recorded.
- **a rolled-back flow loses its notice and its recorded state together**, so the next call announces the change correctly.

When the table is created, every existing event's current state is recorded, so deploying sends no burst of old transitions. A re-run never overwrites it.

**Window.** "Open" means `registration_closed_reason(event, now)` is null, the same rule registration and promotion use.

| Live vs announced | Sends | Cause | Audiences |
|---|---|---|---|
| unchanged | nothing | none | none |
| closed → open | `registration_opened` | `p_cause`, or `opening_time` if null | organiser, coordinator, waitlisted |
| open → closed | `registration_closed` | taken from the closing reason: `closing_time`, `switched_off`, `event_started`, `event_not_confirmed`, else `settings_changed` | organiser, coordinator, waitlisted; **no waitlisted for `event_started`**, since the queue will never move again |
| open → closed, event `cancelled` | nothing; the state is recorded | none | none (decision 2 in section 6) |

**Capacity.** "Full" means a capacity is set and the registered count is at least that capacity.

| Live vs announced | Sends | Audiences |
|---|---|---|
| unchanged | nothing | none |
| not full → full | `registration_capacity_reached` `{capacity, registeredCount}` | organiser, coordinator |
| full → not full, cause `withdrawal` | `registration_place_released` `{cause, capacity, registeredCount}` | organiser, coordinator |
| full → not full, any other cause (capacity raised or removed) | nothing; the state is recorded | none |

**For both handlers:** with `settings_changed`, the Organiser made the change, so the Organiser is left out as a person, in every audience they belong to (proposed: nobody is told about their own action). Since 041 this also covers an Organiser who is on their own event's queue.

**Waiting-list status.** waitlisted → registered is the only status change the system makes, and `promote_waitlisted_registrations` notifies it as `registration_promoted`. Since 041 its recipient is the `registrant` the resolver finds for the promoted registration: the attendee whose status changed, and no one else. Joining and leaving are the attendee's own actions and send nothing.

**Call order (wired in 043).** Inside the flow's transaction, after its writes:
1. Run the promotion.
2. Call `announce_registration_capacity`.
3. Call `announce_registration_window`.

Doing this after promotion means a queued attendee who just got a place is told about their place, not about a moving queue. It also means a withdrawal whose place the queue filled straight away doesn't report a free place.

| Flow | Calls |
|---|---|
| `register_for_event` | capacity `promotion` after a catch-up promotion; capacity `registration` after a new registration |
| `join_event_waitlist` | capacity `promotion` after a catch-up promotion. A join that finds room goes through `register_for_event`; a join that queues sends nothing |
| `withdraw_registration` | promotion, then capacity `withdrawal` |
| `setup_event_registration` (only once saved; refused or invalid saves return earlier) | promotion, then capacity `settings_changed`, then window `settings_changed` |
| `promote_waitlist_on_confirmation` (return to Confirmed) | promotion, capacity `promotion` if anyone was promoted, then window `event_confirmed` |
| `announce_registration_window_on_status_change` (new trigger: leaving Confirmed) | window with null: closes with `event_not_confirmed`; a cancellation settles silently |
| `process_waitlist_promotions` (promotion job) | capacity `promotion` for each event where it promoted |
| `process_registration_window_notices` (SCRUM-237 job) | promotion, capacity `promotion`, window with null |
| `leave_event_waitlist` | nothing: the attendee's own act, and no place changes |

**Guarantees kept from SCRUM-460.** The flows are 037's, restated with only these calls added. Every handler runs after the flow's own event lock, takes the same event row first and then its own `registration_notice_state` row, and runs inside the RPC's single transaction. Promotion is still the one operation that hands out places, in queue order and only while registration is open, so one released place still gives at most one promotion. A notice is a row in that transaction: if the operation rolls back, the notice goes with it. If a notice can't be stored, the operation fails instead of committing without it. No outbox is needed.

**Withdrawal confirmations.** The withdrawing attendee gets the API's `withdrawn` answer and no notification, so nothing is duplicated. A promoted attendee gets one `registration_promoted`, as before.

**Recipient resolution (SCRUM-238, migration 041).** Every registration notice, promotion included, gets its recipients from one function:

```sql
registration_notification_recipients(
  p_event_request_id uuid,
  p_audiences text[],                 -- organiser | coordinator | waitlisted | registrant
  p_registration_ids uuid[] = null,   -- required for registrant
  p_exclude_recipient_id uuid = null  -- the actor, left out in every audience
) returns table (recipient_id uuid, audience text)
```

Recipients come only from the event row and its registrations at the time of the call. No caller supplies a user id; the only ids it accepts are registrations, which must belong to the event, and an actor to *leave out*. The handlers, the writer and the resolver can't be executed by `anon` or `authenticated`.

| Audience | Resolves to | Excludes |
|---|---|---|
| `organiser` | `event_requests.organiser_id` | none |
| `coordinator` | `assigned_coordinator_id` now | a coordinator who was reassigned away; nobody when the event is unassigned |
| `waitlisted` | this event's registrations whose status is `waitlisted` now | registered, withdrawn and cancelled attendees, and other events' queues |
| `registrant` | the attendee of each named registration of this event, **whatever its status now** | registrations of another event (refused, 22023) |

`registrant` keeps the directly affected attendee. A promotion takes them off the queue in the same statement that notifies them, so `waitlisted` would miss them.

**One notice per person.** Someone in several audiences (requirements §1 allows several roles) is told once, under the first of organiser, coordinator, registrant, waitlisted. The per-recipient unique index makes a second notice for the same occurrence impossible anyway.

**Who receives each notice**

| Notice | Recipients | Basis |
|---|---|---|
| `registration_capacity_reached` | organiser, assigned coordinator, deduplicated | AC2 |
| `registration_promoted` | the promoted attendee only | AC3 and requirements §10. No rule asks for managers to be told |
| `registration_opened` / `registration_closed` | organiser, assigned coordinator, wait-listed attendees (none for `event_started`) | **proposed**; no product rule names the audience |
| `registration_place_released` | organiser, assigned coordinator | **proposed** |
| any of the above with `settings_changed` | as above, without the Organiser | **proposed**: the actor isn't told about their own change |

Registered attendees aren't told when the window opens or closes (proposed). Nobody outside the event is ever resolved, and there's no broadcast and no fallback: an unknown audience is refused, and an empty audience resolves to nobody.

## 5a. Opening/closing job (SCRUM-237, migration 042)

**What runs.** The job is `backend/src/jobs/registrationWindowScheduler.js`, started from `backend/src/jobs/backgroundJobs.js`, which `app.js` calls. It runs once on API start-up and then once a minute. It's off under test, and `REGISTRATION_WINDOW_JOB=off` turns it off. It calls `process_registration_window_notices()`, which hands each event to `announce_registration_window(event, null)`, the same handler the flows use.

**Rule and clock.** "Open" is `registration_closed_reason`, the function registering uses, evaluated with the database clock after the event lock. The job decides with that clock, not the API's, so a notice never disagrees with whether Register works. Tests inject the clock by replacing `clock_timestamp()`, as the promotion tests do.

| Setting | Effect |
|---|---|
| status ≠ `confirmed` | closed |
| `registration_enabled` false | closed |
| `registration_opens_at` | opens **at** that instant (inclusive). Can't be null while enabled: `event_requests_enabled_registration_has_window` |
| `registration_closes_at` | closes **at** that instant (the window is `[opens, closes)`). Null means open until switched off or the start |
| `proposed_start` | closes at the start. Null means closed |

All the columns are `timestamptz` and are compared as instants, so time zones never matter; payload times are UTC text. Nothing compares times for equality. Each run asks "is the window open now?" and compares the answer with what was last announced, so a late run still catches a boundary it missed.

**Recovery after downtime.** The first run after start-up announces every event whose window differs from what was announced. That covers an opening or closing missed while the API was down; the notice is sent late, and `opensAt` and `closedAt` give the real boundary. A window that opened and closed again entirely during downtime is announced not at all, because both notices would be stale.

**Obsolete schedules.** No delivery is queued in advance. Each run re-reads the event's current dates under its lock. A closing time moved later, an opening time moved later, or registration switched off before the boundary therefore produces nothing at the old time.

**Flows and the job don't overlap.** A flow that changes the window (a settings save, a return to Confirmed, from SCRUM-239) announces it in its own transaction and records the state. The job then finds that event already settled. Until SCRUM-239 is wired, the job also notices those changes, reporting a closure with its real reason and an opening as `opening_time`.

**Reopening and reconfirmation (policy).**
- Every closed → open transition is a new occurrence with a new key, and is announced again. Wait-listed attendees see "has reopened".
- An Organiser's settings save is announced by the save itself, with cause `settings_changed` and without telling the Organiser. A return to Confirmed is announced by the confirmation, with cause `event_confirmed`.
- Leaving Confirmed closes with `event_not_confirmed`.
- A cancelled event settles silently.

**Order.** Before announcing, the job hands any free places to the waiting list and announces any capacity that filled. A queued attendee who gets a place is told about that place, not about the opening.

**Failures.** Each event runs in its own subtransaction. If one fails, its work is rolled back and it's reported in `failures` and logged by the job, and it stays due for the next run; the other events still go. A failed RPC is logged and retried on the next tick. Two API processes running the job at once are safe, because events are visited in a fixed order under their locks and the second run finds them settled.

## 6. Open questions

1. Someone in the product role should sign off on every **proposed** row in section 3, and on dropping the actor's own notice.
2. When an event is **cancelled**, it leaves Confirmed. Should waiting attendees be told? `event_cancelled` reaches staff only. Until someone decides, the window handler sends nothing for a cancelled event.
