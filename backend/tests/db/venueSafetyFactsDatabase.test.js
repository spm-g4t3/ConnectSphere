/**
 * SCRUM-493: a venue's emergency access and known restrictions -- run
 * against a real Postgres.
 *
 * venues.emergency_access and known_restrictions are nullable text, 1 to
 * 2,000 characters, at least one non-whitespace character. create_venue and
 * update_venue take them, trim with the [[:space:]] class and store a blank
 * as NULL, "not recorded"; on update_venue a NULL parameter keeps the
 * current value and '' clears it. These tests call the real functions on the
 * final schema.
 *
 * Known, accepted limit (not tested as a failure): a direct SQL write of only
 * U+00A0 (non-breaking space) is stored, because [[:space:]] does not match
 * it in PGlite. The API path trims it first (String.prototype.trim), see
 * venueValidation.test.js.
 *
 * Dates: update_venue's re-check uses now() for "not started", so D is the
 * Singapore date 10 days from when the test runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedBooking, seedEvent, seedUser, seedVenue } from './helpers/schemaDb.js';
import { expectSqlError, queriesFor } from './helpers/queries.js';
import { at } from '../fixtures/time.js';

const EXITS = 'Two exits on Level 2 (east and west stairs); assemble at the SCIS lawn.';
const RESTRICTIONS = 'No rigging from the ceiling. Amplified sound ends at 22:00.';
const DOOR = '\u{1F6AA}';

describe('SCRUM-493: emergency access and known restrictions', () => {
  let db;
  let organiser;
  let staff;
  let otherStaff;
  let counter = 0;

  const { one, rows } = queriesFor(() => db);

  const makeUser = (role) => seedUser(db, { email: `u${++counter}@x`, role });

  /** A venue inserted directly, not through create_venue. */
  const makeVenue = (setup = 0, turnaround = 0) =>
    seedVenue(db, { name: `Harbour Room ${++counter}`, setup, turnaround });

  /** create_venue with named arguments; returns the new id. */
  async function createVenue(args = {}, userId = staff) {
    counter += 1;
    const all = { name: `Seminar Room ${counter}`, location: 'Level 2, SCIS', max_capacity: 40, ...args };
    const names = Object.keys(all);
    const sql = `select create_venue(${names.map((n, i) => `p_${n} => $${i + 1}`).join(', ')}, ` +
      `p_user_id => $${names.length + 1}) as id`;
    return (await one(sql, [...Object.values(all), userId])).id;
  }

  /** update_venue with named arguments; returns its jsonb. */
  async function updateVenue(venueId, args = {}, userId = staff) {
    const names = Object.keys(args);
    const sql = `select update_venue(p_id => $1, ${names
      .map((n, i) => `p_${n} => $${i + 2}`)
      .join(', ')}${names.length ? ', ' : ''}p_user_id => $${names.length + 2}) as result`;
    return (await one(sql, [venueId, ...Object.values(args), userId])).result;
  }

  const venue = (id) => one('select * from venues where id = $1', [id]);
  const facts = (id) => one('select emergency_access, known_restrictions from venues where id = $1', [id]);
  const history = (id) =>
    rows('select * from venue_change_history where venue_id = $1 order by changed_at, id', [id]);

  /**
   * The history rows `step` adds. Diffed by id rather than sliced by order:
   * PGlite's now() can give two quick statements the same changed_at, and
   * the ids are random, so ordering alone is not reliable.
   */
  async function historyAddedBy(id, step) {
    const before = new Set((await history(id)).map((h) => h.id));
    await step();
    return (await history(id)).filter((h) => !before.has(h.id));
  }

  function makeEvent(coordinatorId) {
    counter += 1;
    return seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinatorId,
      event_name: `Event ${counter}`,
      proposed_start: at('10:00'),
      proposed_end: at('12:00'),
      expected_attendance: 150,
    });
  }

  async function makeBooking(venueId, startsAt, endsAt, coordinatorId) {
    const eventId = await makeEvent(coordinatorId);
    return seedBooking(db, { venueId, eventId, status: 'approved', start: startsAt, end: endsAt });
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await makeUser(null);
    staff = await makeUser('venue_staff');
    otherStaff = await makeUser('venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });


  describe('schema', () => {
    it('SCRUM493_AC1_both_columns_are_nullable_text_with_no_default', async () => {
      const columns = await rows(
        `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
          where table_name = 'venues' and column_name in ('emergency_access', 'known_restrictions')
          order by column_name`,
      );
      expect(columns).toEqual([
        { column_name: 'emergency_access', data_type: 'text', is_nullable: 'YES', column_default: null },
        { column_name: 'known_restrictions', data_type: 'text', is_nullable: 'YES', column_default: null },
      ]);
    });

    it('SCRUM493_AC1_pg_proc_shows_one_create_venue_and_one_update_venue', async () => {
      const procs = await rows(
        `select proname, pronargs, pg_get_function_identity_arguments(oid) as args
           from pg_proc where proname in ('create_venue', 'update_venue') order by proname`,
      );
      expect(procs.map((p) => [p.proname, p.pronargs])).toEqual([
        ['create_venue', 12],
        // SCRUM-575 added p_hours_flag_booking_ids after p_user_id.
        ['update_venue', 14],
      ]);
      for (const p of procs) {
        expect(p.args).toContain('p_emergency_access text, p_known_restrictions text, p_user_id uuid');
      }
    });
  });


  describe('create_venue', () => {
    it('SCRUM493_AC1_create_stores_both_fields_trimmed', async () => {
      const id = await createVenue({
        emergency_access: `  \n\t${EXITS}\r\n `,
        known_restrictions: `\t${RESTRICTIONS}  `,
      });
      expect(await facts(id)).toEqual({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });
    });

    it('SCRUM493_AC1_create_keeps_inner_line_breaks', async () => {
      const text = 'Exit A: east stairs.\n\nExit B: west stairs.';
      const id = await createVenue({ emergency_access: text });
      expect((await facts(id)).emergency_access).toBe(text);
    });

    it('SCRUM493_AC2_create_without_the_fields_stores_null', async () => {
      const id = await createVenue();
      expect(await facts(id)).toEqual({ emergency_access: null, known_restrictions: null });
    });

    it.each([
      ['empty', ''],
      ['spaces', '     '],
      ['tabs', '\t\t'],
      ['newlines', '\n\r\n'],
      ['a mix', ' \t\n\r\u000b\f '],
    ])('SCRUM493_AC2_create_with_whitespace_only_(%s)_stores_null', async (_label, blank) => {
      const id = await createVenue({ emergency_access: blank, known_restrictions: blank });
      expect(await facts(id)).toEqual({ emergency_access: null, known_restrictions: null });
    });

    it('SCRUM493_AC4_create_history_row_carries_the_starting_values', async () => {
      const id = await createVenue({ emergency_access: EXITS });
      const creation = (await history(id)).find((h) => Object.keys(h.old_values).length === 0
        && 'name' in h.new_values);
      expect(creation).toBeDefined();
      expect(creation.changed_by).toBe(staff);
      expect(creation.new_values.emergency_access).toBe(EXITS);
      expect(creation.new_values.known_restrictions).toBeNull();
    });
  });


  describe('the 2,000-character limit', () => {
    it.each([
      ['ASCII', 'x'],
      ['emoji', DOOR],
      ['CJK', '安'],
    ])('SCRUM493_AC1_2000_%s_characters_are_accepted', async (_label, ch) => {
      const text = ch.repeat(2000);
      const id = await createVenue({ emergency_access: text, known_restrictions: text });
      const stored = await one(
        'select char_length(emergency_access) as ea, char_length(known_restrictions) as kr from venues where id = $1',
        [id],
      );
      expect(stored).toEqual({ ea: 2000, kr: 2000 });

      // And through update_venue, and a direct write.
      const other = await makeVenue();
      await updateVenue(other, { emergency_access: text });
      expect((await facts(other)).emergency_access).toBe(text);
      await db.query('update venues set known_restrictions = $2 where id = $1', [other, text]);
      expect((await facts(other)).known_restrictions).toBe(text);
    });

    it.each([
      ['ASCII', 'x'],
      ['emoji', DOOR],
      ['CJK', '安'],
    ])('SCRUM493_AC1_2001_%s_characters_are_refused', async (_label, ch) => {
      const text = ch.repeat(2001);
      await expectSqlError(createVenue({ emergency_access: text }), '23514', 'venues_emergency_access_length');
      await expectSqlError(createVenue({ known_restrictions: text }), '23514', 'venues_known_restrictions_length');

      const id = await makeVenue();
      await expectSqlError(updateVenue(id, { emergency_access: text }), '23514', 'venues_emergency_access_length');
      await expectSqlError(updateVenue(id, { known_restrictions: text }), '23514', 'venues_known_restrictions_length');
      await expectSqlError(
        db.query('update venues set emergency_access = $2 where id = $1', [id, text]),
        '23514',
        'venues_emergency_access_length',
      );
      // Nothing was stored by any of the refusals.
      expect(await facts(id)).toEqual({ emergency_access: null, known_restrictions: null });
    });

    it('SCRUM493_AC1_the_limit_is_measured_after_the_trim', async () => {
      const text = 'x'.repeat(2000);
      const id = await createVenue({ emergency_access: `   ${text}\n\n` });
      expect((await facts(id)).emergency_access).toBe(text);
    });
  });


  describe('direct writes', () => {
    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['a tab', '\t'],
      ['newlines', '\n\n'],
      ['a mix', ' \t\r\n '],
    ])('SCRUM493_AC2_a_direct_blank_(%s)_write_is_refused', async (_label, blank) => {
      const id = await makeVenue();
      await expectSqlError(
        db.query('update venues set emergency_access = $2 where id = $1', [id, blank]),
        '23514',
        'venues_emergency_access_length',
      );
      await expectSqlError(
        db.query('update venues set known_restrictions = $2 where id = $1', [id, blank]),
        '23514',
        'venues_known_restrictions_length',
      );
      await expectSqlError(
        db.query(
          `insert into venues (name, location, max_capacity, emergency_access) values ('X', 'Y', 1, $1)`,
          [blank],
        ),
        '23514',
        'venues_emergency_access_length',
      );
    });

    it('SCRUM493_AC2_a_direct_write_with_text_and_surrounding_space_is_allowed', async () => {
      // The CHECK only refuses blank; trimming is the functions' job.
      const id = await makeVenue();
      await db.query('update venues set emergency_access = $2 where id = $1', [id, ' Exit A ']);
      expect((await facts(id)).emergency_access).toBe(' Exit A ');
    });

    it('SCRUM493_AC1_a_direct_nbsp_only_write_is_stored_known_limit', async () => {
      // Known, accepted limit, pinned as a PASSING test so a change in PGlite
      // or Postgres behaviour is noticed. U+00A0 (non-breaking space) is not
      // in [[:space:]], so the CHECK sees a non-whitespace character and a
      // direct SQL write of only U+00A0 is stored -- a "recorded" value that
      // shows blank. The API path cannot produce it: validation trims with
      // String.prototype.trim(), which does strip U+00A0, so the value reaches
      // the database as null. That is proved in
      // tests/validation/venueValidation.test.js ::
      // SCRUM493_AC1_%s_%s_trims_a_non_breaking_space.
      const nbsp = '  ';
      const id = await makeVenue();
      await db.query('update venues set emergency_access = $2 where id = $1', [id, nbsp]);
      await db.query('update venues set known_restrictions = $2 where id = $1', [id, nbsp]);

      const stored = await facts(id);
      expect(stored.emergency_access).toBe(nbsp);
      expect(stored.known_restrictions).toBe(nbsp);
    });
  });


  describe('update_venue', () => {
    it('SCRUM493_AC4_an_update_with_only_emergency_access_changes_nothing_else', async () => {
      const id = await createVenue({
        layouts: ['classroom', 'theatre'],
        facilities: ['projector'],
        setup_minutes: 15,
        turnaround_minutes: 30,
        known_restrictions: RESTRICTIONS,
      });
      const before = await venue(id);
      const layoutsBefore = await rows('select * from venue_room_layouts where venue_id = $1 order by 2', [id]);
      const facilitiesBefore = await rows('select * from venue_facilities where venue_id = $1 order by 2', [id]);

      const result = await updateVenue(id, { emergency_access: EXITS });

      const after = await venue(id);
      expect(after.emergency_access).toBe(EXITS);
      const strip = ({ emergency_access: _e, updated_at: _u, last_modified_by: _l, ...rest }) => rest;
      expect(strip(after)).toEqual(strip(before));
      expect(after.known_restrictions).toBe(RESTRICTIONS);
      expect(await rows('select * from venue_room_layouts where venue_id = $1 order by 2', [id])).toEqual(layoutsBefore);
      expect(await rows('select * from venue_facilities where venue_id = $1 order by 2', [id])).toEqual(facilitiesBefore);
      expect(result).toEqual({ flagged_bookings: [] });
    });

    it('SCRUM493_AC4_null_keeps_the_current_value', async () => {
      const id = await createVenue({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });

      // Left out entirely, and passed as NULL explicitly.
      await updateVenue(id, { name: 'Renamed Room' });
      await updateVenue(id, { emergency_access: null, known_restrictions: null });

      expect(await facts(id)).toEqual({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });
    });

    it.each([
      ['an empty string', ''],
      ['spaces', '   '],
      ['tabs and newlines', '\t\n\r\n'],
    ])('SCRUM493_AC4_%s_clears_the_value_to_null', async (_label, blank) => {
      const id = await createVenue({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });

      await updateVenue(id, { known_restrictions: blank });

      expect(await facts(id)).toEqual({ emergency_access: EXITS, known_restrictions: null });
    });

    it('SCRUM493_AC4_text_replaces_the_value_trimmed', async () => {
      const id = await createVenue({ emergency_access: EXITS });

      await updateVenue(id, { emergency_access: '  Exit C only.\n' });

      expect((await facts(id)).emergency_access).toBe('Exit C only.');
    });

    it('SCRUM493_AC4_a_missing_venue_is_still_refused', async () => {
      await expectSqlError(
        updateVenue('00000000-0000-4000-8000-000000000000', { emergency_access: EXITS }),
        'P0002',
      );
    });
  });


  describe('history (AC4)', () => {
    it('SCRUM493_AC4_one_history_row_per_change_with_the_user_and_old_and_new_values', async () => {
      const id = await createVenue({ known_restrictions: RESTRICTIONS });

      // 1. Record emergency access.
      const first = await historyAddedBy(id, () => updateVenue(id, { emergency_access: EXITS }, otherStaff));
      // 2. Change known restrictions.
      const second = await historyAddedBy(id, () =>
        updateVenue(id, { known_restrictions: 'No open flames.' }, staff));
      // 3. Clear emergency access.
      const third = await historyAddedBy(id, () => updateVenue(id, { emergency_access: '' }, otherStaff));

      for (const added of [first, second, third]) expect(added).toHaveLength(1);

      expect(first[0].changed_by).toBe(otherStaff);
      expect(first[0].old_values).toEqual({ emergency_access: null });
      expect(first[0].new_values).toEqual({ emergency_access: EXITS });

      expect(second[0].changed_by).toBe(staff);
      expect(second[0].old_values).toEqual({ known_restrictions: RESTRICTIONS });
      expect(second[0].new_values).toEqual({ known_restrictions: 'No open flames.' });

      expect(third[0].changed_by).toBe(otherStaff);
      expect(third[0].old_values).toEqual({ emergency_access: EXITS });
      expect(third[0].new_values).toEqual({ emergency_access: null });

      // Each row has its date and time.
      for (const [row] of [first, second, third]) {
        expect(row.changed_at).toBeInstanceOf(Date);
      }
    });

    it('SCRUM493_AC4_changing_both_fields_writes_one_row_naming_both', async () => {
      const id = await createVenue();

      const added = await historyAddedBy(id, () =>
        updateVenue(id, { emergency_access: EXITS, known_restrictions: RESTRICTIONS }));

      expect(added).toHaveLength(1);
      expect(added[0].old_values).toEqual({ emergency_access: null, known_restrictions: null });
      expect(added[0].new_values).toEqual({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });
    });

    it.each([
      ['the same text', EXITS],
      ['the same text with surrounding whitespace', `  ${EXITS}\n`],
    ])('SCRUM493_AC4_saving_%s_writes_no_history_row', async (_label, value) => {
      const id = await createVenue({ emergency_access: EXITS });
      const added = await historyAddedBy(id, () => updateVenue(id, { emergency_access: value }));

      expect(added).toEqual([]);
    });

    it('SCRUM493_AC4_clearing_an_already_empty_field_writes_no_history_row', async () => {
      const id = await createVenue();
      const added = await historyAddedBy(id, () => updateVenue(id, { known_restrictions: '' }));

      expect(added).toEqual([]);
    });
  });


  describe('retired venues (AC5)', () => {
    it('SCRUM493_AC5_a_retired_venue_keeps_both_values', async () => {
      const id = await createVenue({ emergency_access: EXITS, known_restrictions: RESTRICTIONS });

      const added = await historyAddedBy(id, () => db.query('select retire_venue($1, $2)', [id, staff]));

      const after = await venue(id);
      expect(after.retired_at).not.toBeNull();
      expect(after.emergency_access).toBe(EXITS);
      expect(after.known_restrictions).toBe(RESTRICTIONS);
      // The retirement's history row names retired_at only: neither field
      // was cleared.
      expect(added).toHaveLength(1);
      expect(Object.keys(added[0].new_values)).toEqual(['retired_at']);
    });
  });


  describe('bookings (AC6) and the setup-change re-check', () => {
    /** A 30/45 venue whose two approved bookings already clash under 30/45. */
    async function clashingVenue() {
      const V = await makeVenue(30, 45);
      const C1 = await makeUser('event_coordinator');
      const C2 = await makeUser('event_coordinator');
      // A [09:30, 12:45) and B [12:00, 14:45) overlap under 30/45.
      const A = await makeBooking(V, at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, at('12:30'), at('14:00'), C2);
      return { V, A, B };
    }

    const statuses = async (ids) =>
      (await rows('select status from bookings where id = any($1::uuid[]) order by id', [ids])).map((r) => r.status);
    const notifications = (ids) =>
      rows('select * from notifications where booking_id = any($1::uuid[])', [ids]);

    it('SCRUM493_AC6_a_text_only_edit_at_a_30_45_venue_flags_nothing_and_notifies_no_one', async () => {
      const { V, A, B } = await clashingVenue();
      const notificationsBefore = (await one('select count(*)::int as n from notifications')).n;

      const results = [
        await updateVenue(V, { emergency_access: EXITS }),
        await updateVenue(V, { known_restrictions: RESTRICTIONS }),
        await updateVenue(V, { emergency_access: '', known_restrictions: 'Changed.' }),
      ];

      for (const result of results) {
        expect(result).toEqual({ flagged_bookings: [] });
      }
      expect(await statuses([A, B])).toEqual(['approved', 'approved']);
      expect(await notifications([A, B])).toEqual([]);
      expect((await one('select count(*)::int as n from notifications')).n).toBe(notificationsBefore);
      const after = await venue(V);
      expect([after.setup_minutes, after.turnaround_minutes]).toEqual([30, 45]);
    });

    it('SCRUM493_AC6_a_text_edit_with_the_same_minutes_still_flags_nothing', async () => {
      // Passing the current minutes beside the text is not a change.
      const { V, A, B } = await clashingVenue();

      const result = await updateVenue(V, {
        emergency_access: EXITS,
        setup_minutes: 30,
        turnaround_minutes: 45,
      });

      expect(result).toEqual({ flagged_bookings: [] });
      expect(await statuses([A, B])).toEqual(['approved', 'approved']);
      expect(await notifications([A, B])).toEqual([]);
    });

    it('SCRUM493_AC6_a_minute_change_still_flags_new_clashes', async () => {
      // The setup-change re-check still runs: at 0/0 A and B are clear; at
      // 30/45 they clash, so both are flagged and each coordinator is notified -- even
      // when the same call also sets the safety text.
      const V = await makeVenue(0, 0);
      const C1 = await makeUser('event_coordinator');
      const C2 = await makeUser('event_coordinator');
      const A = await makeBooking(V, at('10:00'), at('12:00'), C1);
      const B = await makeBooking(V, at('12:30'), at('14:00'), C2);

      const result = await updateVenue(V, {
        setup_minutes: 30,
        turnaround_minutes: 45,
        emergency_access: EXITS,
      });

      expect(result.flagged_bookings.map((b) => b.booking_id).sort()).toEqual([A, B].sort());
      expect(await statuses([A, B])).toEqual(['flagged_for_review', 'flagged_for_review']);
      const sent = await notifications([A, B]);
      expect(sent.map((n) => n.recipient_id).sort()).toEqual([C1, C2].sort());
      expect(sent.every((n) => n.type === 'booking_flagged_setup_change')).toBe(true);
      expect((await facts(V)).emergency_access).toBe(EXITS);
    });

    it('SCRUM493_AC6_a_minute_change_still_leaves_old_clashes_alone', async () => {
      // The re-check's second rule holds too: bookings already clashing under
      // the old minutes are not flagged by a further change.
      const { V, A, B } = await clashingVenue();

      const result = await updateVenue(V, { setup_minutes: 60 });

      expect(result).toEqual({ flagged_bookings: [] });
      expect(await statuses([A, B])).toEqual(['approved', 'approved']);
    });
  });
});
