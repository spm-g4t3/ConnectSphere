-- 056_equipment_request_queue.sql
--
-- SCRUM-284 "Technical Support Dashboard and Request Queue", sub-task SCRUM-285
-- (the queue endpoint). Run in the Supabase SQL Editor after 055.
--
-- One read-only function that answers the whole dashboard:
--
--   equipment_request_queue(p_status, p_include_past)
--
-- It returns { "needs_action": [...], "requests": [...] }, both lists made of the
-- same row, which carries exactly what AC3 lists and nothing else (AC6):
--
--   event_request_id, event_name, proposed_start, proposed_end,
--   venue_id, venue_name, coordinator_id, coordinator_name, line_count,
--   status, reviewer_id, reviewer_name, flagged_count, flag_reasons
--
-- Which request stands for an event: the same rule the review screen uses
-- (038, equipment_review_for_event): a live request over a cancelled one, then
-- the newest. So the row a person selects opens the request they see.
--
-- requests (AC2):  every status, optionally one status, earliest event start
--                  first. Events that have ended are left out unless
--                  p_include_past is true. An event with no period yet has not
--                  ended, so it is kept, and sorted last.
-- needs_action (AC4): Pending review requests, and any request holding a live
--                  reservation that is flagged, earliest event first. The status
--                  filter does not touch it, because it is the part of the page
--                  that says "do this", whatever is being browsed. The past
--                  filter does, for the reason AC2 gives.
--
-- A reservation counts as flagged only while it is live (released_at is null),
-- so a released one never keeps a request on the list.
--
-- stable: opening the dashboard can never change anything.
-- p_status is text so a bad value can be refused by the caller with a clear
-- message instead of an enum cast error; null means every status.

create or replace function equipment_request_queue(
  p_status       text    default null,
  p_include_past boolean default false
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_status equipment_request_status;
  v_rows   jsonb;
begin
  if p_status is not null then
    begin
      v_status := p_status::equipment_request_status;
    exception when invalid_text_representation then
      raise exception 'Unknown status %', p_status using errcode = '22023';
    end;
  end if;

  with picked as (
    select distinct on (r.event_request_id) r.*
      from equipment_requests r
     order by r.event_request_id, (r.status = 'cancelled'), r.created_at desc, r.id desc
  ),
  queue_rows as (
    select
      e.id                                         as event_request_id,
      e.event_name,
      e.proposed_start,
      e.proposed_end,
      venue.venue_id,
      venue.venue_name,
      e.assigned_coordinator_id                    as coordinator_id,
      coordinator.full_name                        as coordinator_name,
      (select count(*) from equipment_lines l where l.equipment_request_id = p.id)::int
                                                   as line_count,
      p.status::text                               as status,
      p.reviewer_id,
      reviewer.full_name                           as reviewer_name,
      coalesce(flagged.flagged_count, 0)::int      as flagged_count,
      coalesce(flagged.flag_reasons, '[]'::jsonb)  as flag_reasons
    from picked p
    join event_requests e on e.id = p.event_request_id
    left join profiles coordinator on coordinator.id = e.assigned_coordinator_id
    left join profiles reviewer    on reviewer.id    = p.reviewer_id
    left join lateral (
      select v.id as venue_id, v.name as venue_name
        from bookings b
        join venues v on v.id = b.venue_id
       where b.event_request_id = e.id
         and b.status::text in ('approved', 'flagged_for_review')
       order by b.starts_at asc, b.id asc
       limit 1
    ) venue on true
    left join lateral (
      select count(*)                                       as flagged_count,
             coalesce(jsonb_agg(distinct res.flag_reason)
                      filter (where res.flag_reason is not null), '[]'::jsonb)
                                                            as flag_reasons
        from equipment_reservations res
        join equipment_lines l on l.id = res.equipment_line_id
       where l.equipment_request_id = p.id
         and res.released_at is null
         and res.flagged
    ) flagged on true
    where p_include_past
       or e.proposed_end is null
       or e.proposed_end >= now()
  )
  select jsonb_build_object(
           'needs_action', coalesce((
             select jsonb_agg(to_jsonb(r) order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where r.status = 'pending_review' or r.flagged_count > 0
           ), '[]'::jsonb),
           'requests', coalesce((
             select jsonb_agg(to_jsonb(r) order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where v_status is null or r.status = v_status::text
           ), '[]'::jsonb)
         )
    into v_rows;

  return v_rows;
end;
$$;
