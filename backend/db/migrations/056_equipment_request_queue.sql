-- 056_equipment_request_queue.sql
-- Run after 055. Safe to run twice.
--
-- equipment_request_queue(p_caller, p_status, p_include_past, p_limit) answers the
-- Technical Support dashboard in one read: { needs_action, requests, ...flags }.
--
-- One event is one row, standing for its live equipment request, or else its
-- newest (the choice equipment_review_for_event makes), so a row opens the
-- request the reviewer sees. Both lists are earliest event first, events with no
-- period last.
--
--   requests      every status, or the one asked for
--   needs_action  Pending review, and any request holding a live flagged
--                 reservation, for events still going ahead (approved, the
--                 safety statuses, confirmed); a rejected or draft event's
--                 request stays out. Neither the status filter nor
--                 p_include_past narrows it
--
-- Events that have ended are left out of requests unless p_include_past. Each
-- list is cut at p_limit (default 200, at most 500); *_truncated says when rows
-- were left off and *_total is the real count before the cut.
-- item_count is units across the request's live lines; venues is every venue the
-- event holds an approved or flagged booking at.
--
-- Only technical_support_staff may call it (42501), as the route also requires.
-- Read-only (stable). p_status is text so a bad value is a clear 22023.

-- The signature changed from (text, boolean): drop it so it cannot stay callable.
drop function if exists equipment_request_queue(text, boolean);

create or replace function equipment_request_queue(
  p_caller       uuid,
  p_status       text    default null,
  p_include_past boolean default false,
  p_limit        integer default 200
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_status equipment_request_status;
  v_limit  integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  -- Statuses where the event, and so its equipment request, is still going ahead.
  -- Not equipment_reservable_event_statuses(): that is who may reserve, a separate rule.
  v_live_event_statuses constant text[] := array['approved', 'safety_review', 'safety_approved', 'confirmed'];
  v_result jsonb;
begin
  if p_caller is null
     or not exists (select 1 from profiles where id = p_caller and role::text = 'technical_support_staff') then
    raise exception 'Only technical support staff can see the equipment request queue'
      using errcode = '42501';
  end if;

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
      join event_requests e on e.id = r.event_request_id
     where p_include_past
        or e.proposed_end is null
        or e.proposed_end >= now()
        or e.status::text = any (v_live_event_statuses)
     order by r.event_request_id, (r.status = 'cancelled'), r.created_at desc, r.id desc
  ),
  base as (
    select p.id as request_id,
           p.event_request_id,
           p.status,
           e.proposed_start,
           e.status::text as event_status,
           not (e.proposed_end is null or e.proposed_end >= now()) as ended,
           exists (
             select 1
               from equipment_reservations res
               join equipment_lines l on l.id = res.equipment_line_id
              where l.equipment_request_id = p.id
                and res.released_at is null
                and res.flagged
           ) as has_flag
      from picked p
      join event_requests e on e.id = p.event_request_id
  ),
  needs_all as (
    select b.*
      from base b
     where (b.status = 'pending_review' or b.has_flag)
       and b.event_status = any (v_live_event_statuses)
  ),
  needs as (
    select n.*
      from needs_all n
     order by n.proposed_start asc nulls last, n.event_request_id
     limit v_limit
  ),
  reqs_all as (
    select b.*
      from base b
     where (p_include_past or not b.ended)
       and (v_status is null or b.status = v_status)
  ),
  reqs as (
    select r.*
      from reqs_all r
     order by r.proposed_start asc nulls last, r.event_request_id
     limit v_limit
  ),
  wanted as (
    select request_id from needs
    union
    select request_id from reqs
  ),
  queue_rows as (
    select
      p.id                                         as request_id,
      e.id                                         as event_request_id,
      e.event_name,
      e.proposed_start,
      e.proposed_end,
      venues.venues,
      e.assigned_coordinator_id                    as coordinator_id,
      coordinator.full_name                        as coordinator_name,
      coalesce((
        select sum(l.quantity)
          from equipment_lines l
         where l.equipment_request_id = p.id
           and l.removed_at is null
      ), 0)::int                                   as item_count,
      p.status::text                               as status,
      p.reviewer_id,
      reviewer.full_name                           as reviewer_name,
      coalesce(flagged.flagged_count, 0)::int      as flagged_count,
      coalesce(flagged.flag_reasons, '[]'::jsonb)  as flag_reasons
    from wanted w
    join equipment_requests p on p.id = w.request_id
    join event_requests e on e.id = p.event_request_id
    left join profiles coordinator on coordinator.id = e.assigned_coordinator_id
    left join profiles reviewer    on reviewer.id    = p.reviewer_id
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name)
                                order by x.first_start, x.id), '[]'::jsonb) as venues
        from (
          select v.id, v.name, min(b.starts_at) as first_start
            from bookings b
            join venues v on v.id = b.venue_id
           where b.event_request_id = e.id
             and b.status::text in ('approved', 'flagged_for_review')
           group by v.id, v.name
        ) x
    ) venues on true
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
  )
  select jsonb_build_object(
           'needs_action', coalesce((
             select jsonb_agg(to_jsonb(r) - 'request_id' order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where r.request_id in (select request_id from needs)
           ), '[]'::jsonb),
           'needs_action_total', (select count(*) from needs_all),
           'needs_action_truncated', (select count(*) from needs_all) > v_limit,
           'requests', coalesce((
             select jsonb_agg(to_jsonb(r) - 'request_id' order by r.proposed_start asc nulls last, r.event_request_id)
               from queue_rows r
              where r.request_id in (select request_id from reqs)
           ), '[]'::jsonb),
           'requests_total', (select count(*) from reqs_all),
           'requests_truncated', (select count(*) from reqs_all) > v_limit
         )
    into v_result;

  return v_result;
end;
$$;

-- p_caller is trusted: the role check inside reads whatever id it is given. Only
-- the API (service_role) may call this, so a direct call through Supabase's REST
-- endpoint cannot skip requireRole. Same as the other p_caller functions.
revoke execute on function equipment_request_queue(uuid, text, boolean, integer)
  from public, anon, authenticated;
