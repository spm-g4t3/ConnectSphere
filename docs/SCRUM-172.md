# SCRUM-172 — View and Manage My Notifications

**Story:** View and Manage My Notifications — All Users
**Closing subtask:** SCRUM-202 (this document)
**Status as of 16 October 2026:** built and tested; all eight criteria done (section 1). No live script was run for this review.

This document is the record of what SCRUM-172 delivered, how each acceptance
criterion is proved, why the design looks the way it does, and what is still
missing. The chain is **user story → acceptance criterion → test → code**.

**The short version, for anyone asked "what changed?":** every role's dashboard
now shows one notifications inbox, newest first, with unread rows marked "New".
The navigation bar shows the exact unread count, worked out by the database and
not from a list capped at 50. Every notification type has words saying what
changed and when. Selecting a notification marks it read and, where the role has
a page for that event, opens it. Notifications are read only through the API,
which scopes every query to the signed-in user; the database refuses direct
clients.

---

## Subtasks and what each delivered

| Subtask | Delivered | Commit |
|---|---|---|
| SCRUM-195 | `toNotification` returns `eventRequestId` on every notification: the column first, then the payload, then the booking's event. No schema change | `1a71852` |
| SCRUM-196 | `GET /api/notifications`, the caller's notifications newest first (built under SCRUM-128, kept) | earlier |
| SCRUM-197 | `GET /api/notifications/unread-count`, a database count scoped to the caller (`countUnreadNotifications`) | `37b95fb` |
| SCRUM-198 | The access-control audit: RLS on with no policies or client grants (migration scan), 404 for another user's notification, no Supabase client in the frontend | `446e481` |
| SCRUM-199 | `CoordinatorNotifications` renamed to `NotificationInbox` and mounted on every dashboard; `UnreadCountContext` shares one count between the nav badge and the inbox heading | `a2a1cb6`, `3afc84a` |
| SCRUM-562 | Wording for the six types that showed "cannot be displayed yet", and a guard that every type in the latest type list has wording | `7b2629c` (message says SCRUM-526 by mistake) |
| SCRUM-200 | `notificationLink.js`: where each role lands when it opens a notification; opening marks it read; the organiser's list focuses the event | `9dfd306` |
| SCRUM-201 | The end-to-end inbox flow test (`notificationInboxFlow.test.jsx`) and a demo seed (`db/seeds/notifications.js` with its cleanup) | `62c4d6c` |
| SCRUM-202 | This document | uncommitted at writing |

### Verification as of 16 October 2026

| Evidence | Result |
|---|---|
| Backend suite (`npm run test:coverage` in `backend`) | 6248 passing across 133 files; every coverage gate met (6258 before the clean-up below removed 10 redundant cases) |
| Frontend suite (`npm run test:coverage` in `frontend`) | 2773 passing and 1 todo across 120 files; every coverage gate met; `npm run lint` 0 errors (20 warnings, 2 in this story's files: section 3); `npm run build` passes |
| Pre-PR clean-up | Repeated logic and redundant tests removed from the notification area only (section 3). The wording of `describeNotification` was checked unchanged over 1,541 inputs; every test name cited in `docs/` still runs; every notification file stays at 100% |
| SCRUM-172's gates | Backend: `notificationService.js`, `routes/notifications.js` and `notificationValidation.js` at 100% (`backend/vitest.config.js`). Frontend: `SCRUM172_FILES` (`UnreadCountContext.jsx`, `notificationLink.js`) at 100%; `NotificationInbox.jsx`, `notificationDisplay.js` and `notificationService.js` stay at 100% in `SCRUM17_FILES` (`frontend/vite.config.js`) |
| SCRUM-172's own tests | 128 distinct `SCRUM172_…` titles in a run (a table row with its own title counts once): 17 backend, 111 frontend. Mark-as-read and newest-first are also proved by SCRUM-128's `SCRUM17_AC3_…` tests, which this story kept |
| Live database | No migration in this story, so nothing to apply. No live script was run |

---

## 1. Acceptance criteria

| AC | Criterion (quoted) | Status |
|---|---|---|
| AC1 | Every signed-in user can view only their own notifications. | **Done** |
| AC2 | Notifications are displayed newest first. | **Done** |
| AC3 | Unread notifications are visually distinguished. | **Done** |
| AC4 | The unread notification count is displayed. | **Done** |
| AC5 | A user can mark a notification as read. | **Done** |
| AC6 | A notification contains a short description of what changed and when it occurred. | **Done** |
| AC7 | Where applicable, selecting the notification links to the related event, provided the user is authorised to view that event. | **Done**, for the roles that have an event page (D5) |
| AC8 | Users cannot access another user's notifications. | **Done** |

**Tally:** 8 done, 0 partial, 0 deferred.

### Evidence for each criterion

| AC | Code (file, function) | Proved by |
|---|---|---|
| AC1 | `router.use(requireAuth)` and `req.user.id` on every route (`backend/src/routes/notifications.js`); `.eq('recipient_id', …)` in `listNotifications` (`backend/src/services/notificationService.js`); `<NotificationInbox />` on every dashboard | `SCRUM172_AC1_counts_for_the_signed_in_user_only` (route); `SCRUM17_AC3_always_filters_by_recipient` (service); `SCRUM172_AC1_attendee_dashboard_shows_the_inbox`, `SCRUM172_AC1_%s_has_the_notifications_link`, `SCRUM172_AC1_AC8_the_inbox_never_asks_for_another_users_notifications`, `SCRUM172_AC1_AC2_AC3_AC4_coordinator_sees_their_inbox_newest_first_with_the_count` (frontend) |
| AC2 | `.order('created_at', { ascending: false })` in `listNotifications` (`notificationService.js:123`); the inbox does not re-sort | `SCRUM17_AC3_reads_the_callers_notifications_newest_first`, `keeps the database order` (service); `SCRUM17_AC3_indexes_recipient_then_newest_first` (migration); `SCRUM172_AC1_AC2_AC3_AC4_…` (flow, seeded oldest first so the order on screen is the API's) |
| AC3 | `notification-inbox__item--unread` and the "New" marker in `NotificationInbox.jsx` | `SCRUM17_AC3_unread_row_has_New_and_Mark_as_read` (component); `SCRUM172_AC1_AC2_AC3_AC4_…` (flow: every unread row has the class and "New") |
| AC4 | `GET /unread-count` and `countUnreadNotifications`; `UnreadCountContext.jsx`; the badge in `Navigation.jsx`; the inbox heading | `SCRUM172_AC4_counts_only_the_callers_unread`, `SCRUM172_AC4_counts_beyond_the_list_limit`, `SCRUM172_AC4_returns_the_unread_count` (backend); `SCRUM172_AC4_nav_shows_the_exact_count_past_the_list_cap`, `SCRUM172_AC4_heading_uses_the_exact_server_count`, `SCRUM172_AC4_never_shows_the_previous_users_count`, `SCRUM172_AC4_refreshes_when_the_tab_regains_focus` and the rest of `UnreadCountContext.test.jsx` and `useRefetchOnReturn.test.jsx` (frontend) |
| AC5 | `PATCH /:id/read` and `markNotificationRead` (guarded update, idempotent); the inbox's "Mark as read" button and `refresh()` of the shared count | `SCRUM17_AC3_marks_an_unread_notification_read_with_a_guarded_update`, `SCRUM17_AC3_already_read_returns_the_original_read_at` (service); `SCRUM17_AC3_answers_200_with_the_notification_marked_read`, `SCRUM17_AC3_is_idempotent_and_returns_the_original_read_at`, `ignores a readAt in the body` (route); `SCRUM172_AC4_marking_read_refreshes_the_shared_count`, `SCRUM172_AC5_a_failed_mark_leaves_the_shared_count_alone`, `SCRUM172_AC5_marking_read_lowers_the_badge_and_heading_together` (frontend) |
| AC6 | `describeNotification` (`frontend/src/services/notificationDisplay.js`): a headline per type and a detail line; "Received <time>" on every row | `SCRUM172_AC6_every_known_type_has_wording` (guard over migration 066's list); 24 per-type `SCRUM172_AC6_…` wording tests; `SCRUM172_AC6_every_row_reads_as_words_with_a_time` (flow) |
| AC7 | `eventRequestId` in `toNotification` (backend); `notificationLink.js` (one entry per role); the `<Link>` in `NotificationInbox.jsx`; the focus in `MyEventRequests.jsx` | `SCRUM172_AC7_event_id_comes_from_the_column_first`, `…_falls_back_to_the_payload_event_id`, `…_falls_back_to_the_booking_event_for_booking_only_types` (service); `SCRUM172_AC7_%s_opens_the_event_review_page_for_%s`, `SCRUM172_AC7_role_%s_without_an_event_page_gets_no_link`, `SCRUM172_AC7_tech_support_gets_no_link_for_a_cancelled_event` (link); `SCRUM172_AC7_clicking_an_unread_link_marks_it_read_then_refreshes_and_navigates`, `SCRUM172_AC7_an_event_not_in_the_list_says_so_and_focuses_nothing` (screens); `SCRUM172_AC7_opening_a_notification_marks_it_read_and_lands_on_the_event`, `SCRUM172_AC7_venue_staff_rows_have_no_link` (flow) |
| AC8 | RLS on `notifications` with no policies (014); the API filters every read and update on `recipient_id`; missing and not-yours return the same 404 | `SCRUM172_AC8_row_level_security_stays_enabled`, `SCRUM172_AC8_no_migration_adds_a_policy_on_notifications`, `SCRUM172_AC8_no_migration_grants_notifications_to_client_roles` (migrations); `SCRUM172_AC8_marking_another_users_notification_filters_on_the_caller`, `SCRUM17_AC3_someone_elses_or_missing_is_404_with_one_message` (route); `SCRUM17_AC3_missing_and_not_yours_answer_the_same_message` (service); `SCRUM172_AC8_frontend_has_no_direct_database_client` (frontend) |

---

## 2. Design decisions

### D1. Newest first is the backend's order
The service orders by `created_at` descending, backed by the recipient-then-newest
index. The inbox renders what it receives and never re-sorts, so there is one
place the order can be wrong.

### D2. The count comes from the database
Before SCRUM-197 the count was worked out in the browser from a list capped at
50, which undercounted anyone with more than 50 unread. `GET /unread-count` asks
the database. One `UnreadCountContext` feeds the badge and the heading, so they
cannot disagree, and it refreshes after a mark, after a list read and when the
tab regains focus.

### D3. Not yours and missing are the same 404
Telling them apart would confirm that another user's notification id exists. The
mark-as-read update is guarded on `recipient_id`; when it matches nothing, a read
scoped to the caller decides between "already read" (200) and "not found" (404).

### D4. No role gate on the notification routes
Every route is scoped to `req.user.id`, so a gate adds nothing, and a user whose
role changes would lose what they were sent. This matches the rule in
`routes/eventRequests.js`.

### D5. A role gets a link only to a page it already has
AC7's "provided the user is authorised" is met by linking each role only to a
page its own routes allow; the page's API still enforces access on load.
Coordinators and the Lead go to `/event-requests/:id`; the organiser goes to
their own list, focused on the event; Technical Support go to the equipment
review for `safety_equipment_review` only. Venue Staff, the Safety Officer and
Attendees have no event page yet, so their rows show no link ("where
applicable").

### D6. The related event is resolved on read
`eventRequestId` comes from the notification's column, else its payload, else
its booking's event. Older types that stored only a booking still link, with no
migration.

---

## 3. Known gaps, and technical debt

### Not done, or deferred to another story
- **No link for Venue Staff, the Safety Officer or Attendees.** Each waits on a page from another story (SCRUM-174, SCRUM-490 and SCRUM-495, as named in `notificationLink.js`). Adding one is a single line in `LINKS_BY_ROLE`.
- **The inbox lists only the newest 50.** The count is exact past 50 (D2), but older notifications cannot be reached. Pagination is not in the criteria.

### Pre-PR clean-up (done)
- `notificationDisplay.js`: one `DESCRIBERS` map in place of 17 `if` blocks; the event and venue fallbacks are resolved once.
- `useRefetchOnReturn.js`: the re-read on returning to the tab, once, for the inbox and the unread count (gated in `SCRUM172_FILES`).
- Tests: shared fixtures (`backend/tests/fixtures/notifications.js`, `frontend/tests/fixtures/notifications.js`) and helpers (`frontend/tests/helpers/`); tests already proved elsewhere removed; near-identical tests turned into tables. Other stories' files were left alone.

### Technical debt, left
- Mark-as-read and newest-first are proved by SCRUM-128's `SCRUM17_AC3_…` tests, not by `SCRUM172_AC5`/`AC2` names. A search for `SCRUM172_AC5` finds only the frontend half of AC5.
- Commit `7b2629c` is labelled SCRUM-526; the work is SCRUM-562's.
- `react-hooks/set-state-in-effect` warns at `NotificationInbox.jsx:81` and `UnreadCountContext.jsx:37`. Both set loading state when a read starts, the same pattern as the 16 other screens that warn; fixing it belongs in one sweep across them, not here.

---

## 4. Open questions for the team

1. **Several roles.** The requirements allow one user to hold several roles, but the frontend links by a single `user.role`. The links will need revisiting when several roles reach the client; this belongs to the story that brings that in.
2. **Older notifications.** Should the inbox page past 50, or is the newest 50 plus an exact count enough for Release 1?
