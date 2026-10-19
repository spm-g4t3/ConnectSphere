-- Shared persistence used by registration settings, browse counts and the atomic writer.
-- Requires SCRUM-494 migrations through 091; preserves any legacy registration rows.
lock table event_requests, event_registrations in access exclusive mode;

alter table event_registrations
  add column if not exists created_at timestamptz,
  add column if not exists updated_at timestamptz;
update event_registrations
   set created_at = coalesce(created_at, registered_at),
       updated_at = coalesce(updated_at, registered_at)
 where created_at is null or updated_at is null;
alter table event_registrations
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table event_registrations drop constraint if exists event_registrations_status_known;
alter table event_registrations add constraint event_registrations_status_known
  check (status in ('registered', 'withdrawn', 'waitlisted', 'cancelled'));

do $$
declare
  v_import boolean := false;
begin
  if exists (select 1 from pg_class where oid = to_regclass('public.registrations') and relkind = 'r') then
    if to_regclass('public.registrations_legacy_archive') is not null then
      raise exception 'Registration archive already exists; reconcile it before migrating';
    end if;
    alter table registrations rename to registrations_legacy_archive;
    v_import := true;
  end if;

  if to_regclass('public.registrations_legacy_archive') is not null then
    lock table registrations_legacy_archive in access exclusive mode;
    if v_import then
      insert into event_registrations
        (id, event_request_id, attendee_id, status, registered_at, created_at, updated_at)
      select distinct on (event_request_id, attendee_id)
             id, event_request_id, attendee_id, status, created_at, created_at, updated_at
        from registrations_legacy_archive
       order by event_request_id, attendee_id, (status = 'registered') desc, updated_at desc, id
      on conflict (event_request_id, attendee_id) do update
        set status = excluded.status,
            registered_at = excluded.registered_at,
            created_at = least(event_registrations.created_at, excluded.created_at),
            updated_at = greatest(event_registrations.updated_at, excluded.updated_at)
        where (excluded.status = 'registered' and event_registrations.status <> 'registered')
           or (event_registrations.status <> 'registered'
               and excluded.updated_at > event_registrations.updated_at);
    end if;

    revoke all on registrations_legacy_archive from public, anon, authenticated, service_role;
    grant select on registrations_legacy_archive to service_role;
  end if;
end;
$$;

create or replace view registrations with (security_invoker = true) as
  select id, event_request_id, attendee_id, status, created_at, updated_at
    from event_registrations;
revoke all on registrations from public, anon, authenticated, service_role;
grant select on registrations to service_role;

drop trigger if exists event_registrations_set_updated_at on event_registrations;
create trigger event_registrations_set_updated_at before update on event_registrations
  for each row execute function set_updated_at();
alter table event_registrations enable row level security;
revoke all on event_registrations from public, anon, authenticated;
grant select, insert, update on event_registrations to service_role;
revoke all on event_registration_settings_history from public, anon, authenticated;
grant select, insert on event_registration_settings_history to service_role;

notify pgrst, 'reload schema';
