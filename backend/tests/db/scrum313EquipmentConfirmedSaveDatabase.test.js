/**
 * The confirmed save, against the final schema in a real Postgres (PGlite).
 *
 * apply_equipment_change is the one place a total change, damage, maintenance or a
 * retirement is saved. It locks the type, recalculates which reservations the
 * change affects (equipment_change_affected), refuses if that is not
 * exactly the list the staff member confirmed, and otherwise saves the change and
 * flags the affected reservations in the same transaction.
 *
 *   AC4  a confirmed change saves and flags together; their requests go back to
 *        Pending review; a forced failure changes nothing
 *   AC7  a change that affects nothing saves directly
 *   AC2  an unconfirmed or out-of-date confirmation writes nothing
 *   AC5  the coordinator of each affected event is told (the existing notice trigger)
 *   AC6  a Confirmed event stays Confirmed
 *   AC8  the change and each flag record the user, the time and the reason
 *
 * Reservations for the calculation are inserted directly with a chosen
 * created_at so "oldest" is set by the test. Reservations whose requests must go
 * back to Pending review are made through the real functions.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { reservationSteps, asJson, applyEquipmentChange } from './helpers/equipment.js';
import { clientsCanExecute } from './helpers/grants.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

const DAY = 86_400_000;
const BASE = Math.floor((Date.now() + 10 * DAY) / DAY) * DAY;
const hour = (h) => new Date(BASE + h * 3_600_000).toISOString();
const NOBODY = '00000000-0000-4000-8000-000000000001';

const NAMED = {
  total: 'p_total',
  damaged: 'p_damaged',
  underMaintenance: 'p_under_maintenance',
  retire: 'p_retire',
  fields: 'p_fields',
  note: 'p_note',
  confirmed: 'p_confirmed_reservation_ids',
};

describe('SCRUM-310 (SCRUM-313): the confirmed save', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;
  let seq = 0;

  const { one, rows } = queriesFor(() => db);
  const steps = reservationSteps(
    () => ({ db, organiser, coordinator, reviewerA }),
    { start: hour(1), end: hour(2), newStart: hour(3), newEnd: hour(4) },
  );
  const { newType, newEvent, add, reserve, requestStatus, reviewed, reservation } = steps;

  const newTypeNamed = (total = 10) => newType(`Projector ${++seq} ${Math.random()}`, total);

  /** One held reservation, inserted directly; `order` sets how old it is. */
  async function held(type, order, quantity, from, to, { flagged = false, flagCode = null, event: existing } = {}) {
    const event = existing ?? (await newEvent({ start: hour(from), end: hour(to) }));
    const line = (await add(event, type, quantity)).request.lines[0].id;
    const created = new Date(Date.UTC(2026, 0, 1, 0, order)).toISOString();
    const { id } = await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at,
          flagged, flag_code, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [type, event, line, quantity, hour(from), hour(to), flagged, flagged ? flagCode : null, created],
    );
    return { id, event };
  }

  /** The call with exactly the arguments given, by name as the API sends them. */
  async function raw(type, args = {}, caller = reviewerA) {
    const names = ['p_equipment_type_id', 'p_caller'];
    const values = [type, caller];
    for (const [key, name] of Object.entries(NAMED)) {
      if (!(key in args)) continue;
      names.push(name);
      values.push(key === 'fields' ? JSON.stringify(args[key]) : args[key]);
    }
    const casts = { p_fields: '::jsonb', p_confirmed_reservation_ids: '::uuid[]' };
    const list = names.map((n, i) => `${n} => $${i + 1}${casts[n] ?? ''}`).join(', ');
    return asJson(await one(`select apply_equipment_change(${list})::text as answer`, values));
  }

  const typeRow = (type) => one('select * from equipment_types where id = $1', [type]);

  /** Sets a scene up by plain updates without the backstop flagging as they happen. */
  async function withBackstopOff(work) {
    await db.exec('alter table equipment_types disable trigger equipment_types_flag_unconfirmed_loss');
    try {
      return await work();
    } finally {
      await db.exec('alter table equipment_types enable trigger equipment_types_flag_unconfirmed_loss');
    }
  }
  const historyOf = (type) =>
    rows(
      `select field_name, old_value, new_value, note, changed_by, changed_at
         from equipment_type_history where equipment_type_id = $1 and field_name <> 'created' order by id`,
      [type],
    );
  const flaggedState = async (ids) =>
    Object.fromEntries(
      (await rows('select id, flagged from equipment_reservations where id = any($1::uuid[])', [ids]))
        .map((r) => [r.id, r.flagged]),
    );
  const reservationRow = (id) => one('select * from equipment_reservations where id = $1', [id]);
  const flagEvents = (reservationId) =>
    rows(
      `select user_id, reason, created_at from equipment_reservation_events
        where equipment_reservation_id = $1 and action = 'flagged' order by id`,
      [reservationId],
    );
  const counts = async () => ({
    events: (await one('select count(*)::int as n from equipment_reservation_events')).n,
    history: (await one('select count(*)::int as n from equipment_type_history')).n,
    notices: (await one('select count(*)::int as n from notifications')).n,
    flagged: (await one('select count(*)::int as n from equipment_reservations where flagged')).n,
  });
  const ids = (list) => list.map((r) => r.reservation_id);

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
    coordinator = await seedUser(db, {
      email: 'coordinator@example.com', role: 'event_coordinator', fullName: 'Casey Coordinator',
    });
    reviewerA = await seedUser(db, { email: 'tech-a@example.com', role: 'technical_support_staff' });
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  describe('who may save, and what is refused outright', () => {
    it('SCRUM310_AC4_a_null_caller_is_refused_with_42501_and_nothing_changes', async () => {
      const type = await newTypeNamed();
      const before = await typeRow(type);
      expect((await refusal(raw(type, { total: 5, confirmed: [] }, null)))?.code).toBe('42501');
      expect(await typeRow(type)).toEqual(before);
    });

    it.each([
      'event_organiser', 'event_coordinator', 'event_coordinator_lead', 'venue_staff',
      'safety_officer', 'attendee', 'technical_support',
    ])('SCRUM310_AC4_a_%s_is_refused_with_42501_and_nothing_changes', async (role) => {
      const type = await newTypeNamed();
      const caller = await seedUser(db, { email: `${role}-${++seq}@example.com`, role });
      const before = await typeRow(type);
      const counted = await counts();

      expect((await refusal(raw(type, { total: 5, confirmed: [] }, caller)))?.code).toBe('42501');

      expect(await typeRow(type)).toEqual(before);
      expect(await counts()).toEqual(counted);
    });

    it.each([
      ['raising the total', { total: 20, confirmed: [] }],
      ['a name edit', { fields: { name: 'Sneaky rename' }, confirmed: [] }],
      ['fixing damaged units', { damaged: 0, note: 'Fixed', confirmed: [] }],
      ['a retirement of a type with no usable units', { retire: true, confirmed: [] }],
    ])('SCRUM310_AC4_a_coordinator_is_refused_%s_even_though_no_reservation_check_runs', async (_label, args) => {
      const type = await newTypeNamed(10);
      if (args.retire) await db.query('update equipment_types set damaged_quantity = 10 where id = $1', [type]);
      else if (args.damaged === 0) await db.query('update equipment_types set damaged_quantity = 2 where id = $1', [type]);
      const before = await typeRow(type);
      const counted = await counts();

      expect((await refusal(raw(type, args, coordinator)))?.code).toBe('42501');

      expect(await typeRow(type)).toEqual(before);
      expect(await counts()).toEqual(counted);
    });

    it('SCRUM310_AC4_a_caller_with_no_profile_or_a_made_up_one_is_refused_with_42501', async () => {
      const type = await newTypeNamed();
      const bare = await seedUser(db, { email: `bare-${++seq}@example.com` });
      expect((await refusal(raw(type, { total: 5, confirmed: [] }, bare)))?.code).toBe('42501');
      expect((await refusal(raw(type, { total: 5, confirmed: [] }, NOBODY)))?.code).toBe('42501');
    });

    it('SCRUM310_AC4_an_unknown_type_is_refused_with_P0002', async () => {
      const error = await refusal(raw('00000000-0000-4000-8000-000000000000', { total: 5 }));
      expect(error?.code).toBe('P0002');
    });

    it('SCRUM310_AC4_a_missing_type_id_is_refused_with_P0002', async () => {
      expect((await refusal(raw(null, { total: 5 })))?.code).toBe('P0002');
    });

    it('SCRUM310_AC4_the_client_roles_cannot_execute_the_new_functions_and_service_role_can', async () => {
      const roles = ['anon', 'authenticated', 'service_role'];
      for (const fn of [
        'apply_equipment_change(uuid, uuid, integer, integer, integer, boolean, jsonb, text, uuid[])',
        'flag_equipment_reservations_by(uuid[], text, uuid, text)',
        'flag_equipment_reservations(uuid[], text)',
      ]) {
        expect(await clientsCanExecute(db, fn, roles), fn).toEqual(['service_role']);
      }
    });
  });

  describe('bad input is refused with 22023 and nothing changes', () => {
    const refusedAndUnchanged = async (args, pattern) => {
      const type = await newTypeNamed(10);
      const before = await typeRow(type);
      const counted = await counts();

      const error = await refusal(raw(type, args));

      expect(error?.code).toBe('22023');
      if (pattern) expect(error?.message).toMatch(pattern);
      expect(await typeRow(type)).toEqual(before);
      expect(await historyOf(type)).toEqual([]);
      expect(await counts()).toEqual(counted);
    };

    it('SCRUM310_AC4_a_null_confirmed_list_is_refused', () =>
      refusedAndUnchanged({ total: 5, confirmed: null }, /confirmed/));

    it('SCRUM310_AC4_a_confirmed_list_with_a_null_in_it_is_refused', () =>
      refusedAndUnchanged({ total: 5, confirmed: [null] }, /confirmed/));

    it.each([
      ['a negative total', { total: -1, confirmed: [] }],
      ['a negative damaged quantity', { damaged: -1, note: 'x', confirmed: [] }],
      ['a negative under-maintenance quantity', { underMaintenance: -1, note: 'x', confirmed: [] }],
    ])('SCRUM310_AC4_%s_is_refused', (_label, args) => refusedAndUnchanged(args, /zero or more/));

    it('SCRUM310_AC4_nothing_to_change_is_refused', () =>
      refusedAndUnchanged({ confirmed: [] }, /nothing to change/i));

    it('SCRUM310_AC4_retire_false_with_nothing_else_is_refused', () =>
      refusedAndUnchanged({ retire: false, confirmed: [] }, /nothing to change/i));

    it.each([
      ['a total', { total: 3 }],
      ['damaged', { damaged: 1, note: 'x' }],
      ['under maintenance', { underMaintenance: 1, note: 'x' }],
      ['fields', { fields: { name: 'Renamed' } }],
    ])('SCRUM310_AC4_retiring_together_with_%s_is_refused', (_label, extra) =>
      refusedAndUnchanged({ retire: true, confirmed: [], ...extra }, /can not be combined/));

    it.each([
      ['no note', {}],
      ['a null note', { note: null }],
      ['an empty note', { note: '' }],
      ['a blank note', { note: '   ' }],
    ])('SCRUM310_AC8_a_damage_change_with_%s_is_refused', (_label, extra) =>
      refusedAndUnchanged({ damaged: 1, confirmed: [], ...extra }, /note is required/));

    it.each([
      ['no note', {}],
      ['a blank note', { note: '  ' }],
    ])('SCRUM310_AC8_a_maintenance_change_with_%s_is_refused', (_label, extra) =>
      refusedAndUnchanged({ underMaintenance: 1, confirmed: [], ...extra }, /note is required/));

    it.each([
      ['an array', []],
      ['a string', 'name'],
      ['a number', 4],
    ])('SCRUM310_AC4_fields_given_as_%s_are_refused', (_label, fields) =>
      refusedAndUnchanged({ total: 5, fields, confirmed: [] }, /must be an object/));

    it('SCRUM310_AC4_damaged_plus_under_maintenance_above_the_total_is_refused', () =>
      refusedAndUnchanged({ total: 3, damaged: 2, underMaintenance: 2, note: 'x', confirmed: [] }, /can not exceed/));

    it('SCRUM310_AC4_a_smaller_total_than_the_units_already_out_is_refused', async () => {
      const type = await newTypeNamed(10);
      await raw(type, { damaged: 3, underMaintenance: 2, note: 'Out', confirmed: [] });
      const before = await typeRow(type);

      const error = await refusal(raw(type, { total: 4, confirmed: [] }));

      expect(error?.code).toBe('22023');
      expect(error?.message).toMatch(/5.*4/);
      expect(await typeRow(type)).toEqual(before);
    });

    it('SCRUM310_AC4_damaged_plus_under_maintenance_exactly_the_total_is_allowed', async () => {
      const type = await newTypeNamed(10);
      const answer = await raw(type, { total: 5, damaged: 3, underMaintenance: 2, note: 'All out', confirmed: [] });
      expect(answer.saved).toBe(true);
      expect(answer.equipment_type).toMatchObject({
        total_quantity: 5, damaged_quantity: 3, under_maintenance_quantity: 2,
      });
    });

    it('SCRUM310_AC4_a_total_of_zero_is_allowed_when_nothing_is_out', async () => {
      const type = await newTypeNamed(4);
      const answer = await raw(type, { total: 0, confirmed: [] });
      expect(answer.saved).toBe(true);
      expect((await typeRow(type)).total_quantity).toBe(0);
    });
  });

  describe('AC7: a change that affects nothing saves directly', () => {
    it('SCRUM310_AC7_a_type_with_no_reservations_saves_a_smaller_total_with_nothing_flagged', async () => {
      const type = await newTypeNamed(10);
      const answer = await raw(type, { total: 6, confirmed: [] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect(answer.equipment_type).toMatchObject({ id: type, total_quantity: 6 });
      expect((await typeRow(type)).total_quantity).toBe(6);
    });

    it('SCRUM310_AC7_damage_that_still_leaves_enough_units_saves_with_nothing_flagged', async () => {
      const type = await newTypeNamed(10);
      const { id } = await held(type, 1, 4, 10, 12);

      const answer = await raw(type, { damaged: 6, note: 'Cracked lenses', confirmed: [] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect((await typeRow(type)).damaged_quantity).toBe(6);
      expect(await flaggedState([id])).toEqual({ [id]: false });
    });

    it('SCRUM310_AC7_a_boundary_change_that_leaves_exactly_enough_units_affects_nothing', async () => {
      const type = await newTypeNamed(10);
      const { id } = await held(type, 1, 4, 10, 12);
      const answer = await raw(type, { total: 4, confirmed: [] });
      expect(answer.saved).toBe(true);
      expect(await flaggedState([id])).toEqual({ [id]: false });
    });

    it('SCRUM310_AC7_one_unit_below_the_boundary_is_not_saved_directly', async () => {
      const type = await newTypeNamed(10);
      const { id } = await held(type, 1, 4, 10, 12);
      const answer = await raw(type, { total: 3, confirmed: [] });
      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([id]);
    });

    it('SCRUM310_AC7_ended_and_released_reservations_do_not_block_a_direct_save', async () => {
      const type = await newTypeNamed(10);
      await held(type, 1, 6, -300, -298);
      const released = await held(type, 2, 6, 10, 12);
      await db.query('update equipment_reservations set released_at = now() where id = $1', [released.id]);

      const answer = await raw(type, { total: 1, confirmed: [] });
      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
    });

    it('SCRUM310_AC7_a_reservation_on_another_type_does_not_block_a_direct_save', async () => {
      const type = await newTypeNamed(10);
      const other = await newTypeNamed(10);
      const { id } = await held(other, 1, 9, 10, 12);

      expect((await raw(type, { total: 1, confirmed: [] })).saved).toBe(true);
      expect(await flaggedState([id])).toEqual({ [id]: false });
    });

    it('SCRUM310_AC7_raising_the_usable_quantity_is_never_checked_and_flags_nothing', async () => {
      const type = await newTypeNamed(10);
      const { id } = await held(type, 1, 3, 10, 12, { flagged: true, flagCode: 'equipment_lost' });
      await withBackstopOff(() => db.query('update equipment_types set damaged_quantity = 9 where id = $1', [type]));

      // Usable goes from 1 to 2, still short of the 3 reserved.
      const answer = await raw(type, { damaged: 8, note: 'One fixed', confirmed: [] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect((await typeRow(type)).damaged_quantity).toBe(8);
      expect(await flaggedState([id])).toEqual({ [id]: true });
      expect(await flagEvents(id)).toEqual([]);
    });

    it('SCRUM310_AC7_a_change_that_keeps_the_usable_quantity_the_same_saves_directly', async () => {
      const type = await newTypeNamed(10);
      await held(type, 1, 9, 10, 12);
      // Total up one and damaged up one: usable stays 10, so nothing is checked.
      const answer = await raw(type, { total: 11, damaged: 1, note: 'Swap', confirmed: [] });
      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
    });

    it('SCRUM310_AC3_units_already_under_maintenance_count_against_new_damage', async () => {
      const type = await newTypeNamed(10);
      await db.query('update equipment_types set under_maintenance_quantity = 4 where id = $1', [type]);
      const { id } = await held(type, 1, 6, 10, 12);

      // Six usable now; one more damaged leaves five, which the reservation of six no longer fits.
      const refused = await raw(type, { damaged: 1, note: 'Cracked', confirmed: [] });
      expect(refused.saved).toBe(false);
      expect(ids(refused.affected)).toEqual([id]);
    });

    it('SCRUM310_AC3_new_maintenance_counts_against_units_already_damaged', async () => {
      const type = await newTypeNamed(10);
      await db.query('update equipment_types set damaged_quantity = 2 where id = $1', [type]);
      const { id } = await held(type, 1, 6, 10, 12);

      const refused = await raw(type, { underMaintenance: 3, note: 'Service', confirmed: [] });
      expect(refused.saved).toBe(false);
      expect(ids(refused.affected)).toEqual([id]);

      const saved = await raw(type, { underMaintenance: 2, note: 'Service', confirmed: [] });
      expect(saved).toMatchObject({ saved: true, affected: [] });
    });

    it('SCRUM310_AC7_a_name_only_edit_saves_with_no_check_at_all', async () => {
      const type = await newTypeNamed(10);
      await held(type, 1, 9, 10, 12);
      const answer = await raw(type, { fields: { name: `Renamed ${++seq}` }, confirmed: [] });
      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
    });

    it('SCRUM310_AC7_a_direct_save_still_refuses_a_confirmed_id_that_is_not_affected', async () => {
      const type = await newTypeNamed(10);
      const { id } = await held(type, 1, 2, 10, 12);

      const answer = await raw(type, { total: 8, confirmed: [id] });

      expect(answer).toEqual({ saved: false, affected: [] });
      expect((await typeRow(type)).total_quantity).toBe(10);
    });
  });

  describe('AC2: nothing is saved unless the shown list is confirmed', () => {
    it('SCRUM310_AC2_an_affecting_change_with_nothing_confirmed_writes_nothing_and_returns_the_list', async () => {
      const type = await newTypeNamed(4);
      const a = await held(type, 1, 3, 10, 12);
      const b = await held(type, 2, 3, 11, 13);
      const before = await typeRow(type);
      const counted = await counts();

      const answer = await raw(type, { total: 3, confirmed: [] });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([b.id]);
      expect(answer.affected[0]).toMatchObject({
        event_request_id: b.event, quantity: 3, flagged: false,
        coordinator_id: coordinator, coordinator_name: 'Casey Coordinator',
      });
      expect(await typeRow(type)).toEqual(before);
      expect(await historyOf(type)).toEqual([]);
      expect(await counts()).toEqual(counted);
      expect(await flaggedState([a.id, b.id])).toEqual({ [a.id]: false, [b.id]: false });
    });

    it('SCRUM310_AC2_the_list_returned_is_the_one_the_preview_function_gives', async () => {
      const type = await newTypeNamed(10);
      await held(type, 1, 3, 10, 12);
      await held(type, 2, 3, 11, 13);
      await held(type, 3, 3, 10, 14);

      const answer = await raw(type, { total: 4, confirmed: [] });
      const preview = asJson(await one(
        'select equipment_over_commitment($1, 4, $2)::text as answer', [type, reviewerA],
      ));

      expect(answer.affected).toEqual(preview);
    });

    it('SCRUM310_AC2_a_confirmed_list_missing_one_affected_reservation_is_refused', async () => {
      const type = await newTypeNamed(2);
      const a = await held(type, 1, 2, 10, 12);
      const b = await held(type, 2, 1, 10, 12);
      const c = await held(type, 3, 1, 10, 12);
      // One usable unit: a (two units) cannot fit, b is kept, c no longer fits beside b.
      const answer = await raw(type, { total: 1, confirmed: [a.id] });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([a.id, c.id]);
      expect(b.id).toBeDefined();
      expect((await typeRow(type)).total_quantity).toBe(2);
      expect(await flaggedState([a.id, c.id])).toEqual({ [a.id]: false, [c.id]: false });
    });

    it('SCRUM310_AC2_a_confirmed_list_with_an_extra_reservation_is_refused', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const b = await held(type, 2, 3, 10, 12);
      const unrelated = await held(await newTypeNamed(4), 3, 1, 10, 12);

      const answer = await raw(type, { total: 3, confirmed: [b.id, unrelated.id] });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([b.id]);
      expect((await typeRow(type)).total_quantity).toBe(4);
      expect(await flaggedState([b.id, unrelated.id])).toEqual({ [b.id]: false, [unrelated.id]: false });
    });

    it('SCRUM310_AC2_a_confirmed_list_of_the_wrong_reservations_is_refused', async () => {
      const type = await newTypeNamed(4);
      const kept = await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);

      const answer = await raw(type, { total: 3, confirmed: [kept.id] });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([lost.id]);
    });

    it('SCRUM310_AC2_made_up_ids_are_refused', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 4, 10, 12);
      await held(type, 2, 1, 10, 12);

      const answer = await raw(type, { total: 3, confirmed: [NOBODY] });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([lost.id]);
    });

    it('SCRUM310_AC2_the_confirmed_order_and_repeats_do_not_matter', async () => {
      const type = await newTypeNamed(1);
      const a = await held(type, 1, 1, 10, 12);
      const b = await held(type, 2, 1, 10, 12);
      const c = await held(type, 3, 1, 10, 12);

      const answer = await raw(type, { total: 0, confirmed: [c.id, a.id, b.id, a.id, c.id] });

      expect(answer.saved).toBe(true);
      expect((await flaggedState([a.id, b.id, c.id]))).toEqual({ [a.id]: true, [b.id]: true, [c.id]: true });
    });

    it('SCRUM310_AC2_after_a_refusal_the_returned_list_confirms_and_saves', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 11, 13);

      const refused = await raw(type, { total: 3, confirmed: [] });
      expect(refused.saved).toBe(false);
      const saved = await raw(type, { total: 3, confirmed: ids(refused.affected) });

      expect(saved.saved).toBe(true);
      expect(await flaggedState([lost.id])).toEqual({ [lost.id]: true });
    });

    it('SCRUM310_AC2_a_reservation_made_after_the_preview_makes_the_old_confirmation_stale', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const preview = await raw(type, { total: 3, confirmed: [] });
      expect(ids(preview.affected)).toEqual([lost.id]);

      // Someone reserves one more unit for an overlapping period.
      const late = await held(type, 3, 1, 11, 12);

      const answer = await raw(type, { total: 3, confirmed: ids(preview.affected) });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([lost.id, late.id]);
      expect((await typeRow(type)).total_quantity).toBe(4);
      expect(await flaggedState([lost.id, late.id])).toEqual({ [lost.id]: false, [late.id]: false });
    });

    it('SCRUM310_AC2_a_reservation_released_after_the_preview_is_not_flagged_and_the_save_goes_ahead', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const preview = await raw(type, { total: 3, confirmed: [] });

      await db.query('update equipment_reservations set released_at = now() where id = $1', [lost.id]);

      const answer = await raw(type, { total: 3, confirmed: ids(preview.affected) });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect((await typeRow(type)).total_quantity).toBe(3);
      expect(await flaggedState([lost.id])).toEqual({ [lost.id]: false });
    });

    it('SCRUM310_AC2_a_reservation_that_ends_after_the_preview_does_not_make_the_confirmation_stale', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const preview = await raw(type, { total: 3, confirmed: [] });
      expect(ids(preview.affected)).toEqual([lost.id]);

      await db.query(
        "update equipment_reservations set start_at = now() - interval '3 days', end_at = now() - interval '2 days' where id = $1",
        [lost.id],
      );

      const answer = await raw(type, { total: 3, confirmed: [lost.id] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect(await flaggedState([lost.id])).toEqual({ [lost.id]: false });
    });

    it('SCRUM310_AC2_a_confirmed_id_that_is_still_held_and_not_affected_makes_the_confirmation_stale', async () => {
      const type = await newTypeNamed(10);
      const fits = await held(type, 1, 2, 10, 12);

      const answer = await raw(type, { total: 9, confirmed: [fits.id] });

      expect(answer.saved).toBe(false);
      expect((await typeRow(type)).total_quantity).toBe(10);
    });

    it('SCRUM310_AC2_a_confirmed_id_from_another_type_makes_the_confirmation_stale_even_if_it_has_ended', async () => {
      const type = await newTypeNamed(10);
      const other = await newTypeNamed(10);
      const elsewhere = await held(other, 1, 2, -300, -298);

      const answer = await raw(type, { total: 9, confirmed: [elsewhere.id] });

      expect(answer.saved).toBe(false);
      expect((await typeRow(type)).total_quantity).toBe(10);
    });

    it('SCRUM310_AC2_an_older_reservation_released_after_the_preview_changes_who_is_affected', async () => {
      const type = await newTypeNamed(4);
      const oldest = await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const preview = await raw(type, { total: 3, confirmed: [] });
      expect(ids(preview.affected)).toEqual([lost.id]);

      await db.query('update equipment_reservations set released_at = now() where id = $1', [oldest.id]);

      const answer = await raw(type, { total: 3, confirmed: ids(preview.affected) });
      expect(answer).toEqual({ saved: false, affected: [] });
    });

    it('SCRUM310_AC2_a_change_to_the_type_after_the_preview_that_changes_the_list_is_caught', async () => {
      const type = await newTypeNamed(10);
      const oldest = await held(type, 1, 4, 10, 12);
      const lost = await held(type, 2, 4, 10, 12);
      const preview = await raw(type, { total: 6, confirmed: [] });
      expect(ids(preview.affected)).toEqual([lost.id]);

      // Someone takes three units out of use in the meantime, so the same
      // total change now leaves three usable and the oldest no longer fits.
      await db.query('update equipment_types set damaged_quantity = 3 where id = $1', [type]);
      const answer = await raw(type, { total: 6, confirmed: ids(preview.affected) });

      expect(answer.saved).toBe(false);
      expect(ids(answer.affected)).toEqual([oldest.id, lost.id]);
      expect((await typeRow(type)).total_quantity).toBe(10);
    });

    it('SCRUM310_AC2_the_function_takes_the_row_lock_before_it_decides', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      await held(type, 2, 3, 10, 12);

      await db.exec('begin');
      try {
        const lockedBefore = (await one('select xmax::text as x from equipment_types where id = $1', [type])).x;
        const answer = await raw(type, { total: 3, confirmed: [] });
        const lockedAfter = (await one('select xmax::text as x from equipment_types where id = $1', [type])).x;

        expect(answer.saved).toBe(false);
        // Earlier inserts that reference the type leave a lock mark of their own, so the
        // check is that this transaction's FOR UPDATE replaced it.
        expect(lockedAfter).not.toBe(lockedBefore);
      } finally {
        await db.exec('rollback');
      }
    });
  });

  describe('AC3: first come, first served decides who is affected', () => {
    it('SCRUM310_AC3_the_newest_overlapping_reservation_loses_and_the_oldest_keep_their_equipment', async () => {
      const type = await newTypeNamed(5);
      const oldest = await held(type, 1, 2, 10, 12);
      const middle = await held(type, 2, 2, 10, 12);
      const newest = await held(type, 3, 2, 10, 12);

      const answer = await raw(type, { total: 4, confirmed: [newest.id] });

      expect(answer.saved).toBe(true);
      expect(await flaggedState([oldest.id, middle.id, newest.id])).toEqual({
        [oldest.id]: false, [middle.id]: false, [newest.id]: true,
      });
    });

    it('SCRUM310_AC3_non_overlapping_reservations_are_all_kept', async () => {
      const type = await newTypeNamed(5);
      await held(type, 1, 3, 10, 12);
      await held(type, 2, 3, 12, 14);
      await held(type, 3, 3, 14, 16);
      expect(await raw(type, { total: 3, confirmed: [] })).toMatchObject({ saved: true, affected: [] });
    });

    it('SCRUM310_AC3_only_the_reservations_that_do_not_fit_are_flagged_in_a_chain_of_partial_overlaps', async () => {
      const type = await newTypeNamed(5);
      const a = await held(type, 1, 2, 10, 13);
      const b = await held(type, 2, 2, 12, 15);
      const c = await held(type, 3, 2, 14, 17);

      // Two usable: a and b overlap at 12-13 (4 > 2), so b is lost; c fits with a ended.
      const answer = await raw(type, { total: 2, confirmed: [b.id] });

      expect(answer.saved).toBe(true);
      expect(await flaggedState([a.id, b.id, c.id])).toEqual({
        [a.id]: false, [b.id]: true, [c.id]: false,
      });
    });

    it('SCRUM310_AC3_a_reservation_already_flagged_as_unavailable_takes_part_and_is_not_flagged_twice', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const already = await held(type, 2, 3, 10, 12, { flagged: true, flagCode: 'equipment_lost' });
      await db.query(
        "update equipment_reservations set flag_reason = 'Earlier reason', flagged_at = '2026-01-01T00:00:00Z' where id = $1",
        [already.id],
      );

      const answer = await raw(type, { total: 3, confirmed: [already.id] });

      // The shown list had it; this save flagged nothing, and says so.
      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      const row = await one('select flagged, flag_reason, flagged_at from equipment_reservations where id = $1', [already.id]);
      expect(row.flag_reason).toBe('Earlier reason');
      expect(new Date(row.flagged_at).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(await flagEvents(already.id)).toEqual([]);
    });

    it('SCRUM310_AC3_a_reservation_larger_than_everything_usable_is_affected_and_the_rest_stay', async () => {
      const type = await newTypeNamed(10);
      const big = await held(type, 1, 6, 10, 12);
      const small = await held(type, 2, 1, 10, 12);
      const answer = await raw(type, { total: 5, confirmed: [big.id] });
      expect(answer.saved).toBe(true);
      expect(await flaggedState([big.id, small.id])).toEqual({ [big.id]: true, [small.id]: false });
    });

    it('SCRUM310_AC3_retiring_affects_every_held_reservation_that_has_not_ended', async () => {
      const type = await newTypeNamed(10);
      const a = await held(type, 1, 1, 10, 12);
      const b = await held(type, 2, 1, 20, 22);
      const ended = await held(type, 3, 1, -300, -298);
      const released = await held(type, 4, 1, 30, 32);
      await db.query('update equipment_reservations set released_at = now() where id = $1', [released.id]);

      const refused = await raw(type, { retire: true, confirmed: [] });
      expect(refused.saved).toBe(false);
      expect(ids(refused.affected)).toEqual([a.id, b.id]);

      const saved = await raw(type, { retire: true, confirmed: [a.id, b.id] });
      expect(saved.saved).toBe(true);
      expect(await flaggedState([a.id, b.id, ended.id, released.id])).toEqual({
        [a.id]: true, [b.id]: true, [ended.id]: false, [released.id]: false,
      });
    });
  });

  describe('AC4: the change, the flags and the requests move together', () => {
    it('SCRUM310_AC4_a_confirmed_change_saves_the_type_flags_the_reservation_and_returns_its_request_to_pending_review', async () => {
      const { event, type, line } = await reviewed('Lamp', 4, 3);
      await reserve(event, reviewerA, line, 3);
      expect(await requestStatus(event)).toBe('arranged');
      const { id } = await reservation(event);

      const refused = await raw(type, { damaged: 2, note: 'Bulbs blown', confirmed: [] });
      expect(refused.saved).toBe(false);
      expect(await requestStatus(event)).toBe('arranged');

      const answer = await raw(type, { damaged: 2, note: 'Bulbs blown', confirmed: ids(refused.affected) });

      expect(answer).toMatchObject({ saved: true, flagged_count: 1 });
      expect(ids(answer.affected)).toEqual([id]);
      expect((await typeRow(type)).damaged_quantity).toBe(2);
      const row = await reservation(event);
      expect(row.flagged).toBe(true);
      expect(row.released_at).toBeNull();
      expect(await requestStatus(event)).toBe('pending_review');
    });

    it('SCRUM310_AC4_a_request_under_review_also_returns_to_pending_review', async () => {
      const { event, type, line } = await reviewed('Lamp', 4, 3);
      await reserve(event, reviewerA, line, 2);
      expect(await requestStatus(event)).toBe('under_review');

      await applyEquipmentChange(db, type, reviewerA, { retire: true });

      expect(await requestStatus(event)).toBe('pending_review');
    });

    it('SCRUM310_AC4_a_reservation_is_flagged_never_released_or_cancelled', async () => {
      const { event, type, line } = await reviewed('Lamp', 4, 3);
      await reserve(event, reviewerA, line, 3);
      await applyEquipmentChange(db, type, reviewerA, { total: 1 });

      const row = await reservation(event);
      expect(row).toMatchObject({ flagged: true, released_at: null, quantity: 3 });
      expect((await one('select status::text as s from event_requests where id = $1', [event])).s).toBe('approved');
    });

    it('SCRUM310_AC4_the_saved_row_comes_back_in_the_answer_as_stored', async () => {
      const type = await newTypeNamed(10);
      const answer = await raw(type, { total: 8, damaged: 1, underMaintenance: 2, note: 'Mixed', confirmed: [] });
      const stored = await typeRow(type);

      expect(answer.equipment_type).toMatchObject({
        id: type, total_quantity: 8, damaged_quantity: 1, under_maintenance_quantity: 2,
        retired_at: null, last_modified_by: reviewerA, last_change_note: 'Mixed',
      });
      expect(answer.equipment_type.total_quantity).toBe(stored.total_quantity);
    });

    it('SCRUM310_AC4_a_forced_failure_while_flagging_changes_nothing', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const before = await typeRow(type);
      const counted = await counts();

      await db.exec('begin');
      try {
        // Replaced inside a transaction, so the rollback restores the real function.
        await db.exec(`
          create or replace function flag_equipment_reservation_ids(p_reservation_ids uuid[], p_reason text, p_user_id uuid, p_code text default 'equipment_lost')
          returns uuid[] language plpgsql as $$
          begin
            raise exception 'forced flagging failure';
          end;
          $$
        `);
        await db.exec('savepoint before_change');

        await expect(raw(type, { total: 3, confirmed: [lost.id] })).rejects.toThrow(/forced flagging failure/);

        await db.exec('rollback to savepoint before_change');
        expect(await typeRow(type)).toEqual(before);
        expect(await historyOf(type)).toEqual([]);
        expect(await counts()).toEqual(counted);
        expect(await flaggedState([lost.id])).toEqual({ [lost.id]: false });
      } finally {
        await db.exec('rollback');
      }

      // And the real function is back.
      expect((await raw(type, { total: 3, confirmed: [lost.id] })).saved).toBe(true);
    });

    it('SCRUM310_AC4_a_name_that_is_already_taken_fails_the_whole_save_and_flags_nothing', async () => {
      const taken = `Taken ${++seq} ${Math.random()}`;
      await one('insert into equipment_types (name, total_quantity) values ($1, 1) returning id', [taken]);
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const before = await typeRow(type);
      const counted = await counts();

      const error = await refusal(raw(type, { total: 3, fields: { name: taken.toUpperCase() }, confirmed: [lost.id] }));

      expect(error?.code).toBe('23505');
      expect(await typeRow(type)).toEqual(before);
      expect(await counts()).toEqual(counted);
      expect(await flaggedState([lost.id])).toEqual({ [lost.id]: false });
    });

    it('SCRUM310_AC4_an_edit_of_the_name_and_a_smaller_total_save_together', async () => {
      const type = await newTypeNamed(10);
      const name = `New name ${++seq} ${Math.random()}`;
      const answer = await raw(type, {
        total: 7, fields: { name, description: 'Blue', category: 'AV', location: 'Store 2' }, confirmed: [],
      });
      expect(answer.saved).toBe(true);
      expect(await typeRow(type)).toMatchObject({
        name, description: 'Blue', category: 'AV', location: 'Store 2', total_quantity: 7,
      });
    });

    it('SCRUM310_AC4_only_the_fields_given_change_and_null_clears_a_field', async () => {
      const type = await newTypeNamed(10);
      await db.query(
        "update equipment_types set description = 'Old', category = 'Cat', location = 'Loc' where id = $1",
        [type],
      );
      const before = await typeRow(type);

      await raw(type, { total: 9, fields: { description: null }, confirmed: [] });

      expect(await typeRow(type)).toMatchObject({
        name: before.name, description: null, category: 'Cat', location: 'Loc', total_quantity: 9,
      });
    });

    it('SCRUM310_AC4_unknown_keys_in_fields_are_ignored', async () => {
      const type = await newTypeNamed(10);
      const before = await typeRow(type);
      await raw(type, { total: 9, fields: { total_quantity: 1, retired_at: '2026-01-01', id: NOBODY }, confirmed: [] });
      const after = await typeRow(type);
      expect(after.total_quantity).toBe(9);
      expect(after.retired_at).toBeNull();
      expect(after.id).toBe(before.id);
    });

    it('SCRUM310_AC4_changes_to_one_type_never_touch_another_types_reservations', async () => {
      const type = await newTypeNamed(4);
      const other = await newTypeNamed(4);
      await held(type, 1, 4, 10, 12);
      const bystander = await held(other, 2, 4, 10, 12);

      await applyEquipmentChange(db, type, reviewerA, { retire: true });

      expect(await flaggedState([bystander.id])).toEqual({ [bystander.id]: false });
      expect((await typeRow(other)).retired_at).toBeNull();
    });
  });

  describe('retiring', () => {
    it('SCRUM310_AC4_a_retirement_sets_retired_at_and_leaves_the_quantities', async () => {
      const type = await newTypeNamed(7);
      const answer = await raw(type, { retire: true, confirmed: [] });
      expect(answer.saved).toBe(true);
      const row = await typeRow(type);
      expect(row.retired_at).not.toBeNull();
      expect(row).toMatchObject({ total_quantity: 7, damaged_quantity: 0, under_maintenance_quantity: 0 });
    });

    it('SCRUM310_AC4_retiring_a_retired_type_is_a_PT409_with_its_hint_and_changes_nothing', async () => {
      const type = await newTypeNamed(7);
      await raw(type, { retire: true, confirmed: [] });
      const before = await typeRow(type);
      const counted = await counts();

      const error = await refusal(raw(type, { retire: true, confirmed: [] }));

      expect(error?.code).toBe('PT409');
      expect(error?.hint).toBe('EQUIPMENT_ALREADY_RETIRED');
      expect(await typeRow(type)).toEqual(before);
      expect(await counts()).toEqual(counted);
    });

    it('SCRUM310_AC4_a_retired_type_can_still_have_its_quantities_changed', async () => {
      const type = await newTypeNamed(7);
      await raw(type, { retire: true, confirmed: [] });
      const answer = await raw(type, { total: 5, confirmed: [] });
      expect(answer.saved).toBe(true);
      expect((await typeRow(type)).retired_at).not.toBeNull();
    });

    it('SCRUM310_AC4_retiring_a_type_with_no_usable_units_still_flags_the_reservations_it_holds', async () => {
      const type = await newTypeNamed(4);
      await withBackstopOff(() => db.query('update equipment_types set damaged_quantity = 4 where id = $1', [type]));
      const { id } = await held(type, 1, 2, 10, 12);

      const refused = await raw(type, { retire: true, confirmed: [] });
      expect(refused.saved).toBe(false);
      expect(ids(refused.affected)).toEqual([id]);

      const answer = await raw(type, { retire: true, confirmed: [id] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 1 });
      expect(await flaggedState([id])).toEqual({ [id]: true });
      expect((await flagEvents(id))[0].reason).toBe('The equipment type was retired');
    });

    it('SCRUM310_AC4_retiring_a_type_with_no_usable_units_leaves_a_reservation_already_flagged_as_unavailable_alone', async () => {
      const type = await newTypeNamed(4);
      await withBackstopOff(() => db.query('update equipment_types set damaged_quantity = 4 where id = $1', [type]));
      const { id } = await held(type, 1, 2, 10, 12, { flagged: true, flagCode: 'equipment_lost' });

      const answer = await raw(type, { retire: true, confirmed: [id] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 0, affected: [] });
      expect(await flagEvents(id)).toEqual([]);
    });

    it('SCRUM310_AC4_retiring_a_type_whose_reservations_have_all_ended_saves_directly', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 2, -300, -298);
      expect(await raw(type, { retire: true, confirmed: [] })).toMatchObject({ saved: true, affected: [] });
    });
  });

  describe('AC5: the coordinators are told', () => {
    const flaggedNotices = (event) =>
      rows(
        `select recipient_id, payload from notifications
          where event_request_id = $1 and type = 'equipment_flagged' order by created_at, id`,
        [event],
      );

    it('SCRUM310_AC5_the_coordinator_of_each_affected_event_gets_one_notice_with_the_reason', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const first = await held(type, 2, 3, 10, 12);
      const second = await held(type, 3, 3, 10, 12);
      await db.query('delete from notifications');

      const answer = await raw(type, { total: 3, confirmed: [first.id, second.id] });

      expect(answer.saved).toBe(true);
      for (const { event } of [first, second]) {
        const notices = await flaggedNotices(event);
        expect(notices).toHaveLength(1);
        expect(notices[0].recipient_id).toBe(coordinator);
        expect(notices[0].payload.reason).toBe('Fewer units of this equipment are usable');
      }
    });

    it('SCRUM310_AC5_an_unaffected_event_and_a_refused_save_notify_nobody', async () => {
      const type = await newTypeNamed(4);
      const kept = await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      await db.query('delete from notifications');

      await raw(type, { total: 3, confirmed: [] });
      expect(await flaggedNotices(lost.event)).toEqual([]);

      await raw(type, { total: 3, confirmed: [lost.id] });
      expect(await flaggedNotices(kept.event)).toEqual([]);
      expect(await flaggedNotices(lost.event)).toHaveLength(1);
    });

    it('SCRUM310_AC5_a_reservation_already_flagged_as_unavailable_is_not_announced_again', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const already = await held(type, 2, 3, 10, 12, { flagged: true, flagCode: 'equipment_lost' });
      await db.query('delete from notifications');

      await raw(type, { total: 3, confirmed: [already.id] });

      expect(await flaggedNotices(already.event)).toEqual([]);
    });

    it('SCRUM310_AC5_a_reservation_flagged_for_another_reason_is_announced_when_its_equipment_becomes_unavailable', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const other = await held(type, 2, 3, 10, 12, { flagged: true });
      await db.query(
        "update equipment_reservations set flag_reason = 'The event date or time changed' where id = $1",
        [other.id],
      );
      await db.query('delete from notifications');

      await raw(type, { total: 3, confirmed: [other.id] });

      const notices = await flaggedNotices(other.event);
      expect(notices).toHaveLength(1);
      expect(notices[0].recipient_id).toBe(coordinator);
      expect(notices[0].payload.reason).toBe('Fewer units of this equipment are usable');
    });

    it('SCRUM310_AC5_a_retirement_names_the_retirement_as_the_reason', async () => {
      const type = await newTypeNamed(4);
      const only = await held(type, 1, 3, 10, 12);
      await db.query('delete from notifications');

      await raw(type, { retire: true, confirmed: [only.id] });

      const notices = await flaggedNotices(only.event);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload.reason).toBe('The equipment type was retired');
    });
  });

  describe('AC6: a Confirmed event stays Confirmed', () => {
    it.each(['approved', 'confirmed', 'safety_review', 'safety_approved'])(
      'SCRUM310_AC6_an_event_that_is_%s_keeps_that_status_when_its_equipment_is_flagged',
      async (status) => {
        const type = await newTypeNamed(4);
        const { id, event } = await held(type, 1, 3, 10, 12);
        await withSafetyReviewTransitionGuardDisabled(db, () =>
          db.query('update event_requests set status = $2 where id = $1', [event, status]));

        const answer = await raw(type, { total: 1, confirmed: [id] });

        expect(answer.saved).toBe(true);
        expect(await flaggedState([id])).toEqual({ [id]: true });
        expect((await one('select status::text as s from event_requests where id = $1', [event])).s).toBe(status);
        expect((await one('select status::text as s from equipment_requests where event_request_id = $1', [event])).s)
          .toBe('pending_review');
      },
    );
  });

  describe('AC8: the change and each flag record the user, the time and the reason', () => {
    it('SCRUM310_AC8_the_history_row_names_the_user_the_old_and_new_value_and_the_note', async () => {
      const type = await newTypeNamed(10);
      const started = Date.now();

      await raw(type, { damaged: 3, note: 'Dropped in transit', confirmed: [] });

      const history = await historyOf(type);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        field_name: 'damaged_quantity', old_value: '0', new_value: '3',
        note: 'Dropped in transit', changed_by: reviewerA,
      });
      expect(Math.abs(new Date(history[0].changed_at).getTime() - started)).toBeLessThan(60_000);
    });

    it('SCRUM310_AC8_a_total_change_records_its_optional_note_and_one_without_a_note_records_none', async () => {
      const type = await newTypeNamed(10);
      await raw(type, { total: 8, note: 'Written off two', confirmed: [] });
      await raw(type, { total: 7, confirmed: [] });

      const totals = (await historyOf(type)).filter((h) => h.field_name === 'total_quantity');
      expect(totals.map((h) => [h.old_value, h.new_value, h.note, h.changed_by])).toEqual([
        ['10', '8', 'Written off two', reviewerA],
        ['8', '7', null, reviewerA],
      ]);
    });

    it('SCRUM310_AC8_a_retirement_records_the_user_and_its_note', async () => {
      const type = await newTypeNamed(10);
      await raw(type, { retire: true, note: 'End of life', confirmed: [] });

      const retired = (await historyOf(type)).filter((h) => h.field_name === 'retired_at');
      expect(retired).toHaveLength(1);
      expect(retired[0]).toMatchObject({ old_value: null, note: 'End of life', changed_by: reviewerA });
      expect(retired[0].new_value).not.toBeNull();
    });

    it('SCRUM310_AC8_a_combined_change_writes_one_history_row_per_field_that_changed', async () => {
      const type = await newTypeNamed(10);
      await raw(type, { total: 9, damaged: 1, underMaintenance: 0, note: 'One broke', confirmed: [] });

      const fields = (await historyOf(type)).map((h) => h.field_name);
      expect(fields.sort()).toEqual(['damaged_quantity', 'total_quantity']);
    });

    it('SCRUM310_AC8_each_flag_event_records_the_user_the_time_and_the_reason_with_the_note', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      const started = Date.now();

      await raw(type, { damaged: 1, note: 'Bulbs blown', confirmed: [lost.id] });

      const events = await flagEvents(lost.id);
      expect(events).toHaveLength(1);
      expect(events[0].user_id).toBe(reviewerA);
      expect(events[0].reason).toBe('Fewer units of this equipment are usable (Bulbs blown)');
      expect(Math.abs(new Date(events[0].created_at).getTime() - started)).toBeLessThan(60_000);
      const row = await one('select flag_reason, flagged_at from equipment_reservations where id = $1', [lost.id]);
      expect(row.flag_reason).toBe('Fewer units of this equipment are usable (Bulbs blown)');
      expect(row.flagged_at).not.toBeNull();
    });

    it('SCRUM310_AC8_without_a_note_the_flag_reason_is_the_plain_one', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 3, 10, 12);
      await raw(type, { total: 1, confirmed: [lost.id] });
      expect((await flagEvents(lost.id))[0].reason).toBe('Fewer units of this equipment are usable');
    });

    it('SCRUM310_AC8_a_blank_note_on_a_total_change_counts_as_no_note', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 3, 10, 12);
      await raw(type, { total: 1, note: '   ', confirmed: [lost.id] });
      expect((await flagEvents(lost.id))[0].reason).toBe('Fewer units of this equipment are usable');
      expect((await typeRow(type)).last_change_note).toBeNull();
    });

    it('SCRUM310_AC8_a_retirement_flag_records_the_user_and_the_retirement_reason', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 3, 10, 12);
      await raw(type, { retire: true, note: 'Sold', confirmed: [lost.id] });

      const [event] = await flagEvents(lost.id);
      expect(event.user_id).toBe(reviewerA);
      expect(event.reason).toBe('The equipment type was retired (Sold)');
    });

    it('SCRUM310_AC8_the_note_is_trimmed_before_it_is_stored', async () => {
      const type = await newTypeNamed(4);
      await raw(type, { damaged: 1, note: '  Cracked  ', confirmed: [] });
      expect((await typeRow(type)).last_change_note).toBe('Cracked');
    });

    it('SCRUM310_AC8_a_refused_save_records_nothing', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 3, 10, 12);
      await held(type, 0, 3, 10, 12);
      const counted = await counts();

      expect((await raw(type, { total: 3, note: 'x', confirmed: [] })).saved).toBe(false);

      expect(await counts()).toEqual(counted);
      expect(await flagEvents(lost.id)).toEqual([]);
      expect(await historyOf(type)).toEqual([]);
    });

    it('SCRUM310_AC8_the_old_two_argument_flagging_still_records_no_user', async () => {
      const type = await newTypeNamed(4);
      const held1 = await held(type, 1, 1, 10, 12);
      await db.query('select flag_equipment_reservations($1::uuid[], $2)', [[held1.id], 'System reason']);
      expect((await flagEvents(held1.id))).toMatchObject([{ user_id: null, reason: 'System reason' }]);
    });

    it('SCRUM310_AC8_the_new_flagging_function_records_the_user_it_is_given', async () => {
      const type = await newTypeNamed(4);
      const held1 = await held(type, 1, 1, 10, 12);
      await db.query('select flag_equipment_reservations_by($1::uuid[], $2, $3)', [[held1.id], 'Person reason', reviewerA]);
      expect((await flagEvents(held1.id))).toMatchObject([{ user_id: reviewerA, reason: 'Person reason' }]);
    });
  });

  describe('the silent flagging is gone, and the backstop for changes made outside the save', () => {
    it('SCRUM310_AC4_the_trigger_and_its_function_no_longer_exist', async () => {
      expect(await rows(
        "select tgname from pg_trigger where tgname = 'equipment_types_flag_reservations_on_unusable'",
      )).toEqual([]);
      expect(await rows(
        "select proname from pg_proc where proname = 'equipment_flag_on_type_unusable'",
      )).toEqual([]);
    });

    it('SCRUM310_AC4_a_change_the_save_makes_is_flagged_once_not_again_by_the_backstop', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);

      await raw(type, { total: 3, confirmed: [lost.id] });

      expect(await flagEvents(lost.id)).toHaveLength(1);
    });

    it('SCRUM310_AC4_the_fixes_migration_can_be_run_again_and_the_save_still_works', async () => {
      const sql = readFileSync(new URL('../../db/migrations/026_equipment_loss_fixes.sql', import.meta.url), 'utf8');
      await db.exec(sql);
      await db.exec(sql);

      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const lost = await held(type, 2, 3, 10, 12);
      expect(await raw(type, { total: 3, confirmed: [lost.id] })).toMatchObject({ saved: true, flagged_count: 1 });
      expect(await rows(
        "select tgname from pg_trigger where tgname = 'equipment_types_flag_unconfirmed_loss'",
      )).toHaveLength(1);
    });

    it('SCRUM310_AC4_the_other_flagging_triggers_still_work', async () => {
      const { event, line } = await reviewed('Lamp', 4, 2);
      await reserve(event, reviewerA, line, 2);
      await db.query('select amend_equipment_line($1, $2, $3, 3)', [event, coordinator, line]);
      expect((await reservation(event)).flagged).toBe(true);
    });
  });

  describe('a change made outside the confirmed save still flags what it leaves short', () => {
    it('SCRUM310_AC4_a_plain_update_that_lowers_the_usable_quantity_flags_the_newest_reservations', async () => {
      const type = await newTypeNamed(10);
      const first = await held(type, 1, 3, 10, 12);
      const second = await held(type, 2, 3, 10, 12);
      await db.query(
        'update equipment_types set damaged_quantity = 6, last_modified_by = $2, last_change_note = $3 where id = $1',
        [type, reviewerA, 'Cracked in transit'],
      );

      expect(await flaggedState([first.id, second.id])).toEqual({ [first.id]: false, [second.id]: true });
      const events = await flagEvents(second.id);
      expect(events).toHaveLength(1);
      expect(events[0].user_id).toBe(reviewerA);
      expect(events[0].reason).toBe('Fewer units of this equipment are usable (Cracked in transit)');
      expect((await reservationRow(second.id)).flag_code).toBe('equipment_lost');
      expect(await requestStatus(second.event)).toBe('pending_review');
    });

    it('SCRUM310_AC4_a_plain_retirement_flags_every_held_reservation_even_with_no_usable_units', async () => {
      const type = await newTypeNamed(4);
      const only = await held(type, 1, 2, 10, 12);
      await withBackstopOff(() => db.query('update equipment_types set damaged_quantity = 4 where id = $1', [type]));
      await db.query('update equipment_types set retired_at = now() where id = $1', [type]);

      expect(await flaggedState([only.id])).toEqual({ [only.id]: true });
      expect((await flagEvents(only.id))[0].reason).toBe('The equipment type was retired');
    });

    it('SCRUM310_AC7_a_plain_update_that_leaves_room_or_changes_only_the_name_flags_nothing', async () => {
      const type = await newTypeNamed(10);
      const only = await held(type, 1, 3, 10, 12);

      await db.query('update equipment_types set damaged_quantity = 7 where id = $1', [type]);
      await db.query("update equipment_types set name = name || ' renamed', description = 'x' where id = $1", [type]);
      await db.query('update equipment_types set damaged_quantity = 2 where id = $1', [type]);

      expect(await flaggedState([only.id])).toEqual({ [only.id]: false });
    });

    it('SCRUM310_AC6_a_reservation_flagged_for_another_reason_is_flagged_as_unavailable_when_its_equipment_is_lost', async () => {
      const type = await newTypeNamed(4);
      await held(type, 1, 3, 10, 12);
      const other = await held(type, 2, 3, 10, 12, { flagged: true });
      await db.query(
        "update equipment_reservations set flag_reason = 'The event date or time changed', flagged_at = '2026-01-01T00:00:00Z' where id = $1",
        [other.id],
      );

      const answer = await raw(type, { total: 3, confirmed: [other.id] });

      expect(answer).toMatchObject({ saved: true, flagged_count: 1 });
      expect(ids(answer.affected)).toEqual([other.id]);
      const row = await reservationRow(other.id);
      expect(row).toMatchObject({
        flagged: true,
        flag_code: 'equipment_lost',
        flag_reason: 'Fewer units of this equipment are usable',
      });
      expect(new Date(row.flagged_at).getTime()).toBeGreaterThan(Date.parse('2026-01-02T00:00:00Z'));
      const events = await flagEvents(other.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ user_id: reviewerA, reason: 'Fewer units of this equipment are usable' });
      expect(await requestStatus(other.event)).toBe('pending_review');
    });

    it('SCRUM310_AC6_a_flag_for_another_reason_never_replaces_a_flag_for_unavailable_equipment', async () => {
      const type = await newTypeNamed(4);
      const lost = await held(type, 1, 2, 10, 12, { flagged: true, flagCode: 'equipment_lost' });
      await db.query("update equipment_reservations set flag_reason = 'Lost reason' where id = $1", [lost.id]);

      await db.query('select flag_equipment_reservations($1::uuid[], $2)', [[lost.id], 'The event date or time changed']);

      expect(await reservationRow(lost.id)).toMatchObject({ flag_reason: 'Lost reason', flag_code: 'equipment_lost' });
      expect(await flagEvents(lost.id)).toEqual([]);
    });

    it('SCRUM310_AC6_a_second_flag_for_another_reason_leaves_the_first_one_alone', async () => {
      const type = await newTypeNamed(4);
      const other = await held(type, 1, 2, 10, 12, { flagged: true });
      await db.query("update equipment_reservations set flag_reason = 'First reason' where id = $1", [other.id]);

      await db.query('select flag_equipment_reservations($1::uuid[], $2)', [[other.id], 'Second reason']);

      expect(await reservationRow(other.id)).toMatchObject({ flag_reason: 'First reason', flag_code: null });
    });
  });

  describe('against a plain reading of the rule, over seeded scenarios', () => {
    // A small seeded generator, so a failure names the seed that reproduces it.
    function generator(seed) {
      let state = seed;
      return (max) => {
        state = (state * 48271) % 2147483647;
        return state % max;
      };
    }

    function expectedAffected(list, usable) {
      const kept = [];
      const affected = [];
      for (const r of list) {
        let peak = 0;
        for (let slot = r.from; slot < r.to; slot += 1) {
          const heldNow = kept
            .filter((k) => k.from <= slot && slot < k.to)
            .reduce((sum, k) => sum + k.quantity, 0);
          peak = Math.max(peak, heldNow);
        }
        if (peak + r.quantity > usable) affected.push(r);
        else kept.push(r);
      }
      return affected;
    }

    it.each([11, 29, 47, 83, 101, 257])(
      'SCRUM310_AC3_seed_%i_flags_exactly_the_reservations_the_plain_rule_picks_and_nothing_else',
      async (seed) => {
        const next = generator(seed);
        const total = 6 + next(6);
        const usable = next(total);
        const type = await newTypeNamed(total);
        const list = [];
        for (let i = 0; i < 6 + next(4); i += 1) {
          const from = 10 + next(8);
          const r = { from, to: from + 1 + next(4), quantity: 1 + next(3), order: i + 1 };
          const made = await held(type, r.order, r.quantity, r.from, r.to);
          list.push({ ...r, id: made.id });
        }
        const lostIds = expectedAffected(list, usable).map((r) => r.id);

        const change = { total: Math.min(total, usable), confirmed: [] };
        const refused = await raw(type, change);
        expect(refused.saved, `seed ${seed}`).toBe(lostIds.length === 0);
        expect(ids(refused.affected).sort(), `seed ${seed}`).toEqual([...lostIds].sort());

        const saved = refused.saved ? refused : await raw(type, { ...change, confirmed: lostIds });
        expect(saved.saved, `seed ${seed}`).toBe(true);
        const state = await flaggedState(list.map((r) => r.id));
        for (const r of list) {
          expect(state[r.id], `seed ${seed} reservation ${r.order}`).toBe(lostIds.includes(r.id));
        }
      },
    );
  });
});
