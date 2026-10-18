-- SCRUM-41: successful registrations, using the shape read by migration 068.
-- SCRUM-39 must lock the event row, check eligibility/capacity and insert in
-- one PostgreSQL function call, deriving the attendee from the verified caller.

create table if not exists registrations (
  id               uuid primary key default gen_random_uuid(),
  event_request_id uuid not null references event_requests (id) on delete restrict,
  attendee_id      uuid not null references auth.users (id) on delete restrict,
  status           text not null default 'registered',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint registrations_status_known
    check (status in ('registered', 'withdrawn', 'cancelled'))
);

-- Inactive rows remain as history; a later registration may take a new place.
create unique index if not exists idx_registrations_active_attendee_event
  on registrations (attendee_id, event_request_id)
  where status = 'registered';

create index if not exists idx_registrations_attendee
  on registrations (attendee_id, created_at desc);
create index if not exists idx_registrations_event_request
  on registrations (event_request_id, status);

drop trigger if exists registrations_set_updated_at on registrations;
create trigger registrations_set_updated_at
  before update on registrations
  for each row execute function set_updated_at();

-- As with event_requests, Express authorises access through its secret key.
-- No browser policies or write function: checked insertion belongs to SCRUM-39.
alter table registrations enable row level security;
revoke all on table registrations from public, anon, authenticated;
grant select, insert, update on table registrations to service_role;
