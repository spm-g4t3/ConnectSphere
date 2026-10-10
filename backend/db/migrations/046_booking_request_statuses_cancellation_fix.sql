-- 046_booking_request_statuses_cancellation_fix.sql
-- Ensure cancellation functions can inspect and withdraw venue booking
-- requests on databases where 027_booking_request_statuses.sql was missed.
--
-- 027 remains the authoritative booking-request status migration. These
-- idempotent additions are a deployment catch-up: the live cancellation
-- preview reported that 'pending' was missing from booking_status, and
-- release_event_arrangements also requires 'withdrawn'.
--
-- Keep this migration limited to enum additions. PostgreSQL makes newly added
-- enum values available after the migration transaction commits.

alter type booking_status add value if not exists 'pending';
alter type booking_status add value if not exists 'rejected';
alter type booking_status add value if not exists 'withdrawn';
