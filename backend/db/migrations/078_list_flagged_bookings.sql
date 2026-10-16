-- Venue Staff see every booking flagged for review, each with what flagged it,
-- so they can reinstate (076) or cancel (077) it. Two more review reasons are
-- allowed now, for the event and venue edits that will flag bookings later.


-- ---------------------------------------------------------------------
-- 1. Review reasons (extends 071)
-- ---------------------------------------------------------------------
-- 071's list with event_changed and venue_details_changed. Nothing sets them
-- yet. Dropped and re-added by name, as 034 does, so a re-run replaces it.

alter table bookings
  drop constraint if exists bookings_review_reason_known;

alter table bookings
  add constraint bookings_review_reason_known
  check (review_reason in ('setup_or_turnaround_changed', 'safety_review',
                           'event_changed', 'venue_details_changed'));


-- ---------------------------------------------------------------------
-- 2. list_flagged_bookings
-- ---------------------------------------------------------------------
-- list_pending_booking_requests' (066) shape, for flagged bookings. A safety
-- flag keeps the block that flagged the booking before it (071), so the block
-- columns are read whatever the review reason is. Oldest flag first; a
-- booking flagged before 014 has no flag time, so it is the oldest.
-- `reinstatable` is a hint for the screen only: 076 enforces the rule.

create or replace function list_flagged_bookings(p_caller uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_role text;
begin
  -- Only Venue Staff, as 076 checks it. A null caller is refused too.
  select p.role::text
    into v_role
    from profiles p
   where p.id = p_caller;

  if p_caller is null or v_role is distinct from 'venue_staff' then
    raise exception 'only Venue Staff can view flagged bookings'
      using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    with flagged as (
      select b.*,
             er.event_name,
             er.status::text                      as event_status,
             er.proposed_start                    as event_starts_at,
             er.proposed_end                      as event_ends_at,
             er.assigned_coordinator_id,
             v.name                               as venue_name,
             v.location                           as venue_location,
             vb.reason::text                      as block_reason,
             vb.notes                             as block_notes,
             vb.starts_at                         as block_starts_at,
             vb.ends_at                           as block_ends_at,
             vb.removed_at                        as block_removed_at,
             venue_occupied_period(b.starts_at, b.ends_at,
                                   v.setup_minutes, v.turnaround_minutes) as occupied
        from bookings b
        join event_requests er    on er.id = b.event_request_id
        join venues v             on v.id  = b.venue_id
        left join venue_blocks vb on vb.id = b.review_block_id
       where b.status = 'flagged_for_review'
    )
    select jsonb_agg(
             jsonb_build_object(
               'id',                      f.id,
               'event_request_id',        f.event_request_id,
               'venue_id',                f.venue_id,
               'starts_at',               f.starts_at,
               'ends_at',                 f.ends_at,
               'occupied_starts_at',      lower(f.occupied),
               'occupied_ends_at',        upper(f.occupied),
               'flagged_at',              f.flagged_at,
               'flagged_by',              f.flagged_by,
               'review_reason',           f.review_reason,
               'event_name',              f.event_name,
               'event_status',            f.event_status,
               'event_starts_at',         f.event_starts_at,
               'event_ends_at',           f.event_ends_at,
               'assigned_coordinator_id', f.assigned_coordinator_id,
               'venue_name',              f.venue_name,
               'venue_location',          f.venue_location,
               'block_id',                f.review_block_id,
               'block_reason',            f.block_reason,
               'block_notes',             f.block_notes,
               'block_starts_at',         f.block_starts_at,
               'block_ends_at',           f.block_ends_at,
               'block_removed_at',        f.block_removed_at,
               'reinstatable',            f.review_reason is distinct from 'safety_review'
             )
             order by f.flagged_at nulls first, f.created_at, f.id
           )
      from flagged f
  ), '[]'::jsonb);
end;
$$;

-- As 066: it trusts p_caller to be who the API authenticated. Nothing is granted.
revoke execute on function list_flagged_bookings(uuid)
  from public, anon, authenticated;
