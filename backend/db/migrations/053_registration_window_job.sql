-- Migration 053: the registration opening/closing job (SCRUM-177, SCRUM-237).
-- Registration opens and closes when a time passes, with no write to notice it.
-- process_registration_window_notices, called once a minute by the API's job
-- (backend/src/jobs/registrationWindowScheduler.js), finds every event whose
-- window is not what was last announced and hands it to
-- announce_registration_window (052), the one path the registration flows use too.
--
-- Boundaries and clock: registration_closed_reason, the rule registering uses,
-- read with the database clock after the event lock: open from
-- registration_opens_at inclusive, closed from registration_closes_at (or the
-- start) inclusive; a null closing time stays open until switched off or the
-- start; a null opening time or start is closed. timestamptz throughout, so no
-- time zone is involved, and nothing compares a time for equality: the job asks
-- "open now?" against what was announced, so a late run still sees a boundary.
--
-- Re-runnable.

-- One run of the job. Every event whose window differs from what was announced
-- is due, however long ago its boundary passed, so a run after downtime catches
-- up. A window that opened and closed again while nobody ran is not announced
-- at all: both notices would be stale, and nothing is open to act on.
--
-- Each event is decided again under its lock by announce_registration_window,
-- from the dates as they are now, so a date moved or registration switched off
-- since the boundary sends nothing obsolete. A change a flow already announced
-- has recorded its state, so the job finds nothing to do for it.
--
-- Before announcing an opening, it hands any free places to the waiting list
-- (as the flows do) so a queued attendee who gets one is told that instead,
-- and announces a capacity that promotion filled.
--
-- One event failing (its own subtransaction is rolled back) does not stop the
-- rest; it stays due and is retried next run. Returns
-- { notified, events, failures: [{ eventRequestId, message }] }.

create or replace function process_registration_window_notices()
returns jsonb
language plpgsql
as $$
declare
  v_event_id uuid;
  v_notified integer := 0;
  v_events integer := 0;
  v_failures jsonb := '[]'::jsonb;
begin
  for v_event_id in
    select e.id
      from event_requests e
      left join registration_notice_state s on s.event_request_id = e.id
     -- Only a confirmed event can be open, so any other is due only while it
     -- is still recorded open; finished events are skipped every run.
     where (e.status::text = 'confirmed' or s.open_announced)
       and (registration_closed_reason(e, clock_timestamp()) is null)
           is distinct from coalesce(s.open_announced, false)
     -- Event locks are held to the end of the run; a fixed order keeps two
     -- concurrent runs from deadlocking on each other.
     order by e.id
  loop
    begin
      if promote_waitlisted_registrations(v_event_id) > 0 then
        v_notified := v_notified + announce_registration_capacity(v_event_id, 'promotion');
      end if;
      v_notified := v_notified + announce_registration_window(v_event_id, null);
      v_events := v_events + 1;
    exception when others then
      v_failures := v_failures || jsonb_build_object('eventRequestId', v_event_id, 'message', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('notified', v_notified, 'events', v_events, 'failures', v_failures);
end;
$$;
revoke execute on function process_registration_window_notices() from public, anon, authenticated;
