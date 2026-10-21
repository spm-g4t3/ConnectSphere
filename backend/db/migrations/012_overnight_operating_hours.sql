-- Migration 012: a weekday's hours may run past midnight.
-- A closing time at or before the opening time now means the next day, so the
-- only window left to refuse is an empty one (opening equals closing).

alter table venue_operating_hours drop constraint if exists venue_operating_hours_ordered;

alter table venue_operating_hours drop constraint if exists venue_operating_hours_not_empty;
alter table venue_operating_hours
  add constraint venue_operating_hours_not_empty check (closes_at <> opens_at);
