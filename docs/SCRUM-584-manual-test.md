# SCRUM-584 manual test record

Run by ___ on ___ with `npm run dev`, using existing accounts. No new seed data is needed.

Check each row on a laptop browser. Mark ✅ or ❌ and write a note for anything that looks wrong. Two rows also need the device's time zone changed: on macOS, System Settings → General → Date & Time, turn off "Set time zone automatically", and pick a city such as New York. Set it back afterwards.

## Login (any account)

| # | Check | Result |
|---|---|---|
| 1 | The page has one large title, "Log in". The fields and the full-width teal button look as they did before the story. | |
| 2 | Submitting with empty fields shows "Email and password are required" in a red notice with no Try again button. | |
| 3 | A wrong password shows the error notice and clears the password. A correct one opens the dashboard. | |
| 4 | Reloading the app shows "Loading..." (three full stops) before the page appears. | |

## Navigation and Dashboard shell (sign in as each of the 7 roles in turn)

| # | Check | Result |
|---|---|---|
| 5 | Each role sees its own dashboard with one large title. The nav links match that role. | |
| 6 | Log out is a teal button. While logging out it shows "Logging out..." and is dimmed. | |
| 7 | The Notifications link (with the unread badge) jumps to the inbox on the dashboard. | |

## Notification inbox (an account with unread notifications, for example a Coordinator)

| # | Check | Result |
|---|---|---|
| 8 | The section heading reads "Notifications (n unread)" and is smaller than the page title. | |
| 9 | Each row shows "Received" with a date like "15 Jan 2026, 9:00 am". Dates inside the messages use the same style. | |
| 10 | Mark as read is a teal button. It works, and the unread count and nav badge both drop by one. | |
| 11 | Stop the backend and reload the dashboard: the inbox shows "Notifications could not be loaded." with Try again. Start the backend again and click Try again: "Loading..." shows, then the list. | |
| 12 | An account with no notifications sees "You have no notifications." and "Updates about your events will appear here." | |
| 13 | Change the device's time zone to New York and reload. The inbox times are unchanged, because they are Singapore time. Set it back. | |

## "Not available to your role"

| # | Check | Result |
|---|---|---|
| 14 | Signed in as an Attendee, open `/venue-catalogue` directly. The page has one title, "Not available to your role", and says to ask your Event Coordinator Lead. It does not mention an administrator. | |

## Elsewhere (unchanged by the story, checked for side effects)

| # | Check | Result |
|---|---|---|
| 15 | One role screen per role, for example the review queue and the venue catalogue, looks the same as before the story: colours, badges and buttons. | |
| 16 | With the time zone still set to New York (from row 13), an event's time on a role screen matches the Singapore time it was created for. | |

## Found and fixed during the test

-

## Not checked by hand

- Every role's heading count and the one-h1 rule: covered by `scrum584SharedScreenHeadings.test.jsx`.
- An unknown role's empty dashboard: no such account can sign in, so it is covered by `Dashboard.test.jsx`.
