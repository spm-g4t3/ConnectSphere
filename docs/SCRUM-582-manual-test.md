# SCRUM-582 manual test

Show Requests I Have Reviewed Before (Technical Support Staff). Run on 30 October 2026
against the 582 branch, local frontend and backend, shared Supabase with migration
`041_equipment_reviewed_by_me.sql` applied.

The automated suites prove each rule against the real schema (see `SCRUM-582.md`,
section 2). This record covers what only a person at a browser can see: the
section on screen and the live API with real sessions. The Safety return and the
flagged reservation reasons are covered by the database tests and are not repeated
here.

## Setup

- Restart the backend and frontend on the 582 branch.
- Accounts: Technical Support A (`techsupport@connectsphere.com`) and B
  (`techsupport2@connectsphere.com`, kept after the test), an Event Coordinator, and
  an approved event with an equipment line.
- A and B are signed in at the same time, one in a normal tab and one in a private
  window.
- API calls use the signed-in token from `sessionStorage` (`connectsphere_auth`,
  `session.access_token`) in the browser console. The backend is on port 5000.

## Steps

1. **Own review appears.** A started the review. On A's dashboard and on `/equipment`,
   "Reviewed by me" lists the event as Under review with the time A last worked on
   it, and no "Your review ended" or "Back in Pending review" line. Pass.
2. **Someone else's work does not show.** B's "Reviewed by me" did not list the event
   A started. Pass.
3. **An interrupted review is marked.** The coordinator changed the line's quantity.
   A's entry showed Pending review, "Your review ended: The lines were changed during
   the review." and "Back in Pending review since you last worked on it." Pass.
4. **View only.** The section shows Open links and no Start or Take over buttons.
   Open goes to the review screen and nothing was assigned until Start review was
   pressed. Pass.
5. **Starting again clears the mark.** After A started the review again, the entry
   showed Under review with no interruption lines. Pass.
6. **Another reviewer.** B started the review of the same event and it appeared in
   B's list. A's entry stayed Under review with no interruption line. Pass.
7. **Other roles are refused.** `GET /api/equipment-requests/reviewed-by-me` with the
   coordinator's token returned 403. With A's token it returned 200. `/equipment` as
   the coordinator went to the unauthorized page. Pass.

## Result

All seven steps pass. No defect was found in the 582 code.

## Found while testing, outside this story

A Completed event's equipment request stays Arranged, because completing releases
the reservations but does not change the request. The review screen then shows "All
equipment is arranged" with "0 of 2 reserved". Nothing can be changed (the final
event guard answers 409). Raised as a note for SCRUM-379, 284 and 290.
