-- Keep PR #68's table authoritative for settings, registration and browsing.
-- Retain legacy rows as read-only history; never discard an existing sign-up.
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

create or replace function register_for_event(p_event_request_id uuid, p_attendee_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_capacity integer;
  v_count bigint;
  v_registration event_registrations;
begin
  -- This takes the event lock and reads the clock after any wait. Refusals
  -- reveal no more about an unavailable event than the browse read does.
  begin
    perform assert_event_registration_eligible(p_event_request_id, p_attendee_id);
  exception
    when no_data_found or object_not_in_prerequisite_state then
      return jsonb_build_object('outcome', 'not_found');
    when insufficient_privilege then
      return jsonb_build_object('outcome', 'forbidden');
  end;

  select * into v_registration from event_registrations
   where event_request_id = p_event_request_id and attendee_id = p_attendee_id for update;
  if v_registration.status in ('registered', 'waitlisted') then
    return jsonb_build_object('outcome', 'already_registered');
  end if;

  select registration_capacity into v_capacity from event_requests where id = p_event_request_id;
  select count(*) into v_count from event_registrations
   where event_request_id = p_event_request_id and status = 'registered';
  if v_capacity is not null and v_count >= v_capacity then
    return jsonb_build_object('outcome', 'capacity_reached');
  end if;

  if v_registration.id is not null then
    update event_registrations set status = 'registered', registered_at = clock_timestamp()
     where id = v_registration.id returning * into v_registration;
  else
    insert into event_registrations (event_request_id, attendee_id)
    values (p_event_request_id, p_attendee_id)
    on conflict (event_request_id, attendee_id) do nothing
    returning * into v_registration;
    if not found then
      return jsonb_build_object('outcome', 'already_registered');
    end if;
  end if;

  return jsonb_build_object(
    'outcome', 'registered', 'registeredCount', v_count + 1,
    'registration', jsonb_build_object(
      'id', v_registration.id, 'eventRequestId', v_registration.event_request_id,
      'attendeeId', v_registration.attendee_id, 'status', v_registration.status,
      'registeredAt', v_registration.registered_at,
      'createdAt', v_registration.created_at, 'updatedAt', v_registration.updated_at
    )
  );
end;
$$;

revoke execute on function register_for_event(uuid, uuid) from public, anon, authenticated;
grant execute on function register_for_event(uuid, uuid) to service_role;
notify pgrst, 'reload schema';
