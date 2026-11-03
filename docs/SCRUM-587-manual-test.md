# SCRUM-587 manual test record

Run by ___ on ___ with `npm run dev`, signed in as Venue Staff. No new seed data is needed. To have something in each list, as a Coordinator send a booking request for an Approved event (Booking Requests), and add a block over an approved booking's period (Flagged Bookings). For the hold rows, place a hold from a venue's holds panel.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, use only Tab, Shift+Tab, the arrow keys, Space, Enter and Escape.

## Headings, buttons and badges

| # | Check | Result |
|---|---|---|
| 1 | Venue Catalogue, Booking Requests and Flagged Bookings each have one large title. The dashboard has "Welcome, …" with these as sections below it. | |
| 2 | Booking Requests and Flagged Bookings titles show a count, e.g. "Pending booking requests (3)". It drops by one after a decision. | |
| 3 | Each catalogue row leads with a teal View bookings & history button. Edit details, Manage blocks and Place hold are outlined, and Retire is red and last. | |
| 4 | Badges use one colour per meaning: Active and Approved green; Pending amber; Tentatively held blue; Flagged for review, blocks and Rejected red; Retired, Ended and Cancelled grey. | |
| 5 | A hold shows "Expires … (in N days)". A hold expiring within 24 hours also shows an amber "Expires soon" badge. | |
| 6 | The venue calendar shows a key naming the colours for Booked, Booked – under review, Blocked and Tentatively held. | |

## Loading, empty, errors and dates

| # | Check | Result |
|---|---|---|
| 7 | Reloading any list, a venue's detail or the calendar shows "Loading..." (three full stops) first. | |
| 8 | A venue with no blocks says "This venue has no blocks." and how to add one. An empty catalogue, holds list and calendar period say what to do next too. | |
| 9 | With the backend stopped, reload the catalogue, Booking Requests and the calendar: each shows its error with Try again. Start the backend and click Try again: the content appears. | |
| 10 | Dates read like "15 Jan 2026, 9:00 am". Booking periods end "(Singapore time)". Calendar headings read like "Mon, 5 Oct 2026" and "5 – 11 Oct 2026". | |

## Confirmations

| # | Check | Result |
|---|---|---|
| 11 | Retire opens a dialog "Retire (venue)?". Keep venue closes it and nothing changes. Retire venue retires it, and the row shows the grey Retired badge. | |
| 12 | Remove on a block opens "Remove this block?" with its reason and period. Keep block closes it; Remove block removes it. | |
| 13 | Adding a block over an approved booking shows the clash. Override and flag opens a dialog saying how many bookings will be flagged. Confirming flags them. | |
| 14 | Editing a venue's opening hours so they clash with a booking: Save and flag opens the same dialog. | |
| 15 | No "Yes, …" button appears anywhere on these screens. | |

## Keyboard

| # | Check | Result |
|---|---|---|
| 16 | Tab reaches every button, link and field on each screen, and each shows a visible focus ring, including the booking card rows and the venue form fields. | |
| 17 | Opening Edit details, View bookings & history, Manage blocks or Place hold from the second venue moves focus to that panel's heading. Back returns focus to the same button. | |
| 18 | Approving a booking request moves focus to the next card's row, or to the title when none are left. A failed approval keeps focus on the card's row. | |
| 19 | In each dialog, focus starts on the cancel button. Escape closes it and focus returns to the button that opened it. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 20 | Catalogue, venue detail, blocks, holds, Booking Requests and Flagged Bookings: no sideways scrolling, and long venue or event names wrap. | |
| 21 | Catalogue row actions wrap under the details, with Retire last. | |
| 22 | Venue form: each opening-hours row shows the day above its opens and closes times. Block form start and end stack. All fields fit the width. | |
| 23 | Calendar: the month grid keeps 7 columns with no scrolling. The week view shows as one row per day. The key and toolbar wrap. Check the week view with VoiceOver too: it should still read as days and entries. | |
| 24 | Each confirmation dialog fits, and its two buttons are fully visible. | |

## Found and fixed during the test

-

## Not checked by hand

- The exact request each confirmation sends: covered by `SCRUM587_AC9_each_confirmation_sends_the_same_request_as_before`.
- An expired session offering no Try again, and a 409 conflict offering none: covered by the `SCRUM587_AC4` tests.
- A new set of conflicts closing the override dialog: covered by `SCRUM587_AC6_a_new_set_of_conflicts_closes_the_override_confirmation`.
