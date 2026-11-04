-- Baseline 05: the notifications table and the one sql function that writes to it.
-- Part of the baseline that rebuilds the schema as of migration 102; never pasted into live.

-- Functions only the API may call revoke execute from the client roles; service_role
-- keeps the grant it gets from the default privileges.

-- Adding a type means restating the whole notifications_type_known list in a new migration.
create table notifications (
  id uuid not null default gen_random_uuid(),
  recipient_id uuid not null,
  type text not null,
  booking_id uuid,
  block_id uuid,
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  venue_hold_id uuid,
  event_request_id uuid,
  constraint notifications_pkey primary key (id),
  constraint notifications_block_id_fkey foreign key (block_id) references venue_blocks(id) on delete cascade,
  constraint notifications_booking_id_fkey foreign key (booking_id) references bookings(id) on delete cascade,
  constraint notifications_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete cascade,
  constraint notifications_recipient_id_fkey foreign key (recipient_id) references auth.users(id) on delete cascade,
  constraint notifications_venue_hold_id_fkey foreign key (venue_hold_id) references venue_holds(id) on delete cascade,
  constraint notifications_booking_decision_needs_booking check ((type <> all (array['booking_request_approved'::text, 'booking_request_rejected'::text, 'booking_request_conflicting'::text])) or (booking_id is not null)),
  constraint notifications_booking_flagged_needs_refs check ((type <> 'booking_flagged'::text) or ((booking_id is not null) and (block_id is not null))),
  constraint notifications_event_cancelled_needs_event check ((type <> 'event_cancelled'::text) or (event_request_id is not null)),
  constraint notifications_hold_expired_needs_hold check ((type <> 'venue_hold_expired'::text) or (venue_hold_id is not null)),
  constraint notifications_request_submitted_needs_booking check ((type <> 'booking_request_submitted'::text) or (booking_id is not null)),
  constraint notifications_request_unavailable_needs_booking check ((type <> 'booking_request_venue_unavailable'::text) or (booking_id is not null)),
  constraint notifications_request_withdrawn_needs_booking check ((type <> 'booking_request_withdrawn'::text) or (booking_id is not null)),
  constraint notifications_setup_change_needs_booking check ((type <> 'booking_flagged_setup_change'::text) or (booking_id is not null)),
  constraint notifications_type_known check (type = any (array[
    'booking_flagged',
    'booking_request_withdrawn',
    'clarification_requested',
    'clarification_replied',
    'clarification_closed',
    'booking_flagged_setup_change',
    'venue_hold_expired',
    'event_cancelled',
    'event_request_awaiting_assignment',
    'event_request_assigned',
    'event_request_coordinator_assigned',
    'safety_review_response',
    'safety_booking_flagged',
    'safety_equipment_review',
    'event_submitted_for_safety_review',
    'booking_request_approved',
    'booking_request_rejected',
    'booking_request_conflicting',
    'flagged_booking_resolved',
    'booking_request_submitted',
    'booking_request_venue_unavailable',
    'booking_flagged_venue_retired',
    'booking_released',
    'booking_request_conflict_cleared',
    'equipment_requested',
    'equipment_request_changed',
    'equipment_request_cancelled',
    'equipment_arranged',
    'equipment_not_fully_arranged',
    'equipment_flagged',
    'registration_schedule_conflict',
    'event_significant_change',
    'event_significant_change_attendee',
    'booking_flagged_event_change',
    'booking_request_event_change'
  ])),
  constraint notifications_venue_retired_needs_booking check ((type <> 'booking_flagged_venue_retired'::text) or (booking_id is not null))
);
create index idx_notifications_recipient_created on notifications (recipient_id, created_at desc);
create unique index notifications_event_cancelled_once_per_recipient on notifications (recipient_id, event_request_id) where (type = 'event_cancelled'::text);
-- A hold is notified about once, however often the expiry job runs.
create unique index notifications_one_per_expired_hold on notifications (venue_hold_id) where (type = 'venue_hold_expired'::text);
-- A re-flag for the same block tells nobody twice; recipient_id is in the key so an
-- unassigned event still reaches every Lead.
create unique index notifications_request_unavailable_once_per_block on notifications (booking_id, block_id, recipient_id) where (type = 'booking_request_venue_unavailable'::text);
alter table notifications enable row level security;

-- Language sql, so it is checked when created and must follow the table.

create or replace function notify_flagged_booking_resolved(
  p_resolution_id    uuid,
  p_resolved_by_role text
)
returns void
language sql
as $$
  insert into notifications (recipient_id, type, booking_id, payload)
  select r.recipient_id,
         'flagged_booking_resolved',
         b.id,
         jsonb_build_object(
           'audience',             r.audience,
           'outcome',              br.outcome,
           'eventRequestId',       b.event_request_id,
           'eventName',            er.event_name,
           'venueId',              b.venue_id,
           'venueName',            v.name,
           'startsAt',             b.starts_at,
           'endsAt',               b.ends_at,
           'reason',               br.reason,
           'resolvedAt',           br.created_at,
           'resolvedByRole',       p_resolved_by_role,
           'replacementBookingId', rb.id,
           'replacementVenueName', rv.name,
           'replacementStartsAt',  rb.starts_at,
           'replacementEndsAt',    rb.ends_at
         )
    from booking_resolutions br
    join bookings b        on b.id = br.booking_id
    join venues v          on v.id = b.venue_id
    join event_requests er on er.id = b.event_request_id
    left join bookings rb  on rb.id = br.replacement_booking_id
    left join venues rv    on rv.id = rb.venue_id
   cross join lateral (
     values ('coordinator', er.assigned_coordinator_id),
            ('organiser',   case when er.status::text = 'confirmed' then er.organiser_id end)
   ) as r (audience, recipient_id)
   where br.id = p_resolution_id
     and r.recipient_id is not null
     and r.recipient_id <> br.resolved_by
   order by r.audience;
$$;
revoke execute on function notify_flagged_booking_resolved(uuid, text) from public, anon, authenticated;
