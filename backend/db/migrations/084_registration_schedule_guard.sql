create or replace function guard_registration_schedule_on_start_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.proposed_start is not distinct from old.proposed_start
     or new.proposed_start is null then
    return new;
  end if;

  if new.registration_closes_at is not null
     and new.registration_closes_at > new.proposed_start then
    raise exception 'The new event start is earlier than the registration closing time. Adjust the registration settings before changing the start.'
      using errcode = '23514',
            constraint = 'event_requests_registration_closes_before_start';
  end if;

  if new.registration_withdrawal_deadline is not null
     and new.registration_withdrawal_deadline > new.proposed_start then
    raise exception 'The new event start is earlier than the registration withdrawal deadline. Adjust the registration settings before changing the start.'
      using errcode = '23514',
            constraint = 'event_requests_withdrawal_before_start';
  end if;

  return new;
end;
$$;

drop trigger if exists event_requests_guard_registration_schedule on event_requests;
create trigger event_requests_guard_registration_schedule
  before update of proposed_start on event_requests
  for each row
  execute function guard_registration_schedule_on_start_change();

-- The attendee list reuses the shared open-event service, so the SQL copy of its rule is retired.
drop function if exists list_open_registration_events(uuid);

