-- ---------------------------------------------------------------------------
-- 009_bookings.sql
--
-- PROVISIONAL. Created by SCRUM-15 solely so that AC3's final clause --
-- "while its past bookings remain viewable" -- is demonstrable rather than
-- aspirational. Retiring a venue is meaningless as a soft delete if nothing
-- can hold a reference to the venue afterwards.
--
-- The venue booking feature is a separate story: the customer briefing lists
-- Venue Booking Request, Venue Booking Approval, Tentative Venue Holding,
-- Booking Conflict Detection and Setup and Turnaround Time as their own
-- features, and this table implements none of them. Whoever picks that story
-- up OWNS this table and is expected to extend it -- status, approval,
-- holds, conflict detection, setup and turnaround windows -- rather than
-- create a second one beside it.
--
-- Deliberately absent, so that extending is easier than unpicking:
--   no status enum, no approval columns, no hold or block handling, no
--   exclusion constraint on overlapping bookings.
--
-- Run once in the Supabase SQL Editor, after 008_venue_audit_completion.sql.
-- ---------------------------------------------------------------------------

create table if not exists bookings (
  id               uuid primary key default gen_random_uuid(),

  -- on delete restrict is the load-bearing line of this migration. It makes
  -- "a venue with bookings cannot be hard-deleted" a guarantee of the database
  -- rather than a convention, which is precisely what AC3 rests on: retirement
  -- is the supported way to remove a venue, and a booked venue must survive it
  -- so its past bookings stay readable.
  venue_id         uuid not null references venues (id) on delete restrict,

  -- cascade, unlike the venue: if the event request itself is deleted there is
  -- nothing left for the booking to be a booking *for*.
  event_request_id uuid not null references event_requests (id) on delete cascade,

  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  created_at       timestamptz not null default now(),

  -- The same shape as event_requests_dates_ordered in 001. Conflict detection
  -- between bookings is the booking story's; this only says a single booking
  -- may not end before it starts.
  constraint bookings_times_ordered check (ends_at > starts_at)
);


-- How a venue's bookings are read: most recent first, including for a venue
-- that has since been retired.
create index if not exists idx_bookings_venue
  on bookings (venue_id, starts_at desc);

-- And the other direction, for "what is booked for this event".
create index if not exists idx_bookings_event_request
  on bookings (event_request_id);


-- Same posture as every other table: enabled with no policies, so a stray
-- publishable key reads nothing and the API stays the only way in.
alter table bookings enable row level security;
