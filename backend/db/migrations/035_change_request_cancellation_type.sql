-- Migration 035: an Organiser may ask for their event to be cancelled through a
-- change request (SCRUM-402 AC7). The value is added on its own, ahead of 036,
-- because Postgres cannot use an enum value in the transaction that adds it:
-- 036's functions compare against it as text and nothing there inserts it.
--
-- Re-runnable.

alter type event_change_field add value if not exists 'cancellation';
