-- Lock only the significant fields on a confirmed event (requirements §3).
-- Ordinary edits (name, description, purpose) still arrive through an approved
-- change request; 019 applies them without leaving Confirmed, so 099's wider
-- lock left them no path. Significant fields change only through 100, which
-- returns the event to Approved first. Equipment is reviewed through equipment
-- requests, not this column, which only a clarification amendment writes.
create or replace function enforce_confirmed_event_fields()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'confirmed' and new.status = 'confirmed'
     and row(new.proposed_start, new.proposed_end, new.expected_attendance,
             new.venue_requirements, new.accessibility_requirements)
         is distinct from
         row(old.proposed_start, old.proposed_end, old.expected_attendance,
             old.venue_requirements, old.accessibility_requirements) then
    raise exception 'Confirmed event details are locked. Apply a significant change and complete safety review before confirming again.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke execute on function enforce_confirmed_event_fields() from public, anon, authenticated;
grant execute on function enforce_confirmed_event_fields() to service_role;

notify pgrst, 'reload schema';
