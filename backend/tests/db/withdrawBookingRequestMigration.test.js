/**
 * SCRUM-253: withdraw_booking_request, run against a real Postgres.
 *
 * Builds the final schema in an in-process Postgres (PGlite), so the guarded
 * status change, the refusals and the notifications are exercised, not read as
 * text. No server or credentials are needed, so this runs in CI.
 *
 * What PGlite is not: a second connection. It cannot show a withdrawal and an
 * approval blocking each other. A change that committed first is simulated by
 * setting the status before the call, which is exactly what the second
 * transaction sees after waiting on the row lock; the lock order and the guard
 * on the UPDATE are pinned from the function's source as Postgres holds it. True parallel coverage is
 * SCRUM-256's.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

const START = '2026-12-01T09:00:00+00:00';
const END = '2026-12-01T17:00:00+00:00';

describe('SCRUM-253: withdraw_booking_request in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let staffA;
  let staffB;
  let counter = 0;

  const { one } = queriesFor(() => db);
  const statusOf = async (id) => (await one('select status from bookings where id = $1', [id])).status;
  const withdrawnNotifications = async (bookingId) =>
    (
      await db.query(
        `select * from notifications where type = 'booking_request_withdrawn' and booking_id = $1 order by recipient_id`,
        [bookingId],
      )
    ).rows;
  const notificationCount = async () => (await one('select count(*)::int as n from notifications')).n;

  const makeUser = (email, role) => seedUser(db, { email, role });

  const makeVenue = () => seedVenue(db, { name: `Hall ${++counter}`, setup: 0, turnaround: 0 });

  function makeEvent(extra = {}) {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: `Event ${counter}`,
      proposed_start: START,
      proposed_end: END,
      expected_attendance: 150,
      assigned_coordinator_id: coordinator,
      ...extra,
    });
  }

  /** A booking placed at `status`, for an event and venue made here unless given. */
  async function makeBooking(status = 'pending', { eventId, venueId } = {}) {
    const event = eventId ?? (await makeEvent());
    const venue = venueId ?? (await makeVenue());
    return {
      id: await seedBooking(db, { venueId: venue, eventId: event, status, start: START, end: END, requestedBy: coordinator }),
      eventId: event,
      venueId: venue,
    };
  }

  const withdraw = async (bookingId, by = coordinator) =>
    (await one('select withdraw_booking_request($1, $2) as result', [bookingId, by])).result;

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser('o@x', 'event_organiser');
    coordinator = await makeUser('c1@x', 'event_coordinator');
    otherCoordinator = await makeUser('c2@x', 'event_coordinator');
    staffA = await makeUser('s1@x', 'venue_staff');
    staffB = await makeUser('s2@x', 'venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('withdrawing a pending request', () => {
    it('SCRUM253_sets_the_status_to_withdrawn_and_changes_nothing_else', async () => {
      const { id } = await makeBooking('pending');
      const before = await one('select * from bookings where id = $1', [id]);

      const result = await withdraw(id);

      expect(result.outcome).toBe('withdrawn');
      expect(result.booking.status).toBe('withdrawn');
      const after = await one('select * from bookings where id = $1', [id]);
      expect(after).toEqual({ ...before, status: 'withdrawn' });
    });

    it('SCRUM253_a_withdrawn_request_leaves_the_venue_staff_pending_list', async () => {
      const venueId = await makeVenue();
      const keep = await makeBooking('pending', { venueId });
      const gone = await makeBooking('pending', { venueId });
      const pendingIds = async () =>
        (await db.query(`select id from bookings where status = 'pending' and venue_id = $1 order by id`, [venueId])).rows.map(
          (r) => r.id,
        );
      expect(await pendingIds()).toEqual([keep.id, gone.id].sort());

      await withdraw(gone.id);

      expect(await pendingIds()).toEqual([keep.id]);
    });

    it('SCRUM253_the_event_can_raise_a_new_request_afterwards', async () => {
      const first = await makeBooking('pending');
      await withdraw(first.id);

      const result = (
        await one(
          `select create_booking_request($1, $2, $3, null, null, '{"suitable": true, "criteria": []}'::jsonb, false, 150, null) as result`,
          [first.eventId, await makeVenue(), coordinator],
        )
      ).result;

      expect(result.outcome).toBe('created');
    });

    it('SCRUM253_is_allowed_whatever_the_events_status_now_is', async () => {
      const { id } = await makeBooking('pending', { eventId: await makeEvent({ status: 'cancelled' }) });
      expect((await withdraw(id)).booking.status).toBe('withdrawn');
    });
  });

  describe('notifying Venue Staff', () => {
    it('SCRUM253_notifies_every_venue_staff_profile_and_nobody_else', async () => {
      const { id, eventId, venueId } = await makeBooking('pending');
      const eventName = (await one('select event_name from event_requests where id = $1', [eventId])).event_name;
      const venueName = (await one('select name from venues where id = $1', [venueId])).name;

      await withdraw(id);

      const rows = await withdrawnNotifications(id);
      expect(rows.map((r) => r.recipient_id).sort()).toEqual([staffA, staffB].sort());
      expect(rows[0]).toMatchObject({ type: 'booking_request_withdrawn', booking_id: id, block_id: null, read_at: null });
      expect(rows[0].payload).toMatchObject({ eventRequestId: eventId, eventName, venueId, venueName });
      expect(new Date(rows[0].payload.startsAt).toISOString()).toBe(new Date(START).toISOString());
      expect(new Date(rows[0].payload.endsAt).toISOString()).toBe(new Date(END).toISOString());
    });

    it('SCRUM253_does_not_notify_the_coordinator_or_the_organiser', async () => {
      const { id } = await makeBooking('pending');
      await withdraw(id);
      const recipients = (await withdrawnNotifications(id)).map((r) => r.recipient_id);
      expect(recipients).not.toContain(coordinator);
      expect(recipients).not.toContain(organiser);
    });

    it('SCRUM253_a_refused_withdrawal_notifies_nobody', async () => {
      const { id } = await makeBooking('pending');
      const before = await notificationCount();

      await refusal(withdraw(id, otherCoordinator));

      expect(await notificationCount()).toBe(before);
      expect(await statusOf(id)).toBe('pending');
    });

    it('SCRUM253_the_notification_type_check_accepts_the_new_type_and_still_refuses_others', async () => {
      const { id } = await makeBooking('pending');
      const insert = (type, bookingId) =>
        db.query('insert into notifications (recipient_id, type, booking_id) values ($1, $2, $3)', [
          staffA,
          type,
          bookingId,
        ]);

      await insert('booking_request_withdrawn', id);
      expect((await refusal(insert('something_else', id))).code).toBe('23514');
      expect((await refusal(insert('booking_request_withdrawn', null))).code).toBe('23514');
    });
  });

  describe('who may withdraw', () => {
    it('SCRUM253_refuses_a_coordinator_who_is_not_assigned_and_changes_nothing', async () => {
      const { id } = await makeBooking('pending');
      const err = await refusal(withdraw(id, otherCoordinator));
      expect(err.code).toBe('42501');
      expect(await statusOf(id)).toBe('pending');
    });

    it('SCRUM253_refuses_a_null_caller', async () => {
      const { id } = await makeBooking('pending');
      expect((await refusal(withdraw(id, null))).code).toBe('42501');
      expect(await statusOf(id)).toBe('pending');
    });

    it('SCRUM253_refuses_the_organiser_even_though_it_is_their_event', async () => {
      const { id } = await makeBooking('pending');
      expect((await refusal(withdraw(id, organiser))).code).toBe('42501');
    });

    it('SCRUM253_a_handover_that_committed_first_refuses_the_previous_coordinator', async () => {
      const { id, eventId } = await makeBooking('pending');
      await db.query('update event_requests set assigned_coordinator_id = $1 where id = $2', [otherCoordinator, eventId]);

      expect((await refusal(withdraw(id, coordinator))).code).toBe('42501');
      expect((await withdraw(id, otherCoordinator)).booking.status).toBe('withdrawn');
    });

    it('SCRUM253_reports_an_unknown_booking_as_not_found', async () => {
      const err = await refusal(withdraw('00000000-0000-4000-8000-000000000000'));
      expect(err.code).toBe('P0002');
    });

    it('SCRUM253_checks_the_caller_before_the_status', async () => {
      const { id } = await makeBooking('approved');
      expect((await refusal(withdraw(id, otherCoordinator))).code).toBe('42501');
    });
  });

  describe('only a pending request can be withdrawn', () => {
    it.each(['approved', 'rejected', 'withdrawn', 'cancelled', 'flagged_for_review'])(
      'SCRUM253_refuses_a_%s_request_and_leaves_it_as_it_was',
      async (status) => {
        const { id } = await makeBooking(status);
        const before = await one('select * from bookings where id = $1', [id]);
        const notifications = await notificationCount();

        const err = await refusal(withdraw(id));

        expect(err).toMatchObject({ code: 'PT409', hint: 'BOOKING_NOT_PENDING' });
        expect(err.message).toContain(status);
        expect(await one('select * from bookings where id = $1', [id])).toEqual(before);
        expect(await notificationCount()).toBe(notifications);
      },
    );

    it('SCRUM253_an_approval_that_committed_first_is_not_overwritten', async () => {
      const { id } = await makeBooking('pending');
      // What the second transaction sees once the approval has committed.
      await db.query(`update bookings set status = 'approved' where id = $1`, [id]);

      expect((await refusal(withdraw(id))).hint).toBe('BOOKING_NOT_PENDING');
      expect(await statusOf(id)).toBe('approved');
    });

    it('SCRUM253_a_repeated_withdrawal_is_refused_not_repeated', async () => {
      const { id } = await makeBooking('pending');
      await withdraw(id);
      const notifications = await notificationCount();

      const err = await refusal(withdraw(id));

      expect(err).toMatchObject({ code: 'PT409', hint: 'BOOKING_NOT_PENDING' });
      expect(err.message).toContain('withdrawn');
      expect(await statusOf(id)).toBe('withdrawn');
      // Venue Staff are told once, not once per attempt.
      expect(await withdrawnNotifications(id)).toHaveLength(2);
      expect(await notificationCount()).toBe(notifications);
    });
  });

  describe('SCRUM-256: a withdrawal and its notification succeed or fail together', () => {
    it('SCRUM256_a_failed_notification_rolls_the_withdrawal_back', async () => {
      const { id } = await makeBooking('pending');
      await db.exec(`
        create function pg_temp_refuse_notification() returns trigger language plpgsql as $$
        begin raise exception 'notifications are unavailable' using errcode = 'XX001'; end $$;
        create trigger refuse_notification before insert on notifications
          for each row execute function pg_temp_refuse_notification();
      `);

      try {
        const err = await refusal(withdraw(id));

        expect(err.code).toBe('XX001');
        // Neither half survived: still pending, and nobody was told.
        expect(await statusOf(id)).toBe('pending');
        expect(await withdrawnNotifications(id)).toHaveLength(0);
      } finally {
        await db.exec('drop trigger refuse_notification on notifications; drop function pg_temp_refuse_notification();');
      }

      // Once notifications work again the same request can be withdrawn.
      expect((await withdraw(id)).booking.status).toBe('withdrawn');
      expect(await withdrawnNotifications(id)).toHaveLength(2);
    });

    it('SCRUM256_a_withdrawal_with_no_venue_staff_still_succeeds_and_notifies_nobody', async () => {
      const { id } = await makeBooking('pending');
      await db.query(`update profiles set role = 'event_coordinator' where id = any ($1)`, [[staffA, staffB]]);

      try {
        expect((await withdraw(id)).booking.status).toBe('withdrawn');
        expect(await withdrawnNotifications(id)).toHaveLength(0);
      } finally {
        await db.query(`update profiles set role = 'venue_staff' where id = any ($1)`, [[staffA, staffB]]);
      }
    });
  });

  describe('the locking protocol and who may call', () => {
    // The function's source as Postgres holds it, comments dropped and spaces folded.
    let sql;
    beforeAll(async () => {
      const { prosrc } = await one("select prosrc from pg_proc where proname = 'withdraw_booking_request'");
      sql = prosrc.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
    });

    it('SCRUM253_locks_the_event_then_the_booking_for_update', () => {
      const event = sql.indexOf('from event_requests where id = v_event_id for update');
      const booking = sql.indexOf('from bookings where id = p_booking_id for update');
      expect(event).toBeGreaterThan(-1);
      expect(booking).toBeGreaterThan(event);
    });

    it('SCRUM253_the_update_can_only_move_a_pending_request', () => {
      // An open request: pending, or conflicting since SCRUM-492's decisions.
      expect(sql).toContain(
        "update bookings set status = 'withdrawn' where id = p_booking_id and status in ('pending', 'conflicting') returning * into v_booking",
      );
    });

    it('SCRUM253_checks_the_caller_before_reading_the_status', () => {
      expect(sql.indexOf('insufficient_privilege')).toBeGreaterThan(-1);
      expect(sql.indexOf('insufficient_privilege')).toBeLessThan(sql.indexOf("v_booking.status not in ('pending', 'conflicting')"));
    });

    it('SCRUM253_writes_the_notifications_after_the_status_change_in_the_same_function', () => {
      expect(sql.indexOf('insert into notifications')).toBeGreaterThan(sql.indexOf("set status = 'withdrawn'"));
    });

    it('SCRUM253_is_not_callable_by_the_publishable_roles', async () => {
      expect(await clientsCanExecute(db, 'withdraw_booking_request(uuid, uuid)')).toEqual([]);
    });
  });
});
