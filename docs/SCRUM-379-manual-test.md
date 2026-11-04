# SCRUM-379 manual test record

Run by SL on 28 Oct 2026 against Supabase with migrations 033 and 034 applied, using the seed `SCRUM-379-manual-seed.sql` (eight events named `ZZ smoke 379 A` to `H`) and two coordinator accounts (C1 and C2). The seed is for testing only and is not part of the PR.

## The seeded events

- A: ended, assigned to C1, with a change request and a venue booking. Completed during the test with no notes typed.
- B: ended, no notes. Completed during the test with no notes.
- C: confirmed, end time moved to 3:07 pm to test the "not ended yet" rule, then completed.
- D: approved, never confirmed.
- E: pending clarification, overdue.
- F: confirmed, assigned to the other coordinator.
- G: confirmed, ends on 4 Nov 2026, no venue booking.
- H: ended, with a venue and reserved equipment. Completed with the note "Test note".

## What was checked, by acceptance criterion

AC1 (only an assigned coordinator, only after the end time)
- Mark as completed is offered on an ended Confirmed event of the signed-in coordinator, and not before the end time.
- Event C was refused before its end time and accepted after it.
- Database refusals, called directly: not ended (G), not Confirmed (D approved, C already Completed), wrong coordinator (F). Each raised the expected error.

AC2 (optional closing notes, coordinators only)
- Notes are optional: B was completed with none.
- The 2000 character limit refuses 2001 characters.
- H saved "Test note". C1 (assigned) and C2 (not assigned, by direct link) both read it. The page says that only coordinators can see the notes.
- An event completed with no notes reads "No closing notes were recorded".
- The panel after the first click shows the notes with an Edit notes button before the final confirm.

AC3 (final and read-only)
- A Completed event shows no Mark as completed, edit or cancel buttons to the other coordinator.
- The organiser no longer sees Request a change on a Completed event (found in this test and fixed).

AC4 (one action releases everything else)
- H: its equipment reservation was released with the reason "event completed".
- A: its open change request was closed with the outcome `event_completed`. The coordinator page first showed this as "Rejected" (found and fixed), and now reads "Closed, event completed".
- Registration closed. The venue booking was kept as a history record.

AC5 (every record viewable)
- The organiser sees the arrangements of a Completed event: the venue, and the equipment once its status was set to arranged on H (found and fixed).
- Closing notes are visible to coordinators, never to the organiser.

AC6 (status history)
- Status history rows for A, B and H were checked in the database: the coordinator who completed each event and the time are recorded.
- The organiser sees the status "Completed".

AC7 (Needs attention)
- The list is per coordinator, earliest event first, and one row per reason.
- A completed event leaves the list.
- Restyled and given an Open button after the first look.

## Found and fixed during the test

- Request a change was still offered to the organiser on a Completed event.
- A Completed event showed no confirmed arrangements to the organiser.
- A change request closed by the completion was labelled "Rejected" (coordinator page).
- The Needs attention list was unstyled and had no way to open an event.
- "Go back" on the completion panel was renamed Edit notes, and its hint text was shortened.

## Not checked by hand

- The organiser's status history has no screen. It was read with SQL only.
- Seed artefacts to ignore: "No name on record", and "No coordinator has been assigned" (the seed made no assignment history rows).
