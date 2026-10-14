-- 070_converted_venue_hold_status.sql
-- SCRUM-262 (SCRUM-258): a venue hold can be 'converted' -- its event's
-- booking request for the same venue was approved, so the booking now
-- occupies the venue and the hold no longer does.
--
-- Appended, as 047 appends 'released', because
-- backend/src/domain/venueHoldStatus.js mirrors the enum in declared order.
--
-- Its own file: PostgreSQL will not let a transaction use an enum value until
-- the transaction that added it commits (see 047 and 067). 071 uses it.
--
-- Re-runnable: add value if not exists.

alter type venue_hold_status add value if not exists 'converted';
