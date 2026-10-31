# SCRUM-591 manual test record

Run by ___ on ___ with `npm run dev`, signed in as a Safety Officer. No new seed data is needed. You need two events waiting for a safety check: sign in as their Coordinator and use "Submit for safety check" on each, then sign back in as the Safety Officer. At least one of them should have a booked venue and an equipment request.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, the arrow keys, Space, Enter and Escape.

## Navigation and headings

| # | Check | Result |
|---|---|---|
| 1 | The nav shows Dashboard and Review history, with no separate "Safety review" link. Dashboard opens the queue. | |
| 2 | Opening `/safety-review` directly shows the same queue, so old links still work. | |
| 3 | The queue has one large title, "Safety review", and the list is headed "Waiting for review". Review history has the title "Review history", and its list is headed "Reviewed events". | |

## Queue and review detail

| # | Check | Result |
|---|---|---|
| 4 | Each row shows its time as "15 Jan 2026, 9:00 am – 11:00 am" style and a teal Review event button. | |
| 5 | Review event opens the detail. "← Back to Safety review" is an underlined link at the top. Back returns to the list. | |
| 6 | The response choices are three cards, each with a line on what happens next. Clicking anywhere on a card selects it, and the selected card is highlighted. | |
| 7 | Choose Request changes. The booking and equipment checkboxes appear, and the Note becomes required. | |
| 8 | Choose Approve and submit. A green "Response recorded: Approved." shows, and the form is replaced by "This event is now SAFETY APPROVED" with a green badge. The event has left the queue. | |
| 9 | On the second event, choose Reject the safety arrangement and submit with no reason. The browser asks for a reason, and no dialog opens. | |
| 10 | Enter a reason and submit. A dialog asks "Reject the safety arrangement for (event)?". Go back closes it, sends nothing and keeps the reason. Submit again and choose Reject arrangement: the event shows "This event is now PLANNING" with a blue badge. | |

## Review history

| # | Check | Result |
|---|---|---|
| 11 | Each row shows "Outcome:" with a coloured badge (green Approved, amber Changes requested, red Safety arrangement rejected) and "Reviewed:" with a date like "16 Jan 2026, 2:30 pm". | |
| 12 | View details opens the event without a response form. Its earlier responses show the same badges and date style. | |

## Loading, empty and error states

| # | Check | Result |
|---|---|---|
| 13 | Reloading the queue or history shows "Loading..." (three full stops) first. | |
| 14 | With the backend stopped, reload the queue: "The safety review list could not be loaded." with Try again. Start the backend and click Try again: the list appears. Do the same on Review history. | |
| 15 | When nothing is waiting, the queue says "No events are waiting for a safety review." and "Events appear here when a coordinator sends them for a safety check." | |

## Keyboard

| # | Check | Result |
|---|---|---|
| 16 | Tab reaches every button, link, checkbox, card and the note box, and each shows a visible focus ring. | |
| 17 | Opening a review puts focus on the event name. Back puts focus on the Review event button of the row you opened. | |
| 18 | On the response choices, the arrow keys move between the cards. Space ticks a checkbox. | |
| 19 | After Submit, focus is on the "This event is now…" line. In the reject dialog, focus starts on Go back, and Escape closes it with focus back on Submit response. | |
| 20 | Stop the backend, then submit a response: the error shows and focus stays on Submit response. Start the backend again. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 21 | Queue, detail, Review history and history detail: no sideways scrolling. The Review event and View details buttons sit under each row's details. | |
| 22 | In the detail, each label (Expected attendance, Location and so on) sits above its value. A long event or venue name wraps. | |
| 23 | The response cards, the note box and Submit response fit the width, and the consequence text wraps. | |
| 24 | The reject dialog fits the width, and Go back and Reject arrangement are both fully visible. | |

## Found and fixed during the test

-

## Not checked by hand

- The exact data sent for each response choice: covered by `SCRUM591_AC8_each_choice_sends_the_same_payload_as_before`.
- The refresh-failure and conflict Try again paths, which need a failure partway through a response: covered by the `SCRUM591_AC4` and `SCRUM591_AC6` tests in `scrum591SafetyOfficerScreens.test.jsx`.
