import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

// SCRUM-402: the Organiser's change requests, submitted as groups and processed
// by the event's coordinator (035, 036), on the full schema. Statuses are
// reached through the real workflow functions; only Completed is seeded.
// Cases: docs/test-cases/SCRUM-402.md.
describe('SCRUM-402: change requests (035, 036)', () => {
  let db;
  let organiser;
  let otherOrganiser;
  let coordinator;
  let otherCoordinator;
  let lead;
  let safetyOfficer;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);
  const DAY = 24 * 60 * 60 * 1000;
  const at = (days) => new Date(Date.now() + days * DAY);

  const STORED = {
    event_name: 'Tech Talk',
    purpose: 'Industry networking',
    description: 'Talks and networking',
    expected_attendance: 100,
    venue_requirements: 'A large hall',
    accessibility_requirements: 'Step-free access',
    equipment_requirements: null,
  };

  // ---- reaching each status through the real functions ----

  async function submitted() {
    counter += 1;
    return seedEvent(db, {
      status: 'submitted', organiser_id: organiser, ...STORED,
      proposed_start: at(10), proposed_end: at(10.25),
    });
  }
  async function assigned() {
    const id = await submitted();
    await db.query("select assign_event_request($1, $2, $3, 'Yours')", [id, coordinator, lead]);
    return id;
  }
  async function underReview() {
    const id = await assigned();
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
  async function hall() {
    return seedVenue(db, { name: `Hall ${counter}-${Math.random()}`, capacity: 200, setup: 0, turnaround: 0 });
  }
  /** Approved, with one approved booking covering its period. */
  async function bookedApproved() {
    const id = await approved();
    await seedBooking(db, { venueId: await hall(), eventId: id, status: 'approved' });
    return id;
  }
  async function safetyReview() {
    const id = await bookedApproved();
    await db.query('select submit_event_for_safety_review($1, $2, null, true)', [id, coordinator]);
    return id;
  }
  async function safetyApproved() {
    const id = await safetyReview();
    await db.query("select respond_to_safety_review($1, $2, 'approved', null, '{}', false)", [id, safetyOfficer]);
    return id;
  }
  async function confirmed() {
    const id = await safetyApproved();
    const { revision } = await one('select updated_at::text as revision from event_requests where id = $1', [id]);
    await db.query('select confirm_event_request($1, $2, false, $3::timestamptz)', [id, coordinator, revision]);
    return id;
  }
  async function rejected() {
    const id = await underReview();
    await db.query("select decide_event_request($1, 'rejected', 'Not this term', $2, now())", [id, coordinator]);
    return id;
  }
  async function cancelled() {
    const id = await approved();
    await db.query("select cancel_event_request($1, $2, 'Called off', 'organiser_request')", [id, coordinator]);
    return id;
  }
  function completed() {
    counter += 1;
    return seedEvent(db, {
      status: 'completed', organiser_id: organiser, assigned_coordinator_id: coordinator,
      reviewing_coordinator_id: coordinator, ...STORED, proposed_start: at(-2), proposed_end: at(-1.9),
    });
  }
  const STATUS_OF = {
    under_review: underReview, pending_clarification: pendingClarification, approved,
    safety_review: safetyReview, safety_approved: safetyApproved, confirmed,
  };

  // ---- the functions under test ----

  const group = async (eventId, changes, by = organiser, note = null) => (await db.query(
    'select * from create_change_request_group($1, $2, $3::jsonb, $4)',
    [eventId, by, JSON.stringify(changes.map(([changeField, requestedChange]) => ({ changeField, requestedChange }))), note],
  )).rows;
  const groupId = async (eventId, changes) => (await group(eventId, changes))[0].id;

  const accept = (id, { by = coordinator, notes = null, impact = null } = {}) => db.query(
    "select * from process_change_request($1, 'approved', $2, $3, $4::jsonb)",
    [id, notes, by, impact === null ? null : JSON.stringify(impact)],
  );
  const decline = (id, notes, by = coordinator) => db.query(
    "select * from process_change_request($1, 'rejected', $2, $3)", [id, notes, by],
  );
  const preview = async (id, by = coordinator) =>
    (await one('select preview_change_request($1, $2) as p', [id, by])).p;

  const event = (id) => one('select * from event_requests where id = $1', [id]);
  const requests = (eventId) => rows(
    'select id, request_group_id, change_field::text as change_field, status::text as status, decision::text as decision, decision_notes, processed_by from event_change_requests where event_request_id = $1 order by created_at, id',
    [eventId],
  );
  const history = (eventId) => rows(
    'select field_name, old_value, new_value, reason, source, change_request_id, changed_by from event_change_history where event_request_id = $1 order by changed_at, field_name',
    [eventId],
  );
  const notices = (eventId, type) => rows(
    'select recipient_id, payload from notifications where event_request_id = $1 and type = $2', [eventId, type],
  );

  async function snapshot(eventId) {
    return {
      event: await event(eventId),
      requests: await requests(eventId),
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


  describe('AC1: one submission is one group', () => {
    it('SCRUM402_AC1_one_submission_is_one_group_of_rows_named_by_the_first', async () => {
      // AC1-01.
      const id = await approved();

      const created = await group(id, [['event_name', 'Tech Talk 2026'], ['proposed_start', at(11).toISOString()], ['venue', 'A tiered hall']]);

      expect(created.map((r) => r.change_field)).toEqual(['event_name', 'proposed_start', 'venue']);
      expect(new Set(created.map((r) => r.request_group_id))).toEqual(new Set([created[0].id]));
      expect(created.every((r) => r.status === 'outstanding')).toBe(true);
    });

    it.each([
      ['no_change', []],
      ['ten_changes', Array.from({ length: 10 }, (_, i) => ['other', `Note ${i}`])],
      ['a_field_twice', [['purpose', 'One'], ['purpose', 'Two']]],
      ['a_field_outside_the_vocabulary', [['venueRequirements', 'A hall']]],
      ['a_blank_value', [['purpose', '   ']]],
    ])('SCRUM402_AC1_a_group_with_%s_is_refused_with_22023', async (_label, changes) => {
      // AC1-02.
      const id = await approved();

      await expectRefused(id, () => group(id, changes), '22023');
    });

    it('SCRUM402_AC1_a_cancellation_must_be_alone_in_its_group', async () => {
      // AC1-03 (trap), D8.
      const id = await approved();

      await expectRefused(id, () => group(id, [['cancellation', 'We lost our speaker'], ['purpose', 'New']]), '22023');
      expect(await group(id, [['cancellation', 'We lost our speaker']])).toHaveLength(1);
    });

    it('SCRUM402_AC1_only_the_organiser_and_never_on_a_draft', async () => {
      // AC1-04: SCRUM-11's rule, kept as it was.
      const id = await approved();
      const draft = await seedEvent(db, { status: 'draft', organiser_id: organiser });

      await expectRefused(id, () => group(id, [['purpose', 'New']], otherOrganiser), '22023');
      await expectRefused(draft, () => group(draft, [['purpose', 'New']]), '22023');
      expect((await refusal(group('00000000-0000-4000-8000-000000000000', [['purpose', 'New']])))?.code).toBe('P0002');
    });

    it('SCRUM402_AC1_a_groups_note_is_stored_on_every_row_and_previewed', async () => {
      // AC1-08: one note for the submission, on each row, trimmed.
      const id = await approved();

      const created = await group(id, [['purpose', 'Alumni networking'], ['expected_attendance', '150']], organiser, '  Our sponsor asked for both  ');

      expect(created.map((r) => r.organiser_note)).toEqual(['Our sponsor asked for both', 'Our sponsor asked for both']);
      expect(created.map((r) => r.requested_change)).toEqual(['Alumni networking', '150']);
      expect((await preview(created[1].id)).organiserNote).toBe('Our sponsor asked for both');
    });

    it.each([
      ['no_note', null],
      ['a_blank_note', '   '],
    ])('SCRUM402_AC1_a_group_with_%s_stores_null', async (_label, note) => {
      // AC1-09.
      const id = await approved();

      const created = await group(id, [['purpose', 'New']], organiser, note);

      expect(created[0].organiser_note).toBeNull();
      expect((await preview(created[0].id)).organiserNote).toBeNull();
    });

    it('SCRUM402_AC1_a_note_over_2000_characters_is_refused_by_the_function_and_by_the_table', async () => {
      // AC1-10: the function says so in words; a direct insert meets the check.
      const id = await approved();

      await expectRefused(id, () => group(id, [['purpose', 'New']], organiser, 'x'.repeat(2001)), '22023');
      expect((await refusal(db.query(
        "insert into event_change_requests (event_request_id, requested_by, change_field, requested_change, organiser_note) values ($1, $2, 'purpose', 'New', $3)",
        [id, organiser, 'x'.repeat(2001)],
      )))?.code).toBe('23514');
      expect((await refusal(db.query(
        "insert into event_change_requests (event_request_id, requested_by, change_field, requested_change, organiser_note) values ($1, $2, 'purpose', 'New', '   ')",
        [id, organiser],
      )))?.code).toBe('23514');
      expect(await group(id, [['purpose', 'New']], organiser, 'y'.repeat(2000))).toHaveLength(1);
    });

    it('SCRUM402_AC1_a_row_written_as_before_036_is_its_own_group', async () => {
      // AC1-05 (trap): the trigger fills request_group_id.
      const id = await approved();
      const { id: row, request_group_id: g } = await one(
        "insert into event_change_requests (event_request_id, requested_by, change_field, requested_change) values ($1, $2, 'purpose', 'New') returning id, request_group_id",
        [id, organiser],
      );

      expect(g).toBe(row);
    });
  });


  describe('AC2: who may process, and in which status', () => {
    it.each([
      ['another_coordinator', () => otherCoordinator],
      ['the_Lead', () => lead],
      ['the_organiser', () => organiser],
      ['a_null_caller', () => null],
    ])('SCRUM402_AC2_%s_is_refused_with_42501', async (_label, who) => {
      // AC2-01.
      const id = await approved();
      const cr = await groupId(id, [['purpose', 'New']]);

      await expectRefused(id, () => accept(cr, { by: who() }), '42501');
      await expectRefused(id, () => preview(cr, who()), '42501');
    });

    it('SCRUM402_AC2_a_submitted_event_asks_for_its_review_to_be_started_first', async () => {
      // AC2-02 (trap).
      const id = await assigned();
      const cr = await groupId(id, [['purpose', 'New']]);

      await expectRefused(id, () => accept(cr), 'PT409', 'REVIEW_NOT_STARTED');
      await expectRefused(id, () => decline(cr, 'No'), 'PT409', 'REVIEW_NOT_STARTED');
      await expectRefused(id, () => preview(cr), 'PT409', 'REVIEW_NOT_STARTED');
    });

    it.each([
      ['rejected', rejected],
      ['cancelled', cancelled],
      ['completed', completed],
    ])('SCRUM402_AC2_an_event_that_is_%s_is_refused_naming_its_status', async (status, reach) => {
      // AC2-03.
      const id = await reach();
      const cr = await groupId(id, [['purpose', 'New']]);

      const err = await expectRefused(id, () => accept(cr), 'PT409', 'EVENT_STATUS_NOT_ALLOWED');
      expect(err.message).toContain(status);
      await expectRefused(id, () => preview(cr), 'PT409', 'EVENT_STATUS_NOT_ALLOWED');
    });

    it('SCRUM402_AC2_a_draft_is_refused_as_a_strangers_call', async () => {
      // AC2-04: reopened to a draft, it has no coordinator (015).
      const id = await rejected();
      const cr = await groupId(id, [['purpose', 'New']]);
      await db.query('select reopen_event_request($1, $2)', [id, organiser]);

      await expectRefused(id, () => accept(cr), '42501');
    });
  });


  describe('AC3: decline, as a whole', () => {
    it.each([
      ['no_reason', null],
      ['a_blank_reason', '   '],
      ['a_reason_over_2000_characters', 'x'.repeat(2001)],
    ])('SCRUM402_AC3_a_decline_with_%s_is_refused_and_the_group_stays_open', async (_label, notes) => {
      // AC3-01.
      const id = await approved();
      const cr = await groupId(id, [['purpose', 'New'], ['description', 'Newer']]);

      await expectRefused(id, () => decline(cr, notes), '22023');
    });

    it('SCRUM402_AC3_a_decline_records_the_reason_on_every_row_and_changes_nothing_else', async () => {
      // AC3-02.
      const id = await approved();
      const cr = await groupId(id, [['purpose', 'New'], ['description', 'Newer']]);
      const before = await event(id);

      await decline(cr, '  Not this term  ');

      expect((await requests(id)).map(({ status, decision, decision_notes, processed_by }) => ({ status, decision, decision_notes, processed_by })))
        .toEqual([1, 2].map(() => ({ status: 'processed', decision: 'rejected', decision_notes: 'Not this term', processed_by: coordinator })));
      expect(await event(id)).toEqual(before);
      expect(await history(id)).toEqual([]);
    });
  });


  describe('AC4: the preview', () => {
    it('SCRUM402_AC4_the_preview_classes_each_row_with_its_current_and_requested_values', async () => {
      // AC4-01.
      const id = await approved();
      // Still before the stored end, a quarter-day after the start.
      const start = at(10.1);
      const cr = await groupId(id, [['event_name', 'Tech Talk 2026'], ['proposed_start', start.toISOString()], ['venue', 'A tiered hall']]);
      const before = await snapshot(id);

      const p = await preview(cr);

      expect(p.rows.map((r) => [r.changeField, r.class, r.field, r.changed])).toEqual([
        ['event_name', 'ordinary', 'eventName', true],
        ['proposed_start', 'significant', 'proposedStart', true],
        ['venue', 'significant', 'venueRequirements', true],
      ]);
      expect(p.rows[0]).toMatchObject({ currentValue: 'Tech Talk', requestedValue: 'Tech Talk 2026' });
      expect(new Date(p.rows[1].requestedValue).getTime()).toBe(start.getTime());
      expect(p.rows[2]).toMatchObject({ currentValue: 'A large hall', requestedValue: 'A tiered hall' });
      expect(p).toMatchObject({ changeRequestId: cr, invalid: [], revertsEvent: false });
      expect(p.impact).toMatchObject({ statusBefore: 'approved', statusAfter: 'approved' });
      expect(await snapshot(id)).toEqual(before);
    });

    it('SCRUM402_AC4_a_confirmed_events_preview_says_it_reverts_with_395s_impact', async () => {
      // AC4-02.
      const id = await confirmed();
      const cr = await groupId(id, [['expected_attendance', '120']]);

      const p = await preview(cr);

      expect(p.revertsEvent).toBe(true);
      expect(p.impact).toMatchObject({ statusBefore: 'confirmed', statusAfter: 'approved', changedFields: ['expectedAttendance'] });
    });

    it('SCRUM402_AC4_the_preview_lists_each_invalid_value_by_field_and_shows_no_impact', async () => {
      // AC4-03.
      const id = await approved();
      const cr = await groupId(id, [['proposed_start', '2020-01-01T09:00:00Z'], ['expected_attendance', '0']]);
      const endFirst = await groupId(id, [['proposed_end', at(9).toISOString()]]);

      const p = await preview(cr);
      expect(p.invalid).toEqual(expect.arrayContaining([
        { field: 'expectedAttendance', message: 'must be a positive whole number' },
        { field: 'proposedStart', message: 'must be in the future' },
      ]));
      expect(p.impact).toBeNull();
      expect((await preview(endFirst)).invalid).toEqual([{ field: 'proposedEnd', message: 'must be later than the proposed start' }]);
    });

    it('SCRUM402_AC4_an_impact_that_changed_since_the_preview_refuses_the_accept', async () => {
      // AC4-04 (trap): 395's own check, the group left open.
      const id = await bookedApproved();
      const cr = await groupId(id, [['proposed_start', at(10.05).toISOString()]]);
      const { impact } = await preview(cr);
      await seedBooking(db, { venueId: await hall(), eventId: id, status: 'approved' });

      await expectRefused(id, () => accept(cr, { impact }), 'PT409', 'SIGNIFICANT_CHANGE_IMPACT_CHANGED');
    });
  });


  describe('AC5: accept applies by status', () => {
    it.each(['under_review', 'pending_clarification'])(
      'SCRUM402_AC5_while_%s_every_field_goes_through_387',
      async (status) => {
        // AC5-01.
        const id = await STATUS_OF[status]();
        const cr = await groupId(id, [['event_name', 'Tech Talk 2026'], ['expected_attendance', '150']]);

        await accept(cr);

        expect(await event(id)).toMatchObject({ event_name: 'Tech Talk 2026', expected_attendance: 150, status });
        expect((await history(id)).map((h) => h.field_name)).toEqual(['eventName', 'expectedAttendance'].sort());
      },
    );

    it.each(['approved', 'safety_review', 'safety_approved'])(
      'SCRUM402_AC5_while_%s_an_ordinary_field_is_applied_directly',
      async (status) => {
        // AC5-02.
        const id = await STATUS_OF[status]();
        const cr = await groupId(id, [['description', 'Talks, then networking']]);

        await accept(cr);

        expect(await event(id)).toMatchObject({ description: 'Talks, then networking', status });
      },
    );

    it.each(['approved', 'safety_review', 'safety_approved'])(
      'SCRUM402_AC5_while_%s_a_significant_field_goes_through_395_and_the_event_is_approved',
      async (status) => {
        // AC5-03.
        const id = status === 'approved' ? await bookedApproved() : await STATUS_OF[status]();
        const { proposed_start: start } = await event(id);
        const later = new Date(start.getTime() + 30 * 60000);
        const cr = await groupId(id, [['proposed_start', later.toISOString()]]);

        await accept(cr, { notes: 'Organiser asked to move it' });

        expect(await event(id)).toMatchObject({ status: 'approved', proposed_start: later });
        expect((await one("select count(*)::int as n from bookings where event_request_id = $1 and status = 'flagged_for_review'", [id])).n).toBe(1);
      },
    );

    it('SCRUM402_AC5_with_both_parts_395_goes_first_then_387', async () => {
      // AC5-04 (trap): on a Confirmed event 387 refuses even a name
      // (EVENT_CONFIRMED) until 395 has returned the event to Approved.
      const id = await confirmed();
      const cr = await groupId(id, [['event_name', 'Tech Talk 2026'], ['expected_attendance', '150']]);

      await accept(cr);

      expect(await event(id)).toMatchObject({ status: 'approved', event_name: 'Tech Talk 2026', expected_attendance: 150 });
    });

    it('SCRUM402_AC5_a_confirmed_event_with_ordinary_fields_only_returns_to_approved_first', async () => {
      // AC5-05 (trap), D7.
      const id = await confirmed();
      const cr = await groupId(id, [['purpose', 'Alumni networking']]);

      await accept(cr);

      expect(await event(id)).toMatchObject({ status: 'approved', purpose: 'Alumni networking' });
      expect(await one(
        "select previous_status::text as f, new_status::text as t from event_request_status_history where event_request_id = $1 order by created_at desc, id desc limit 1",
        [id],
      )).toEqual({ f: 'confirmed', t: 'approved' });
    });

    it('SCRUM402_AC5_a_confirmed_events_significant_field_goes_through_395', async () => {
      // AC5-06.
      const id = await confirmed();
      const cr = await groupId(id, [['expected_attendance', '120']]);

      await accept(cr);

      expect(await event(id)).toMatchObject({ status: 'approved', expected_attendance: 120 });
      expect(await notices(id, 'event_significant_change')).toHaveLength(1);
    });

    it('SCRUM402_AC5_a_venue_request_becomes_the_venue_requirements', async () => {
      // AC5-07, D6.
      const id = await approved();
      const cr = await groupId(id, [['venue', 'A tiered hall']]);

      await accept(cr);

      expect((await event(id)).venue_requirements).toBe('A tiered hall');
      expect((await history(id)).map((h) => h.field_name)).toEqual(['venueRequirements']);
    });

    it.each([
      ['an_end_before_the_stored_start', [['proposed_end', 'X']], 'proposedEnd'],
      ['a_past_start', [['proposed_start', '2020-01-01T09:00:00Z']], 'proposedStart'],
      ['attendance_zero', [['expected_attendance', '0']], 'expectedAttendance'],
    ])('SCRUM402_AC5_%s_is_refused_naming_the_field_and_the_group_stays_open', async (_label, changes, field) => {
      // AC5-08.
      const id = await approved();
      const resolved = changes.map(([f, v]) => [f, v === 'X' ? at(9).toISOString() : v]);
      const cr = await groupId(id, resolved);

      const err = await expectRefused(id, () => accept(cr), '22023');
      expect(err.message).toContain(field);
    });

    it('SCRUM402_AC5_a_value_equal_to_the_stored_one_is_dropped', async () => {
      // AC5-09 (trap): 387 refuses a save with no change, so nothing reaches it.
      const id = await approved();
      const same = await groupId(id, [['description', `  ${STORED.description}  `]]);
      const before = await event(id);

      await accept(same);

      expect(await event(id)).toEqual(before);
      expect(await history(id)).toEqual([]);
      expect((await requests(id))[0]).toMatchObject({ status: 'processed', decision: 'approved' });

      const mixed = await groupId(id, [['description', STORED.description], ['purpose', 'Alumni networking']]);
      await accept(mixed);
      expect((await history(id)).map((h) => h.field_name)).toEqual(['purpose']);
    });

    it('SCRUM402_AC5_387s_leftover_arrangement_refusal_propagates', async () => {
      // AC5-10 (trap): rejected with a booking, reopened, resubmitted, reviewed again.
      const id = await bookedApproved();
      await db.query("select change_event_request_status($1, 'approved', 'rejected', $2, 'Wrong term')", [id, coordinator]);
      await db.query('select reopen_event_request($1, $2)', [id, organiser]);
      await db.query('select submit_event_request($1, now(), $2)', [id, organiser]);
      await db.query("select assign_event_request($1, $2, $3, 'Back to you')", [id, coordinator, lead]);
      await db.query('select start_event_review($1, $2)', [id, coordinator]);
      const cr = await groupId(id, [['proposed_start', at(10.05).toISOString()]]);

      await expectRefused(id, () => accept(cr), 'PT409', 'EVENT_HOLDS_ARRANGEMENTS');
    });
  });


  describe('AC6: the history names the change request', () => {
    it('SCRUM402_AC6_387s_rows_are_labelled_change_request_and_linked', async () => {
      // AC6-01.
      const id = await underReview();
      const cr = await groupId(id, [['event_name', 'Tech Talk 2026']]);

      await accept(cr, { notes: 'As asked' });

      expect(await history(id)).toEqual([expect.objectContaining({
        field_name: 'eventName', source: 'change_request', change_request_id: cr, reason: 'As asked', changed_by: coordinator,
      })]);
    });

    it('SCRUM402_AC6_395s_rows_are_labelled_the_same_way_without_395_restated', async () => {
      // AC6-02, D3.
      const id = await approved();
      const cr = await groupId(id, [['expected_attendance', '150']]);

      await accept(cr);

      expect(await history(id)).toEqual([expect.objectContaining({
        field_name: 'expectedAttendance', source: 'change_request', change_request_id: cr,
        reason: 'Organiser change request accepted.',
      })]);
    });

    it('SCRUM402_AC6_a_direct_edit_after_a_change_request_in_one_transaction_is_its_own', async () => {
      // AC6-03 (trap): the settings are cleared before the function returns.
      const id = await underReview();
      const cr = await groupId(id, [['event_name', 'Tech Talk 2026']]);

      await db.query('begin');
      try {
        await accept(cr);
        await db.query(
          'select edit_event_request_details($1, $2, $3::jsonb, $4::jsonb, $5)',
          [id, coordinator, JSON.stringify({ purpose: 'Alumni networking' }), JSON.stringify({ purpose: STORED.purpose }), 'Direct fix'],
        );
        await db.query('commit');
      } catch (err) {
        await db.query('rollback');
        throw err;
      }

      expect((await history(id)).map((h) => [h.field_name, h.source, h.change_request_id])).toEqual([
        ['eventName', 'change_request', cr],
        ['purpose', 'direct_edit', null],
      ]);
    });

    it.each([
      ['a_change_request_row_without_a_link', "'change_request'", 'null'],
      ['a_link_on_another_source', "'direct_edit'", '$3'],
    ])('SCRUM402_AC6_%s_is_refused_by_the_check', async (_label, source, link) => {
      // AC6-04 (trap).
      const id = await approved();
      const cr = await groupId(id, [['purpose', 'New']]);

      const err = await refusal(db.query(
        `insert into event_change_history (event_request_id, changed_by, field_name, reason, source, change_request_id)
         values ($1, $2, 'purpose', 'Why', ${source}, ${link}::uuid)`,
        [id, coordinator, ...(link === '$3' ? [cr] : [])],
      ));
      expect(err?.code).toBe('23514');
    });
  });


  describe('AC7: a cancellation request', () => {
    it('SCRUM402_AC7_accepting_cancels_with_the_organisers_request_and_the_coordinators_reason', async () => {
      // AC7-01, AC7-02 (trap): marked accepted before the cancel closes the rest.
      const id = await approved();
      const other = await groupId(id, [['purpose', 'New']]);
      const cr = await groupId(id, [['cancellation', 'We lost our speaker']]);

      await accept(cr, { notes: '  Speaker withdrew  ' });

      expect(await event(id)).toMatchObject({
        status: 'cancelled', cancellation_initiator: 'organiser_request', cancellation_reason: 'Speaker withdrew', cancelled_by: coordinator,
      });
      const byId = Object.fromEntries((await requests(id)).map((r) => [r.id, r.decision]));
      expect(byId).toEqual({ [cr]: 'approved', [other]: 'event_cancelled' });
    });

    it('SCRUM402_AC7_a_cancellations_reason_is_prefilled_from_the_organisers_note', async () => {
      // AC7-04: the note, not the request's own text, when the Organiser gave one.
      const id = await approved();
      const [{ id: cr }] = await group(id, [['cancellation', 'Cancel the event']], organiser, 'We lost our speaker');

      expect((await preview(cr)).cancellationReason).toBe('We lost our speaker');
      await accept(cr);

      expect((await event(id)).cancellation_reason).toBe('We lost our speaker');
    });

    it('SCRUM402_AC7_with_no_note_and_no_reason_the_requests_own_text_is_the_cancellation_reason', async () => {
      // AC7-03.
      const id = await approved();
      const cr = await groupId(id, [['cancellation', 'We lost our speaker']]);

      await accept(cr);

      expect((await event(id)).cancellation_reason).toBe('We lost our speaker');
    });
  });


  describe('AC8: an equipment change', () => {
    it('SCRUM402_AC8_in_review_it_is_written_to_the_equipment_requirements', async () => {
      // AC8-01.
      const id = await underReview();
      const cr = await groupId(id, [['equipment', 'Two more microphones']]);

      await accept(cr);

      expect((await event(id)).equipment_requirements).toBe('Two more microphones');
    });

    it('SCRUM402_AC8_in_planning_395_records_it_for_the_equipment_lines', async () => {
      // AC8-02.
      const id = await approved();
      const cr = await groupId(id, [['equipment', 'Two more microphones']]);

      await accept(cr);

      expect(await event(id)).toMatchObject({ status: 'approved', equipment_requirements: null });
      expect(await history(id)).toEqual([expect.objectContaining({
        field_name: 'equipment', new_value: { changeRequested: true }, source: 'change_request', change_request_id: cr,
      })]);
    });

    it('SCRUM402_AC8_on_a_confirmed_event_it_returns_the_event_to_approved', async () => {
      // AC8-03.
      const id = await confirmed();
      const cr = await groupId(id, [['equipment', 'Two more microphones']]);

      await accept(cr);

      expect((await event(id)).status).toBe('approved');
    });
  });


  describe('AC9, AC10: something else, and once only', () => {
    it('SCRUM402_AC9_something_else_records_the_note_and_changes_no_field', async () => {
      // AC9-01.
      const id = await approved();
      const cr = await groupId(id, [['other', 'Can we have a photographer?']]);
      const before = await event(id);

      await accept(cr, { notes: 'Arranged with Media' });

      expect(await event(id)).toEqual(before);
      expect(await history(id)).toEqual([]);
      expect((await requests(id))[0]).toMatchObject({ status: 'processed', decision: 'approved', decision_notes: 'Arranged with Media' });
    });

    it('SCRUM402_AC10_a_group_is_processed_once_only', async () => {
      // AC10-01 (trap).
      const id = await approved();
      const cr = await groupId(id, [['purpose', 'Alumni networking'], ['description', 'Talks, then networking']]);
      await accept(cr);
      const second = (await requests(id))[1].id;

      await expectRefused(id, () => accept(cr), 'PT409', 'CHANGE_REQUEST_ALREADY_PROCESSED');
      await expectRefused(id, () => decline(second, 'Changed my mind'), 'PT409', 'CHANGE_REQUEST_ALREADY_PROCESSED');
      expect((await requests(id)).every((r) => r.processed_by === coordinator)).toBe(true);
      expect((await one('select count(*)::int as n from event_change_requests where request_group_id = $1 and processed_at is not null', [cr])).n).toBe(2);
    });
  });


  describe('AC11, AC12: notices', () => {
    it('SCRUM402_AC11_the_organiser_is_told_the_outcome_on_accept_and_on_decline', async () => {
      // AC11-01, D9.
      const id = await approved();
      const yes = await groupId(id, [['purpose', 'Alumni networking']]);
      const no = await groupId(id, [['description', 'Shorter']]);

      await accept(yes, { notes: 'Done' });
      await decline(no, 'Keep it as it is');

      const sent = await notices(id, 'change_request_decided');
      expect(sent.map((n) => [n.recipient_id, n.payload.changeRequestId, n.payload.decision, n.payload.notes, n.payload.changeFields])).toEqual([
        [organiser, yes, 'approved', 'Done', ['purpose']],
        [organiser, no, 'rejected', 'Keep it as it is', ['description']],
      ]);
    });

    it('SCRUM402_AC12_a_significant_request_tells_the_holder', async () => {
      // AC12-01.
      const id = await approved();

      const cr = await groupId(id, [['purpose', 'New'], ['proposed_start', at(11).toISOString()]]);

      expect(await notices(id, 'change_request_significant_submitted')).toEqual([{
        recipient_id: coordinator,
        payload: { eventRequestId: id, eventName: 'Tech Talk', changeRequestId: cr, changeFields: ['purpose', 'proposed_start'] },
      }]);
    });

    it('SCRUM402_AC12_an_ordinary_request_or_one_nobody_holds_tells_no_one', async () => {
      // AC12-02.
      const id = await approved();
      const unassigned = await submitted();

      await group(id, [['purpose', 'New']]);
      await group(unassigned, [['proposed_start', at(11).toISOString()]]);

      expect(await notices(id, 'change_request_significant_submitted')).toEqual([]);
      expect(await notices(unassigned, 'change_request_significant_submitted')).toEqual([]);
    });
  });


  describe('Schema', () => {
    it('SCRUM402_AC11_the_new_functions_stay_closed_to_the_client_roles', async () => {
      // SC-02.
      for (const fn of [
        'create_change_request_group(uuid, uuid, jsonb, text)',
        'preview_change_request(uuid, uuid)',
        'process_change_request(uuid, change_request_decision, text, uuid, jsonb)',
        'change_request_group_plan(uuid, event_requests)',
        'change_request_gate(uuid, uuid)',
        'change_request_targets()',
        'change_request_field_class(text)',
        'set_change_request_group()',
      ]) {
        expect(await clientsCanExecute(db, fn), fn).toEqual([]);
      }
    });

    it('SCRUM402_AC11_a_notification_type_added_elsewhere_survives_036_and_a_second_run_changes_nothing', async () => {
      // SC-01 (trap): another branch's type, added after 022 and before 036 runs.
      // A fresh database, so no notice of the two new types exists yet.
      const fresh = await createSchemaDb();
      const def = async () => (await fresh.query(
        "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_type_known'",
      )).rows[0].d;
      const types = (d) => [...d.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
      const live = types(await def()).filter((t) => !t.startsWith('change_request_'));
      await fresh.query('alter table notifications drop constraint notifications_type_known');
      await fresh.query(`alter table notifications add constraint notifications_type_known check (type = any (array[${
        [...live, 'added_on_another_branch'].map((t) => `'${t}'`).join(', ')}]))`);

      const sql036 = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/036_process_change_requests.sql'), 'utf8',
      );
      await fresh.exec(sql036);
      const once = await def();
      await fresh.exec(sql036);

      expect(types(once)).toEqual([...live, 'added_on_another_branch', 'change_request_decided', 'change_request_significant_submitted']);
      expect(await def()).toBe(once);
      await fresh.close();
    }, 120_000);
  });
});
