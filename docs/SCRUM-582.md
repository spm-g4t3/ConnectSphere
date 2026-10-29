# SCRUM-582 - Show Requests I Have Reviewed Before - Technical Support Staff

**Story:** Show Requests I Have Reviewed Before - Technical Support Staff
**Status of the work:** built and tested. The manual check in section 5 is still to be run.

This records what SCRUM-582 added, how each acceptance criterion is proved, and the
choices made where the story left room.

**Short version.** One read-only database function reads `equipment_review_history`
for the signed-in user and returns the requests they started or took over, newest
work first, with the request's status, when they last worked on it, why their review
ended if it did not finish, and a mark when the request has come back to Pending
review. A new route and a "Reviewed by me" section on the Technical Support dashboard
show it. No new table, no change to who is notified, nothing is assigned or locked.

---

## 1. What changed in the product

| Area | Change |
|---|---|
| `db/migrations/041_equipment_reviewed_by_me.sql` | New function `equipment_reviewed_by_me(p_caller, p_limit)`. Stable (so it cannot write), checks the caller's role itself, execute revoked from `public`, `anon` and `authenticated`. |
| `routes/equipmentQueue.js` | New `GET /api/equipment-requests/reviewed-by-me`, Technical Support only, `Cache-Control: no-store`. The existing `GET /` is unchanged. |
| `services/equipmentQueueService.js` (backend) | `getRequestsReviewedByMe` and `toReviewedRow`: camelCase, status label, 42501 becomes a 403. |
| `services/equipmentQueueService.js` (frontend) | `getReviewedByMe()`. |
| `EquipmentReviewedByMe.jsx` | The "Reviewed by me" section, with its own loading, error and Try again. Shown under the queue on the dashboard and on `/equipment`. |
| `vite.config.js` | `EquipmentReviewedByMe.jsx` gated at 100% coverage. |

The migration must be applied on the shared Supabase database before the route works.
It is 041: above the highest number on dev and above 040, which an open PR (#90) uses.

## 2. Acceptance criteria and the tests that prove them

| AC | Rule | Held by | Tests |
|---|---|---|---|
| AC1 | A "Reviewed by me" view of requests where I started or took over a review, newest first | The function lists requests with a `started` or `taken_over` row by me, ordered by my latest action, one row per request | `scrum582ReviewedByMeDatabase.test.js` (started and taken over both listed, never started not listed, once per request, newest first, cap and empty list); route and component tests |
| AC2 | Each entry shows the event, current status, when I last worked on it and, if the review was interrupted, why | `event_name`, period, `status`, `last_worked_at`, `interrupted_reason` | Database: name, period and status; reasons for a line change, a flagged reservation, a cancellation and a Safety return. Route: exact response shape. Component: what is drawn |
| AC3 | A request back in Pending review since I last worked on it is marked | `returned_to_pending`, true when the request's status is Pending review | Database: marked after a line change; not marked when I started again, or completed. Component: the mark and its absence |
| AC4 | A view only: anyone can still start any review, nothing is assigned or locked | A stable function; the route only reads; the component has links and no buttons | Database: stable, and the request's reviewer and history are identical after reading. Route: one function call, no table access. Component: no buttons, only links |
| AC5 | Own history only; other roles refused | The function takes the caller from the token, never from the request; refuses a null caller and any other role with 42501 | Database: another reviewer's requests not listed; coordinator, organiser, Safety Officer, null and unknown caller refused; browser roles cannot execute. Route: all other roles 403, signed out 401, a `userId` query is ignored. Service: caller id only |

Test names follow the repo convention `SCRUM582_AC<n>_<behaviour>`.

## 3. Choices made

- **One row per request, ordered by my latest action.** "Last worked on" is my latest
  start, take over, mark, unmark, complete or arrange. Someone else's work on the same
  request does not move it.
- **Why a review ended is read from the first `interrupted` row after my latest start
  or take over**, unless someone started or took over in between. The Safety return
  writes the Safety Officer as the row's user and no previous reviewer, so the row's
  user columns are not used to decide whose review ended, only the position.
- **Marked means the request is Pending review now.** Starting a review moves a request
  to Under review and nothing a reviewer does moves it back, so Pending review after
  my work means it came back since.
- **A review I started again after an interruption shows no interruption.** The newest
  review is the one that counts.
- **A cap of 200 rows**, most recent first. The response says when the list was cut
  and how many there were. The service does not let the browser change the limit.
- **Same approach as the queue** for access: the route checks the role and the function
  checks it again, so a caller who skips the route is still refused.
- **Separate from SCRUM-28.** That is a forward-looking duty set by the coordinator.
  This is a history of my own reviews. If both end up on one page they should share a
  "My work" area, as the story says.

## 4. Known limits

- A request cancelled after it was arranged shows status Cancelled but no reason: the
  database writes an `interrupted` row only when a review in progress is cancelled.
- The Safety return is tested by writing the same status change and history row that
  `respond_to_safety_review` writes, not by running a whole Safety review. The flagged
  reservation reason is tested the same way, by setting the value the flag function sets.
- The history of a request I reviewed before this migration exists only as far as
  `equipment_review_history` recorded it.

## 5. Manual check (to run once migration 041 is applied)

Accounts: two Technical Support users (A and B), a coordinator, an approved event with
an equipment line.

1. As A, open the event's equipment review and start the review. On the dashboard,
   "Reviewed by me" lists the event as Under review. As B, the section does not list it.
2. As the coordinator, change the line's quantity. As A, the entry shows Pending
   review, "Your review ended: The lines were changed during the review." and "Back in
   Pending review since you last worked on it."
3. As A, open it from the list. Nothing is assigned until A chooses Start review.
4. As B, start the review of the same event. B's list shows it; A's list shows the same
   interruption reason (A's review is the one that ended) and the status Under review.
5. As the coordinator, `/equipment` sends the coordinator to the unauthorized page, and
   `GET /api/equipment-requests/reviewed-by-me` with a coordinator token returns 403.
