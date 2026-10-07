-- 028_booking_status_default_pending.sql
-- SCRUM-251: Default a new booking's status to pending
--
-- Part of SCRUM-243 "Submit a Venue Booking Request". Run this once in the
-- Supabase SQL Editor, after 027_booking_request_statuses.sql. Safe to re-run:
-- setting a default to the value it already has changes nothing.
--
-- 011 gave bookings.status a default of 'approved', which was honest while a
-- booking was only ever an approved hold. A booking is now a request that
-- Venue Staff have not yet decided, so a row written without a status must be
-- 'pending', not a hold nobody approved.
--
-- Why this is its own file and not part of 027: 'pending' was added to the
-- enum there, and Postgres refuses to use a new enum value in the transaction
-- that added it. The SQL Editor runs a script as one transaction, so naming
-- 'pending' in a default had to wait for a script of its own.
--
-- What does and does not change:
--   * Only the default. `set default` is not applied to existing rows, so
--     every booking already stored keeps the status it has -- all 'approved'
--     today, because 011 defaulted them.
--   * A writer that names a status is unaffected, so an explicit 'approved',
--     'cancelled' or any other value is stored as given.
--   * The column stays `not null`.
--   * Nothing in backend/src inserts a booking, so no application default
--     needs to change. The writer for SCRUM-243 should still set the status
--     itself rather than lean on this default.

alter table bookings
  alter column status set default 'pending';
