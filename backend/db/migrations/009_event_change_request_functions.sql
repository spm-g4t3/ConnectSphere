-- 009_event_change_request_functions.sql
-- SCRUM-37 (AC5): apply an approved change back onto the event record once
-- a change request has been processed.
--
-- Part of SCRUM-11 "Save/edit request". Run this once in the Supabase SQL
-- Editor, after 008_event_change_request_decision.sql.
--
-- Why this is a Postgres function rather than two separate updates from
-- JavaScript: deciding a change request and applying it to event_requests
-- are two different tables, and supabase-js talks to PostgREST, where every
-- call is its own HTTP request with no shared transaction. Without a single
-- transaction, an approval that fails to apply -- a rejected proposed_start
-- because it would now fall after proposed_end, for instance -- could leave
-- a change request marked processed for a change that was never actually
-- made. A Postgres function body IS a transaction, the same reasoning
-- create_venue and update_venue in 004_venue_functions.sql already rely on.


-- ---------------------------------------------------------------------
-- process_change_request
-- ---------------------------------------------------------------------
-- Records the decision, then -- only if it was an approval -- applies the
-- requested change to the event it belongs to.
--
-- change_field is matched with an explicit branch per structured field
-- rather than a dynamic column update, the same choice update_venue makes
-- for its own attribute sets over a generic loop: every field this function
-- can apply is named here, in the open, rather than trusted to a string
-- built at runtime.
--
-- venue, equipment and other have no branch: event_requests has no column
-- for any of them yet (see the comment on 'other' in
-- 005_event_change_requests.sql). Approving one of those is still a valid,
-- recorded decision -- it is only not reflected anywhere on the event
-- record, because nowhere yet exists to put it.
--
-- WHERE ... and status <> 'processed' is what makes "already processed"
-- safe under concurrency: a second call racing the first can only ever
-- match zero rows, never double-apply a change or overwrite one decision
-- with another.

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
  v_request event_change_requests;
begin
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
      -- surfaces to the service as a ValidationError, not a 404: the request
      -- exists, it is just no longer open to a decision
      raise exception 'change request % has already been processed', p_change_request_id;
    else
      -- surfaces to the service as NotFoundError
      raise exception 'change request % not found', p_change_request_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_decision = 'approved' then
    if v_request.change_field = 'event_name' then update event_requests set event_name = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'description' then update event_requests set description = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'purpose' then update event_requests set purpose = v_request.requested_change where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_start' then update event_requests set proposed_start = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'proposed_end' then update event_requests set proposed_end = v_request.requested_change::timestamptz where id = v_request.event_request_id;
    elsif v_request.change_field = 'expected_attendance' then update event_requests set expected_attendance = v_request.requested_change::integer where id = v_request.event_request_id;
    end if;
    -- venue, equipment, other: no matching branch, nothing to apply -- see
    -- the comment above this function.
  end if;

  return v_request;
end;
$$;
