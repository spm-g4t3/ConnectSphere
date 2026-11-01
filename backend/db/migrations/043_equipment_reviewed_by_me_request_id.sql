-- Migration 043: "Reviewed by me" keeps each row's request id (SCRUM-582).
-- One event can have more than one equipment request (one is cancelled and a new
-- one is made), so the event id alone does not tell two rows apart. The list
-- already orders by request_id; this stops 041 from removing it before it
-- returns. Same signature as 041, so create or replace is all it takes.
-- Read only, as in 041.

create or replace function equipment_reviewed_by_me(
  p_caller uuid,
  p_limit  integer default 200
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_result jsonb;
begin
  if p_caller is null
     or not exists (select 1 from profiles where id = p_caller and role::text = 'technical_support_staff') then
    raise exception 'Only technical support staff can see the requests they have reviewed'
      using errcode = '42501';
  end if;

  with mine as (
    -- One row per request the caller started or took over. last_start_id is
    -- their latest such row; history ids only increase, so it orders the log.
    select h.equipment_request_id as request_id,
           max(h.id) filter (where h.action in ('started', 'taken_over')) as last_start_id,
           max(h.created_at) as last_worked_at
      from equipment_review_history h
     where h.user_id = p_caller
       and h.action in ('started', 'taken_over', 'line_marked', 'line_unmarked', 'completed', 'arranged')
     group by h.equipment_request_id
    having count(*) filter (where h.action in ('started', 'taken_over')) > 0
  ),
  ended as (
    -- The interruption that ended the caller's latest review: the first
    -- 'interrupted' row after it, unless someone started or took over first.
    -- The row's own user_id and from_user_id are not used: the Safety return
    -- records the Safety Officer and no previous reviewer.
    select m.*,
           (select min(i.id)
              from equipment_review_history i
             where i.equipment_request_id = m.request_id
               and i.action = 'interrupted'
               and i.id > m.last_start_id
               and not exists (
                 select 1
                   from equipment_review_history s
                  where s.equipment_request_id = m.request_id
                    and s.action in ('started', 'taken_over')
                    and s.id > m.last_start_id
                    and s.id < i.id)) as interrupt_id
      from mine m
  ),
  listed as (
    select r.id                         as request_id,
           e.id                         as event_request_id,
           e.event_name,
           e.proposed_start,
           e.proposed_end,
           r.status::text               as status,
           x.last_worked_at,
           ih.note                      as interrupted_reason,
           ih.created_at                as interrupted_at,
           -- Starting a review moves the request to Under review, and nothing
           -- the caller does returns it to Pending, so Pending now means it
           -- came back after they last worked on it.
           (r.status = 'pending_review') as returned_to_pending
      from ended x
      join equipment_requests r on r.id = x.request_id
      join event_requests e on e.id = r.event_request_id
      left join equipment_review_history ih on ih.id = x.interrupt_id
  )
  select jsonb_build_object(
           'requests', coalesce((
             select jsonb_agg(to_jsonb(p) order by p.last_worked_at desc, p.request_id desc)
               from (select * from listed order by last_worked_at desc, request_id desc limit v_limit) p
           ), '[]'::jsonb),
           'total', (select count(*) from listed),
           'truncated', (select count(*) from listed) > v_limit
         )
    into v_result;

  return v_result;
end;
$$;
revoke execute on function equipment_reviewed_by_me(uuid, integer) from public, anon, authenticated;
