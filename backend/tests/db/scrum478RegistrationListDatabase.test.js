import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { clientsCanExecute } from './helpers/grants.js';
import { listEventRegistrations } from '../../src/services/registrationListService.js';

// list_event_registrations through the service, against the final schema.
describe('SCRUM-478: registration list in Postgres', () => {
  let db;
  let organiser;
  let otherOrganiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let attendees;
  let eventId;

  const client = {
    // As service_role, like the API: live Supabase refuses it auth.users, and
    // so does this schema, so a read of auth.users fails here too.
    rpc: async (name, args) => {
      expect(name).toBe('list_event_registrations');
      try {
        return await db.transaction(async (tx) => {
          await tx.query('set local role service_role');
          const { rows } = await tx.query(
            'select list_event_registrations($1::uuid, $2::uuid, $3::boolean) as result',
            [args.p_event_request_id, args.p_user_id, args.p_hide_withdrawn],
          );
          return { data: rows[0].result, error: null };
        });
      } catch (error) { return { data: null, error }; }
    },
    // What the admin API reads, from the same auth.users.
    auth: {
      admin: {
        listUsers: async ({ page, perPage }) => {
          const { rows } = await db.query(
            'select id, email from auth.users order by id limit $1 offset $2',
            [perPage, (page - 1) * perPage],
          );
          return { data: { users: rows }, error: null };
        },
      },
    },
  };
  const list = (userId, { event = eventId, hideWithdrawn } = {}) =>
    listEventRegistrations({ eventRequestId: event, userId, hideWithdrawn, client });

  const event = (status, overrides = {}) => seedEvent(db, {
    status,
    organiser_id: organiser,
    reviewing_coordinator_id: coordinator,
    event_name: `List ${status}`,
    purpose: 'Registration list test',
    expected_attendance: 50,
    proposed_start: '2030-01-01T12:00:00Z',
    proposed_end: '2030-01-01T14:00:00Z',
    // seedEvent leaves a cancelled event unassigned; these were cancelled after review.
    ...(status === 'cancelled' && { assigned_coordinator_id: coordinator }),
    ...overrides,
  });
  const register = (event, attendee, status, registeredAt, id = null) => db.query(
    `insert into event_registrations (id, event_request_id, attendee_id, status, registered_at)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5)`,
    [id, event, attendee, status, registeredAt],
  );

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser', fullName: 'Olive Organiser' });
    otherOrganiser = await seedUser(db, { email: 'other-organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });
    lead = await seedUser(db, { email: 'lead@test', role: 'event_coordinator_lead' });
    attendees = [];
    for (const [index, name] of ['Ada', 'Ben', 'Cy', 'Di'].entries()) {
      attendees.push(await seedUser(db, { email: `a${index}@test`, role: 'attendee', fullName: name }));
    }

    eventId = await event('confirmed', { registration_capacity: 10 });
    // Ben and Cy registered at the same instant, so the id decides their order.
    await register(eventId, attendees[0], 'withdrawn', '2029-12-01T09:00:00Z');
    await register(eventId, attendees[2], 'registered', '2029-12-01T10:00:00Z', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    await register(eventId, attendees[1], 'registered', '2029-12-01T10:00:00Z', '00000000-0000-4000-8000-000000000001');
    await register(eventId, attendees[3], 'registered', '2029-11-30T08:00:00Z');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM478_AC1_allows_the_assigned_coordinator_and_the_creating_organiser', async () => {
    expect((await list(coordinator)).entries).toHaveLength(4);
    expect((await list(organiser)).entries).toHaveLength(4);
  });

  it('SCRUM478_AC1_refuses_other_coordinators_the_lead_attendees_and_a_null_caller', async () => {
    for (const caller of [otherCoordinator, lead, attendees[1], null]) {
      await expect(list(caller)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('SCRUM478_AC1_answers_another_organiser_not_found_so_the_event_stays_hidden', async () => {
    await expect(list(otherOrganiser)).rejects.toMatchObject({ status: 404 });
  });

  it('SCRUM478_AC1_answers_not_found_for_an_unknown_event', async () => {
    await expect(list(organiser, { event: '99999999-9999-4999-8999-999999999999' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('SCRUM478_AC2_returns_every_field_for_each_entry', async () => {
    const { entries } = await list(organiser);
    const ada = entries.find((entry) => entry.attendeeName === 'Ada');
    expect(ada).toEqual({
      id: expect.any(String),
      attendeeName: 'Ada',
      attendeeEmail: 'a0@test',
      registeredAt: expect.any(String),
      status: 'withdrawn',
      statusLabel: 'Withdrawn',
    });
    // Postgres writes the session's offset, so compare the instant.
    expect(new Date(ada.registeredAt).toISOString()).toBe('2029-12-01T09:00:00.000Z');
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        ['attendeeEmail', 'attendeeName', 'id', 'registeredAt', 'status', 'statusLabel'],
      );
    }
  });

  it('SCRUM478_AC2_shows_registrations_on_a_cancelled_event_as_event_cancelled', async () => {
    const cancelled = await event('cancelled', {
      cancellation_reason: 'Called off', cancellation_initiator: 'organiser_request', cancelled_by: coordinator,
      cancelled_at: new Date(),
    });
    await register(cancelled, attendees[0], 'registered', '2029-12-01T09:00:00Z');
    await register(cancelled, attendees[1], 'withdrawn', '2029-12-01T10:00:00Z');
    await register(cancelled, attendees[2], 'cancelled', '2029-12-01T11:00:00Z');

    const result = await list(organiser, { event: cancelled });
    expect(result.entries.map((entry) => [entry.status, entry.statusLabel])).toEqual([
      ['cancelled', 'Event cancelled'],
      ['withdrawn', 'Withdrawn'],
      ['cancelled', 'Event cancelled'],
    ]);
    expect(result.counts.registered).toBe(0);
    // The list only reads: the stored rows keep their statuses.
    const { rows } = await db.query(
      'select status from event_registrations where event_request_id = $1 order by registered_at', [cancelled],
    );
    expect(rows.map((row) => row.status)).toEqual(['registered', 'withdrawn', 'cancelled']);
  });

  it('SCRUM478_AC3_counts_registered_against_capacity_or_alone', async () => {
    const withCapacity = await list(organiser);
    expect(withCapacity.counts).toEqual({ registered: 3, capacity: 10 });

    const noCapacity = await event('confirmed');
    await register(noCapacity, attendees[0], 'registered', '2029-12-01T09:00:00Z');
    expect((await list(organiser, { event: noCapacity })).counts).toEqual({ registered: 1, capacity: null });
  });

  it('SCRUM478_AC3_reports_no_waitlisted_count_while_there_is_no_waiting_list', async () => {
    expect(await list(organiser)).not.toHaveProperty('counts.waitlisted');
  });

  it('SCRUM478_AC4_hides_withdrawn_entries_without_changing_the_counts', async () => {
    const all = await list(organiser);
    const hidden = await list(organiser, { hideWithdrawn: 'true' });
    expect(all.entries.some((entry) => entry.status === 'withdrawn')).toBe(true);
    expect(hidden.entries.some((entry) => entry.status === 'withdrawn')).toBe(false);
    expect(hidden.entries).toHaveLength(3);
    expect(hidden.counts).toEqual(all.counts);
  });

  it('SCRUM478_AC4_orders_oldest_first_with_the_id_breaking_ties', async () => {
    const { entries } = await list(organiser);
    expect(entries.map((entry) => entry.attendeeName)).toEqual(['Di', 'Ada', 'Ben', 'Cy']);
  });

  it('SCRUM478_AC6_is_available_for_confirmed_completed_and_cancelled_events', async () => {
    const completed = await event('completed');
    const cancelled = await event('cancelled');
    for (const id of [eventId, completed, cancelled]) {
      await expect(list(coordinator, { event: id })).resolves.toHaveProperty('entries');
    }
  });

  it('SCRUM478_AC6_is_available_when_a_significant_change_returned_the_event_to_approved', async () => {
    const changed = await event('confirmed');
    await db.query(
      "select apply_significant_event_change($1, jsonb_build_object('proposedStart', $2::text), 'Start moved.', $3)",
      [changed, '2030-01-01T11:00:00Z', coordinator],
    );
    const { rows } = await db.query('select status from event_requests where id = $1', [changed]);
    expect(rows[0].status).toBe('approved');
    await expect(list(organiser, { event: changed })).resolves.toHaveProperty('event.status', 'approved');
  });

  it('SCRUM478_AC6_is_not_available_for_a_first_approval_or_any_other_status', async () => {
    const statuses = [
      'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
      'safety_review', 'safety_approved', 'rejected',
    ];
    for (const status of statuses) {
      const id = await event(status);
      await expect(list(organiser, { event: id })).rejects.toMatchObject({
        status: 409, code: 'REGISTRATION_LIST_NOT_AVAILABLE',
      });
    }

    // Sent back by the Safety Officer, never confirmed: still a first approval.
    const sentBack = await event('approved');
    await db.query(
      `insert into event_request_status_history (event_request_id, previous_status, new_status, changed_by)
       values ($1, 'safety_review', 'approved', $2)`,
      [sentBack, coordinator],
    );
    await expect(list(organiser, { event: sentBack })).rejects.toMatchObject({ status: 409 });
  });

  it('SCRUM478_AC5_is_callable_only_by_the_api', async () => {
    expect(await clientsCanExecute(db, 'list_event_registrations(uuid, uuid, boolean)')).toEqual([]);
  });
});
