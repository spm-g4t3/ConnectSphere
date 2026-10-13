-- 042_event_cancellation_fields.sql
-- SCRUM-371: store cancellation details and the cancellation outcome for
-- outstanding event change requests.
--
-- The application currently has no registrations table, so registration
-- display is deliberately not changed here.
--
-- Run after 001_event_requests.sql and 006_event_change_requests.sql.
-- Safe to run again.


-- ---------------------------------------------------------------------
-- 1. Cancellation metadata on the event
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_cancellation_initiator') then
    create type event_cancellation_initiator as enum (
      'organiser_request',
      'connectsphere_decision'
    );
  end if;
end
$$;

alter table event_requests
  add column if not exists cancellation_reason text,
  add column if not exists cancellation_initiator event_cancellation_initiator,
  add column if not exists cancelled_by uuid references auth.users (id) on delete restrict,
  add column if not exists cancelled_at timestamptz,
  add column if not exists attendee_message text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_cancellation_reason_nonblank'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_cancellation_reason_nonblank
      check (cancellation_reason is null or length(trim(cancellation_reason)) > 0);
  end if;
end
$$;


-- ---------------------------------------------------------------------
-- 2. Cancellation outcome for change requests
-- ---------------------------------------------------------------------
-- Cancellation closes change requests through the event-cancellation
-- transaction, not through the regular approve/reject endpoint.

alter type change_request_decision
  add value if not exists 'event_cancelled';


notify pgrst, 'reload schema';
