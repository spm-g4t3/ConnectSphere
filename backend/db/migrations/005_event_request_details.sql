-- 005_event_request_details.sql
-- SCRUM-10: Create event request
--
-- Adds the fields an Event Organiser supplies when creating a request: three
-- prose descriptions of what they need (venue, accessibility, equipment) and
-- the timestamp recording when the request left draft. 001_event_requests.sql
-- deliberately stopped at the columns a status can hang off and asks in its
-- header for the rest to arrive in a new numbered migration; this is that
-- migration. 001 is already applied to the live database and two branches
-- build on it, so it is not edited.
--
-- Event name, purpose, proposed dates and expected attendance -- the other
-- fields the story names -- already exist in 001. Only the requirements and
-- the submission timestamp are new.
--
-- Run this once in the Supabase SQL Editor.
--
--
-- What this migration deliberately does not do:
--
--   * No NOT NULL on any column. The status enum begins at 'draft' and the
--     column defaults to it, so every request is born incomplete by design and
--     SCRUM-11 (save/edit draft) depends on that staying true. These fields are
--     mandatory only at the draft -> submitted transition, which is a rule about
--     one state change rather than a rule every row must satisfy at all times,
--     so the API enforces it in src/validation/eventRequestValidation.js. A
--     NOT NULL here would make saving a half-written draft impossible.
--
--   * No defaults. An unanswered requirement is absent, not an empty string,
--     and a default would hide the difference from the submission check.
--
--   * No structured requirement tables. At request time the Organiser describes
--     what they need in their own words. The customer briefing has the
--     Coordinator later clarifying and formalising that prose into venue
--     searches and equipment lines, which is downstream Coordinator work --
--     equipment_lines and the venue criteria tables arrive with those stories
--     and read these columns as their source. Structuring it here would mean
--     inventing a vocabulary before anyone has asked the Organiser to use one.
--
--   * No indexes. Nothing filters, joins or sorts on these columns yet; the
--     lists that exist are served by 001's indexes on organiser_id and status.
--
--   * No RLS policies. The table is deny-all by design (see 001 section 5) --
--     the Express API holds the service_role key and authorises in middleware,
--     where role and event relationship are both known.


-- ---------------------------------------------------------------------
-- 1. Requirement descriptions
-- ---------------------------------------------------------------------
-- Free text, in the Organiser's own words. Three columns rather than one
-- "requirements" blob because the Coordinator acts on them separately -- venue
-- needs drive a venue search, equipment needs an equipment list -- and the
-- Organiser's status view shows them as distinct fields.

alter table event_requests
  -- what the event needs from a space: size, layout, location, timing, and
  -- anything else the Organiser thinks matters. Prose, not a venue id: the
  -- Organiser describes the need, the Coordinator matches it to the catalogue.
  add column if not exists venue_requirements         text,

  -- accessibility needs, stated separately rather than folded into the venue
  -- text so they cannot be lost in a paragraph about room size. The briefing
  -- treats accessibility as a first-class requirement, so it gets its own field.
  add column if not exists accessibility_requirements text,

  -- equipment and technical needs -- microphones, projector, staging, catering
  -- hookups. Becomes structured equipment lines once a Coordinator formalises it.
  add column if not exists equipment_requirements     text;


-- ---------------------------------------------------------------------
-- 2. Submission timestamp
-- ---------------------------------------------------------------------
-- Separate from created_at, which records when the draft was first saved. A
-- draft may sit unfinished for days before it is sent, so "when was this
-- written" and "when did ConnectSphere receive it" are genuinely different
-- facts, and review turnaround is measured from the second one.
--
-- Null while the request is in draft; set by the API at the draft -> submitted
-- transition. Not maintained by a trigger: unlike updated_at, this is written
-- once, by the one code path that performs that transition.

alter table event_requests
  add column if not exists submitted_at timestamptz;


-- ---------------------------------------------------------------------
-- 3. Keep submitted_at consistent with status
-- ---------------------------------------------------------------------
-- A draft has not been submitted, so it cannot carry a submission time. This
-- catches the one ordering mistake the API could plausibly make -- stamping
-- submitted_at without moving the status, or rolling the status back to draft
-- and leaving the stamp behind.
--
-- Constrains drafts only. Every other status is left alone deliberately: a
-- request that reached 'submitted' and beyond must have a submitted_at, but
-- rows created before this migration have none, so requiring it here would
-- reject perfectly good history. The API enforces that half at the transition.
--
-- status is not null (001), so `status <> 'draft'` never evaluates to null and
-- the check cannot pass a row by accident through three-valued logic.
--
-- Guarded rather than written bare, in the same style as 001's enum creation,
-- so the file can be re-run. conrelid is part of the test because constraint
-- names are unique per table, not per database -- the name alone could match
-- another table's constraint.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_requests_submitted_at_matches_status'
      and conrelid = 'public.event_requests'::regclass
  ) then
    alter table event_requests
      add constraint event_requests_submitted_at_matches_status check (
        status <> 'draft'
        or submitted_at is null
      );
  end if;
end
$$;
