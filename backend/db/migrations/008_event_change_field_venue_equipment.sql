-- 008_event_change_field_venue_equipment.sql
-- Frontend/backend contract fix: add 'venue' and 'equipment' as first-class
-- change fields.
--
-- Builds on 006_event_change_requests.sql -- run after it.
--
-- The change request form already shipped (frontend/ChangeRequestForm.jsx,
-- SCRUM-32) offers "Venue" and "Equipment" as choices distinct from
-- event_name/description/proposed_start/proposed_end/expected_attendance,
-- alongside an "other" catch-all. 006's vocabulary predates that form and
-- did not have either as its own value, which would have made every
-- Organiser who picked "Venue" or "Equipment" fail validation with no way
-- to fix it from the form itself.
--
-- Purely additive: nothing existing is removed or renamed, so no data and no
-- other caller of this enum is affected. 'purpose' stays too, even though
-- the current form does not offer it as an option -- removing a value a
-- caller might already be relying on is not this migration's call to make.
--
-- ADD VALUE cannot run inside the same transaction as a statement that uses
-- the new value, which is why this migration only adds them and does
-- nothing else.

alter type event_change_field add value if not exists 'venue';
alter type event_change_field add value if not exists 'equipment';
