-- 065_booking_decision_statuses.sql
-- SCRUM-258: the two enum values Venue Staff decisions need.
--   booking_status 'conflicting'  still open, but another event's request for
--                                 an overlapping period was approved
--   venue_hold_status 'converted' its event's request for the same venue was
--                                 approved, so the booking occupies it instead
--
-- Appended, as 027 and 047 append theirs, because bookingStatus.js and
-- venueHoldStatus.js in backend/src/domain mirror the enums in declared order.
--
-- Its own file: PostgreSQL will not let a transaction use an enum value until
-- the transaction that added it commits (see 027, 047 and 062), and Supabase's
-- SQL editor runs a file as one transaction.
--
-- Run order: 065, then 066, then 067, each as a separate execution.
-- Re-runnable: add value if not exists.

alter type booking_status add value if not exists 'conflicting';
alter type venue_hold_status add value if not exists 'converted';
