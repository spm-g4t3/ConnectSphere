# SCRUM-585 manual test record

Run by ___ on ___ with `npm run dev`, signed in as an Event Organiser. The seed scripts cover venues, equipment, holds, booking suitability and notifications, not Organiser event requests, so set these up in the app first:

- A draft request, and a submitted request with a long name with one very long word (for the 360px rows).
- A rejected request with a previous decision: a Coordinator rejects it, you revise and resubmit, and they reject it again.
- A pending_clarification request with a reply-by date: a Coordinator asks for clarification with at least one field enabled.
- An approved or confirmed event with registration configured (capacity and an opening time), and at least one Attendee registered for it.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, Space, Enter and Escape.

## Dashboard

| # | Check | Result |
|---|---|---|
| 1 | One large title, "Welcome, (name)", then "Needs your response" first and "My events" below it. | |
| 2 | The clarification request shows its question, an amber "Reply by" badge with a date like "15 Jan 2026", and a "Respond in My Events" link that opens the reply panel. | |
| 3 | Each event in "My events" opens to show its details, dates like "15 Jan 2026, 9:00 am" and an "Open in My Events" link that highlights that row. | |

## My Events

| # | Check | Result |
|---|---|---|
| 4 | One large title, "My event requests", with a teal "+ New event request" button. Each row has a coloured status badge. | |
| 5 | The draft shows "Continue editing", the rejected request "Revise and resubmit" with its decision and "Previous decisions", the clarification request "Respond to clarification" with "Please respond by (day)", and the approved event "Registration settings", "View registrations" and "Request a change". | |
| 6 | "View clarification history" opens the dialog; Close and Escape close it. | |

## Create or edit a request, and Request submitted

| # | Check | Result |
|---|---|---|
| 7 | "+ New event request" opens "Create event request". Save draft with a name: "Draft saved. You can submit it when you're ready." | |
| 8 | Submit request: "Request submitted" replaces the form, with the reference number. "← Back to my requests" shows the list with the new request as Requested. | |
| 9 | "Revise and resubmit" opens "Edit draft request" with the previous decisions beside it. Submit: "Request submitted", without the old rejection. | |

## Request a change

| # | Check | Result |
|---|---|---|
| 10 | "Request a change" opens a panel titled "Request a change" with the event's name under it. | |
| 11 | Choose a field, describe it and press "Submit change request": "Your change request has been submitted." shows with "Request another change", the panel stays open, and "Change request history" lists the new request as Outstanding. | |
| 12 | "Request another change" brings the empty form back. "← Back to my requests" returns to the list. | |

## Reply to a clarification

| # | Check | Result |
|---|---|---|
| 13 | "Respond to clarification" opens "Reply to the Coordinator" with the question, "Please reply by (day).", and "Event amendments" listing only the fields the Coordinator enabled. | |
| 14 | Write a reply and press "Send reply": the list shows again and the request no longer reads "Awaiting your response". | |

## Registration

| # | Check | Result |
|---|---|---|
| 15 | Registration in the nav: one title, "Event registration", and each eligible event with its status, start date and a "Configure registration" button. | |
| 16 | Settings: "Current registration" shows Status, Opens, Closes, Capacity, Registered and Waiting list. "Configure registration" opens the form; "Save registration settings" returns to the summary with "Registration settings saved." | |
| 17 | "View registrations": the event's name as the title, Registered and Waitlisted counts, "Hide withdrawn", and a table of attendee, email, joined time and status. | |

## Keyboard

| # | Check | Result |
|---|---|---|
| 18 | Tab reaches every link, button, field, select, checkbox and "details" line on each screen, in reading order, and each shows a clear teal focus ring. Enter or Space opens and closes each "details" line. | |
| 19 | Enter on "+ New event request", "Continue editing", "Respond to clarification" or "Request a change" puts focus on the panel's title. "← Back to my requests" puts focus back on the button that opened it. | |
| 20 | "Respond in My Events" on the dashboard opens the reply panel with focus on "Reply to the Coordinator". After "Send reply", focus is on "My event requests". | |
| 21 | After Submit request, focus is on "Request submitted". After "Submit change request", focus is on the confirmation; after "Request another change", on "What needs to change?". | |
| 22 | On the settings page, "Configure registration" puts focus on the form's "Configure registration" heading. "← Back to registration settings" and Save put it back on the "Configure registration" button. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 23 | Dashboard, My Events, each panel, and the three registration pages: no sideways scrolling. | |
| 24 | The long event name wraps in the dashboard rows, the My Events row, the "Request a change" panel and the registration titles. The badges sit under or beside it. | |
| 25 | The forms are one column: the start and end times, the change rows, the reply amendments and the registration fields fit the width, and the buttons wrap rather than run off the edge. | |
| 26 | The event details on the dashboard and My Events show each label above its value. On "View registrations", each registration is a card of Attendee, Email, Joined (Singapore time) and Status. | |

## Found and fixed during the test

-

## Not checked by hand

- Where focus goes when the opener's row has gone before Back: covered by `SCRUM585_AC5_back_after_the_opener_has_gone_focuses_the_list_title` in `scrum585OrganiserKeyboard.test.jsx`.
- Button height: the shared Button is about 40px tall, below the 44px target; that belongs to `ui.css`, not this story.
