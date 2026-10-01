-- SCRUM-46: Coordinator clarification and Organiser amendment loop.
-- Run once in the Supabase SQL Editor after 009_bookings.sql.

alter table event_requests
  add column if not exists clarification_note text;

notify pgrst, 'reload schema';