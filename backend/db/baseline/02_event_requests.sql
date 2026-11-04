-- Baseline 02: event requests, their status, assignment, clarification and
-- change-request history, and the functions and triggers of that workflow.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

-- Other triggers on event_requests sit with their functions in 06_equipment,
-- 07_safety_review and 08_registration.
create table event_requests (
  id uuid not null default gen_random_uuid(),
  organiser_id uuid not null,
  event_name text not null,
  description text,
  purpose text,
  proposed_start timestamptz,
  proposed_end timestamptz,
  expected_attendance integer,
  status event_request_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  venue_requirements text,
  accessibility_requirements text,
  equipment_requirements text,
  submitted_at timestamptz,
  reviewing_coordinator_id uuid,
  decision event_request_decision,
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  clarification_note text,
  assigned_coordinator_id uuid,
  clarification_reply_by_date date,
  cancellation_reason text,
  cancellation_initiator event_cancellation_initiator,
  cancelled_by uuid,
  cancelled_at timestamptz,
  attendee_message text,
  registration_enabled boolean not null default false,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  registration_capacity integer,
  registration_withdrawal_deadline timestamptz,
  constraint event_requests_pkey primary key (id),
  constraint event_requests_assigned_coordinator_id_fkey foreign key (assigned_coordinator_id) references auth.users(id) on delete restrict,
  constraint event_requests_cancelled_by_fkey foreign key (cancelled_by) references auth.users(id) on delete restrict,
  constraint event_requests_decided_by_fkey foreign key (decided_by) references auth.users(id) on delete restrict,
  constraint event_requests_organiser_id_fkey foreign key (organiser_id) references auth.users(id) on delete restrict,
  constraint event_requests_reviewing_coordinator_id_fkey foreign key (reviewing_coordinator_id) references auth.users(id) on delete restrict,
  -- Submissions wait unassigned in the Lead's queue; from review on, a coordinator holds the event.
  constraint event_requests_assigned_when_submitted check (
    status in ('draft', 'submitted', 'cancelled') or assigned_coordinator_id is not null
  ),
  constraint event_requests_attendance_positive check ((expected_attendance is null) or (expected_attendance > 0)),
  constraint event_requests_cancellation_reason_nonblank check ((cancellation_reason is null) or (length(trim(cancellation_reason)) > 0)),
  constraint event_requests_dates_ordered check ((proposed_start is null) or (proposed_end is null) or (proposed_end > proposed_start)),
  -- decided_by null says nothing has been decided, and nothing about who holds the review.
  constraint event_requests_decided_by_is_reviewer check ((decided_by is null) or (not (decided_by is distinct from reviewing_coordinator_id))),
  constraint event_requests_decided_status_has_decision check (
    status::text <> all (array['approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected'])
    or decision is not null
  ),
  constraint event_requests_decision_fields_together check (((decision is null) and (decided_by is null) and (decided_at is null)) or ((decision is not null) and (decided_by is not null) and (decided_at is not null))),
  constraint event_requests_decision_has_decided_status check (
    decision is null
    or status::text = any (array['approved', 'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'])
  ),
  -- An open-ended window (no closing time) is allowed: the Organiser closes it by hand.
  constraint event_requests_enabled_registration_has_window check ((not registration_enabled) or (registration_opens_at is not null)),
  constraint event_requests_event_name_check check (length(trim(event_name)) > 0),
  constraint event_requests_registration_capacity_positive check ((registration_capacity is null) or (registration_capacity > 0)),
  constraint event_requests_registration_window_ordered check ((registration_closes_at is null) or ((registration_opens_at is not null) and (registration_opens_at < registration_closes_at))),
  constraint event_requests_rejection_has_reason check ((decision is distinct from 'rejected'::event_request_decision) or ((decision_note is not null) and (length(trim(decision_note)) > 0))),
  -- The enum keeps 'planning', which Postgres cannot drop; this check keeps it out.
  -- Compared as text, as on live.
  constraint event_requests_status_in_lifecycle check (
    status::text = any (array[
    'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
    'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'
  ])
  ),
  constraint event_requests_submitted_at_matches_status check ((status <> 'draft'::event_request_status) or (submitted_at is null))
);
create index idx_event_requests_organiser_status on event_requests (organiser_id, status);
create index idx_event_requests_status on event_requests (status);
alter table event_requests enable row level security;

create trigger event_requests_set_updated_at
  before update on event_requests
  for each row
  execute function set_updated_at();

create table event_request_status_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  previous_status event_request_status not null,
  new_status event_request_status not null,
  changed_by uuid not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint event_request_status_history_pkey primary key (id),
  constraint event_request_status_history_changed_by_fkey foreign key (changed_by) references auth.users(id) on delete restrict,
  constraint event_request_status_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint event_request_status_history_reason_not_blank check ((reason is null) or (length(trim(reason)) > 0)),
  constraint event_request_status_history_status_changes check (previous_status <> new_status),
  -- The same set as the lifecycle, so every transition can write its history row.
  constraint event_request_status_history_statuses_in_lifecycle check (
    previous_status::text = any (array[
      'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
      'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'
    ])
    and new_status::text = any (array[
      'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
      'safety_review', 'safety_approved', 'confirmed', 'completed', 'rejected', 'cancelled'
    ])
  )
);
create index idx_event_request_status_history_event on event_request_status_history (event_request_id, created_at);
alter table event_request_status_history enable row level security;

create table event_request_assignment_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  previous_coordinator_id uuid,
  new_coordinator_id uuid not null,
  assigned_by uuid,
  handover_note text,
  created_at timestamptz not null default now(),
  constraint event_request_assignment_history_pkey primary key (id),
  constraint event_request_assignment_history_assigned_by_fkey foreign key (assigned_by) references auth.users(id) on delete restrict,
  constraint event_request_assignment_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint event_request_assignment_history_new_coordinator_id_fkey foreign key (new_coordinator_id) references auth.users(id) on delete restrict,
  constraint event_request_assignment_history_previous_coordinator_id_fkey foreign key (previous_coordinator_id) references auth.users(id) on delete restrict,
  constraint event_request_assignment_history_coordinator_changes check (previous_coordinator_id is distinct from new_coordinator_id)
);
create index idx_event_request_assignment_history_event on event_request_assignment_history (event_request_id, created_at desc);
alter table event_request_assignment_history enable row level security;

create table event_request_clarification_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  entry_type text not null,
  message text not null,
  created_by uuid not null,
  reply_by_date date,
  created_at timestamptz not null default now(),
  requested_fields text[] not null default '{}'::text[],
  constraint event_request_clarification_history_pkey primary key (id),
  constraint event_request_clarification_history_created_by_fkey foreign key (created_by) references auth.users(id),
  constraint event_request_clarification_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint clarification_question_has_reply_by_only check ((entry_type = 'question'::text) or (reply_by_date is null)),
  constraint event_clarification_requested_fields_known check ((requested_fields <@ array['eventName'::text, 'purpose'::text, 'description'::text, 'proposedStart'::text, 'proposedEnd'::text, 'expectedAttendance'::text, 'venueRequirements'::text, 'accessibilityRequirements'::text, 'equipmentRequirements'::text]) and ((entry_type = 'question'::text) or (cardinality(requested_fields) = 0))),
  constraint event_request_clarification_history_entry_type_check check (entry_type = any (array['question'::text, 'reply'::text, 'closure'::text])),
  constraint event_request_clarification_history_message_check check (length(btrim(message)) > 0)
);
create index idx_event_clarification_history_request_created on event_request_clarification_history (event_request_id, created_at, id);
alter table event_request_clarification_history enable row level security;

create table event_change_requests (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  requested_by uuid not null,
  change_field event_change_field not null,
  requested_change text not null,
  status change_request_status not null default 'outstanding',
  decision change_request_decision,
  decision_notes text,
  processed_by uuid,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_change_requests_pkey primary key (id),
  constraint event_change_requests_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint event_change_requests_processed_by_fkey foreign key (processed_by) references auth.users(id) on delete restrict,
  constraint event_change_requests_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete restrict,
  -- A row can never be processed with no outcome, or carry an outcome while still open.
  constraint event_change_requests_decision_matches_status check ((status = 'processed'::change_request_status) = (decision is not null)),
  constraint event_change_requests_requested_change_check check (length(trim(requested_change)) > 0)
);
create index idx_event_change_requests_event on event_change_requests (event_request_id, created_at desc);
create index idx_event_change_requests_requested_by on event_change_requests (requested_by, created_at desc);
alter table event_change_requests enable row level security;

create trigger event_change_requests_set_updated_at
  before update on event_change_requests
  for each row
  execute function set_updated_at();

-- Field-level audit of significant changes to an event.
create table event_change_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  changed_by uuid not null,
  field_name text not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null,
  changed_at timestamptz not null default now(),
  constraint event_change_history_pkey primary key (id),
  constraint event_change_history_changed_by_fkey foreign key (changed_by) references auth.users(id) on delete restrict,
  constraint event_change_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint event_change_history_field_known check (field_name = any (array['proposedStart'::text, 'proposedEnd'::text, 'expectedAttendance'::text, 'venueRequirements'::text, 'accessibilityRequirements'::text, 'equipment'::text])),
  constraint event_change_history_reason_nonblank check ((reason = btrim(reason)) and ((length(reason) >= 1) and (length(reason) <= 4000)))
);
create index idx_event_change_history_event on event_change_history (event_request_id, changed_at desc, id);
alter table event_change_history enable row level security;

-- Status lifecycle: the allowed transitions and the one function that moves along them.

create or replace function event_request_status_allows(
  p_from event_request_status,
  p_to   event_request_status
)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
      from (values
        ('draft',                 'submitted'),
        ('submitted',             'under_review'),
        ('under_review',          'pending_clarification'),
        ('pending_clarification', 'under_review'),
        ('under_review',          'approved'),
        ('under_review',          'rejected'),
        ('approved',              'rejected'),
        ('rejected',              'draft'),
        ('approved',              'safety_review'),
        ('safety_review',         'safety_approved'),
        ('safety_review',         'approved'),
        ('safety_approved',       'approved'),
        ('safety_approved',       'confirmed'),
        ('confirmed',             'approved'),
        ('confirmed',             'completed'),
        ('submitted',             'cancelled'),
        ('under_review',          'cancelled'),
        ('pending_clarification', 'cancelled'),
        ('approved',              'cancelled'),
        ('safety_review',         'cancelled'),
        ('safety_approved',       'cancelled'),
        ('confirmed',             'cancelled')
      ) as t (from_status, to_status)
     where t.from_status = p_from::text
       and t.to_status   = p_to::text
  );
$$;

create or replace function change_event_request_status(
  p_event_request_id      uuid,
  p_expected_status       event_request_status,
  p_new_status            event_request_status,
  p_changed_by            uuid,
  p_reason                text default null,
  p_expected_coordinator  uuid default null
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_expected_status is null or p_new_status is null or p_changed_by is null then
    raise exception 'change_event_request_status needs the expected status, the new status and the user'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_new_status = 'submitted' then
    raise exception 'a request is submitted with submit_event_request, not change_event_request_status'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_new_status = p_expected_status then
    raise exception 'event request status cannot change from % to itself', p_expected_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lock first, then read: the row cannot change between the checks below and
  -- the update that relies on them.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> p_expected_status then
    raise exception 'event request % has status %, not %',
      p_event_request_id, v_request.status, p_expected_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not event_request_status_allows(v_request.status, p_new_status) then
    raise exception 'event request % has status %, which cannot change to %',
      p_event_request_id, v_request.status, p_new_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- `is distinct from` so that an event with no coordinator, compared with a
  -- caller who named one, is a mismatch and not an unknown that passes.
  if p_expected_coordinator is not null
     and v_request.assigned_coordinator_id is distinct from p_expected_coordinator then
    raise exception 'event request % is no longer assigned to this coordinator', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  if p_new_status = 'draft'
     and exists (
       select 1
         from information_schema.columns
        where table_schema = 'public'
          and table_name   = 'event_requests'
          and column_name  = 'decision'
     ) then
    -- A reopened request: no submission time and no decision, together. See 2
    -- of the header. Dynamic, because the decision columns are not created by
    -- this folder's migrations and a static reference would fail to run where
    -- they do not exist.
    execute
      'update event_requests
          set status       = $1,
              submitted_at = null,
              decision     = null,
              decision_note = null,
              decided_by   = null,
              decided_at   = null
        where id = $2
          and status = $3
       returning *'
      into v_request
      using p_new_status, p_event_request_id, p_expected_status;
  else
    -- The status, and the clarification note that goes with it, in one
    -- statement. The note is the reason for entering pending_clarification and
    -- is cleared on leaving it; every other transition leaves it alone. A
    -- reopened draft has no submission time (005).
    -- `and status = p_expected_status` cannot fail to match while the lock is
    -- held. It makes the statement itself unable to move a row that is not in
    -- the status the caller checked, as 018's guard does.
    update event_requests
       set status             = p_new_status,
           submitted_at       = case
             when p_new_status = 'draft' then null
             else submitted_at
           end,
           clarification_note = case
             when p_new_status = 'pending_clarification' then p_reason
             when p_expected_status = 'pending_clarification' then null
             else clarification_note
           end
     where id = p_event_request_id
       and status = p_expected_status
    returning * into v_request;
  end if;

  -- Both branches leave v_request empty when no row matched.
  if v_request.id is null then
    raise exception 'event request % changed status while it was being updated', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, p_expected_status, p_new_status, p_changed_by, p_reason);

  return v_request;
end;
$$;

-- Submission, assignment and review.

create or replace function pick_event_coordinator(p_event_request_id uuid)
returns uuid
language plpgsql
stable
as $$
declare
  v_previous    uuid;
  v_coordinator uuid;
begin
  -- 1. Resubmission: the most recent holder, if they are still a coordinator.
  --
  -- Only the newest history row is considered. If its coordinator has lost
  -- the role, the event goes through steps 2-4 instead. It does not go back
  -- to an earlier holder: that person handed the event over, and returning it
  -- to them would reverse a deliberate handover.
  --
  -- created_at descending gives the newest row. id breaks a tie, which only
  -- happens if two history rows for one event are written in the same
  -- transaction (now() is fixed for a whole transaction). Nothing does that
  -- today. The id order is arbitrary, but it makes the answer stable.
  select h.new_coordinator_id
    into v_previous
    from event_request_assignment_history h
   where h.event_request_id = p_event_request_id
   order by h.created_at desc, h.id desc
   limit 1;

  if v_previous is not null and exists (
    select 1
      from profiles p
     where p.id = v_previous
       and p.role = 'event_coordinator'
  ) then
    return v_previous;
  end if;

  -- 2-4. Fewest active events, then longest without a new assignment, then id.
  --
  -- 'event_coordinator' is the only role value used, as in 014: the live
  -- user_role enum differs from 007's declaration in other values, so no other
  -- value is assumed to exist.
  --
  -- A "new assignment" in step 3 is any history row naming this coordinator
  -- as new_coordinator_id. That covers both automatic assignments and
  -- handovers they received, because either one is new work arriving. A
  -- coordinator with no history row has never been assigned anything, so
  -- their max is null, and nulls first puts them at the front.
  --
  -- If no profile has the role, the query returns no row, select into leaves
  -- v_coordinator null, and step 5 is the return below.
  select p.id
    into v_coordinator
    from profiles p
   where p.role = 'event_coordinator'
   order by
     (select count(*)
        from event_requests e
       where e.assigned_coordinator_id = p.id
         and e.status in ('submitted', 'under_review', 'pending_clarification',
                          'approved', 'planning', 'confirmed')) asc,
     (select max(h.created_at)
        from event_request_assignment_history h
       where h.new_coordinator_id = p.id) asc nulls first,
     p.id asc
   limit 1;

  return v_coordinator;
end;
$$;

create or replace function submit_event_request(
  p_event_request_id uuid,
  p_submitted_at     timestamptz,
  p_changed_by       uuid
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  if p_submitted_at is null then
    raise exception 'submit_event_request needs a submission time'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_changed_by is null then
    raise exception 'submit_event_request needs the user submitting the request'
      using errcode = 'null_value_not_allowed';
  end if;

  -- Lock first, then read: the row cannot change between the status check
  -- below and the update that relies on it.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'draft' then
    raise exception 'event request % has status %, and only a draft can be submitted',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- status and submitted_at in one statement, as before (005's constraint is
  -- checked against the whole row). The coordinator and the reviewer are set
  -- to null rather than left alone: a draft reopened from rejected (022) still
  -- carries both, and leaving them would hand the request back to its old
  -- coordinator, past the Lead's queue (TR-02).
  update event_requests
     set status                   = 'submitted',
         submitted_at             = p_submitted_at,
         assigned_coordinator_id  = null,
         reviewing_coordinator_id = null
   where id = p_event_request_id
  returning * into v_request;

  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'draft', 'submitted', p_changed_by, null);

  -- AC10: every Lead is told a request is waiting. An insert from a select,
  -- as 014 tells every coordinator: with no Lead it writes nothing and fails
  -- nothing (AC11).
  insert into notifications (recipient_id, type, event_request_id, payload)
  select p.id,
         'event_request_awaiting_assignment',
         v_request.id,
         jsonb_build_object(
           'eventRequestId', v_request.id,
           'eventName',      v_request.event_name,
           'submittedAt',    v_request.submitted_at
         )
    from profiles p
   where p.role = 'event_coordinator_lead';

  return v_request;
end;
$$;

create or replace function assign_event_request(
  p_event_request_id uuid,
  p_coordinator_id   uuid,
  p_assigned_by      uuid,
  p_note             text
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  -- Lock first, then read: a second assignment of the same request waits here
  -- for the first to commit, then sees its coordinator (AC4).
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- Only a Lead. Checked under for share, as 018 checks the incoming
  -- coordinator's role: a role revoked at the same moment either waits for
  -- this assignment or refuses it. A null caller is refused explicitly.
  if p_assigned_by is null then
    raise exception 'only the Event Coordinator Lead can assign event request %', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  perform 1
     from profiles p
    where p.id = p_assigned_by
      and p.role = 'event_coordinator_lead'
      for share;

  if not found then
    raise exception 'only the Event Coordinator Lead can assign event request %', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- AC4: if someone got there first, say who, through profile_display_name
  -- (section 1a): the name, or the id for a coordinator with none on record,
  -- so the Lead is never told "already assigned" without being told to whom.
  if v_request.assigned_coordinator_id is not null then
    raise exception 'event request % is already assigned to %',
      p_event_request_id, profile_display_name(v_request.assigned_coordinator_id)
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_request.status <> 'submitted' then
    raise exception 'event request % has status %, and only a submitted request can be assigned',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Only an Event Coordinator, which with one role per account excludes every
  -- Lead (see the header). Under for share, as 018.
  perform 1
     from profiles p
    where p.id = p_coordinator_id
      and p.role = 'event_coordinator'
      for share;

  if not found then
    raise exception 'user % is not an Event Coordinator, so cannot be assigned event request %',
      p_coordinator_id, p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- The coordinator and the history row in one statement (AC4): the insert
  -- reads the update's returned row, so a row is written only if the update
  -- matched, and neither stands without the other. The guard repeats the
  -- checks above at the statement itself, as 018's and 022's do.
  -- assigned_by names the Lead, so this row reads as a person's, not as
  -- SCRUM-327's automatic assignment (AC9). A blank note is stored as null.
  with assigned as (
    update event_requests
       set assigned_coordinator_id = p_coordinator_id
     where id = p_event_request_id
       and status = 'submitted'
       and assigned_coordinator_id is null
    returning *
  ), recorded as (
    insert into event_request_assignment_history
      (event_request_id, previous_coordinator_id, new_coordinator_id,
       assigned_by, handover_note)
    select a.id, null, a.assigned_coordinator_id,
           p_assigned_by, nullif(btrim(p_note), '')
      from assigned a
    returning 1
  )
  select * into v_request from assigned;

  if not found then
    raise exception 'event request % changed while it was being assigned', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- AC10: the new coordinator, and the Organiser with the coordinator's name.
  -- After every refusal, so a refused assignment notifies nobody. No previous
  -- coordinator on a first assignment. The note goes to the coordinator only:
  -- the Organiser does not see it (AC9).
  insert into notifications (recipient_id, type, event_request_id, payload)
  values
    (p_coordinator_id,
     'event_request_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'assignedById',            p_assigned_by,
       'assignedByName',          profile_display_name(p_assigned_by),
       'previousCoordinatorId',   null::uuid,
       'previousCoordinatorName', null::text,
       'note',                    nullif(btrim(p_note), '')
     )),
    (v_request.organiser_id,
     'event_request_coordinator_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'coordinatorId',           p_coordinator_id,
       'coordinatorName',         profile_display_name(p_coordinator_id),
       'previousCoordinatorId',   null::uuid,
       'previousCoordinatorName', null::text
     ));

  return v_request;
end;
$$;

create or replace function reassign_event_request(
  p_event_request_id   uuid,
  p_new_coordinator_id uuid,
  p_assigned_by        uuid,
  p_handover_note      text
)
returns event_requests
language plpgsql
as $$
declare
  v_request  event_requests;
  v_outgoing uuid;
  v_is_lead  boolean := false;
begin
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  v_outgoing := v_request.assigned_coordinator_id;

  -- The holder, or a Lead. A null caller is refused explicitly, as in 018.
  -- The Lead's role is looked up only when the caller is not the holder, so
  -- the holder's handover reads exactly as it did in 018.
  if p_assigned_by is not null and v_outgoing is distinct from p_assigned_by then
    perform 1
       from profiles p
      where p.id = p_assigned_by
        and p.role = 'event_coordinator_lead'
        for share;
    v_is_lead := found;
  end if;

  if p_assigned_by is null or (v_outgoing is distinct from p_assigned_by and not v_is_lead) then
    raise exception 'only the coordinator assigned to event request %, or the Event Coordinator Lead, can hand it over',
      p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A request nobody holds is assigned, not reassigned.
  if v_outgoing is null then
    raise exception 'event request % has no coordinator yet, so it must be assigned, not reassigned',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- AC5's seven, compared as text so safety_review and safety_approved can be
  -- named before SCRUM-488 adds them to the enum (037 does the same).
  if v_request.status::text not in ('submitted', 'under_review', 'pending_clarification',
                                    'approved', 'safety_review', 'safety_approved',
                                    'confirmed') then
    raise exception 'event request % has status %, and cannot be handed over in that status',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform 1
     from profiles p
    where p.id = p_new_coordinator_id
      and p.role = 'event_coordinator'
      for share;

  if not found then
    raise exception 'user % is not an Event Coordinator, so cannot be handed event request %',
      p_new_coordinator_id, p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  if p_new_coordinator_id = v_outgoing then
    raise exception 'event request % is already assigned to that coordinator', p_event_request_id
      using errcode = 'check_violation';
  end if;

  -- 018's update, guarded on the outgoing coordinator read under the lock
  -- rather than on the caller: a Lead is not the holder, and the guard's job
  -- is "nobody moved it in between". The reviewer rule is 018's.
  update event_requests
     set assigned_coordinator_id  = p_new_coordinator_id,
         reviewing_coordinator_id = case
           when decision is null and reviewing_coordinator_id is not null
             then p_new_coordinator_id
           else reviewing_coordinator_id
         end
   where id = p_event_request_id
     and assigned_coordinator_id = v_outgoing
  returning * into v_request;

  if not found then
    raise exception 'event request % changed hands while this handover was being made', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  insert into event_request_assignment_history
    (event_request_id, previous_coordinator_id, new_coordinator_id,
     assigned_by, handover_note)
  values
    (p_event_request_id, v_outgoing, p_new_coordinator_id,
     p_assigned_by, p_handover_note);

  -- AC10, as for a first assignment, with who held it before (SCRUM-518). The
  -- same two types; previousCoordinatorId is what makes it a handover. The
  -- note to the new coordinator only, never the Organiser (AC9).
  insert into notifications (recipient_id, type, event_request_id, payload)
  values
    (p_new_coordinator_id,
     'event_request_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'assignedById',            p_assigned_by,
       'assignedByName',          profile_display_name(p_assigned_by),
       'previousCoordinatorId',   v_outgoing,
       'previousCoordinatorName', profile_display_name(v_outgoing),
       'note',                    nullif(btrim(p_handover_note), '')
     )),
    (v_request.organiser_id,
     'event_request_coordinator_assigned',
     v_request.id,
     jsonb_build_object(
       'eventRequestId',          v_request.id,
       'eventName',               v_request.event_name,
       'coordinatorId',           p_new_coordinator_id,
       'coordinatorName',         profile_display_name(p_new_coordinator_id),
       'previousCoordinatorId',   v_outgoing,
       'previousCoordinatorName', profile_display_name(v_outgoing)
     ));

  return v_request;
end;
$$;

create or replace function start_event_review(
  p_event_request_id uuid,
  p_coordinator_id   uuid
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
begin
  -- Lock first, then read: nothing can change the row between the checks
  -- below and the update that relies on them. A handover (018) takes the same
  -- lock, so the two take turns.
  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- SCRUM-486 AC8: a submitted request nobody has been assigned is waiting for
  -- the Lead. Before the caller check, unlike 029's other checks, and on
  -- purpose: 029 asks "is it yours?" before "is it reviewable?" because only
  -- its coordinator has reason to ask the second (018's argument). Here there
  -- is no coordinator, so there is no "yours" to be wrong about; the answer is
  -- the same for every caller, the Lead included. Without this the caller
  -- check below would answer it, as 42501 "only the coordinator assigned ...",
  -- telling the caller the request is someone else's when it is nobody's.
  --
  -- Submitted only. A draft has no coordinator either, but it is not waiting
  -- for the Lead; it is still the Organiser's, and SCRUM-19 answers it with
  -- the caller check's 403 on purpose (docs/test-cases/SCRUM-19.md, AC1-03).
  if v_request.status = 'submitted' and v_request.assigned_coordinator_id is null then
    raise exception 'event request % is waiting for the Event Coordinator Lead to assign it a coordinator, so its review cannot start yet',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- AC1: only the assigned coordinator starts the review.
  --
  -- A null caller is refused explicitly, as 018 does. `is distinct from` alone
  -- would compare a null caller with an event that has no coordinator, find
  -- them not distinct, and let the caller through.
  if p_coordinator_id is null
     or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
    raise exception 'only the coordinator assigned to event request % can start reviewing it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status <> 'submitted' then
    raise exception 'event request % has status %, and only a submitted request can be put under review',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Always true today; asked so the database's transition table stays the one
  -- authority (see (a) in the header).
  if not event_request_status_allows('submitted', 'under_review') then
    raise exception 'event request % has status submitted, which cannot change to under_review', p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The status and the reviewer in one statement. `and status = 'submitted'`
  -- cannot fail to match while the lock is held; it makes the statement itself
  -- unable to move a row that is not in the status checked, as 018's and 022's
  -- guards do.
  update event_requests
     set status                   = 'under_review',
         reviewing_coordinator_id = p_coordinator_id
   where id = p_event_request_id
     and status = 'submitted'
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while the review was being started', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The same row shape change_event_request_status writes. No reason: starting
  -- a review needs none.
  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'submitted', 'under_review', p_coordinator_id, null);

  return v_request;
end;
$$;

create or replace function decide_event_request(
  p_event_request_id uuid,
  p_decision         event_request_decision,
  p_decision_note    text,
  p_decided_by       uuid,
  p_decided_at       timestamptz
)
returns event_requests
language plpgsql
as $$
declare
  v_request    event_requests;
  v_new_status event_request_status;
  v_note       text := nullif(btrim(p_decision_note), '');
begin
  if p_decision is null or p_decided_at is null then
    raise exception 'decide_event_request needs the decision and the time it was made'
      using errcode = 'null_value_not_allowed';
  end if;

  -- The decision names the status it leads to: approved or rejected.
  v_new_status := p_decision::text::event_request_status;

  select *
    into v_request
    from event_requests
   where id = p_event_request_id
     for update;

  if not found then
    raise exception 'event request % not found', p_event_request_id
      using errcode = 'no_data_found';
  end if;

  -- SCRUM-486 AC8, the same check as start_event_review's and for the same
  -- reason. A request cannot be under review without a coordinator (052's
  -- constraint still requires one past submitted), but this function checks
  -- the caller before the status, so a decision attempted on an unassigned
  -- submitted request would otherwise be answered by the caller check, as 42501
  -- "only the coordinator assigned ... can decide it". Reachable by a direct
  -- call to the decision route; not unreachable, so guarded.
  if v_request.status = 'submitted' and v_request.assigned_coordinator_id is null then
    raise exception 'event request % is waiting for the Event Coordinator Lead to assign it a coordinator, so it cannot be decided yet',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Only the assigned coordinator decides. A null caller is refused
  -- explicitly, for the reason start_event_review gives.
  if p_decided_by is null
     or v_request.assigned_coordinator_id is distinct from p_decided_by then
    raise exception 'only the coordinator assigned to event request % can decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- AC2 and AC3: a decision is made only on a request under review. This is
  -- what refuses a request awaiting clarification, one not yet under review,
  -- and one already decided, each with its current status named.
  if v_request.status <> 'under_review' then
    raise exception 'event request % has status %, and only a request under review can be decided',
      p_event_request_id, v_request.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- See (a) in the header.
  if not event_request_status_allows(v_request.status, v_new_status) then
    raise exception 'event request % has status %, which cannot change to %',
      p_event_request_id, v_request.status, v_new_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- And only the reviewer. A recorded reviewer who is someone else is refused,
  -- never overwritten; an empty one is filled in below. See (b) in the header.
  --
  -- After the status check, not before it. A decided event keeps the reviewer
  -- who decided it, even after a handover (018), so on an approved event this
  -- check would refuse the new coordinator for the wrong reason. The status is
  -- the true reason a decided event cannot be decided again.
  if v_request.reviewing_coordinator_id is not null
     and v_request.reviewing_coordinator_id <> p_decided_by then
    raise exception 'event request % is under review by another coordinator, who must decide it', p_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  -- A rejection must say why. Checked here so the coordinator gets this
  -- sentence rather than 025's constraint name.
  if p_decision = 'rejected' and v_note is null then
    raise exception 'a reason is required to reject event request %', p_event_request_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- AC6: an event whose proposed start has passed cannot be approved. Measured
  -- at p_decided_at, the service's clock (see the comment above the function).
  -- A start exactly at the decision time counts as passed: the event would
  -- already be under way. A missing start is refused too, rather than approved
  -- unchecked: submission requires one, so a missing start means a row made
  -- outside the application, and approving it would approve an event whose
  -- date nobody could confirm. A rejection is allowed whatever the date.
  if p_decision = 'approved'
     and (v_request.proposed_start is null or v_request.proposed_start <= p_decided_at) then
    raise exception 'event request % cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request',
      p_event_request_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The status and the whole decision in one statement, for the reason in the
  -- header: 025's constraints are checked against the row after the statement,
  -- and any split would leave a row one of them refuses. The reviewer is
  -- filled in here, in the same statement, so decided_by_is_reviewer sees the
  -- two equal.
  update event_requests
     set status                   = v_new_status,
         decision                 = p_decision,
         decision_note            = v_note,
         decided_by               = p_decided_by,
         decided_at               = p_decided_at,
         reviewing_coordinator_id = coalesce(reviewing_coordinator_id, p_decided_by)
   where id = p_event_request_id
     and status = 'under_review'
  returning * into v_request;

  if not found then
    raise exception 'event request % changed status while it was being decided', p_event_request_id
      using errcode = 'serialization_failure';
  end if;

  -- The same row shape change_event_request_status writes. The note is the
  -- reason: for a rejection it is why the request was rejected, which is
  -- exactly what the status history's reason records.
  insert into event_request_status_history
    (event_request_id, previous_status, new_status, changed_by, reason)
  values
    (p_event_request_id, 'under_review', v_new_status, p_decided_by, v_note);

  return v_request;
end;
$$;

-- Clarification: the coordinator asks, the organiser replies (optionally amending
-- the requested fields), the coordinator closes.

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
revoke execute on function reply_to_event_clarification(uuid, uuid, text) from public, anon, authenticated;

create or replace function request_event_clarification_with_fields(
  p_event_request_id     uuid,
  p_changed_by           uuid,
  p_expected_coordinator uuid,
  p_reason               text,
  p_reply_by_date        date,
  p_requested_fields     text[]
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_requested_fields text[];
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
  if p_requested_fields is null then
    raise exception 'requested fields must be a list'
      using errcode = '22023';
  end if;
  if exists (
    select field
      from unnest(p_requested_fields) as fields(field)
     where field is null
        or field not in (
       'eventName', 'purpose', 'description', 'proposedStart', 'proposedEnd',
       'expectedAttendance', 'venueRequirements', 'accessibilityRequirements',
       'equipmentRequirements'
     )
  ) then
    raise exception 'one or more clarification amendment fields are invalid'
      using errcode = '22023';
  end if;

  select array_agg(field order by first_position)
    into v_requested_fields
    from (
      select field, min(position) as first_position
        from unnest(p_requested_fields) with ordinality as fields(field, position)
       group by field
    ) deduplicated;
  v_requested_fields := coalesce(v_requested_fields, '{}'::text[]);

  select * into v_request
    from change_event_request_status(
      p_event_request_id,
      'under_review'::event_request_status,
      'pending_clarification'::event_request_status,
      p_changed_by,
      btrim(p_reason),
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
    (event_request_id, entry_type, message, created_by, reply_by_date, requested_fields)
  values
    (p_event_request_id, 'question', btrim(p_reason), p_changed_by, p_reply_by_date, v_requested_fields);

  insert into notifications (recipient_id, type, payload)
  values (
    v_request.organiser_id,
    'clarification_requested',
    jsonb_build_object(
      'eventRequestId', v_request.id,
      'eventName', v_request.event_name,
      'message', btrim(p_reason),
      'replyByDate', p_reply_by_date,
      'requestedFields', v_requested_fields
    )
  );

  return v_request;
end;
$$;

create or replace function reply_to_event_clarification_with_amendments(
  p_event_request_id uuid,
  p_organiser_id     uuid,
  p_reply            text,
  p_updates          jsonb
)
returns event_requests
language plpgsql
as $$
declare
  v_request event_requests;
  v_question event_request_clarification_history;
  v_updates jsonb := coalesce(p_updates, '{}'::jsonb);
begin
  if p_reply is null or btrim(p_reply) = '' then
    raise exception 'clarification reply is required'
      using errcode = '22023';
  end if;
  if length(btrim(p_reply)) > 2000 then
    raise exception 'clarification reply must be 2000 characters or fewer'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_updates) <> 'object' then
    raise exception 'clarification amendments must be an object'
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

  select question.* into v_question
    from event_request_clarification_history question
   where question.event_request_id = p_event_request_id
     and question.entry_type = 'question'
     and not exists (
       select 1
         from event_request_clarification_history closed
        where closed.event_request_id = question.event_request_id
          and closed.entry_type in ('reply', 'closure')
          and (closed.created_at, closed.id) > (question.created_at, question.id)
     )
   order by question.created_at desc, question.id desc
   limit 1;

  if not found then
    raise exception 'no open clarification question was found'
      using errcode = '55000';
  end if;

  if exists (
    select key
      from jsonb_object_keys(v_updates) as update_keys(key)
     where not (key = any(v_question.requested_fields))
  ) then
    raise exception 'an amendment includes a field the Coordinator did not request'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key in (
       'eventName', 'purpose', 'description', 'venueRequirements',
       'accessibilityRequirements', 'equipmentRequirements'
     )
       and jsonb_typeof(value) not in ('string', 'null')
  ) or exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key in ('proposedStart', 'proposedEnd')
       and jsonb_typeof(value) not in ('string', 'null')
  ) or exists (
    select 1
      from jsonb_each(v_updates) as updates(key, value)
     where key = 'expectedAttendance'
       and jsonb_typeof(value) not in ('number', 'null')
  ) then
    raise exception 'amendment values have an invalid type'
      using errcode = '22023';
  end if;

  if v_updates ? 'eventName'
     and nullif(btrim(v_updates ->> 'eventName'), '') is null then
    raise exception 'eventName cannot be blank'
      using errcode = '22023';
  end if;

  update event_requests
     set event_name = case when v_updates ? 'eventName'
       then btrim(v_updates ->> 'eventName') else event_name end,
         purpose = case when v_updates ? 'purpose'
       then nullif(btrim(v_updates ->> 'purpose'), '') else purpose end,
         description = case when v_updates ? 'description'
       then nullif(btrim(v_updates ->> 'description'), '') else description end,
         proposed_start = case when v_updates ? 'proposedStart'
       then (v_updates ->> 'proposedStart')::timestamptz else proposed_start end,
         proposed_end = case when v_updates ? 'proposedEnd'
       then (v_updates ->> 'proposedEnd')::timestamptz else proposed_end end,
         expected_attendance = case when v_updates ? 'expectedAttendance'
       then (v_updates ->> 'expectedAttendance')::integer else expected_attendance end,
         venue_requirements = case when v_updates ? 'venueRequirements'
       then nullif(btrim(v_updates ->> 'venueRequirements'), '') else venue_requirements end,
         accessibility_requirements = case when v_updates ? 'accessibilityRequirements'
       then nullif(btrim(v_updates ->> 'accessibilityRequirements'), '') else accessibility_requirements end,
         equipment_requirements = case when v_updates ? 'equipmentRequirements'
       then nullif(btrim(v_updates ->> 'equipmentRequirements'), '') else equipment_requirements end
   where id = p_event_request_id
     and status = 'pending_clarification'
  returning * into v_request;

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
      'message', btrim(p_reply),
      'amendedFields', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
                          from jsonb_object_keys(v_updates) as update_keys(key))
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
  if p_coordinator_id is null
     or v_request.assigned_coordinator_id is distinct from p_coordinator_id then
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

-- A reply-by date only means something while the request waits on the organiser.

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

create trigger event_requests_clear_clarification_reply_by_date
  before update of status on event_requests
  for each row
  execute function clear_event_clarification_reply_by_date();

-- The clarification thread is a record: entries are never edited or deleted.

create or replace function refuse_event_clarification_history_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'clarification history entries cannot be changed or deleted'
    using errcode = '42501';
end;
$$;

create trigger event_clarification_history_immutable
  before delete or update on event_request_clarification_history
  for each row
  execute function refuse_event_clarification_history_mutation();

-- Change requests: the assigned coordinator decides, and an approval applies the change.

create or replace function set_change_request_processed_at()
returns trigger
language plpgsql
as $$
begin
  if new.decision is not null and old.decision is null then
    new.processed_at = now();
  end if;
  return new;
end;
$$;

create trigger event_change_requests_set_processed_at
  before update on event_change_requests
  for each row
  execute function set_change_request_processed_at();

create or replace function process_change_request(
  p_change_request_id uuid,
  p_decision           change_request_decision,
  p_decision_notes     text default null,
  p_processed_by       uuid default null
)
returns event_change_requests
language plpgsql
as $$
declare
  v_request              event_change_requests;
  v_event_request_id     uuid;
  v_assigned_coordinator uuid;
  v_event_status         text;
  v_change               jsonb;
begin
  select er.id, er.assigned_coordinator_id, er.status::text
    into v_event_request_id, v_assigned_coordinator, v_event_status
    from event_change_requests cr
    join event_requests er on er.id = cr.event_request_id
   where cr.id = p_change_request_id
     for update of er;

  if not found then
    raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
  end if;

  if p_processed_by is null or v_assigned_coordinator is distinct from p_processed_by then
    raise exception 'only the coordinator assigned to event request % can decide its change requests', v_event_request_id
      using errcode = 'insufficient_privilege';
  end if;

  update event_change_requests
  set
    status         = 'processed',
    decision       = p_decision,
    decision_notes = p_decision_notes,
    processed_by   = p_processed_by
  where id = p_change_request_id
    and status <> 'processed'
  returning * into v_request;

  if not found then
    if exists (select 1 from event_change_requests where id = p_change_request_id) then
      raise exception 'change request % has already been processed', p_change_request_id;
    else
      raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_decision = 'approved' then
    -- 100 validates ISO timestamps and JSON numbers; the request stores text.
    v_change := case v_request.change_field::text
      when 'proposed_start' then jsonb_build_object('proposedStart',
        to_char(v_request.requested_change::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      when 'proposed_end' then jsonb_build_object('proposedEnd',
        to_char(v_request.requested_change::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      when 'expected_attendance' then jsonb_build_object('expectedAttendance', v_request.requested_change::integer)
    end;

    if v_change is not null and v_event_status = 'confirmed' then
      perform apply_significant_event_change(
        v_request.event_request_id,
        v_change,
        coalesce(left(nullif(btrim(p_decision_notes), ''), 4000), 'Change request approved.'),
        p_processed_by
      );
    elsif v_request.change_field = 'event_name' then update event_requests set event_name = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'description' then update event_requests set description = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'purpose' then update event_requests set purpose = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_start' then update event_requests set proposed_start = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_end' then update event_requests set proposed_end = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'expected_attendance' then update event_requests set expected_attendance = v_request.requested_change::integer where id = v_request.event_request_id;
    end if;
    -- venue, equipment, other: nothing to apply, as in 006.
  end if;

  return v_request;
end;
$$;

-- After confirmation the significant fields lock; changes go through a significant
-- change and a fresh safety review.

create or replace function enforce_confirmed_event_fields()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' and new.status = 'confirmed'
     and row(new.proposed_start, new.proposed_end, new.expected_attendance,
             new.venue_requirements, new.accessibility_requirements)
         is distinct from
         row(old.proposed_start, old.proposed_end, old.expected_attendance,
             old.venue_requirements, old.accessibility_requirements) then
    raise exception 'Confirmed event details are locked. Apply a significant change and complete safety review before confirming again.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke execute on function enforce_confirmed_event_fields() from public, anon, authenticated;

create trigger event_requests_confirmed_fields
  before update on event_requests
  for each row
  execute function enforce_confirmed_event_fields();
