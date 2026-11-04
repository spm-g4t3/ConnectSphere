# SCRUM-590 manual test record

Run by ___ on ___ with `npm run dev`, signed in as an Event Coordinator Lead. No seed script creates unassigned requests, so set up first:

- As an Event Organiser, submit three event requests. Give one a long name with one very long word, and a long organiser name if you can (for the 360px rows). Leave one without a date. Give one accessibility requirements and leave them blank on another.
- You need at least two Event Coordinator accounts, and at least one event already held by a coordinator (assign one in row 8 if there is none).

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, the arrow keys, Space and Enter.

## Navigation and headings

| # | Check | Result |
|---|---|---|
| 1 | The nav shows Dashboard, Unassigned Queue and Assigned Events. | |
| 2 | The dashboard has one large title, "Event Coordinator Lead", then the cards "Unassigned queue (N)", "Coordinator overview" (with an "Assigned Events" link) and the notifications. | |
| 3 | Unassigned Queue has one large title, "Unassigned queue (N)". Assigned Events has one large title, "Assigned events", with "Coordinators" and "Events" as teal section headings. | |

## Unassigned queue and panels

| # | Check | Result |
|---|---|---|
| 4 | Each row shows the event name, "Organiser:", the time as "15 Jan 2026, 9:00 am – 11:00 am" (or "not set"), "Expected attendance:" and "waiting N days". Each row has a teal Assign and a red Cancel request button. Oldest submission is first. | |
| 5 | Assign opens "Assign (event name)" with "← Back to the unassigned queue" as an underlined link at the top. Under the title, Organiser, When, Expected attendance and "In the queue" match the row you opened it from. Each coordinator is a card with "N active events". None is chosen, and Confirm assignment stays disabled until you pick one. | |
| 6 | Assign a request that has accessibility requirements: the panel lists them as "Accessibility needs". Assign one without any: that line is not there. | |
| 7 | Back, and the form's Cancel, return to the list with nothing changed. | |
| 8 | Choose a coordinator, add a note and press Confirm assignment. The list shows a green "(event) was assigned to (name)." The row has gone and the count in the title is one lower. | |
| 9 | Cancel request opens "Cancel (event name)". Preview cancellation with no reason or initiator: the browser asks for them. Fill both and preview: the impact shows, with the "I have reviewed the impact…" checkbox. The red Cancel request stays disabled until it is ticked. | |
| 10 | Tick it and press Cancel request. The list shows a green "(event) was cancelled. The organiser has been told." and the row has gone. | |

## Assigned events

| # | Check | Result |
|---|---|---|
| 11 | Under the title, "N requests are waiting for a coordinator." matches the queue, with an "Open the Unassigned Queue" link that opens it. | |
| 12 | The Coordinators table lists every coordinator by name with "Active events" and one column per active status. A zero shows as 0. | |
| 13 | Choose a Coordinator, then a Status: only matching events show. With no match it says "No events match these filters." and "Change or clear the filters to see more." Tick "Include completed, rejected and cancelled": finished events are added. | |
| 14 | With the filters finding nothing, press Clear filters: the selects go back to "All coordinators" and "All statuses", the checkbox is unticked and the events show again. | |
| 15 | When no coordinator holds an active event (before any assignment), the list says "No coordinator is holding an active event." with an "Open the unassigned queue" button that opens the queue. | |
| 16 | Each row shows the name with a coloured status badge (for example green Planning, blue Under review), a date like "15 Jan 2026, 9:00 am" (or "Date not set"), "Organiser:", "Coordinator:" and an Open link. Open goes to the event page. | |

## Reassign and assignment history (event page, as the Lead)

| # | Check | Result |
|---|---|---|
| 17 | Under "Coordinator", "Current coordinator" names who holds it, and "Assignment history" lists "Assigned to (name)" with "15 Jan 2026, 9:00 am · by (name)" and the note, or "No handover note was left." | |
| 18 | "Hand over to another coordinator" opens "Hand over (event name)". The list leaves out the current holder. Cancel returns to the event. | |
| 19 | Choose someone and Confirm handover: "Handed over to (name)." shows and the history gains "Handed from (old) to (new)". | |

## Lead and Coordinator see the same thing

| # | Check | Result |
|---|---|---|
| 20 | Open the same event as the Lead (from Assigned Events) and as its Coordinator (from My events). The status badge has the same words and colour on both, and the history and its dates read the same. | |

## Loading, empty and error states

| # | Check | Result |
|---|---|---|
| 21 | Reloading the queue and Assigned Events shows "Loading..." (three full stops) first, for each part. | |
| 22 | With nothing waiting, the queue says "No event requests are waiting for a coordinator." and "New requests appear here when organisers submit them." | |
| 23 | With the backend stopped, reload the queue: "The unassigned queue could not be loaded." with Try again, and the title shows no count. Start the backend and press Try again: the list appears. | |
| 24 | With the backend stopped, reload Assigned Events: "The number of waiting requests could not be loaded.", "The coordinators' workload could not be loaded." and "The assigned events could not be loaded.", each with Try again. Start the backend: each Try again brings its part back. | |
| 25 | With the queue loaded, stop the backend, then press Assign on a row: "The list of coordinators could not be loaded." with Try again and "Back to the queue". Start the backend and press Try again: the coordinators appear. | |

## Dates

| # | Check | Result |
|---|---|---|
| 26 | Set the computer's time zone to another one (for example London) and reload. The queue, Assigned Events and the history show the same Singapore times as before. | |

## Keyboard only

| # | Check | Result |
|---|---|---|
| 27 | Tab reaches every button, link, card, radio, checkbox, select and note box on these screens, and each shows a teal focus ring. | |
| 28 | Enter on Assign or Cancel request puts focus on the panel's title. Back, Cancel or "Back to the queue" put focus back on the button you opened it from. | |
| 29 | In the assign panel, Tab reaches the first coordinator, the arrow keys move between them, Tab reaches the note and Confirm assignment, and Enter assigns. After assigning or cancelling, focus is on the queue's title. | |
| 30 | After any Try again (rows 23 to 25), focus is on that part's heading or line, not lost at the top of the page. | |
| 31 | After Clear filters (row 14), focus is on the "Events" heading. | |
| 32 | On Assigned Events, Tab reaches the Coordinators table, which shows a focus ring; the left and right arrow keys scroll it when it is wider than the screen. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 33 | Dashboard, Unassigned Queue and Assigned Events: no sideways scrolling. The large titles wrap inside their card. | |
| 34 | Queue rows: Assign and Cancel request sit under the row's details. The long event and organiser names wrap. | |
| 35 | The assign and cancel panels fit the width: the request details (each label above its value), the coordinator cards, note box, radios, checkbox and buttons are fully visible. | |
| 36 | Assigned Events: the Coordinators table scrolls on its own and the page does not. The filters sit one per line, and each event's Open link is under its details. | |

## No behaviour change

| # | Check | Result |
|---|---|---|
| 37 | Assigning, cancelling and handing over do what they did before this change: the same people are told, the same rows leave the queue and the same history is written. | |
| 38 | Signed in as a Coordinator or Organiser, `/unassigned-queue` and `/assigned-events` still say the page is not available to your role. | |

## Found and fixed during the test

-

## Not checked by hand

- The exact data sent when assigning: covered by `SCRUM590_AC6_the_assign_panel_can_be_completed_with_the_keyboard_only`.
- Where focus lands when a row has gone from the queue before Back: covered by `SCRUM590_AC6_back_after_the_row_has_left_the_queue_focuses_the_title` in `scrum590LeadKeyboard.test.jsx`.
