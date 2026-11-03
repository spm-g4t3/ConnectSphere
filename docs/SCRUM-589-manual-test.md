# SCRUM-589 manual test record

Run by ___ on ___ with `npm run dev`, signed in as an Attendee. No seed script creates attendee data, so set it up in the app first, as in the README's "Checking the waiting list by hand":

- As an Organiser, configure registration on two Confirmed events: event A with capacity 5 and a withdrawal deadline in the future, event B with capacity 1 and "Waiting list is on". Give event A a long name with one very long word (for the 360px rows).
- Use three Attendee accounts: Attendee 1 for the test, Attendee 2 to fill event B, and Attendee 3 with no registrations or waiting-list places.
- For row 14, a Coordinator cancels an event that Attendee 1 is registered for.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, Space, Enter and Escape.

## Dashboard and headings

| # | Check | Result |
|---|---|---|
| 1 | The dashboard has one large title, "Welcome, (name)", and the cards are headed "Registered events" and "Browse Open Events". Both buttons are teal and open the right page. | |
| 2 | Each Attendee page has one large title (Browse Open Events, the event's name, Registered events) and teal section headings below it. | |

## Browse Open Events

| # | Check | Result |
|---|---|---|
| 3 | Reloading shows "Loading..." (three full stops) first. Each row shows the event name as a link, a time like "15 Jan 2026, 9:00 am – 11:00 am", "(Singapore time)" and an availability badge (blue places left, amber Full). | |
| 4 | An event you are registered for shows a green Registered badge; one you are waiting for shows "Waitlisted: position N". | |

## Event details and registering

| # | Check | Result |
|---|---|---|
| 5 | Open event A. The When and Availability boxes show, "Back to open events" is an underlined link at the bottom, and Register is a teal button. | |
| 6 | Choose Register. It reads "Registering...", then a green "You are registered for (event)." shows, the button becomes a disabled "Already registered" and a Registered badge appears. | |
| 7 | As Attendee 2, register for event B. Back as Attendee 1, event B shows Full and "Join waiting list". Choose it: "You are on the waiting list for (event) at position 1." shows and the button becomes "On the waiting list". | |

## Registered events and waiting lists

| # | Check | Result |
|---|---|---|
| 8 | Registered events lists event A as a link under "Registered", and event B under "Waiting lists" with "Waitlisted: position 1" and a red Leave waiting list button. | |
| 9 | Choose Leave waiting list. A dialog asks "Leave the waiting list?". Keep my place closes it and the place stays. | |
| 10 | Choose it again and Confirm leaving: the dialog closes, "You have left the waiting list for (event)." shows and the entry disappears. | |

## Event information and withdrawing

| # | Check | Result |
|---|---|---|
| 11 | Open event A from Registered events. Confirmed arrangements shows the time with "(Singapore time)" and the venues. "Back to registered events" is an underlined link. | |
| 12 | Choose Withdraw registration. A dialog asks "Withdraw your registration?". Keep my registration closes it and nothing changes. | |
| 13 | Choose it again and Confirm withdrawal: the dialog closes and "Your registration has been withdrawn." shows with a grey Withdrawn badge and a Browse open events link. | |
| 14 | Open the event the Coordinator cancelled: "This event has been cancelled." shows, with the coordinator's message if any, and no Withdraw registration button. | |

## Errors and empty states

| # | Check | Result |
|---|---|---|
| 15 | Stop the backend and reload Browse Open Events, Registered events and an event page: each shows a red notice with Try again. Start the backend and choose Try again: the page loads. | |
| 16 | With the backend stopped, choose Withdraw registration and confirm: a red notice says the registration has not changed, with Try again. Start the backend and choose Try again: it reads "Withdrawing...", then the withdrawn notice shows. | |
| 17 | As Attendee 3, Registered events says "You have no active event registrations." with a Browse Open Events button, and "You are not on any waiting lists." with how to join one. | |
| 18 | There is a gap below every red notice before the next item. | |
| 19 | Links in text (the event names under Registered, "Manage it from your registrations" on a waitlisted event, "Browse open events" in the withdrawn notice) are dark teal, not blue. The teal buttons keep white text. | |

## Keyboard

| # | Check | Result |
|---|---|---|
| 20 | Tab reaches every link and button on each page in reading order, and each shows a clear teal focus ring, the dashboard and Browse buttons included. Enter opens links and presses buttons. | |
| 21 | In each dialog, focus starts on the keep button (Keep my place, Keep my registration). Tab moves to the confirm button. Escape closes the dialog and focus is back on the button that opened it. | |
| 22 | After Confirm withdrawal, focus is on the "Your registration has been withdrawn." notice. After Confirm leaving, focus is on "You have left the waiting list…". | |
| 23 | After Register or Join waiting list, focus is on the green notice, or on the red notice if it failed. | |
| 24 | Stop the backend, then leave a waiting list: the error shows and focus is back on Leave waiting list. Withdraw with the backend stopped: focus is on the red notice, and Tab reaches Try again. | |
| 25 | Stop the backend and open each page so it shows Try again. Start the backend, Tab to Try again and press Enter: when the page has loaded, focus is on the section heading (Registered, Waiting lists, Events open for registration, Event details; the event's name on event information), not lost. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 26 | Dashboard, Browse Open Events, event details, Registered events and event information: no sideways scrolling. | |
| 27 | The long event name wraps in the page title, in the Browse row, in the Registered link, in the waiting-list row and in the success notices. The badges sit under or beside the name, not off the edge. | |
| 28 | The When and Availability boxes, the description and the Register or Join button fit the width. | |
| 29 | Both dialogs fit the width, and both buttons are fully visible (their labels may wrap onto two lines). | |

## Found and fixed during the test

-

## Not checked by hand

- That registering, joining, leaving and withdrawing send the same requests as before: covered by the existing component tests and `SCRUM589_AC9_*` in `scrum589AttendeeStates.test.jsx`.
- A refusal shown again after the page reloads, which needs a refused withdrawal and then a tab return: covered by `SCRUM589_AC7_a_refusal_shown_again_after_a_reload_does_not_take_focus`.
