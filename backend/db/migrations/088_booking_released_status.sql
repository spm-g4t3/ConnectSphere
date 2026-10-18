-- 088_booking_released_status.sql
-- SCRUM-492: the booking status a coordinator's release writes (089).
-- Its own file, run and committed before 089: an enum value cannot be used in
-- the transaction that adds it (065). Re-runnable: add value if not exists.

alter type booking_status add value if not exists 'released';
