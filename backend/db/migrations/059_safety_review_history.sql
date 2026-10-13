-- 059_safety_review_history.sql
-- SCRUM-490: list events a Safety Officer has already responded to, so the
-- Safety review page shows past outcomes once the queue is empty.
--
-- Apply after 058_safety_review.sql. One row per event, using its latest
-- response, newest first. Read-only.

create or replace function safety_review_history()
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'eventName', e.event_name,
        'startsAt', e.proposed_start,
        'endsAt', e.proposed_end,
        'status', e.status,
        'outcome', r.outcome,
        'note', r.note,
        'safetyOfficerName', officer.full_name,
        'respondedAt', r.created_at
      ) order by r.created_at desc, r.id
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (event_request_id) *
      from safety_review_responses
     order by event_request_id, created_at desc, id desc
  ) r
  join event_requests e on e.id = r.event_request_id
  left join profiles officer on officer.id = r.safety_officer_id;
$$;

revoke execute on function safety_review_history() from public, anon, authenticated;

notify pgrst, 'reload schema';
