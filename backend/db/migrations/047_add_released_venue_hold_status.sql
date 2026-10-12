-- SCRUM-374: add an explicit status for a venue hold released by cancellation.
--
-- Run after 040_venue_holds.sql in its own migration/SQL Editor execution.
-- PostgreSQL does not allow a newly-added enum value to be used until the
-- transaction adding it has committed. Apply 048 only after this completes.

alter type venue_hold_status add value if not exists 'released';
