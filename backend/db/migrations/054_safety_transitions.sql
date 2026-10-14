-- 054_safety_transitions.sql
-- SCRUM-488 (SCRUM-551): the legal status changes, with the Operational Safety
-- Check between Approved and Confirmed.
--
-- event_request_status_allows (022) is the one place the database holds the
-- transition table, and change_event_request_status, start_event_review and
-- decide_event_request (029, 052) all ask it. Restating it here changes what
-- every one of them accepts, with no edit to them: the stale-status check, the
-- row lock, the reason handling, the history insert and every SQLSTATE stay
-- as 022 wrote them. domain/eventRequestStatus.js (ALLOWED_TRANSITIONS) holds
-- the same table, and a test compares the two pair by pair.
--
-- Changes against 022's sixteen, to twenty-two:
--   removed  approved        -> confirmed
--   added    approved        -> safety_review
--            safety_review   -> safety_approved
--            safety_review   -> approved
--            safety_approved -> approved
--            safety_approved -> confirmed
--            safety_review   -> cancelled
--            safety_approved -> cancelled
-- Neither safety status may be rejected: that is SCRUM-347's open decision
-- (docs/SCRUM-488-decisions.md, D4), so it is not a transition until recorded.
-- Who may make each move is checked by the story that makes it, not here.
--
-- Compared as text, as in 022, so the values need no enum literal. 053 has
-- already added the two statuses to the enum, and this file does not depend on
-- that having committed.
--
-- Same signature as 022, so create or replace is a replacement and no overload
-- is left behind. Immutable still holds: the answer depends only on the
-- arguments.

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

notify pgrst, 'reload schema';
