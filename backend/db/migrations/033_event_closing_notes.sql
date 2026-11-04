-- SCRUM-380: closing notes on a completed event.
--
-- Notes the coordinator writes when marking an event completed (actual
-- attendance, issues on the day). Coordinators only: the API never maps this
-- column into an organiser's response. The database keeps the notes tied to
-- the status, so a row that is not Completed cannot carry them.

alter table event_requests
  add column if not exists closing_notes text;

alter table event_requests
  drop constraint if exists event_requests_closing_notes_only_completed;
alter table event_requests
  add constraint event_requests_closing_notes_only_completed
  check (closing_notes is null or status::text = 'completed');

-- Optional notes are stored as null, never as an empty string, and are capped
-- so one event cannot hold an unbounded blob.
alter table event_requests
  drop constraint if exists event_requests_closing_notes_nonblank;
alter table event_requests
  add constraint event_requests_closing_notes_nonblank
  check (closing_notes is null or (closing_notes !~ '^\s*$' and length(closing_notes) <= 2000));
