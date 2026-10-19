import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const registrationMigration = readFileSync(
  resolve(here, '../../db/migrations/091_event_registration_hardening.sql'),
  'utf8',
);
const migration = readFileSync(
  resolve(here, '../../db/migrations/096_significant_event_change.sql'),
  'utf8',
);
const equipmentNotificationsMigration = readFileSync(
  resolve(here, '../../db/migrations/097_equipment_notifications.sql'),
  'utf8',
);
const START = '2040-12-01T10:00:00Z';
const END = '2040-12-01T12:00:00Z';

describe('SCRUM-395 significant event change database transaction', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let attendeeOne;
  let attendeeTwo;
  let venueStaff;
  let technicalStaff;
  let eventId;
  let safetyReviewEventId;
  let smallVenueId;
  let largeVenueId;
  let reservationId;

  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  async function user(email, role) {
    const { id } = await one('insert into auth.users(email) values ($1) returning id', [email]);
    await db.query('insert into profiles(id, role) values ($1, $2)', [id, role]);
    return id;
  }

  async function makeEvent(status = 'confirmed') {
    return (await one(
      `insert into event_requests
         (organiser_id, assigned_coordinator_id, event_name, purpose, status,
          proposed_start, proposed_end, expected_attendance, venue_requirements,
          accessibility_requirements)
       values ($1, $2, 'Tech Talk', 'Knowledge sharing', $3, $4, $5, 80,
               'Lecture space', 'Step-free access')
       returning id`,
      [organiser, coordinator, status, START, END],
    )).id;
  }

  async function makeBooking(forEvent, venueId) {
    return (await one(
      `insert into bookings(event_request_id, venue_id, status, starts_at, ends_at)
       values ($1, $2, 'approved', $3, $4) returning id`,
      [forEvent, venueId, START, END],
    )).id;
  }

  // Confirmed and safety-stage events cannot be inserted through the lifecycle
  // trigger, so seed them with it switched off.
  async function makeEventOutsideLifecycle(status = 'confirmed') {
    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    try {
      return await makeEvent(status);
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
  }

  async function applyChange(forEvent, changes, reason, expectedImpact = null) {
    return (await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4, $5::jsonb) as result`,
      [forEvent, JSON.stringify(changes), reason, coordinator,
        expectedImpact && JSON.stringify(expectedImpact)],
    )).result;
  }

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      set time zone 'UTC';
      create schema auth;
      create role anon;
      create role authenticated;
      create role service_role;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create type event_request_status as enum (
        'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
        'confirmed', 'completed', 'rejected', 'cancelled', 'safety_review', 'safety_approved'
      );
      create type booking_status as enum (
        'approved', 'flagged_for_review', 'cancelled', 'pending', 'conflicting'
      );
      create table profiles (id uuid primary key, role text not null);
      create table event_requests (
        id uuid primary key default gen_random_uuid(),
        organiser_id uuid not null,
        assigned_coordinator_id uuid,
        event_name text not null,
        purpose text,
        status event_request_status not null,
        proposed_start timestamptz,
        proposed_end timestamptz,
        expected_attendance integer,
        venue_requirements text,
        accessibility_requirements text
      );
      create table event_request_status_history (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        previous_status event_request_status not null,
        new_status event_request_status not null,
        changed_by uuid not null,
        reason text,
        created_at timestamptz not null default now()
      );
      create function change_event_request_status(
        p_event_request_id uuid,
        p_expected_status event_request_status,
        p_new_status event_request_status,
        p_changed_by uuid,
        p_reason text default null,
        p_expected_coordinator uuid default null
      )
      returns event_requests
      language plpgsql
      as $$
      declare
        v_updated event_requests%rowtype;
      begin
        update event_requests
           set status = p_new_status
         where id = p_event_request_id and status = p_expected_status
         returning * into v_updated;
        if not found then
          raise exception 'stale event status';
        end if;
        insert into event_request_status_history
          (event_request_id, previous_status, new_status, changed_by, reason)
        values
          (p_event_request_id, p_expected_status, p_new_status, p_changed_by, p_reason);
        return v_updated;
      end;
      $$;
      create table venues (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        location text not null,
        max_capacity integer not null,
        setup_minutes integer not null default 0,
        turnaround_minutes integer not null default 0
      );
      create function venue_occupied_period(
        p_start timestamptz, p_end timestamptz, p_setup integer, p_turnaround integer
      )
      returns tstzrange
      language sql
      immutable
      as $$
        select tstzrange(
          p_start - make_interval(mins => coalesce(p_setup, 0)),
          p_end + make_interval(mins => coalesce(p_turnaround, 0)),
          '[)'
        )
      $$;
      create table bookings (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        venue_id uuid not null,
        status booking_status not null,
        starts_at timestamptz not null,
        ends_at timestamptz not null,
        review_block_id uuid,
        review_reason text,
        flagged_at timestamptz,
        flagged_by uuid,
        constraint bookings_review_reason_known
          check (review_reason in ('setup_or_turnaround_changed', 'safety_review', 'event_changed')),
        constraint bookings_review_flag_paired
          check ((flagged_at is null) = (review_block_id is null and review_reason is null))
      );
      create table equipment_types (id uuid primary key default gen_random_uuid(), name text not null);
      create table equipment_reservations (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        equipment_type_id uuid not null,
        quantity integer not null,
        start_at timestamptz not null,
        end_at timestamptz not null,
        released_at timestamptz,
        flagged boolean not null default false,
        flag_reason text
      );
      create table equipment_reservation_flag_calls (reason text not null, count integer not null);
      -- Just enough of the equipment schema for 097's triggers; the stub below
      -- writes the 'flagged' history row the way 061 does, which 097 watches.
      create table equipment_requests (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        status text not null default 'pending_review'
      );
      create table equipment_lines (
        id uuid primary key default gen_random_uuid(),
        equipment_request_id uuid not null,
        equipment_type_id uuid not null,
        quantity integer not null,
        technical_notes text,
        outcome text,
        removed_at timestamptz
      );
      create table equipment_reservation_events (
        id bigint generated always as identity primary key,
        equipment_reservation_id uuid not null,
        event_request_id uuid not null,
        equipment_line_id uuid,
        action text not null,
        reason text
      );
      create function equipment_line_reserved(p_line_id uuid)
      returns integer language sql stable as $$ select 0 $$;
      create function flag_equipment_reservations(p_reservation_ids uuid[], p_reason text)
      returns integer
      language plpgsql
      as $$
      declare
        v_count integer;
      begin
        with flagged as (
          update equipment_reservations
             set flagged = true, flag_reason = p_reason
           where id = any(p_reservation_ids) and released_at is null and not flagged
          returning id, event_request_id
        ), written as (
          insert into equipment_reservation_events
            (equipment_reservation_id, event_request_id, action, reason)
          select id, event_request_id, 'flagged', p_reason from flagged
          returning 1
        )
        select count(*) into v_count from flagged;
        insert into equipment_reservation_flag_calls(reason, count) values (p_reason, v_count);
        return v_count;
      end;
      $$;
      create table safety_review_submissions (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        created_at timestamptz not null default now()
      );
      create table safety_review_responses (
        id uuid primary key default gen_random_uuid(),
        event_request_id uuid not null,
        outcome text not null,
        created_at timestamptz not null default now()
      );
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null,
        type text not null,
        booking_id uuid,
        event_request_id uuid,
        payload jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('legacy_notification'))
      );
    `);
    await db.exec(registrationMigration);

    organiser = await user('organiser@test', 'event_organiser');
    coordinator = await user('coordinator@test', 'event_coordinator');
    otherCoordinator = await user('other@test', 'event_coordinator');
    attendeeOne = await user('attendee-1@test', 'attendee');
    attendeeTwo = await user('attendee-2@test', 'attendee');
    venueStaff = await user('venue-staff@test', 'venue_staff');
    technicalStaff = await user('technical-staff@test', 'technical_support_staff');
    smallVenueId = (await one(
      `insert into venues(name, location, max_capacity, setup_minutes, turnaround_minutes)
       values ('Small Hall', 'Block A', 50, 15, 30) returning id`,
    )).id;
    largeVenueId = (await one(
      `insert into venues(name, location, max_capacity, setup_minutes, turnaround_minutes)
       values ('Large Hall', 'Block B', 150, 5, 10) returning id`,
    )).id;

    eventId = await makeEvent();
    const smallBooking = await makeBooking(eventId, smallVenueId);
    const largeBooking = await makeBooking(eventId, largeVenueId);
    const equipmentTypeId = (await one(
      `insert into equipment_types(name) values ('Projector') returning id`,
    )).id;
    reservationId = (await one(
      `insert into equipment_reservations
         (event_request_id, equipment_type_id, quantity, start_at, end_at)
       values ($1, $2, 2, $3, $4) returning id`,
      [eventId, equipmentTypeId, START, END],
    )).id;
    await db.query(
      `insert into event_registrations(event_request_id, attendee_id)
       values ($1, $2), ($1, $3)`,
      [eventId, attendeeOne, attendeeTwo],
    );

    const legacyBlockBooking = await one(
      `insert into bookings
         (event_request_id, venue_id, status, starts_at, ends_at, review_block_id, flagged_at)
       values ($1, $2, 'flagged_for_review', $3, $4, $5, now()) returning id`,
      [eventId, smallVenueId, START, END, '11111111-1111-4111-8111-111111111111'],
    );
    const legacyEditBooking = await one(
      `insert into bookings
         (event_request_id, venue_id, status, starts_at, ends_at, review_reason, flagged_at)
       values ($1, $2, 'flagged_for_review', $3, $4, 'setup_or_turnaround_changed', now())
       returning id`,
      [eventId, largeVenueId, START, END],
    );
    const legacySafetyBooking = await one(
      `insert into bookings
         (event_request_id, venue_id, status, starts_at, ends_at, review_reason, flagged_at)
       values ($1, $2, 'flagged_for_review', $3, $4, 'safety_review', now())
       returning id`,
      [eventId, largeVenueId, START, END],
    );

    await db.exec(migration);
    await db.exec(readFileSync(resolve(here, '../../db/migrations/100_significant_change_confirmation_compatibility.sql'), 'utf8'));
    await db.exec(equipmentNotificationsMigration);
    await db.exec(`
      create function event_request_status_allows(
        p_from event_request_status, p_to event_request_status
      )
      returns boolean language sql immutable as $$ select true $$;
      create trigger test_event_safety_transitions
      before insert or update of status on event_requests
      for each row execute function enforce_event_safety_transitions();
      create trigger test_equipment_flag_on_period_change
      after update of proposed_start, proposed_end on event_requests
      for each row
      when (new.proposed_start is distinct from old.proposed_start
            or new.proposed_end is distinct from old.proposed_end)
      execute function equipment_flag_on_event_period_change();
    `);

    expect(await rows(
      'select id, flag_reason from bookings where id = any($1)',
      [[legacyBlockBooking.id, legacyEditBooking.id, legacySafetyBooking.id]],
    )).toEqual(expect.arrayContaining([
      { id: legacyBlockBooking.id, flag_reason: 'venue_block' },
      { id: legacyEditBooking.id, flag_reason: 'venue_edit' },
      { id: legacySafetyBooking.id, flag_reason: 'safety_review' },
    ]));

    await db.query('delete from bookings where id = any($1)', [
      [legacyBlockBooking.id, legacyEditBooking.id, legacySafetyBooking.id],
    ]);
    expect(await rows(
      'select id from bookings where id = any($1)',
      [[smallBooking, largeBooking]],
    )).toHaveLength(2);
  });

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM395_AC3_previews_each_booking_with_its_own_venue_occupied_period', async () => {
    const overCapacity = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ expectedAttendance: 120 })],
    );
    const impacted = overCapacity.impact.venueBookings;
    expect(impacted).toHaveLength(1);
    expect(impacted[0].venueName).toBe('Small Hall');

    const underCapacity = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ expectedAttendance: 40 })],
    );
    expect(underCapacity.impact.venueBookings).toEqual([]);

    const periodChange = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({
        proposedStart: '2040-12-02T10:00:00Z',
        proposedEnd: '2040-12-02T12:00:00Z',
      })],
    );
    expect(periodChange.impact.venueBookings).toHaveLength(2);
    const small = periodChange.impact.venueBookings.find((booking) => booking.venueName === 'Small Hall');
    expect(small.occupiedStartsAt).toBe('2040-12-02T09:45:00+00:00');
    expect(small.occupiedEndsAt).toBe('2040-12-02T12:30:00+00:00');
    expect(periodChange.impact.equipmentReservations).toHaveLength(1);
    expect(periodChange.impact.registeredAttendeesToNotify).toBe(2);

    const requirementsOnly = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ venueRequirements: 'A larger room' })],
    );
    expect(requirementsOnly.impact.venueBookings).toHaveLength(2);
    expect(requirementsOnly.impact.registeredAttendeesToNotify).toBe(0);

    const accessibilityOnly = await one(
      `select significant_event_change_impact($1, $2::jsonb) as impact`,
      [eventId, JSON.stringify({ accessibilityRequirements: 'Accessible seating' })],
    );
    expect(accessibilityOnly.impact.venueBookings).toHaveLength(2);
    expect(accessibilityOnly.impact.registeredAttendeesToNotify).toBe(0);
  });

  it('SCRUM395_AC1_requires_the_assigned_coordinator_and_an_allowed_status', async () => {
    await expect(db.query(
      `select preview_significant_event_change($1, $2::jsonb, $3)`,
      [eventId, JSON.stringify({ expectedAttendance: 90 }), otherCoordinator],
    )).rejects.toThrow(/assigned event coordinator/i);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [eventId, JSON.stringify({ expectedAttendance: 90 }), 'Not assigned', otherCoordinator],
    )).rejects.toThrow(/assigned event coordinator/i);

    const submittedId = await makeEvent('submitted');
    await expect(db.query(
      `select preview_significant_event_change($1, $2::jsonb, $3)`,
      [submittedId, JSON.stringify({ expectedAttendance: 90 }), coordinator],
    )).rejects.toThrow(/does not allow a significant change/i);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [submittedId, JSON.stringify({ expectedAttendance: 90 }), 'Wrong status', coordinator],
    )).rejects.toThrow(/does not allow a significant change/i);
  });

  it('SCRUM395_AC2_rejects_timestamps_without_a_utc_offset', async () => {
    await expect(db.query(
      `select significant_event_change_impact($1, $2::jsonb)`,
      [
        eventId,
        JSON.stringify({ proposedStart: '2040-12-02T10:00:00' }),
      ],
    )).rejects.toThrow(/ISO timestamp/i);
  });

  it('SCRUM395_AC4_applies_the_previewed_fields_flags_arrangements_and_records_history', async () => {
    const changes = {
      proposedStart: '2040-12-02T10:00:00Z',
      proposedEnd: '2040-12-02T12:00:00Z',
      expectedAttendance: 120,
      venueRequirements: 'A larger lecture space',
    };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [eventId, JSON.stringify(changes), coordinator],
    );
    const applied = await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4) as result`,
      [eventId, JSON.stringify(changes), 'Updated event needs', coordinator],
    );

    expect(applied.result.impact).toEqual(preview.impact);
    expect(applied.result.event.status).toBe('approved');
    expect(applied.result.event.proposed_start).toBe('2040-12-02T10:00:00+00:00');
    expect(applied.result.flaggedBookingIds).toHaveLength(2);
    expect(applied.result.flaggedReservationCount).toBe(1);
    expect(await one(
      'select count(*)::int as count from event_change_history where event_request_id = $1',
      [eventId],
    )).toEqual({ count: 4 });
    expect(await one(
      `select array_agg(field_name order by field_name) as fields
         from event_change_history where event_request_id = $1`,
      [eventId],
    )).toEqual({
      fields: ['expectedAttendance', 'proposedEnd', 'proposedStart', 'venueRequirements'],
    });
    expect(await one(
      'select flagged, flag_reason from equipment_reservations where id = $1',
      [reservationId],
    )).toEqual({ flagged: true, flag_reason: 'The event date or time changed' });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'event_significant_change_attendee'],
    )).toEqual({ count: 2 });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'event_significant_change'],
    )).toEqual({ count: 1 });
    expect(await one(
      'select count(*)::int as count from notifications where event_request_id = $1 and type = $2',
      [eventId, 'booking_flagged_event_change'],
    )).toEqual({ count: 2 });
    expect((await rows(
      `select recipient_id from notifications
        where event_request_id = $1 and type = 'booking_flagged_event_change'`,
      [eventId],
    )).every((notice) => notice.recipient_id === venueStaff)).toBe(true);
    expect(await one(
      'select reason from equipment_reservation_flag_calls order by ctid desc limit 1',
    )).toEqual({ reason: 'The event date or time changed' });
  });

  it('SCRUM395_AC5_refuses_to_apply_when_the_impact_changed_after_preview', async () => {
    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    let staleEventId;
    try {
      staleEventId = await makeEvent();
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
    const changes = { expectedAttendance: 120 };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [staleEventId, JSON.stringify(changes), coordinator],
    );
    await makeBooking(staleEventId, smallVenueId);

    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4, $5::jsonb)`,
      [
        staleEventId,
        JSON.stringify(changes),
        'More attendees expected',
        coordinator,
        JSON.stringify(preview.impact),
      ],
    )).rejects.toThrow(/impact changed/i);

    expect(await one(
      'select expected_attendance from event_requests where id = $1',
      [staleEventId],
    )).toEqual({ expected_attendance: 80 });
    expect(await one(
      `select count(*)::int as count from bookings
        where event_request_id = $1 and status = 'approved'`,
      [staleEventId],
    )).toEqual({ count: 1 });
    expect(await one(
      'select count(*)::int as count from event_change_history where event_request_id = $1',
      [staleEventId],
    )).toEqual({ count: 0 });
  });

  it('SCRUM395_AC6_reinstating_a_flagged_booking_clears_its_flag_reason', async () => {
    const flagged = await one(
      `select id from bookings
        where event_request_id = $1 and status = 'flagged_for_review'
        order by id limit 1`,
      [eventId],
    );
    await db.query(
      `update bookings
          set status = 'approved',
              flagged_at = null,
              flagged_by = null,
              review_block_id = null,
              review_reason = null
        where id = $1`,
      [flagged.id],
    );

    expect(await one(
      'select status, flag_reason from bookings where id = $1',
      [flagged.id],
    )).toEqual({ status: 'approved', flag_reason: null });
  });

  it('SCRUM395_AC4_closes_a_pending_safety_review_and_returns_safety_stages_to_approved', async () => {
    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    try {
      safetyReviewEventId = await makeEvent('safety_review');
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
    const submission = await one(
      'insert into safety_review_submissions(event_request_id) values ($1) returning id',
      [safetyReviewEventId],
    );
    await db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [
        safetyReviewEventId,
        JSON.stringify({ accessibilityRequirements: 'Step-free access throughout' }),
        'Accessibility update',
        coordinator,
      ],
    );
    expect(await one(
      'select status from event_requests where id = $1',
      [safetyReviewEventId],
    )).toEqual({ status: 'approved' });
    expect(await one(
      'select safety_review_submission_id, closed_by, reason from safety_review_closures where event_request_id = $1',
      [safetyReviewEventId],
    )).toEqual({
      safety_review_submission_id: submission.id,
      closed_by: coordinator,
      reason: 'Accessibility update',
    });

    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    let safetyApprovedEventId;
    try {
      safetyApprovedEventId = await makeEvent('safety_approved');
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
    await db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [
        safetyApprovedEventId,
        JSON.stringify({ accessibilityRequirements: 'Accessible seating required' }),
        'Accessibility update',
        coordinator,
      ],
    );
    expect(await one(
      'select status from event_requests where id = $1',
      [safetyApprovedEventId],
    )).toEqual({ status: 'approved' });
  });

  it('SCRUM395_AC8_records_an_equipment_change_without_editing_equipment_lines', async () => {
    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    let equipmentChangeEventId;
    try {
      equipmentChangeEventId = await makeEvent();
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
    const original = await one(
      'select expected_attendance from event_requests where id = $1',
      [equipmentChangeEventId],
    );

    const result = await one(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4) as result`,
      [equipmentChangeEventId, JSON.stringify({ equipmentChange: true }), 'Equipment changed', coordinator],
    );

    expect(result.result.event.status).toBe('approved');
    expect(result.result.impact.equipmentChangeRecorded).toBe(true);
    expect(await one(
      'select field_name, reason from event_change_history where event_request_id = $1',
      [equipmentChangeEventId],
    )).toEqual({ field_name: 'equipment', reason: 'Equipment changed' });
    expect(await one(
      'select expected_attendance from event_requests where id = $1',
      [equipmentChangeEventId],
    )).toEqual(original);
  });

  it('SCRUM395_AC5_rolls_everything_back_if_reservation_flagging_fails', async () => {
    await db.exec('alter table event_requests disable trigger test_event_safety_transitions');
    let rollbackEvent;
    try {
      rollbackEvent = await makeEvent();
    } finally {
      await db.exec('alter table event_requests enable trigger test_event_safety_transitions');
    }
    const before = await one('select * from event_requests where id = $1', [rollbackEvent]);
    const rollbackBookingId = await makeBooking(rollbackEvent, smallVenueId);
    await db.exec(`
      create or replace function flag_equipment_reservations(p_reservation_ids uuid[], p_reason text)
      returns integer language plpgsql as $$
      begin
        raise exception 'forced reservation failure';
      end;
      $$
    `);
    const equipmentTypeId = (await one(
      `insert into equipment_types(name) values ('Rollback projector') returning id`,
    )).id;
    const rollbackReservationId = (await one(
      `insert into equipment_reservations
         (event_request_id, equipment_type_id, quantity, start_at, end_at)
       values ($1, $2, 1, $3, $4) returning id`,
      [rollbackEvent, equipmentTypeId, START, END],
    )).id;

    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [
        rollbackEvent,
        JSON.stringify({
          proposedStart: '2040-12-03T10:00:00Z',
          proposedEnd: '2040-12-03T12:00:00Z',
        }),
        'Forced rollback',
        coordinator,
      ],
    )).rejects.toThrow(/forced reservation failure/);

    expect(await one('select * from event_requests where id = $1', [rollbackEvent])).toEqual(before);
    expect(await one(
      'select flagged from equipment_reservations where id = $1',
      [rollbackReservationId],
    )).toEqual({ flagged: false });
    expect(await one(
      'select status, flagged_at, flag_reason from bookings where id = $1',
      [rollbackBookingId],
    )).toEqual({ status: 'approved', flagged_at: null, flag_reason: null });
    expect(await one(
      'select count(*)::int as count from event_change_history where event_request_id = $1',
      [rollbackEvent],
    )).toEqual({ count: 0 });
    await db.exec(`
      create or replace function flag_equipment_reservations(p_reservation_ids uuid[], p_reason text)
      returns integer language plpgsql as $$
      declare v_count integer;
      begin
        with flagged as (
          update equipment_reservations
             set flagged = true, flag_reason = p_reason
           where id = any(p_reservation_ids) and released_at is null and not flagged
          returning id, event_request_id
        ), written as (
          insert into equipment_reservation_events
            (equipment_reservation_id, event_request_id, action, reason)
          select id, event_request_id, 'flagged', p_reason from flagged
          returning 1
        )
        select count(*) into v_count from flagged;
        insert into equipment_reservation_flag_calls(reason, count) values (p_reason, v_count);
        return v_count;
      end;
      $$
    `);
  });

  it('SCRUM395_AC2_rejects_a_blank_reason_without_saving_fields', async () => {
    const before = await one('select * from event_requests where id = $1', [eventId]);
    await expect(db.query(
      `select apply_significant_event_change($1, $2::jsonb, $3, $4)`,
      [eventId, JSON.stringify({ expectedAttendance: 121 }), '  ', coordinator],
    )).rejects.toThrow(/reason/i);
    expect(await one('select * from event_requests where id = $1', [eventId])).toEqual(before);
  });

  it('SCRUM395_AC4_keeps_a_venue_block_as_the_flag_reason_when_the_event_also_changes', async () => {
    const blockedEvent = await makeEventOutsideLifecycle();
    const bookingId = await makeBooking(blockedEvent, smallVenueId);
    const blockId = '22222222-2222-4222-8222-222222222222';
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_block_id = $2, flagged_at = now()
        where id = $1`,
      [bookingId, blockId],
    );

    await applyChange(blockedEvent, {
      proposedStart: '2040-12-04T10:00:00Z',
      proposedEnd: '2040-12-04T12:00:00Z',
    }, 'Moved by a day');

    expect(await one(
      'select status, flag_reason, review_block_id from bookings where id = $1',
      [bookingId],
    )).toEqual({ status: 'flagged_for_review', flag_reason: 'venue_block', review_block_id: blockId });
  });

  it('SCRUM395_AC4_labels_a_safety_review_flag_as_safety_review_and_keeps_it', async () => {
    const safetyFlaggedEvent = await makeEventOutsideLifecycle();
    const bookingId = await makeBooking(safetyFlaggedEvent, smallVenueId);
    await db.query(
      `update bookings
          set status = 'flagged_for_review', review_reason = 'safety_review', flagged_at = now()
        where id = $1`,
      [bookingId],
    );
    expect(await one('select flag_reason from bookings where id = $1', [bookingId]))
      .toEqual({ flag_reason: 'safety_review' });

    await applyChange(safetyFlaggedEvent, { expectedAttendance: 120 }, 'More attendees');

    expect(await one(
      'select status, review_reason, flag_reason from bookings where id = $1',
      [bookingId],
    )).toEqual({
      status: 'flagged_for_review',
      review_reason: 'safety_review',
      flag_reason: 'safety_review',
    });
  });

  it('SCRUM395_AC9_lists_pending_venue_requests_leaves_them_open_and_tells_venue_staff', async () => {
    const movedEvent = await makeEventOutsideLifecycle();
    const request = async (venueId, status) => (await one(
      `insert into bookings(event_request_id, venue_id, status, starts_at, ends_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [movedEvent, venueId, status, START, END],
    )).id;
    const pendingId = await request(smallVenueId, 'pending');
    const conflictingId = await request(largeVenueId, 'conflicting');

    const attendanceOnly = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [movedEvent, JSON.stringify({ expectedAttendance: 90 }), coordinator],
    );
    expect(attendanceOnly.impact.pendingBookingRequests).toEqual([]);

    const changes = { proposedStart: '2040-12-05T10:00:00Z', proposedEnd: '2040-12-05T12:00:00Z' };
    const preview = await one(
      `select preview_significant_event_change($1, $2::jsonb, $3) as impact`,
      [movedEvent, JSON.stringify(changes), coordinator],
    );
    expect(preview.impact.pendingBookingRequests).toEqual(expect.arrayContaining([
      {
        id: pendingId,
        venueName: 'Small Hall',
        startsAt: '2040-12-01T10:00:00+00:00',
        endsAt: '2040-12-01T12:00:00+00:00',
      },
      expect.objectContaining({ id: conflictingId, venueName: 'Large Hall' }),
    ]));
    expect(preview.impact.pendingBookingRequests).toHaveLength(2);
    expect(preview.impact.venueBookings).toEqual([]);

    const applied = await applyChange(movedEvent, changes, 'Speaker moved', preview.impact);

    expect(applied.impact).toEqual(preview.impact);
    expect(await rows(
      'select id, status, flagged_at from bookings where event_request_id = $1 order by status',
      [movedEvent],
    )).toEqual([
      { id: pendingId, status: 'pending', flagged_at: null },
      { id: conflictingId, status: 'conflicting', flagged_at: null },
    ]);
    const notices = await rows(
      `select recipient_id, booking_id, payload from notifications
        where event_request_id = $1 and type = 'booking_request_event_change'
        order by booking_id = $2 desc`,
      [movedEvent, pendingId],
    );
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.recipient_id === venueStaff)).toBe(true);
    expect(notices.map((notice) => notice.booking_id)).toEqual([pendingId, conflictingId]);
    expect(notices[0].payload).toEqual({
      eventRequestId: movedEvent,
      eventName: 'Tech Talk',
      venueName: 'Small Hall',
      startsAt: '2040-12-01T10:00:00+00:00',
      endsAt: '2040-12-01T12:00:00+00:00',
      newStartsAt: '2040-12-05T10:00:00+00:00',
      newEndsAt: '2040-12-05T12:00:00+00:00',
      reason: 'Speaker moved',
    });
  });

  it('SCRUM395_AC9_tells_technical_support_once_and_sends_the_coordinator_no_equipment_flag', async () => {
    const movedEvent = await makeEventOutsideLifecycle();
    const equipmentTypeId = (await one(
      `insert into equipment_types(name) values ('Microphone') returning id`,
    )).id;
    await db.query('insert into equipment_requests(event_request_id) values ($1)', [movedEvent]);
    const movedReservationId = (await one(
      `insert into equipment_reservations
         (event_request_id, equipment_type_id, quantity, start_at, end_at)
       values ($1, $2, 1, $3, $4) returning id`,
      [movedEvent, equipmentTypeId, START, END],
    )).id;

    await applyChange(movedEvent, {
      proposedStart: '2040-12-06T10:00:00Z',
      proposedEnd: '2040-12-06T12:00:00Z',
    }, 'Hall closed that day');

    const equipmentNotices = await rows(
      `select recipient_id, type, payload ->> 'change' as change from notifications
        where event_request_id = $1 and type like 'equipment%'`,
      [movedEvent],
    );
    expect(equipmentNotices.filter((notice) => notice.recipient_id === technicalStaff)).toEqual([
      { recipient_id: technicalStaff, type: 'equipment_request_changed', change: 'event_period' },
    ]);
    expect(equipmentNotices.filter((notice) => notice.recipient_id === coordinator)).toEqual([
      { recipient_id: coordinator, type: 'equipment_request_changed', change: 'event_period' },
    ]);
    expect(await one(
      'select flagged, flag_reason from equipment_reservations where id = $1',
      [movedReservationId],
    )).toEqual({ flagged: true, flag_reason: 'The event date or time changed' });
  });
});
