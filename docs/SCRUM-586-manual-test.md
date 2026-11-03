# SCRUM-586 manual test record

Run by ___ on ___ with `npm run dev`, signed in as an Event Coordinator unless a row says the Lead. No seed script creates events at each status, so set up first:

- If the venue list is empty, run `npm run venues:seed` in `backend/` (it writes to the shared Supabase project, so check with the team first).
- As an Event Organiser, submit five event requests. Give one a long name with one very long word, and a long organiser name if you can (for the 360px rows).
- As the Lead, assign all five to your coordinator. As the coordinator, walk them to these statuses: one left **submitted**; one **under review** (Start review); one **pending clarification** (Return for amendment, with a reply-by date in the past for one row under Needs attention); one **approved**, then sent for the safety check and approved by a Safety Officer, then **confirmed** with an end time already passed (or edit the end time to the past before confirming); one **approved** and left there with a venue request (Find a venue on its Venues tab).
- Later rows make a **rejected**, a **cancelled** and a **completed** event from these, so do the status rows in order.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, the arrow keys, Space, Enter and Escape.

## Navigation and headings

| # | Check | Result |
|---|---|---|
| 1 | The nav shows Dashboard, My Events, Venue Requests, Review Queue and Find a Venue. | |
| 2 | The dashboard has one large title, "Welcome, (you)", then the cards "Needs attention", "My events", "Review queue" and the notifications. | |
| 3 | Each page has one large title: `/my-events` "My events", `/review-queue` "Review queue", `/my-venue-requests` "Venue requests", `/event-requests/(id)` the event's name. Opening an event from a list keeps the list's title and shows the event's name as the next heading down. A page opened from the event (Cancel, Reject, Revise, Edit, Mark as completed, Hand over) is the one large title on `/event-requests/(id)`, and the next heading down under a list's title. | |

## List screens

| # | Check | Result |
|---|---|---|
| 4 | Needs attention lists the overdue clarification and the confirmed event that has ended, each with its reason, its time and an Open button that opens the event page. | |
| 5 | My events groups events under "New, not yet reviewed", "Under review", "Waiting on the organiser", "Approved" and "Confirmed", each with a count. Completed, Rejected and Cancelled are closed groups you can open. Each row has a coloured status badge, a date like "15 Jan 2026, 9:00 am" and "Organiser:". | |
| 6 | Review queue lists the requests waiting for a decision, oldest first, each with a status badge and a Review button. | |
| 7 | Venue requests lists your venue request with its venue, its time as "15 Jan 2026, 9:00 am – 11:00 am" and a badge. Withdraw asks inline; Keep it changes nothing. | |

## Event page, as the Coordinator

| # | Check | Result |
|---|---|---|
| 8 | Every status: the header shows the name, the badge, one line of date · attendees · organiser, and only the buttons that status allows. The Next step card comes first, then Venues, Equipment, Details and Activity tabs. The Event facts rail (progress, Provenance, Coordinator) sits to the right on a wide screen. | |
| 9 | **Submitted**: Next step says to start the review, with a Start review button. Press it: the decision cards appear and the stepper moves to "Under review". | |
| 10 | **Under review**: three cards (Approve, Reject, Return for amendment), none chosen; the submit button is named after the card you pick. Return for amendment shows the field checkboxes and the reply-by date. | |
| 11 | **Pending clarification**: "Waiting for organiser reply" with the current question and reply-by date ("· Overdue" when past), and a Close clarification form. | |
| 12 | **Approved**: Revise event details, Edit event information, Cancel event and Reject event in the header; the Next step card holds "Submit for the safety check". | |
| 13 | **Safety review**: Next step says it is waiting for the Safety Officer. No Confirm Event yet. | |
| 14 | **Confirmed**: Next step says when it can be marked completed; once the end has passed, Mark as completed is in the header. | |
| 15 | **Completed**: "Marked as completed." after doing it; the closing notes show and no action buttons remain. | |
| 16 | **Rejected** (Reject event on an approved event, with a reason): the page shows "Event rejected" with the reason; Back to event shows the decision, and no Reject or Cancel button. | |
| 17 | **Cancelled** (Cancel event, preview, tick, confirm): the page shows "Event cancelled" with the reason; Back to event shows no action buttons. | |
| 18 | Each swap-in page (Revise, Edit, Cancel, Reject, Mark as completed) has "Back to event" at the top, and Back changes nothing. | |

## Event page, as the Lead

| # | Check | Result |
|---|---|---|
| 19 | Open each of the events above from Assigned Events. The header, badge, Next step texts, tabs and stepper read the same as the Coordinator's, with no Start review, decision cards or header action buttons. | |
| 20 | The rail has "Hand over to another coordinator" on every status but cancelled. It opens "Hand over (event)"; Cancel returns to the event; a handover shows "Handed over to (name)." | |

## Loading, empty and error states

| # | Check | Result |
|---|---|---|
| 21 | Each list and the event page show "Loading..." (three full stops) first. | |
| 22 | With the backend stopped, reload each list: "Your Needs attention list could not be loaded.", "Your events could not be loaded.", "The review queue could not be loaded.", "Your venue requests could not be loaded." and, on the event page, "This event request could not be loaded.", each with Try again and no "Please try again." Start the backend: Try again brings each back. | |
| 23 | As the Lead, open `/event-requests/(a made-up id)`: "This event request doesn't exist or hasn't been submitted yet." with no Try again. | |

## Keyboard only

| # | Check | Result |
|---|---|---|
| 24 | Tab reaches every button, link, card, tab, radio, checkbox, select and text box on these screens, and each shows a teal focus ring. | |
| 25 | Enter on Review or Open puts focus on the event's name. "← Back to …" puts focus back on that row's button. In My events, opening an event from an opened Completed group and going back leaves the group open with focus on its Open. | |
| 26 | After Return for amendment from the review queue, focus is on the row's Review button, or on the "Review queue" title if the row has gone. | |
| 27 | Enter on Revise, Edit, Cancel event, Reject event, Mark as completed or (Lead) Hand over puts focus on that page's title. Back to event, Cancel or "Back to the event" put focus back on the button that opened it. | |
| 28 | After a cancellation or rejection, focus is on the recorded page's title; Back then puts it on the event's name. After Mark as completed, focus is on the event's name. After a handover, focus is on Hand over. | |
| 29 | After Start review, a decision, Close clarification (on the event page), Submit for safety check or Confirm Event, focus is on the "Next step" heading. | |
| 30 | On the decision cards, the arrow keys move between Approve, Reject and Return for amendment. On the tabs, the arrow keys, Home and End move between tabs. In the completion dialog, Escape goes back to the notes. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 31 | Dashboard, My events, Review queue and Venue requests: no sideways scrolling. Each row's button sits under its details, and the long event and organiser names wrap. | |
| 32 | Event page: the long name wraps; the header buttons wrap onto new lines; the decision cards, note box and submit fit the width. | |
| 33 | The tabs stay on one line and scroll sideways inside their strip; the page itself does not. | |
| 34 | The rail sits under the main column, and each progress step has its dot beside its label. | |
| 35 | The Revise, Edit, Cancel, Reject, Mark as completed and Hand over pages, and the completion dialog, fit the width with every button fully visible. | |
| 36 | Every button, select, text box, back link and radio or checkbox row is at least 44px tall (check a few in the developer tools). | |

## No behaviour change

| # | Check | Result |
|---|---|---|
| 37 | Each action sends what it did before: the same status changes, the same people are told, and nothing is cancelled or un-booked on its own. | |
| 38 | No step opens the browser's own confirm, alert or prompt box. | |

## Found and fixed during the test

-

## Not checked by hand

- Where focus lands when an event is listed twice in My events (Needs attention and its group): covered by `SCRUM586_AC7_an_event_listed_twice_returns_focus_to_the_copy_it_was_opened_from` in `scrum586CoordinatorKeyboard.test.jsx`.
- That no screen in scope calls a browser dialog in any code path: covered by `SCRUM586_AC7_…_never_calls_a_browser_dialog`.
