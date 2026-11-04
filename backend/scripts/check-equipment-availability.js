/**
 * End-to-end proof for the equipment availability check (SCRUM-23).
 *
 * Run with: npm run equipment-availability:check
 *
 * Builds a small world in the real database (two events, one equipment type
 * with 10 units, 1 damaged and 1 under maintenance, and reservations that
 * exercise every boundary), asks the check about it, and then removes
 * everything it created. It is the counterpart to the mocked tests, which
 * cannot show that the SQL function counts correctly.
 *
 * The period under test is 10:00 to 12:00. The reservations, all of one type:
 *
 *   ends exactly at 10:00        qty 1   does not overlap (AC4)
 *   starts exactly at 12:00      qty 1   does not overlap (AC4)
 *   09:00 to 11:00, straddles    qty 2   overlaps
 *   10:30 to 11:30, inside       qty 1   overlaps
 *   11:00 to 13:00, flagged      qty 1   overlaps and counts anyway (AC6)
 *   10:00 to 12:00, released     qty 3   does not count
 *   10:00 to 12:00, own event A  qty 2   counts, unless event A is the one asking (AC7)
 *
 * So the counted total is 6, and 10 - 1 - 1 - 6 = 2 are available. Asking as
 * event A leaves out its 2, so 4 are available.
 *
 * Needs a profile with role event_organiser to own the test events. Exits
 * non-zero on any failure.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import { checkEquipmentAvailability } from '../src/services/equipmentAvailabilityService.js';
import { createHarness, failureOf } from './lib/harness.js';

const PREFIX = `__check_availability_${Date.now()}`;
const PERIOD = { startAt: '2026-12-01T10:00:00Z', endAt: '2026-12-01T12:00:00Z' };
const at = (time) => `2026-12-01T${time}:00Z`;

const created = { typeId: null, eventIds: [] };
const harness = createHarness();
const { check } = harness;

async function insertRow(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select('id').single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

async function count(table) {
  const { count: total, error } = await supabase.from(table).select('id', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return total;
}

async function cleanup() {
  const steps = [
    () => supabase.from('equipment_reservations').delete().eq('equipment_type_id', created.typeId),
    () => supabase.from('equipment_lines').delete().eq('equipment_type_id', created.typeId),
    () => supabase.from('equipment_requests').delete().in('event_request_id', created.eventIds),
    () => supabase.from('event_requests').delete().in('id', created.eventIds),
    () => supabase.from('equipment_type_history').delete().eq('equipment_type_id', created.typeId),
    () => supabase.from('equipment_types').delete().eq('id', created.typeId),
  ];
  for (const step of steps) {
    const { error } = await step();
    if (error) console.error(`  cleanup warning: ${error.message}`);
  }
}

async function main() {
  console.log('\nEquipment availability check\n');

  const organiser = await supabase.from('profiles').select('id').eq('role', 'event_organiser').limit(1).maybeSingle();
  if (!organiser.data) throw new Error('no profile with role event_organiser to own the test events');

  const eventA = await insertRow('event_requests', { organiser_id: organiser.data.id, event_name: `${PREFIX} own event` });
  const eventB = await insertRow('event_requests', { organiser_id: organiser.data.id, event_name: `${PREFIX} other event` });
  created.eventIds = [eventA, eventB];

  const typeId = await insertRow('equipment_types', {
    name: `${PREFIX}_projector`,
    total_quantity: 10,
    damaged_quantity: 1,
    under_maintenance_quantity: 1,
  });
  created.typeId = typeId;

  const requestA = await insertRow('equipment_requests', { event_request_id: eventA });
  const requestB = await insertRow('equipment_requests', { event_request_id: eventB });
  const lineA = await insertRow('equipment_lines', { equipment_request_id: requestA, equipment_type_id: typeId, quantity: 2 });
  const lineB = await insertRow('equipment_lines', { equipment_request_id: requestB, equipment_type_id: typeId, quantity: 7 });

  async function reserve({ event, line, quantity, start, end, flagged = false, released = false }) {
    return insertRow('equipment_reservations', {
      equipment_type_id: typeId,
      event_request_id: event,
      equipment_line_id: line,
      quantity,
      start_at: at(start),
      end_at: at(end),
      flagged,
      released_at: released ? '2026-11-01T00:00:00Z' : null,
    });
  }

  await reserve({ event: eventB, line: lineB, quantity: 1, start: '08:00', end: '10:00' });
  await reserve({ event: eventB, line: lineB, quantity: 1, start: '12:00', end: '14:00' });
  await reserve({ event: eventB, line: lineB, quantity: 2, start: '09:00', end: '11:00' });
  await reserve({ event: eventB, line: lineB, quantity: 1, start: '10:30', end: '11:30' });
  await reserve({ event: eventB, line: lineB, quantity: 1, start: '11:00', end: '13:00', flagged: true });
  await reserve({ event: eventB, line: lineB, quantity: 3, start: '10:00', end: '12:00', released: true });
  await reserve({ event: eventA, line: lineA, quantity: 2, start: '10:00', end: '12:00' });

  const base = { equipmentTypeId: typeId, ...PERIOD };

  // --- the figure ------------------------------------------------------------
  const full = await checkEquipmentAvailability({ ...base, quantity: 2 });
  check('breakdown: total 10, damaged 1, under maintenance 1', full.breakdown?.total === 10 && full.breakdown.damaged === 1 && full.breakdown.underMaintenance === 1);
  check('reserved is 6: straddling 2, inside 1, flagged 1, own event 2', full.breakdown?.reserved === 6, `got ${full.breakdown?.reserved}`);
  check('available is 10 - 1 - 1 - 6 = 2', full.breakdown?.available === 2 && full.quantityAvailable === 2, `got ${full.quantityAvailable}`);

  // --- the three results -------------------------------------------------------
  check('2 wanted, 2 available: Fully available', full.result === 'Fully available', full.result);
  const partial = await checkEquipmentAvailability({ ...base, quantity: 3 });
  check('3 wanted, 2 available: Partially available, showing 2', partial.result === 'Partially available' && partial.quantityAvailable === 2, partial.result);

  // --- which reservations are listed ----------------------------------------------
  const listed = full.reservations.map((r) => r.quantity).sort();
  check('four overlapping reservations listed (not the touching or released ones)', JSON.stringify(listed) === JSON.stringify([1, 1, 2, 2]), JSON.stringify(listed));
  check('each carries its event name', full.reservations.every((r) => typeof r.eventName === 'string' && r.eventName.startsWith(PREFIX)));
  check('the flagged reservation is listed and counted', full.reservations.some((r) => r.flagged === true));
  check('a reservation ending exactly at the start is not listed', !full.reservations.some((r) => r.startAt.startsWith('2026-12-01T08:00')));
  check('a reservation starting exactly at the end is not listed', !full.reservations.some((r) => r.startAt.startsWith('2026-12-01T12:00')));
  check('the released reservation is not listed', !full.reservations.some((r) => r.quantity === 3));
  check('listed in start order', full.reservations.every((r, i, all) => i === 0 || all[i - 1].startAt <= r.startAt));

  // --- the event's own reservations ------------------------------------------------
  const asEventA = await checkEquipmentAvailability({ ...base, quantity: 4, eventRequestId: eventA });
  check('as the event itself, its own 2 are left out: available 4', asEventA.quantityAvailable === 4, `got ${asEventA.quantityAvailable}`);
  check('asking as the event, 4 wanted is Fully available', asEventA.result === 'Fully available', asEventA.result);
  check('its own reservation is not listed', asEventA.reservations.length === 3 && !asEventA.reservations.some((r) => r.eventRequestId === eventA));
  const asEventB = await checkEquipmentAvailability({ ...base, quantity: 2, eventRequestId: eventB });
  check('as the other event, event A\'s 2 still count', asEventB.reservations.some((r) => r.eventRequestId === eventA));

  // --- a different period ------------------------------------------------------------
  const quiet = await checkEquipmentAvailability({ equipmentTypeId: typeId, quantity: 8, startAt: at('16:00'), endAt: at('18:00') });
  check('a quiet period has nothing reserved', quiet.breakdown?.reserved === 0 && quiet.reservations.length === 0);
  check('8 wanted, 8 usable: Fully available', quiet.result === 'Fully available', quiet.result);

  // --- the period edges -----------------------------------------------------------------
  const justBefore = await checkEquipmentAvailability({ equipmentTypeId: typeId, quantity: 1, startAt: at('08:00'), endAt: at('09:00') });
  check('a period 08:00 to 09:00 overlaps only the 08:00 to 10:00 reservation (qty 1)', justBefore.breakdown?.reserved === 1, `got ${justBefore.breakdown?.reserved}`);
  const touching = await checkEquipmentAvailability({ equipmentTypeId: typeId, quantity: 1, startAt: at('12:00'), endAt: at('13:00') });
  check('a period starting at 12:00 does not see the 10:00 to 12:00 reservations', !touching.reservations.some((r) => r.quantity === 2 && r.startAt.startsWith('2026-12-01T10:00')), JSON.stringify(touching.reservations.map((r) => r.startAt)));

  // --- over-committed: negative inside, zero outside -----------------------------------------
  await reserve({ event: eventB, line: lineB, quantity: 5, start: '10:00', end: '12:00' });
  const over = await checkEquipmentAvailability({ ...base, quantity: 1 });
  check('over-committed: Unavailable', over.result === 'Unavailable', over.result);
  check('over-committed: the quantity is shown as 0, never negative', over.quantityAvailable === 0 && over.breakdown.available === 0, `got ${over.quantityAvailable}`);
  const raw = await supabase.rpc('equipment_availability', { p_equipment_type_id: typeId, p_start_at: PERIOD.startAt, p_end_at: PERIOD.endAt, p_event_request_id: null });
  check('the database function itself returns the raw negative figure (-3)', raw.data?.available === -3, `got ${raw.data?.available}`);

  // --- unknown and retired types ------------------------------------------------------------------
  const unknown = await checkEquipmentAvailability({ ...base, equipmentTypeId: randomUUID(), quantity: 1 });
  check('an unknown type is Unavailable with a not-found message', unknown.result === 'Unavailable' && /not found/.test(unknown.message ?? ''), unknown.message);
  await supabase.from('equipment_types').update({ retired_at: new Date().toISOString() }).eq('id', typeId);
  const retired = await checkEquipmentAvailability({ ...base, quantity: 1 });
  check('a retired type is Unavailable with a retired message', retired.result === 'Unavailable' && /retired/.test(retired.message ?? ''), retired.message);
  check('a retired type has no breakdown and no reservations', retired.breakdown === null && retired.reservations.length === 0);
  await supabase.from('equipment_types').update({ retired_at: null }).eq('id', typeId);

  // --- bad input --------------------------------------------------------------------------------------
  const bad = await failureOf(checkEquipmentAvailability({ equipmentTypeId: typeId, quantity: 0, startAt: PERIOD.endAt, endAt: PERIOD.startAt }));
  check('bad input is refused, listing quantity and endAt', bad?.status === 400 && bad.details.some((d) => d.field === 'quantity') && bad.details.some((d) => d.field === 'endAt'), bad?.message);
  const direct = await supabase.rpc('equipment_availability', { p_equipment_type_id: typeId, p_start_at: PERIOD.endAt, p_end_at: PERIOD.startAt, p_event_request_id: null });
  check('the database function refuses a reversed period itself (22023)', direct.error?.code === '22023', direct.error?.code);

  // --- a check changes nothing ----------------------------------------------------------------------------
  const before = { reservations: await count('equipment_reservations'), requests: await count('equipment_requests'), lines: await count('equipment_lines') };
  await checkEquipmentAvailability({ ...base, quantity: 3 });
  await checkEquipmentAvailability({ ...base, quantity: 1, eventRequestId: eventA });
  const after = { reservations: await count('equipment_reservations'), requests: await count('equipment_requests'), lines: await count('equipment_lines') };
  check('no reservation, request or line was added or removed', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
  const type = await supabase.from('equipment_types').select('total_quantity, damaged_quantity, under_maintenance_quantity, retired_at').eq('id', typeId).single();
  check('the type is untouched', type.data.total_quantity === 10 && type.data.damaged_quantity === 1 && type.data.under_maintenance_quantity === 1 && type.data.retired_at === null);

  console.log(harness.failures === 0 ? '\nAll checks passed.\n' : `\n${harness.failures} check(s) FAILED.\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nCheck aborted:', err.message ?? err);
  harness.failures += 1;
} finally {
  await cleanup();
}

process.exit(harness.failures === 0 ? 0 : 1);
