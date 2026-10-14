-- 067_conflicting_booking_status.sql
-- SCRUM-261 (SCRUM-258 AC3): a booking request can be 'conflicting' -- still
-- open, but another event's request for an overlapping period was approved.
--
-- Appended, as 027 appends the request statuses, because
-- backend/src/domain/bookingStatus.js mirrors the enum in declared order.
--
-- Its own file: PostgreSQL will not let a transaction use an enum value until
-- the transaction that added it commits (see 027 and 062). 068 uses it.
--
-- Re-runnable: add value if not exists.

alter type booking_status add value if not exists 'conflicting';
