-- Migration 010: drop three functions nothing calls any more.
-- pick_event_coordinator was the auto-assignment helper; submissions now wait in
-- the Lead's unassigned queue. The API asks and replies through
-- request_event_clarification_with_fields and reply_to_event_clarification_with_amendments.
-- Dropping a function also drops its grants and revokes.

drop function if exists pick_event_coordinator(uuid);
drop function if exists request_event_clarification(uuid, uuid, uuid, text, date);
drop function if exists reply_to_event_clarification(uuid, uuid, text);
