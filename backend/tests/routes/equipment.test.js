/**
 * Tests for the equipment catalogue routes.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and
 * Status". Named SCRUM275_ACn_<what_it_checks>. These are about transport and
 * authorisation: the right routes exist, the right roles reach them, and a
 * refused attempt reaches no service function, so it changes nothing.
 *
 *   AC1 -- only Technical Support Staff write; coordinators read active types
 *          only; anyone else is refused, and a refused attempt changes nothing
 *   AC2 -- create answers 201, or 400 listing every invalid field
 *   AC3 -- edit answers 200, 400 or 404
 *
 * The Supabase client is mocked with a factory, as in routes/venues.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ok, queryStub } from '../fixtures/supabaseStubs.js';
import { signedOut, signedInFor } from '../fixtures/auth.js';

const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));

vi.mock('../../src/config/supabaseClient.js', () => {
  const client = { from, rpc };
  return { supabase: client, default: client };
});

const { createEquipmentRouter } = await import('../../src/routes/equipment.js');
const { supabase } = await import('../../src/config/supabaseClient.js');
const { ROLE } = await import('../../src/domain/userRole.js');


const TYPE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const STAFF_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function typeRow(overrides = {}) {
  return {
    id: TYPE_ID,
    name: 'Projector',
    description: null,
    category: null,
    location: null,
    total_quantity: 10,
    damaged_quantity: 0,
    under_maintenance_quantity: 0,
    retired_at: null,
    created_at: '2026-10-01T09:00:00+00:00',
    updated_at: '2026-10-01T09:00:00+00:00',
    ...overrides,
  };
}

const signedInAs = signedInFor(STAFF_ID);

/** An app with the router mounted where app.js mounts it. */
function appWith(requireAuth = signedInAs(ROLE.TECHNICAL_SUPPORT_STAFF)) {
  return express()
    .use(express.json())
    .use('/api/equipment', createEquipmentRouter({ requireAuth }));
}

const OTHER_ROLES = [ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER];

/** What apply_equipment_change answers when it saved (SCRUM-313). */
const savedType = (row) => ok({ saved: true, flagged_count: 0, affected: [], equipment_type: row });

beforeEach(() => {
  from.mockReset();
  rpc.mockReset();
});


describe('the test double', () => {
  it('SCRUM275_the_supabase_client_is_mocked_and_never_the_real_one', () => {
    expect(vi.isMockFunction(supabase.from)).toBe(true);
  });
});


describe('AC1: only Technical Support Staff can write', () => {
  it.each(OTHER_ROLES)('SCRUM275_AC1_refuses_%s_on_create_with_403_and_changes_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role)))
      .post('/api/equipment')
      .send({ name: 'Projector', totalQuantity: 1 });

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it.each(OTHER_ROLES)('SCRUM275_AC1_refuses_%s_on_edit_with_403_and_changes_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role)))
      .patch(`/api/equipment/${TYPE_ID}`)
      .send({ name: 'Mic' });

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC1_refuses_a_signed_out_caller_with_401', async () => {
    const res = await request(appWith(signedOut)).post('/api/equipment').send({ name: 'x', totalQuantity: 1 });

    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });
});


describe('AC1: who can read', () => {
  it('SCRUM275_AC1_lets_an_event_coordinator_read_the_active_types', async () => {
    from.mockReturnValueOnce(queryStub(ok([typeRow()])));

    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get('/api/equipment/active');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: TYPE_ID, name: 'Projector', description: null, category: null }]);
  });

  it('SCRUM275_AC1_lets_technical_support_read_the_active_types', async () => {
    from.mockReturnValueOnce(queryStub(ok([])));

    const res = await request(appWith()).get('/api/equipment/active');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([ROLE.EVENT_ORGANISER, ROLE.VENUE_STAFF, ROLE.ATTENDEE, ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM275_AC1_refuses_%s_on_the_active_list_with_403',
    async (role) => {
      const res = await request(appWith(signedInAs(role))).get('/api/equipment/active');

      expect(res.status).toBe(403);
      expect(from).not.toHaveBeenCalled();
    },
  );

  it('SCRUM275_AC1_keeps_the_full_catalogue_to_technical_support', async () => {
    const res = await request(appWith(signedInAs(ROLE.EVENT_COORDINATOR))).get('/api/equipment');

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC5_gives_technical_support_the_full_catalogue_with_usable_quantities', async () => {
    from.mockReturnValueOnce(queryStub(ok([typeRow({ damaged_quantity: 2, under_maintenance_quantity: 1 })])));

    const res = await request(appWith()).get('/api/equipment');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ totalQuantity: 10, usableQuantity: 7 });
  });

  it('SCRUM275_AC1_answers_500_without_leaking_a_driver_message', async () => {
    from.mockReturnValueOnce(queryStub({ data: null, error: { code: '57014', message: 'secret driver text' } }));

    const res = await request(appWith()).get('/api/equipment');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret driver text');
  });
});


describe('AC2: creating a type', () => {
  it('SCRUM275_AC2_creates_a_type_and_answers_201', async () => {
    from.mockReturnValueOnce(queryStub(ok([]))).mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).post('/api/equipment').send({ name: 'Projector', totalQuantity: 10 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: TYPE_ID, name: 'Projector', totalQuantity: 10, usableQuantity: 10 });
  });

  it('SCRUM275_AC2_answers_400_listing_every_invalid_field', async () => {
    const res = await request(appWith()).post('/api/equipment').send({ name: ' ', totalQuantity: -1 });

    expect(res.status).toBe(400);
    expect(res.body.details.map((detail) => detail.field)).toEqual(['name', 'totalQuantity']);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC2_answers_400_for_a_name_already_in_use', async () => {
    from.mockReturnValueOnce(queryStub(ok([{ id: 'x' }])));

    const res = await request(appWith()).post('/api/equipment').send({ name: 'projector', totalQuantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'name', message: 'is already used by another equipment type' }]);
  });

  it('SCRUM275_AC2_answers_409_with_a_code_when_two_writers_race_to_a_name', async () => {
    from
      .mockReturnValueOnce(queryStub(ok([])))
      .mockReturnValueOnce(queryStub({ data: null, error: { code: '23505', message: 'duplicate' } }));

    const res = await request(appWith()).post('/api/equipment').send({ name: 'Projector', totalQuantity: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_NAME_TAKEN');
  });

  it('SCRUM275_AC2_ignores_damaged_and_retired_fields_in_the_body', async () => {
    const insert = queryStub(ok(typeRow()));
    const insertSpy = vi.spyOn(insert, 'insert');
    from.mockReturnValueOnce(queryStub(ok([]))).mockReturnValueOnce(insert);

    await request(appWith())
      .post('/api/equipment')
      .send({ name: 'Projector', totalQuantity: 10, damagedQuantity: 9, retiredAt: '2026-01-01T00:00:00Z' });

    expect(insertSpy).toHaveBeenCalledWith({
      name: 'Projector',
      description: null,
      category: null,
      location: null,
      total_quantity: 10,
      last_modified_by: STAFF_ID,
    });
  });
});


describe('AC3: editing a type', () => {
  it('SCRUM275_AC3_edits_a_type_and_answers_200', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow())))
      .mockReturnValueOnce(queryStub(ok(typeRow({ location: 'Store room 2' }))));

    const res = await request(appWith()).patch(`/api/equipment/${TYPE_ID}`).send({ location: 'Store room 2' });

    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Store room 2');
  });

  it('SCRUM275_AC3_answers_404_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    const res = await request(appWith()).patch(`/api/equipment/${TYPE_ID}`).send({ name: 'Mic' });

    expect(res.status).toBe(404);
  });

  it('SCRUM275_AC3_answers_400_for_a_malformed_id', async () => {
    const res = await request(appWith()).patch('/api/equipment/not-a-uuid').send({ name: 'Mic' });

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC3_answers_400_when_the_total_would_drop_below_damaged_plus_maintenance', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ damaged_quantity: 4, under_maintenance_quantity: 2 }))));

    const res = await request(appWith()).patch(`/api/equipment/${TYPE_ID}`).send({ totalQuantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'totalQuantity', message: "can't be below damaged plus under maintenance (6)" },
    ]);
  });

  it('SCRUM275_AC3_answers_400_for_an_empty_change', async () => {
    const res = await request(appWith()).patch(`/api/equipment/${TYPE_ID}`).send({});

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});


describe('AC8: the change history', () => {
  const historyRow = {
    id: 1,
    equipment_type_id: TYPE_ID,
    field_name: 'total_quantity',
    old_value: '10',
    new_value: '12',
    note: null,
    changed_by: STAFF_ID,
    changed_at: '2026-10-01T09:00:00+00:00',
  };

  it('SCRUM275_AC8_gives_technical_support_a_types_history', async () => {
    from.mockReturnValueOnce(queryStub(ok([historyRow])));

    const res = await request(appWith()).get(`/api/equipment/${TYPE_ID}/history`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ field: 'totalQuantity', oldValue: '10', newValue: '12', changedBy: STAFF_ID });
  });

  it.each(OTHER_ROLES)('SCRUM275_AC8_refuses_%s_on_the_history_with_403', async (role) => {
    const res = await request(appWith(signedInAs(role))).get(`/api/equipment/${TYPE_ID}/history`);

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC8_answers_400_for_a_malformed_id', async () => {
    const res = await request(appWith()).get('/api/equipment/not-a-uuid/history');

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC8_records_the_signed_in_user_and_ignores_one_named_in_the_body', async () => {
    const insert = queryStub(ok(typeRow()));
    const insertSpy = vi.spyOn(insert, 'insert');
    from.mockReturnValueOnce(queryStub(ok([]))).mockReturnValueOnce(insert);

    await request(appWith())
      .post('/api/equipment')
      .send({ name: 'Projector', totalQuantity: 10, lastModifiedBy: 'someone-else', userId: 'someone-else' });

    expect(insertSpy.mock.calls[0][0].last_modified_by).toBe(STAFF_ID);
  });
});


describe('AC4 and AC5: recording damaged and under-maintenance quantities', () => {
  const url = `/api/equipment/${TYPE_ID}/condition`;
  const body = { damagedQuantity: 4, note: 'dropped in transit' };

  it('SCRUM275_AC4_lets_technical_support_record_damage_and_returns_the_usable_figure', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedType(typeRow({ damaged_quantity: 4 })));

    const res = await request(appWith()).patch(url).send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ damagedQuantity: 4, usableQuantity: 6 });
  });

  it.each(OTHER_ROLES)('SCRUM275_AC1_refuses_%s_on_recording_damage_with_403_and_changes_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role))).patch(url).send(body);

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_answers_400_listing_a_missing_note', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).patch(url).send({ damagedQuantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([{ field: 'note', message: 'is required' }]);
  });

  it('SCRUM275_AC4_answers_400_when_damaged_plus_maintenance_would_exceed_the_total', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ total_quantity: 5, damaged_quantity: 0, under_maintenance_quantity: 0 }))));

    const res = await request(appWith()).patch(url).send({ damagedQuantity: 6, note: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.details[0].message).toBe("damaged plus under maintenance (6) can't exceed the total (5)");
  });

  it('SCRUM275_AC4_answers_400_when_nothing_would_change', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).patch(url).send({ damagedQuantity: 0, note: 'same again' });

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('equipment');
  });

  it('SCRUM275_AC4_answers_400_for_a_body_naming_neither_quantity_without_a_query', async () => {
    const res = await request(appWith()).patch(url).send({ note: 'x' });

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_answers_404_for_an_unknown_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(null)));

    const res = await request(appWith()).patch(url).send(body);

    expect(res.status).toBe(404);
  });

  it('SCRUM275_AC4_answers_400_for_a_malformed_id', async () => {
    const res = await request(appWith()).patch('/api/equipment/not-a-uuid/condition').send(body);

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC4_records_the_signed_in_user_and_the_note', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedType(typeRow({ damaged_quantity: 4 })));

    await request(appWith()).patch(url).send({ ...body, lastModifiedBy: 'someone-else', p_caller: 'someone-else' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_caller: STAFF_ID,
      p_damaged: 4,
      p_note: 'dropped in transit',
    });
  });
});


describe('AC6: retire and reinstate', () => {
  const RETIRED = '2026-10-01T09:00:00+00:00';
  const retireUrl = `/api/equipment/${TYPE_ID}/retire`;
  const reinstateUrl = `/api/equipment/${TYPE_ID}/reinstate`;

  it('SCRUM275_AC6_lets_technical_support_retire_a_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedType(typeRow({ retired_at: RETIRED })));

    const res = await request(appWith()).post(retireUrl);

    expect(res.status).toBe(200);
    expect(res.body.retiredAt).toBe(RETIRED);
  });

  it('SCRUM275_AC6_lets_technical_support_reinstate_a_type', async () => {
    from
      .mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))))
      .mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).post(reinstateUrl);

    expect(res.status).toBe(200);
    expect(res.body.retiredAt).toBeNull();
  });

  it.each(OTHER_ROLES)('SCRUM275_AC1_refuses_%s_on_retire_with_403_and_changes_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role))).post(retireUrl);

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it.each(OTHER_ROLES)('SCRUM275_AC1_refuses_%s_on_reinstate_with_403_and_changes_nothing', async (role) => {
    const res = await request(appWith(signedInAs(role))).post(reinstateUrl);

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_answers_409_with_a_code_when_retiring_a_retired_type', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow({ retired_at: RETIRED }))));

    const res = await request(appWith()).post(retireUrl);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_ALREADY_RETIRED');
  });

  it('SCRUM275_AC6_answers_409_with_a_code_when_reinstating_a_type_that_is_not_retired', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));

    const res = await request(appWith()).post(reinstateUrl);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EQUIPMENT_NOT_RETIRED');
  });

  it('SCRUM275_AC6_answers_404_for_an_unknown_type_on_both', async () => {
    from.mockReturnValueOnce(queryStub(ok(null))).mockReturnValueOnce(queryStub(ok(null)));

    expect((await request(appWith()).post(retireUrl)).status).toBe(404);
    expect((await request(appWith()).post(reinstateUrl)).status).toBe(404);
  });

  it('SCRUM275_AC6_answers_400_for_a_malformed_id_on_both', async () => {
    expect((await request(appWith()).post('/api/equipment/not-a-uuid/retire')).status).toBe(400);
    expect((await request(appWith()).post('/api/equipment/not-a-uuid/reinstate')).status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('SCRUM275_AC6_records_the_signed_in_user_when_retiring', async () => {
    from.mockReturnValueOnce(queryStub(ok(typeRow())));
    rpc.mockResolvedValueOnce(savedType(typeRow({ retired_at: RETIRED })));

    await request(appWith()).post(retireUrl).send({ lastModifiedBy: 'someone-else', p_caller: 'someone-else' });

    expect(rpc.mock.calls[0][1].p_caller).toBe(STAFF_ID);
  });
});