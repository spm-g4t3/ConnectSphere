import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';
import { DETAIL_FIELDS, ORDINARY_DETAIL_FIELDS, SIGNIFICANT_DETAIL_FIELDS } from '../../src/domain/eventDetailField.js';
import { getEventChangeHistory } from '../../src/services/eventRequestService.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';

// SCRUM-387: the assigned coordinator edits an event's information through
// edit_event_request_details (022), on the full schema. Statuses are reached
// through the real functions where they exist. Cases: docs/test-cases/SCRUM-387.md.
describe('SCRUM-387: edit_event_request_details (022)', () => {
  let db;
  let organiser;
  let otherOrganiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let safetyOfficer;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  // 17:00 Singapore, written as 09:00 UTC: the same instant two ways (D12).
  const START = '2026-12-01T09:00:00Z';
  const END = '2026-12-01T11:00:00Z';
  const STORED = {
    eventName: 'Tech Talk',
    purpose: 'Industry networking',
    description: 'Talks and networking',
    proposedStart: START,
    proposedEnd: END,
    expectedAttendance: 100,
    venueRequirements: 'A large hall',
    accessibilityRequirements: 'Step-free access',
    equipmentRequirements: 'Two microphones',
  };
  // A new value for every field, each valid sent alone against STORED: the new
  // start is still before the stored end.
  const NEW = {
    eventName: 'Tech Talk 2026',
    purpose: 'Industry and alumni networking',
    description: 'Talks, then networking',
    proposedStart: '2026-12-01T08:00:00Z',
    proposedEnd: '2026-12-02T12:00:00Z',
    expectedAttendance: 150,
    venueRequirements: 'A tiered hall',
    accessibilityRequirements: 'Hearing loop',
    equipmentRequirements: 'Three microphones',
  };

  const edit = (eventId, who, changes, { expected, reason = '  Organiser asked by email  ' } = {}) =>
    db.query(
      'select edit_event_request_details($1, $2, $3::jsonb, $4::jsonb, $5) as result',
      [eventId, who, JSON.stringify(changes), JSON.stringify(expected ?? expectedFor(changes)), reason],
    );
  // STORED, as the event_requests columns every seeded event starts with.
  const STORED_COLUMNS = {
    event_name: STORED.eventName,
    purpose: STORED.purpose,
    description: STORED.description,
    proposed_start: START,
    proposed_end: END,
    expected_attendance: STORED.expectedAttendance,
    venue_requirements: STORED.venueRequirements,
    accessibility_requirements: STORED.accessibilityRequirements,
    equipment_requirements: STORED.equipmentRequirements,
  };

  const expectedFor = (changes) => Object.fromEntries(Object.keys(changes).map((f) => [f, STORED[f]]));
  const editResult = async (...args) => (await edit(...args)).rows[0].result;

  const eventRow = (id) => one('select * from event_requests where id = $1', [id]);
  const history = (id) => rows(
    `select field_name, old_value, new_value, changed_by, reason, source, changed_at
       from event_change_history where event_request_id = $1 order by field_name`,
    [id],
  );
  const notices = (id, type = 'event_details_changed') =>
    rows('select recipient_id, payload from notifications where event_request_id = $1 and type = $2', [id, type]);

  /** Everything a refusal must leave as it was. */
  async function snapshot(eventId) {
    return {
      event: await eventRow(eventId),
      history: await history(eventId),
      notices: await rows('select id from notifications where event_request_id = $1 order by id', [eventId]),
    };
  }

  async function expectRefused(eventId, attempt, code, hint) {
    const before = await snapshot(eventId);
    const err = await refusal(attempt());
    expect(err?.code).toBe(code);
    if (hint) expect(err.hint).toBe(hint);
    expect(await snapshot(eventId)).toEqual(before);
    return err;
  }

  /** Submitted, then assigned by the Lead: an event waiting for its review. */
  async function submitted() {
    counter += 1;
    return seedEvent(db, {
      status: 'submitted',
      organiser_id: organiser,
      ...STORED_COLUMNS,
    });
  }

  async function underReview() {
    const id = await submitted();
    await db.query("select assign_event_request($1, $2, $3, 'Yours')", [id, coordinator, lead]);
    await db.query('select start_event_review($1, $2)', [id, coordinator]);
    return id;
  }

  async function pendingClarification() {
    const id = await underReview();
    await db.query(
      "select request_event_clarification_with_fields($1, $2, $2, 'Please confirm the purpose', null, array['purpose'])",
      [id, coordinator],
    );
    return id;
  }

  async function approved() {
    const id = await underReview();
    await db.query("select decide_event_request($1, 'approved', 'Looks good', $2, now())", [id, coordinator]);
    return id;
  }

  /**
   * A status no workflow function here reaches, seeded directly. A draft has no
   * coordinator: 015's reopen clears it, so every caller on a draft is a stranger.
   */
  function seeded(status) {
    counter += 1;
    return seedEvent(db, {
      status,
      organiser_id: organiser,
      ...STORED_COLUMNS,
      assigned_coordinator_id: status === 'draft' ? null : coordinator,
      ...(status === 'cancelled' && {
        cancellation_reason: 'Called off', cancellation_initiator: 'organiser_request', cancelled_by: coordinator, cancelled_at: new Date(),
      }),
    });
  }

  /**
   * SCRUM-355's path: approved with an arrangement, rejected, reopened by the
   * Organiser and resubmitted, then reviewed again. The arrangement is still held.
   */
  async function reopenedWith(arrange) {
    const id = await approved();
    await arrange(id);
    // decide_event_request decides only a request under review; a later rejection is a plain status change.
    await db.query("select change_event_request_status($1, 'approved', 'rejected', $2, 'Wrong term')", [id, coordinator]);
    await db.query('select reopen_event_request($1, $2)', [id, organiser]);
    await db.query('select submit_event_request($1, now(), $2)', [id, organiser]);
    await db.query("select assign_event_request($1, $2, $3, 'Back to you')", [id, coordinator, lead]);
    await db.query('select start_event_review($1, $2)', [id, coordinator]);
    expect((await eventRow(id)).status).toBe('under_review');
    return id;
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@test', role: 'event_organiser', fullName: 'Olive Organiser' });
    otherOrganiser = await seedUser(db, { email: 'other-organiser@test', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'coordinator@test', role: 'event_coordinator', fullName: 'Priya Nair' });
    otherCoordinator = await seedUser(db, { email: 'other-coordinator@test', role: 'event_coordinator' });
    lead = await seedUser(db, { email: 'lead@test', role: 'event_coordinator_lead' });
    safetyOfficer = await seedUser(db, { email: 'safety@test', role: 'safety_officer' });
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  describe('AC1: only the assigned coordinator', () => {
    it.each([
      ['another_coordinator', () => otherCoordinator],
      ['the_Lead', () => lead],
      ['the_organiser', () => organiser],
      ['another_organiser', () => otherOrganiser],
      ['a_null_caller', () => null],
    ])('SCRUM387_AC1_%s_is_refused_with_42501_and_nothing_changes', async (_label, who) => {
      // AC1-01 to AC1-04.
      const id = await underReview();

      await expectRefused(id, () => edit(id, who(), { eventName: NEW.eventName }), '42501');
    });

    it('SCRUM387_AC1_a_coordinator_reassigned_away_is_refused_with_42501', async () => {
      // AC1-05: the event was handed to another coordinator after review began.
      const id = await underReview();
      await db.query("select reassign_event_request($1, $2, $3, 'Over to you')", [id, otherCoordinator, coordinator]);

      await expectRefused(id, () => edit(id, coordinator, { eventName: NEW.eventName }), '42501');
      expect((await editResult(id, otherCoordinator, { eventName: NEW.eventName })).changedFields).toEqual(['eventName']);
    });

    it.each(['confirmed', 'draft'])(
      'SCRUM387_AC1_a_stranger_on_a_%s_event_gets_42501_not_a_status_message',
      async (status) => {
        // AC1-06 (trap): the caller is checked before the status.
        const id = await seeded(status);

        const err = await expectRefused(id, () => edit(id, otherCoordinator, { eventName: NEW.eventName }), '42501');

        expect(err.message).not.toMatch(/confirmed|draft/i);
      },
    );
  });


  describe('AC2: any field in review; not while old arrangements are held', () => {
    it.each(DETAIL_FIELDS)('SCRUM387_AC2_%s_is_editable_under_review', async (field) => {
      // AC2-01.
      const id = await underReview();

      const result = await editResult(id, coordinator, { [field]: NEW[field] });

      expect(result.changedFields).toEqual([field]);
    });

    it.each(DETAIL_FIELDS)('SCRUM387_AC2_%s_is_editable_pending_clarification', async (field) => {
      // AC2-02.
      const id = await pendingClarification();

      expect((await editResult(id, coordinator, { [field]: NEW[field] })).changedFields).toEqual([field]);
      expect((await eventRow(id)).status).toBe('pending_clarification');
    });

    it.each([
      ['a_leftover_booking', async (id) => {
        const venueId = await seedVenue(db, { name: `Kept hall ${counter}`, setup: 0, turnaround: 0 });
        await seedBooking(db, { venueId, eventId: id, status: 'approved' });
      }, '1 venue bookings'],
      ['a_leftover_hold', async (id) => {
        const venueId = await seedVenue(db, { name: `Held hall ${counter}`, setup: 0, turnaround: 0 });
        await db.query(
          "insert into venue_holds (event_request_id, venue_id, placed_by, expires_at) values ($1, $2, $3, now() + interval '2 days')",
          [id, venueId, coordinator],
        );
      }, '1 venue holds'],
    ])('SCRUM387_AC2_a_reopened_request_with_%s_refuses_a_significant_edit_and_names_it', async (_label, arrange, held) => {
      // AC2-03, AC2-04 (trap), D4.
      const id = await reopenedWith(arrange);

      const err = await expectRefused(
        id, () => edit(id, coordinator, { proposedStart: NEW.proposedStart }), 'PT409', 'EVENT_HOLDS_ARRANGEMENTS',
      );

      expect(err.message).toContain(held);
    });

    it('SCRUM387_AC2_a_reopened_request_still_takes_an_ordinary_edit', async () => {
      // AC2-05.
      const id = await reopenedWith(async (eventId) => {
        const venueId = await seedVenue(db, { name: `Ordinary hall ${counter}`, setup: 0, turnaround: 0 });
        await seedBooking(db, { venueId, eventId, status: 'approved' });
      });

      expect((await editResult(id, coordinator, { description: NEW.description })).changedFields).toEqual(['description']);
    });

    it('SCRUM387_AC2_a_period_change_in_review_flags_no_equipment_and_tells_no_one_else', async () => {
      // AC2-06 (trap): the period triggers in 06 find nothing to act on.
      const id = await underReview();

      await edit(id, coordinator, { proposedStart: NEW.proposedStart, proposedEnd: NEW.proposedEnd });

      expect(await rows('select id from equipment_reservations where event_request_id = $1', [id])).toEqual([]);
      expect((await rows('select type from notifications where event_request_id = $1', [id])).map((n) => n.type))
        .not.toContain('equipment_request_changed');
    });
  });


  describe('AC3: ordinary fields only in planning and the safety check', () => {
    const planning = {
      approved: () => approved(),
      safety_review: () => seeded('safety_review'),
      safety_approved: () => seeded('safety_approved'),
    };

    it.each(Object.keys(planning))('SCRUM387_AC3_an_ordinary_edit_is_allowed_while_%s', async (status) => {
      // AC3-01.
      const id = await planning[status]();

      const result = await editResult(id, coordinator, { eventName: NEW.eventName, purpose: NEW.purpose, description: NEW.description });

      expect(result.changedFields).toEqual(['description', 'eventName', 'purpose']);
      expect((await eventRow(id)).status).toBe(status);
    });

    it.each(Object.keys(planning))('SCRUM387_AC3_a_significant_edit_is_refused_while_%s', async (status) => {
      // AC3-02.
      const id = await planning[status]();

      const err = await expectRefused(
        id, () => edit(id, coordinator, { expectedAttendance: NEW.expectedAttendance }), 'PT409', 'SIGNIFICANT_CHANGE_REQUIRED',
      );

      expect(err.message).toContain('significant change process');
    });

    it('SCRUM387_AC3_a_mixed_save_in_planning_is_refused_whole', async () => {
      // AC3-03 (trap): the ordinary key is not written either.
      const id = await approved();

      await expectRefused(
        id, () => edit(id, coordinator, { eventName: NEW.eventName, venueRequirements: NEW.venueRequirements }),
        'PT409', 'SIGNIFICANT_CHANGE_REQUIRED',
      );
    });
  });


  describe('AC4, AC5: Confirmed and every other status', () => {
    it('SCRUM387_AC4_a_confirmed_event_refuses_even_an_ordinary_field', async () => {
      // AC4-01, D9.
      const id = await seeded('confirmed');

      const err = await expectRefused(id, () => edit(id, coordinator, { eventName: NEW.eventName }), 'PT409', 'EVENT_CONFIRMED');

      expect(err.message).toContain('significant change process');
      expect(err.message).toContain('Approved');
    });

    it.each(['submitted', 'rejected', 'cancelled', 'completed'])(
      'SCRUM387_AC5_an_event_that_is_%s_is_refused_naming_its_status',
      async (status) => {
        // AC5-01: submitted is assigned but not yet reviewed. A draft is AC1-06.
        const id = await seeded(status);

        const err = await expectRefused(id, () => edit(id, coordinator, { eventName: NEW.eventName }), 'PT409', 'EVENT_STATUS_NOT_ALLOWED');

        expect(err.message).toContain(status);
      },
    );
  });


  describe('AC6: the request itself', () => {
    it.each([
      ['a_missing_reason', null],
      ['a_blank_reason', '   '],
      ['a_reason_over_4000_characters', 'x'.repeat(4001)],
    ])('SCRUM387_AC6_%s_is_refused_with_22023', async (_label, reason) => {
      // AC6-05.
      const id = await underReview();

      await expectRefused(id, () => edit(id, coordinator, { eventName: NEW.eventName }, { reason }), '22023');
    });

    it.each([
      ['an_unknown_field', { venue: 'Hall B' }, { venue: null }],
      ['no_field_at_all', {}, {}],
      ['a_field_with_no_expected_value', { eventName: NEW.eventName }, {}],
    ])('SCRUM387_AC6_%s_is_refused_with_22023', async (_label, changes, expected) => {
      // AC6-04, AC6-07.
      const id = await underReview();

      await expectRefused(id, () => edit(id, coordinator, changes, { expected }), '22023');
    });

    it('SCRUM387_AC6_a_save_with_no_real_change_is_refused_with_22023', async () => {
      // AC6-03: every value equals the stored one, the start in another zone included.
      const id = await underReview();

      await expectRefused(
        id,
        () => edit(id, coordinator, { proposedStart: '2026-12-01T17:00:00+08:00', purpose: `  ${STORED.purpose}  ` }),
        '22023',
      );
    });

    it('SCRUM387_AC6_an_end_before_the_stored_start_is_refused_with_22023', async () => {
      // AC6-02: only the end is sent; the function checks it against the stored start.
      const id = await underReview();

      const err = await expectRefused(id, () => edit(id, coordinator, { proposedEnd: '2026-12-01T08:00:00Z' }), '22023');

      expect(err.message).toContain('proposedEnd');
    });
  });


  describe('AC7: the change history', () => {
    it('SCRUM387_AC7_one_row_per_changed_field_with_old_new_who_why_and_source', async () => {
      // AC7-01: description is sent unchanged and gets no row.
      const id = await underReview();

      await edit(id, coordinator, {
        purpose: NEW.purpose, expectedAttendance: NEW.expectedAttendance, description: STORED.description,
      });

      const entries = await history(id);
      expect(entries.map(({ changed_at, ...rest }) => rest)).toEqual([
        {
          field_name: 'expectedAttendance', old_value: 100, new_value: 150,
          changed_by: coordinator, reason: 'Organiser asked by email', source: 'direct_edit',
        },
        {
          field_name: 'purpose', old_value: STORED.purpose, new_value: NEW.purpose,
          changed_by: coordinator, reason: 'Organiser asked by email', source: 'direct_edit',
        },
      ]);
      expect(entries.every((e) => e.changed_at instanceof Date)).toBe(true);
    });

    it('SCRUM387_AC7_a_significant_changes_rows_are_still_written_as_significant_change', async () => {
      // AC7-02: 395's insert names no source, and the default fills it.
      const id = await approved();

      await db.query(
        "select apply_significant_event_change($1, $2::jsonb, 'The venue moved the date', $3)",
        [id, JSON.stringify({ proposedStart: NEW.proposedStart, proposedEnd: NEW.proposedEnd }), coordinator],
      );

      expect((await history(id)).map((e) => [e.field_name, e.source])).toEqual([
        ['proposedEnd', 'significant_change'],
        ['proposedStart', 'significant_change'],
      ]);
    });

    it('SCRUM387_AC7_one_saves_rows_always_come_back_in_field_name_order', async () => {
      // AC7-14: five rows share one changed_at; by uuid alone they would come
      // back in one of 120 orders. Read through the service, as the route does.
      const id = await underReview();
      const fields = ['venueRequirements', 'purpose', 'expectedAttendance', 'eventName', 'description'];
      await edit(id, coordinator, Object.fromEntries(fields.map((f) => [f, NEW[f]])));

      const entries = await getEventChangeHistory(id, organiser, 'event_organiser', { client: pgliteSupabaseClient(db) });

      expect(entries.map((e) => e.field)).toEqual([...fields].sort());
      expect(new Set(entries.map((e) => String(e.changedAt))).size).toBe(1);
      expect(entries[0].changedByName).toBe('Priya Nair');
    });

    it.each([
      ['updated', 'update event_change_history set reason = $2 where event_request_id = $1'],
      ['deleted', 'delete from event_change_history where event_request_id = $1 and $2::text is not null'],
    ])('SCRUM387_AC7_a_history_row_cannot_be_%s', async (_label, sql) => {
      // AC7-04, D13.
      const id = await underReview();
      await edit(id, coordinator, { eventName: NEW.eventName });
      const before = await history(id);

      expect((await refusal(db.query(sql, [id, 'Rewritten'])))?.code).toBe('42501');
      expect(await history(id)).toEqual(before);
    });

    it('SCRUM387_AC7_the_field_list_is_the_one_the_domain_module_names', async () => {
      // AC7-05, D2: every field the module names is accepted in one save, and
      // the module splits it the way the function does.
      const id = await underReview();

      const result = await editResult(id, coordinator, NEW);

      expect(result.changedFields).toEqual([...DETAIL_FIELDS].sort());
      expect([...ORDINARY_DETAIL_FIELDS, ...SIGNIFICANT_DETAIL_FIELDS]).toEqual(DETAIL_FIELDS);
      const planningId = await approved();
      for (const field of SIGNIFICANT_DETAIL_FIELDS) {
        expect((await refusal(edit(planningId, coordinator, { [field]: NEW[field] })))?.hint).toBe('SIGNIFICANT_CHANGE_REQUIRED');
      }
    });
  });


  describe('AC8: the Organiser is told', () => {
    it('SCRUM387_AC8_one_notice_to_the_organiser_per_save_with_the_fields_and_reason', async () => {
      // AC8-01, D8.
      const id = await underReview();

      await edit(id, coordinator, { eventName: NEW.eventName, purpose: NEW.purpose });

      expect(await notices(id)).toEqual([{
        recipient_id: organiser,
        payload: {
          eventRequestId: id,
          eventName: NEW.eventName,
          reason: 'Organiser asked by email',
          changedFields: ['eventName', 'purpose'],
          status: 'under_review',
        },
      }]);
    });

    it('SCRUM387_AC8_an_edit_in_safety_review_tells_no_safety_officer', async () => {
      // AC8-02, D10.
      const id = await seeded('safety_review');

      await edit(id, coordinator, { description: NEW.description });

      expect(await rows('select type from notifications where event_request_id = $1 and recipient_id = $2', [id, safetyOfficer])).toEqual([]);
      expect(await notices(id)).toHaveLength(1);
    });
  });


  describe('AC9: a value changed since the form opened', () => {
    it('SCRUM387_AC9_a_stale_value_is_refused_with_409_and_nothing_written', async () => {
      // AC9-01.
      const id = await underReview();

      const err = await expectRefused(
        id,
        () => edit(id, coordinator, { purpose: NEW.purpose }, { expected: { purpose: 'What the form showed earlier' } }),
        'PT409', 'EVENT_CHANGED_SINCE_OPENED',
      );

      expect(err.message).toContain('purpose');
    });

    it('SCRUM387_AC9_an_organisers_amendment_after_the_form_opened_makes_the_save_stale', async () => {
      // AC9-02 (trap): the Organiser's clarification reply writes the same fields.
      const id = await pendingClarification();
      const shown = (await eventRow(id)).purpose;
      await db.query(
        "select reply_to_event_clarification_with_amendments($1, $2, 'Here it is', $3::jsonb)",
        [id, organiser, JSON.stringify({ purpose: 'The Organiser\'s own words' })],
      );

      await expectRefused(
        id, () => edit(id, coordinator, { purpose: NEW.purpose }, { expected: { purpose: shown } }),
        'PT409', 'EVENT_CHANGED_SINCE_OPENED',
      );
      expect((await eventRow(id)).purpose).toBe('The Organiser\'s own words');
    });

    it('SCRUM387_AC9_the_same_instant_in_another_zone_is_not_stale', async () => {
      // AC9-03: compared typed, not as text.
      const id = await underReview();

      const result = await editResult(
        id, coordinator, { proposedStart: NEW.proposedStart }, { expected: { proposedStart: '2026-12-01T17:00:00.000+08:00' } },
      );

      expect(result.changedFields).toEqual(['proposedStart']);
    });
  });

  it('SCRUM387_AC1_the_functions_stay_closed_to_the_client_roles', async () => {
    // AC1-07: only Express, as the service role, reaches them.
    expect(await clientsCanExecute(db, 'edit_event_request_details(uuid, uuid, jsonb, jsonb, text)')).toEqual([]);
    expect(await clientsCanExecute(db, 'event_detail_value(text, jsonb)')).toEqual([]);
    expect(await clientsCanExecute(db, 'refuse_event_change_history_mutation()')).toEqual([]);
  });
});
