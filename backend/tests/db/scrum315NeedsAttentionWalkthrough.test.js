/**
 * Equipment is lost after a Confirmed event reserved it, and the coordinator's side shows
 * it, walked through over HTTP on a real database.
 *
 * Why real routes. The service tests answer from fake clients and the database
 * tests call the SQL directly; neither shows that the routers, services and
 * functions agree. Here the real equipment, event equipment
 * and event request routers run over the final schema in PGlite, so each status
 * and needsAttention value below comes from where it would in production.
 *
 *   AC5  the event record's equipment section marks the line; the coordinator
 *        is told what happened
 *   AC6  the event stays Confirmed and appears as Needs attention, with the
 *        reason, until the flagged reservations are resolved
 *
 * The adapter is the shared pgliteSupabaseClient, extended only for the two
 * PostgREST embeds needsAttention reads (bookings and equipment reservations).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createEquipmentRouter } from '../../src/routes/equipment.js';
import { createEventEquipmentRouter } from '../../src/routes/eventEquipment.js';
import { createEventRequestRouter } from '../../src/routes/eventRequests.js';
import { ROLE } from '../../src/domain/userRole.js';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { reservationSteps } from './helpers/equipment.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';

// equipmentService and the preview service use the shared client directly, so it
// is replaced by one that forwards to the PGlite client built in beforeAll.
const forward = vi.hoisted(() => ({ client: null }));
vi.mock('../../src/config/supabaseClient.js', () => {
  const proxy = {
    from: (...args) => forward.client.from(...args),
    rpc: (...args) => forward.client.rpc(...args),
  };
  return { supabase: proxy, default: proxy };
});

const DAY = 86_400_000;
const BASE = Math.floor((Date.now() + 10 * DAY) / DAY) * DAY;
const hour = (h) => new Date(BASE + h * 3_600_000).toISOString();

const BOOKING_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object('status', b.status)), '[]'::json)
      from bookings b where b.event_request_id = ${table}.id) as bookings`;
const RESERVATION_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object(
      'flagged', r.flagged, 'released_at', r.released_at, 'flag_reason', r.flag_reason, 'flag_code', r.flag_code)), '[]'::json)
      from equipment_reservations r where r.event_request_id = ${table}.id) as equipment_reservations`;
const BOOKING_TEXT = /\bbookings\(status\)/;
const RESERVATION_TEXT = /\bequipment_reservations\(flagged, released_at, flag_reason, flag_code\)/;

function pgliteClient(db) {
  return pgliteSupabaseClient(db, {
    columns(cols, table) {
      if (/\w+\(/.test(cols.replace(BOOKING_TEXT, '').replace(RESERVATION_TEXT, ''))) {
        throw new Error(`pgliteClient: an embed in "${cols}" is not on this path`);
      }
      return cols.replace(BOOKING_TEXT, BOOKING_EMBED(table)).replace(RESERVATION_TEXT, RESERVATION_EMBED(table));
    },
  });
}

const LOST = 'Equipment unavailable: Fewer units of this equipment are usable (Dropped)';

describe('SCRUM-310 (SCRUM-315): equipment lost after a Confirmed event reserved it, over HTTP on a real database', () => {
  let db;
  let client;
  let organiser;
  let coordinator;
  let tech;
  let seq = 0;

  const { one } = queriesFor(() => db);
  const steps = reservationSteps(
    () => ({ db, organiser, coordinator, reviewerA: tech }),
    { start: hour(1), end: hour(2), newStart: hour(3), newEnd: hour(4) },
  );

  const as = (role, id) => (req, _res, next) => {
    req.user = { id, email: 'someone@example.com', role };
    next();
  };
  const app = (role, id) => {
    const requireAuth = as(role, id);
    return express()
      .use(express.json())
      .use('/api/event-requests/:id/equipment', createEventEquipmentRouter({ client, requireAuth }))
      .use('/api/equipment', createEquipmentRouter({ client, requireAuth }))
      .use('/api/event-requests', createEventRequestRouter({ client, requireAuth }));
  };
  const asCoordinator = () => app(ROLE.EVENT_COORDINATOR, coordinator);
  const asTech = () => app(ROLE.TECHNICAL_SUPPORT_STAFF, tech);

  /** The event as the coordinator's review screen reads it. */
  const inMine = async (eventId) => {
    const res = await request(asCoordinator()).get(`/api/event-requests/${eventId}/review`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const equipmentOf = async (eventId) => {
    const res = await request(asCoordinator()).get(`/api/event-requests/${eventId}/equipment`);
    expect(res.status).toBe(200);
    return res.body.request.lines;
  };

  /** A confirmed event holding `quantity` units of a new type, reserved through the real routes. */
  async function confirmedEventHolding(quantity = 4, { total = 4 } = {}) {
    const type = (await one(
      'insert into equipment_types (name, total_quantity) values ($1, $2) returning id',
      [`Speaker ${++seq} ${Math.random()}`, total],
    )).id;
    const eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      assigned_coordinator_id: coordinator,
      event_name: `Gala ${seq}`,
      proposed_start: hour(1),
      proposed_end: hour(3),
    });
    // The review steps are the SQL functions behind the review routes, which the
    // adapter does not need to carry here: this file is about what the coordinator sees.
    const lineId = (await steps.add(eventId, type, quantity)).request.lines[0].id;
    await steps.start(eventId, tech);
    await steps.reserve(eventId, tech, lineId, quantity);

    await withSafetyReviewTransitionGuardDisabled(db, () =>
      db.query("update event_requests set status = 'confirmed' where id = $1", [eventId]),
    );
    const { id: reservationId } = await one('select id from equipment_reservations where event_request_id = $1', [eventId]);
    return { type, eventId, lineId, reservationId };
  }

  /** What technical support does: record damage, look at the list, confirm exactly that list. */
  async function loseEquipment(type, damaged = 3) {
    const preview = await request(asTech()).post(`/api/equipment/${type}/change-preview`).send({ damagedQuantity: damaged });
    expect(preview.status).toBe(200);
    const saved = await request(asTech())
      .patch(`/api/equipment/${type}/condition`)
      .send({
        damagedQuantity: damaged,
        underMaintenanceQuantity: 0,
        note: 'Dropped',
        confirmedReservationIds: preview.body.affected.map((a) => a.reservationId),
      });
    return { preview, saved };
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    organiser = await seedUser(db, { email: 'o@x', role: 'event_organiser' });
    coordinator = await seedUser(db, { email: 'c@x', role: 'event_coordinator' });
    tech = await seedUser(db, { email: 't@x', role: 'technical_support_staff' });
    client = pgliteClient(db);
    forward.client = client;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM310_AC6_a_confirmed_event_with_nothing_flagged_is_not_on_the_list', async () => {
    const { eventId, lineId } = await confirmedEventHolding();

    const event = await inMine(eventId);

    expect(event).toMatchObject({ status: 'confirmed', needsAttention: false, attentionReasons: [] });
    expect((await equipmentOf(eventId)).find((l) => l.id === lineId).flaggedReservations).toEqual([]);
  });

  it('SCRUM310_AC5_AC6_lost_equipment_marks_the_line_and_puts_the_confirmed_event_on_the_list', async () => {
    const { type, eventId, lineId, reservationId } = await confirmedEventHolding();

    const { preview, saved } = await loseEquipment(type);

    expect(preview.body.affected.map((a) => a.reservationId)).toEqual([reservationId]);
    expect(saved.status).toBe(200);
    expect(saved.body.flaggedCount).toBe(1);

    const event = await inMine(eventId);
    expect(event).toMatchObject({ status: 'confirmed', needsAttention: true, attentionReasons: [LOST] });

    const line = (await equipmentOf(eventId)).find((l) => l.id === lineId);
    expect(line.flaggedReservations).toHaveLength(1);
    expect(line.flaggedReservations[0]).toMatchObject({
      id: reservationId,
      quantity: 4,
      reason: 'Fewer units of this equipment are usable (Dropped)',
    });
    expect(line.flaggedReservations[0].flaggedAt).toEqual(expect.any(String));

  });

  it('SCRUM310_AC6_the_event_stays_confirmed_through_the_loss', async () => {
    const { type, eventId } = await confirmedEventHolding();

    await loseEquipment(type);

    expect((await one('select status from event_requests where id = $1', [eventId])).status).toBe('confirmed');
  });

  it('SCRUM310_AC6_an_event_that_holds_none_of_the_lost_equipment_is_not_on_the_list', async () => {
    const hit = await confirmedEventHolding();
    const untouched = await confirmedEventHolding();

    await loseEquipment(hit.type);

    expect((await inMine(untouched.eventId)).needsAttention).toBe(false);
    expect((await inMine(hit.eventId)).needsAttention).toBe(true);
  });

  it('SCRUM310_AC6_the_entry_goes_once_the_flagged_reservation_is_released', async () => {
    const { type, eventId, lineId, reservationId } = await confirmedEventHolding();
    await loseEquipment(type);
    expect((await inMine(eventId)).needsAttention).toBe(true);

    // The loss sent the request back to Pending review; technical support pick it up again.
    await steps.start(eventId, tech);
    await steps.release(eventId, tech, reservationId, 'Equipment was damaged');

    expect(await inMine(eventId)).toMatchObject({ status: 'confirmed', needsAttention: false, attentionReasons: [] });
    expect((await equipmentOf(eventId)).find((l) => l.id === lineId).flaggedReservations).toEqual([]);
  });

  it('SCRUM310_AC6_the_entry_stays_while_any_flagged_reservation_remains', async () => {
    const { type, eventId, lineId, reservationId } = await confirmedEventHolding(2, { total: 4 });
    await db.query('update equipment_types set total_quantity = 8 where id = $1', [type]);
    const { id: second } = await one(
      `insert into equipment_reservations
         (equipment_type_id, event_request_id, equipment_line_id, quantity, start_at, end_at, flagged, flag_reason, flag_code, flagged_at)
       values ($1, $2, $3, 1, $4, $5, true, 'Lost in transit', 'equipment_lost', now()) returning id`,
      [type, eventId, lineId, hour(1), hour(3)],
    );
    await db.query(
      'update equipment_reservations set flagged = true, flag_reason = $2, flag_code = $3, flagged_at = now() where id = $1',
      [reservationId, 'Lost in transit', 'equipment_lost'],
    );

    await db.query('update equipment_reservations set released_at = now() where id = $1', [reservationId]);
    const event = await inMine(eventId);
    expect(event.needsAttention).toBe(true);
    expect(event.attentionReasons).toEqual(['Equipment unavailable: Lost in transit']);

    await db.query('update equipment_reservations set released_at = now() where id = $1', [second]);
    expect((await inMine(eventId)).needsAttention).toBe(false);
  });

  it('SCRUM310_AC5_AC6_a_date_change_flag_is_on_the_list_but_is_not_called_equipment_lost', async () => {
    const { eventId, lineId, reservationId } = await confirmedEventHolding();
    await db.query("select flag_equipment_reservations($1::uuid[], 'The event date or time changed')", [[reservationId]]);

    const event = await inMine(eventId);
    expect(event).toMatchObject({
      status: 'confirmed',
      needsAttention: true,
      attentionReasons: ['Equipment flagged for review: The event date or time changed'],
    });
    const [flag] = (await equipmentOf(eventId)).find((l) => l.id === lineId).flaggedReservations;
    expect(flag).toMatchObject({ id: reservationId, code: null, reason: 'The event date or time changed' });
  });

  it('SCRUM310_AC5_a_lost_equipment_flag_carries_its_code_to_the_event_record', async () => {
    const { type, eventId, lineId } = await confirmedEventHolding();
    await loseEquipment(type);

    const [flag] = (await equipmentOf(eventId)).find((l) => l.id === lineId).flaggedReservations;

    expect(flag.code).toBe('equipment_lost');
  });

  it('SCRUM310_AC6_a_flag_cleared_by_hand_takes_the_event_off_the_list', async () => {
    const { type, eventId, reservationId } = await confirmedEventHolding();
    await loseEquipment(type);

    await db.query(
      'update equipment_reservations set flagged = false, flag_reason = null, flagged_at = null where id = $1',
      [reservationId],
    );

    expect((await inMine(eventId)).needsAttention).toBe(false);
  });
});
