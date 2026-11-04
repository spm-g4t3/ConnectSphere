import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, expectSqlError } from './helpers/queries.js';
import { at } from '../fixtures/time.js';

// decide_event_request, place_venue_hold and process_venue_hold_reminders (032),
// against the final schema. Hold expiries are relative to now(), the clock the
// reminder job compares with.
describe('SCRUM-173: the organiser and the coordinator hear how a request is progressing', () => {
  let db;
  let organiser;
  let coordinator;
  let staff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  function makeEvent(status) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      reviewing_coordinator_id: coordinator,
      event_name: `Event ${counter}`,
      proposed_start: at('14:00'),
      proposed_end: at('16:00'),
      expected_attendance: 50,
    });
  }

  const makeVenue = () => seedVenue(db, { name: `Hall ${++counter}` });

  const decide = (id, decision, note, caller = coordinator) =>
    db.query('select decide_event_request($1, $2, $3, $4, now())', [id, decision, note, caller]);

  const placeHold = async (eventId, venueId, expiry = "now() + interval '2 hours'") =>
    (await one(`select place_venue_hold($1, $2, ${expiry}, $3) as r`, [eventId, venueId, staff])).r;

  /** A hold written directly, so its expiry and status need no function's checks. */
  async function insertHold(expiry, { status = 'active' } = {}) {
    const eventId = await makeEvent('approved');
    const venueId = await makeVenue();
    const released = status === 'released';
    return (
      await one(
        `insert into venue_holds (event_request_id, venue_id, placed_by, expires_at, status, released_at, released_by)
         values ($1, $2, $3, ${expiry}, $4, ${released ? 'now()' : 'null'}, $5) returning id`,
        [eventId, venueId, staff, status, released ? staff : null],
      )
    ).id;
  }

  const decisionNotices = (eventId) =>
    rows(
      `select recipient_id, type, event_request_id, payload
         from notifications
        where event_request_id = $1 and type in ('event_request_approved', 'event_request_rejected')`,
      [eventId],
    );

  const holdNotices = (holdId, type) =>
    rows('select recipient_id, payload from notifications where venue_hold_id = $1 and type = $2', [holdId, type]);

  const remindersWritten = async () =>
    (await one("select count(*)::int as n from notifications where type = 'venue_hold_expiring'")).n;

  const remind = async (lead) => (await one('select process_venue_hold_reminders($1) as n', [lead])).n;

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'o@x', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'c@x', role: 'event_coordinator' });
    staff = await seedUser(db, { email: 's@x', role: 'venue_staff' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  describe('the decision on an event request', () => {
    it('SCRUM173_AC7_approval_notifies_the_organiser', async () => {
      const id = await makeEvent('under_review');
      await decide(id, 'approved', null);

      const notices = await decisionNotices(id);
      expect(notices).toHaveLength(1);
      const [notice] = notices;
      expect(notice.type).toBe('event_request_approved');
      expect(notice.recipient_id).toBe(organiser);
      expect(notice.event_request_id).toBe(id);
      expect(notice.payload).toMatchObject({
        eventRequestId: id,
        eventName: expect.stringMatching(/^Event \d+$/),
        decidedById: coordinator,
        decidedAt: expect.any(String),
        reason: null,
      });
      expect(notices.some((n) => n.recipient_id === coordinator)).toBe(false);
    });

    it('SCRUM173_AC8_rejection_notifies_the_organiser_with_the_reason', async () => {
      const id = await makeEvent('under_review');
      await decide(id, 'rejected', '  No budget this term  ');

      const notices = await decisionNotices(id);
      expect(notices).toHaveLength(1);
      expect(notices[0].type).toBe('event_request_rejected');
      expect(notices[0].recipient_id).toBe(organiser);
      expect(notices[0].payload.reason).toBe('No budget this term');
    });

    it('SCRUM173_AC7_a_refused_decision_notifies_nobody', async () => {
      const id = await makeEvent('under_review');

      await expectSqlError(decide(id, 'rejected', '   '), '22023');
      await expectSqlError(decide(id, 'approved', null, staff), '42501');

      expect(await decisionNotices(id)).toHaveLength(0);
    });
  });

  describe('a tentative hold', () => {
    it('SCRUM173_AC11_placing_a_hold_notifies_the_assigned_coordinator', async () => {
      const eventId = await makeEvent('approved');
      const venueId = await makeVenue();
      const result = await placeHold(eventId, venueId);
      expect(result.outcome).toBe('placed');

      const notices = await holdNotices(result.hold.id, 'venue_hold_placed');
      expect(notices).toHaveLength(1);
      expect(notices[0].recipient_id).toBe(coordinator);
      expect(notices[0].payload).toMatchObject({
        eventRequestId: eventId,
        venueId,
        venueName: expect.stringMatching(/^Hall \d+$/),
        expiresAt: expect.any(String),
        placedById: staff,
      });
    });

    it('SCRUM173_AC11_a_hold_refused_for_a_clash_notifies_nobody', async () => {
      const venueId = await makeVenue();
      await placeHold(await makeEvent('approved'), venueId);
      const clashing = await makeEvent('approved');
      const before = (await one("select count(*)::int as n from notifications where type = 'venue_hold_placed'")).n;

      expect((await placeHold(clashing, venueId)).outcome).toBe('conflict');

      const after = (await one("select count(*)::int as n from notifications where type = 'venue_hold_placed'")).n;
      expect(after).toBe(before);
    });
  });

  describe('the reminder before a hold expires', () => {
    it('SCRUM173_AC11_a_hold_expiring_within_the_lead_time_is_reminded', async () => {
      const soon = await insertHold("now() + interval '2 hours'");
      const later = await insertHold("now() + interval '3 days'");
      const before = await remindersWritten();

      const written = await remind('24 hours');

      expect(written).toBe((await remindersWritten()) - before);
      const notices = await holdNotices(soon, 'venue_hold_expiring');
      expect(notices).toHaveLength(1);
      expect(notices[0].recipient_id).toBe(coordinator);
      expect(notices[0].payload).toMatchObject({ venueName: expect.any(String), expiresAt: expect.any(String) });
      expect(await holdNotices(later, 'venue_hold_expiring')).toHaveLength(0);
    });

    it('SCRUM173_AC11_each_hold_is_reminded_once', async () => {
      const hold = await insertHold("now() + interval '2 hours'");
      await remind('24 hours');

      expect(await remind('24 hours')).toBe(0);
      expect(await holdNotices(hold, 'venue_hold_expiring')).toHaveLength(1);
    });

    it('SCRUM173_AC11_a_hold_no_longer_active_is_not_reminded', async () => {
      const released = await insertHold("now() + interval '2 hours'", { status: 'released' });
      await remind('24 hours');

      expect(await holdNotices(released, 'venue_hold_expiring')).toHaveLength(0);
    });

    it('SCRUM173_AC11_the_reminder_lead_time_must_be_zero_or_more', async () => {
      await expectSqlError(db.query('select process_venue_hold_reminders(null)'), '22023');
      await expectSqlError(db.query("select process_venue_hold_reminders('-1 hour')"), '22023');
    });
  });

  it('SCRUM173_AC7_AC11_notices_must_name_what_they_are_about', async () => {
    await expectSqlError(
      db.query("insert into notifications (recipient_id, type, payload) values ($1, 'event_request_rejected', '{}')", [organiser]),
      '23514',
      'notifications_event_decision_needs_event',
    );
    await expectSqlError(
      db.query("insert into notifications (recipient_id, type, payload) values ($1, 'venue_hold_expiring', '{}')", [coordinator]),
      '23514',
      'notifications_hold_notice_needs_hold',
    );
  });
});
