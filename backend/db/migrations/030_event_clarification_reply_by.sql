-- Clarification conversations: append-only entries, guarded status changes,
-- reply-by dates, overdue queries, and transactional notifications.
-- Run once in Supabase after migrations 014, 021, and 022. Safe to re-run.

alter table event_requests
  add column if not exists clarification_reply_by_date date;

create table if not exists event_request_clarification_history (
  id                uuid primary key default gen_random_uuid(),
  event_request_id  uuid not null references event_requests(id) on delete cascade,
  entry_type        text not null check (entry_type in ('question', 'reply', 'closure')),
  message           text not null check (length(btrim(message)) > 0),
  created_by        uuid not null references auth.users(id),
  reply_by_date     date,
  created_at        timestamptz not null default now(),
  constraint clarification_question_has_reply_by_only
    check (entry_type = 'question' or reply_by_date is null)
);

create index if not exists idx_event_clarification_history_request_created
  on event_request_clarification_history (event_request_id, created_at, id);

alter table event_request_clarification_history enable row level security;

create or replace function refuse_event_clarification_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'clarification history entries cannot be changed or deleted'
    using errcode = '42501';
end;
$$;

drop trigger if exists event_clarification_history_immutable
  on event_request_clarification_history;

create trigger event_clarification_history_immutable
before update or delete on event_request_clarification_history
for each row execute function refuse_event_clarification_history_mutation();

alter table notifications drop constraint if exists notifications_type_known;
alter table notifications
  add constraint notifications_type_known check (
    type in (
      'booking_flagged',
      'clarification_requested',
      'clarification_replied',
      'clarification_closed'
    )
  );

-- The status and clarification fields in change_event_request_status are
-- updated transactionally. This trigger clears the reply-by date when a
-- clarification is answered or closed.
create or replace function clear_event_clarification_reply_by_date()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'pending_clarification'
     and new.status <> 'pending_clarification' then
    new.clarification_reply_by_date := null;
  end if;
  return new;
end;
$$;

drop trigger if exists event_requests_clear_clarification_reply_by_date
  on event_requests;

create trigger event_requests_clear_clarification_reply_by_date
before update of status on event_requests
for each row execute function clear_event_clarification_reply_by_date();

create or replace function request_event_clarification(
  p_event_request_id     uuid,
  p_changed_by           uuid,
  p_expected_coordinator uuid,
  p_reason               text,
  p_reply_by_date        date
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'clarification message is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reason)) > 2000 then
    raise exception 'clarification message must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if p_reply_by_date is not null
     and p_reply_by_date <= (now() at time zone 'UTC')::date then
    raise exception 'reply-by date must be in the future'
      using errcode = '22023';
  end if;

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'under_review'::event_request_status,
      'pending_clarification'::event_request_status,
      p_changed_by,
      p_reason,
      p_expected_coordinator
    );

  update event_requests
     set clarification_reply_by_date = p_reply_by_date
   where id = p_event_request_id
     and status = 'pending_clarification'
  returning * into v_request;

  if not found then
    raise exception 'event request % is no longer pending clarification', p_event_request_id
      using errcode = '40001';
  end if;

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by, reply_by_date)
  values
    (p_event_request_id, 'question', btrim(p_reason), p_changed_by, p_reply_by_date);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_requested',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reason),
      'replyByDate', p_reply_by_date
    )
  );

  return v_request;
end;
$$;

create or replace function reply_to_event_clarification(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_reply            text
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_reply is null or btrim(p_reply) = '' then
    raise exception 'clarification reply is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reply)) > 2000 then
    raise exception 'clarification reply must be 2000 characters or fewer'
      using errcode = '22023';
  end if;

  select * into v_request
    from event_requests
   where id = p_event_request_id
   for update;
  if not found or v_request.organiser_id <> p_organiser_id then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending_clarification' then
    raise exception 'event request has status %, not pending_clarification', v_request.status
      using errcode = '55000';
  end if;

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'pending_clarification'::event_request_status,
      'under_review'::event_request_status,
      p_organiser_id,
      null::text,
      null::uuid
    );

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by)
  values (p_event_request_id, 'reply', btrim(p_reply), p_organiser_id);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.assigned_coordinator_id,
    'clarification_replied',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reply)
    )
  );

  return v_request;
end;
$$;

create or replace function close_event_clarification(
  p_event_request_id     uuid,
  p_coordinator_id       uuid,
  p_expected_coordinator uuid,
  p_message              text
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_message is null or btrim(p_message) = '' then
    raise exception 'clarification closure note is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_message)) > 2000 then
    raise exception 'clarification closure note must be 2000 characters or fewer'
      using errcode = '22023';
  end if;

  select * into v_request
    from event_requests
   where id = p_event_request_id
   for update;
  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'P0002';
  end if;
  if v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'Only the assigned coordinator can close this clarification request'
      using errcode = '42501';
  end if;
  if v_request.status <> 'pending_clarification' then
    raise exception 'event request has status %, not pending_clarification', v_request.status
      using errcode = '55000';
  end if;

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'pending_clarification'::event_request_status,
      'under_review'::event_request_status,
      p_coordinator_id,
      btrim(p_message),
      p_expected_coordinator
    );

  insert into event_request_clarification_history
    (event_request_id, entry_type, message, created_by)
  values (p_event_request_id, 'closure', btrim(p_message), p_coordinator_id);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_closed',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_message)
    )
  );

  return v_request;
end;
$$;

notify pgrst, 'reload schema';
