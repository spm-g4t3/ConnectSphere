# SCRUM-588 manual test record

Run by ___ on ___ with `npm run dev`, signed in as Technical Support Staff. Set up first:

- Run `npm run equipment:seed` in `backend/` (it is safe to run twice). It adds Projector (HD), Wireless microphone, Portable speaker, Video-conference kit, Presentation laptop and one retired type. No seed script creates equipment requests.
- As an Event Coordinator, record equipment on two approved events assigned to you: event A asks for 3 Projector (HD) and 2 Wireless microphone, and event B asks for 1 Portable speaker. Give event A a long name with one very long word (for the 360px rows).
- For row 9 you need a flagged reservation. After row 7 has reserved Projector (HD) for event A, open the catalogue, edit Projector (HD), lower the total below what is reserved and confirm "Confirm and flag these reservations".

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. For the 360px rows, open the browser's developer tools, turn on the device toolbar and set the width to 360. For the keyboard rows, put the mouse aside and use only Tab, Shift+Tab, Space, Enter and Escape.

## Dashboard and Equipment Requests

| # | Check | Result |
|---|---|---|
| 1 | The dashboard has one large title, "Welcome, (name)", with "Needs action (N)", "Equipment requests" and "Reviewed by me" as teal section headings. The Equipment Requests page has one large title, "Equipment request queue", and the same sections. | |
| 2 | Reloading shows "Loading..." (three full stops). Each row shows the event name, a status badge (amber Pending review, blue Under review, green Arranged, red Cannot be fully arranged), a time like "15 Jan 2026, 9:00 am – 11:00 am", the venues, the coordinator and the item count, and an Open link. | |
| 3 | Choose Status "Under review": only Under review requests show. With no match it says "No equipment requests match these filters." and "Change or clear the filters." Tick Include past events: past events are added. | |
| 4 | After row 6, "Reviewed by me" lists event A with "Last worked on:" and the date in the same format. | |

## Equipment review

| # | Check | Result |
|---|---|---|
| 5 | Open event A. The page has one large title, "Equipment request review", the event name as a heading with an amber Pending review badge, and When, Venue and Coordinator. Refresh is an underlined link. | |
| 6 | Choose Start review: the green "You are now reviewing this request." shows, the badge becomes Under review, and the tabs Needs attention, Done and All show their counts. | |
| 7 | Open Projector (HD), leave the number as offered and choose Reserve: "Reserved N of Projector (HD)." shows and the line's "N of 3 reserved" goes up. | |
| 8 | On the Wireless microphone line, choose Cannot be provided, type a note and Save note: the line shows a red Not provided badge and the note. Save note with an empty note says "Add a note explaining why this cannot be provided." | |
| 9 | With the flagged reservation set up: the line shows an amber Needs decision badge, and the reservation shows "Needs your decision", why it was flagged, "Reserved for" and "The event is now". Choose Keep old time or Move to new time: the flag goes and a green notice says what was done. | |
| 10 | With a line still short, choose Complete review. A dialog asks "Complete this review?". Not yet closes it and nothing changes. Choose it again and Yes, complete review: "Review completed." shows and the badge becomes Cannot be fully arranged. | |

## Equipment Catalogue

| # | Check | Result |
|---|---|---|
| 11 | The page has one large title, "Equipment catalogue", with "Active equipment" and "Retired equipment" headings. Each row's Edit, Damage and maintenance, History and Retire buttons sit on one or two lines, not four. | |
| 12 | Choose Add equipment type: the title becomes "Add an equipment type". Add a type with a long one-word name and total 4. Back on the list, it is in Active equipment. | |
| 13 | Choose Edit on Portable speaker, change the category and Save changes: the list shows the new category. "← Back to the equipment catalogue" returns to the list without saving. | |
| 14 | Choose Damage and maintenance on Portable speaker, set 1 damaged with a note and save: Damaged and Usable change in the row. | |
| 15 | Choose History on Portable speaker: each change shows when it was made, like "15 Jan 2026, 9:00 am", what changed and the note. | |
| 16 | Choose Retire on the type from row 12. A red dialog asks "Retire (name)?". Cancel closes it and nothing changes. Choose it again and Confirm retire: the type moves to Retired equipment. | |
| 17 | Choose Retire on Projector (HD), which event A has reserved, and Confirm retire: the dialog closes and "Check before you save" lists event A's reservation under the row. Keep this type closes the list and nothing changes. | |
| 18 | Choose Reinstate on the type retired in row 16: it moves back to Active equipment. | |

## Check Availability

| # | Check | Result |
|---|---|---|
| 19 | The page has one large title, "Check equipment availability". Choose Projector (HD), quantity 7 and a period: the result says "Partially available" in amber, with the breakdown and any overlapping reservations, each with a time like "15 Jan 2026, 9:00 am – 11:00 am" and a Reserved or Flagged for review badge. | |
| 20 | Submit with every field empty: each fault is listed in red under the form. | |

## Errors and empty states

| # | Check | Result |
|---|---|---|
| 21 | Stop the backend and reload the dashboard, Equipment Requests, a review, the catalogue, a type's History and Check Availability: each shows a red notice with Try again. Start the backend and choose Try again: the page loads. | |
| 22 | Open `/equipment-review/` followed by a made-up id: "That event could not be found." shows with no Try again. | |
| 23 | With the backend stopped, choose Complete review and confirm: the dialog closes and a red notice shows with no Try again (Complete review is the retry). | |
| 24 | A Technical Support account with no reviews sees "You have not reviewed any equipment requests yet." under Reviewed by me. With every type retired (or on an empty database), the catalogue says "No active equipment types yet." and Check Availability offers an "Open the equipment catalogue" button. | |

## Keyboard

| # | Check | Result |
|---|---|---|
| 25 | Tab reaches every link, button, filter and field on each page in reading order, and each shows a clear teal focus ring: the Open links, the review tabs, the + and − buttons, the line toggles, Stock details, and the catalogue and availability buttons. Enter opens links and presses buttons; Space presses buttons. | |
| 26 | On the review, the selected tab is announced as selected (screen reader) and Enter or Space on another tab switches the list. | |
| 27 | In both dialogs, focus starts on Cancel or Not yet. Escape closes the dialog and focus is back on Retire or Complete review. | |
| 28 | After Confirm retire with nothing reserved, focus is on that type's Reinstate button. With reservations, focus is on "Check before you save"; Keep this type puts it back on Retire. After Yes, complete review, focus is on "Review completed." (or on the red notice if it failed). | |
| 29 | Opening Add, Edit, Damage and maintenance or History puts focus on the page title. Back or a save puts it back on the button that opened the panel. On the review, opening a note or reservation form puts focus on its heading, and Cancel puts it on the line's toggle. After Start review, Reserve or Save note, focus is on the green notice or the red error. | |
| 30 | Stop the backend and open each page so it shows Try again. Start the backend, Tab to Try again and press Enter: when the page has loaded, focus is on the section heading (Needs action, Reviewed by me, Active equipment, Choose equipment and period; the page title on a review or History), not lost. | |

## 360px wide

| # | Check | Result |
|---|---|---|
| 31 | Dashboard, Equipment Requests, the review (with a line open, the flagged reservation and a reservation form), the catalogue with a panel open, and Check Availability with a result: no sideways scrolling. | |
| 32 | The long names from the setup and row 12 wrap in the queue rows, the review's heading and lines, the catalogue and the availability results. On the catalogue each type is a card: the name, then each figure with its label, then the buttons. | |
| 33 | Both dialogs and the "Check before you save" list fit the width, with every button fully visible. | |

## Found and fixed during the test

-

## Not checked by hand

- That every screen fetches and sends the same requests as before: covered by the existing component tests and `SCRUM588_AC10_*` in `scrum588TechSupportStates.test.jsx`.
- That a double click on the catalogue's Try again sends one read: covered by `SCRUM588_AC4_a_double_click_on_the_catalogue_try_again_sends_one_read`.
- Focus after a failed note save and after a page error: covered by `SCRUM588_AC8_*` in `scrum588TechSupportKeyboard.test.jsx`.
