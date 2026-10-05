/**
 * End-to-end proof for the equipment catalogue (SCRUM-276, SCRUM-66).
 *
 * Run with: npm run equipment:check
 *
 * Exercises the service against the real database, then removes everything it
 * created. It is the counterpart to tests/services/equipmentService.test.js,
 * which mocks Supabase: only this script can show that Postgres really enforces
 * what the service relies on.
 *
 * SCRUM-279 adds the history steps at the end.
 *
 * What it proves that the mocked tests cannot:
 *   - the ilike name check and the unique index on lower(trim(name)) agree
 *   - the check constraints from 022 refuse bad direct writes
 *   - the updated_at trigger fires
 *   - retired types leave the active list but stay in the full catalogue
 *   - ilike wildcards in a name are matched literally
 *   - the history trigger writes the right old and new values, newest first
 *
 * The check-constraint steps write rows with random ids on purpose: Postgres
 * evaluates a CHECK before the foreign keys, so a bad row is refused with 23514
 * without needing a real event request. Nothing is written when they pass.
 *
 * Exits non-zero on any failure.
 */

import { randomUUID } from 'node:crypto';

import { supabase } from '../src/config/supabaseClient.js';
import {
  createEquipmentType,
  updateEquipmentType,
  listEquipmentTypes,
  listActiveEquipmentTypes,
  getEquipmentTypeHistory,
} from '../src/services/equipmentService.js';

const PREFIX = `__check_equipment_${Date.now()}`;
const createdIds = [];
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

/** Resolve to the error a promise rejects with, or null if it resolves. */
async function failureOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

async function cleanup() {
  if (createdIds.length === 0) return;
  // History first: ON DELETE RESTRICT blocks deleting a type that has any.
  await supabase.from('equipment_type_history').delete().in('equipment_type_id', createdIds);
  await supabase.from('equipment_types').delete().in('id', createdIds);
}

async function track(input) {
  const type = await createEquipmentType(input);
  createdIds.push(type.id);
  return type;
}

async function main() {
  console.log('\nEquipment service check\n');

  // --- create and read back ------------------------------------------------
  const type = await track({
    name: `${PREFIX}_projector`,
    description: 'HD',
    category: 'Display',
    location: 'Store 1',
    totalQuantity: 10,
  });

  check('type created', Boolean(type.id));
  check('total stored', type.totalQuantity === 10, `got ${type.totalQuantity}`);
  check('usable starts equal to total', type.usableQuantity === 10, `got ${type.usableQuantity}`);
  check('retired starts empty', type.retiredAt === null);

  // --- name uniqueness: service pre-check, then the index behind it ---------
  const duplicate = await failureOf(
    createEquipmentType({ name: type.name.toUpperCase(), totalQuantity: 1 }),
  );
  check(
    'same name in another case refused, listing name',
    duplicate?.status === 400 && duplicate.details.some((d) => d.field === 'name'),
    duplicate?.message,
  );

  const indexed = await supabase
    .from('equipment_types')
    .insert({ name: `  ${type.name.toUpperCase()}  `, total_quantity: 1 });
  check('unique index refuses a direct duplicate (23505)', indexed.error?.code === '23505', indexed.error?.code);

  // --- wildcards are matched literally ---------------------------------------
  const percent = await track({ name: `${PREFIX}_50%off`, totalQuantity: 1 });
  const lookalike = await failureOf(
    track({ name: `${PREFIX}_50Xoff`, totalQuantity: 1 }),
  );
  check('a % in a name is not treated as a wildcard', lookalike === null && Boolean(percent.id));

  // --- check constraints from 022, on direct writes --------------------------
  const tooManyDamaged = await supabase
    .from('equipment_types')
    .update({ damaged_quantity: 11 })
    .eq('id', type.id);
  check('damaged above the total refused (23514)', tooManyDamaged.error?.code === '23514', tooManyDamaged.error?.code);

  const combined = await supabase
    .from('equipment_types')
    .update({ damaged_quantity: 6, under_maintenance_quantity: 5 })
    .eq('id', type.id);
  check('damaged plus maintenance above the total refused (23514)', combined.error?.code === '23514', combined.error?.code);

  const negative = await supabase
    .from('equipment_types')
    .insert({ name: `${PREFIX}_neg`, total_quantity: -1 });
  check('a negative total refused (23514)', negative.error?.code === '23514', negative.error?.code);

  const blank = await supabase.from('equipment_types').insert({ name: '   ', total_quantity: 1 });
  check('a blank name refused (23514)', blank.error?.code === '23514', blank.error?.code);

  const badLine = await supabase
    .from('equipment_lines')
    .insert({ equipment_request_id: randomUUID(), equipment_type_id: type.id, quantity: 0 });
  check('a line quantity of zero refused (23514)', badLine.error?.code === '23514', badLine.error?.code);

  const badPeriod = await supabase.from('equipment_reservations').insert({
    equipment_type_id: type.id,
    event_request_id: randomUUID(),
    equipment_line_id: randomUUID(),
    quantity: 1,
    start_at: '2026-12-01T10:00:00Z',
    end_at: '2026-12-01T09:00:00Z',
  });
  check('a reservation ending before it starts refused (23514)', badPeriod.error?.code === '23514', badPeriod.error?.code);

  const badRelease = await supabase.from('equipment_reservations').insert({
    equipment_type_id: type.id,
    event_request_id: randomUUID(),
    equipment_line_id: randomUUID(),
    quantity: 1,
    start_at: '2026-12-01T09:00:00Z',
    end_at: '2026-12-01T10:00:00Z',
    release_reason: 'no release time',
  });
  check('release details without a release time refused (23514)', badRelease.error?.code === '23514', badRelease.error?.code);

  const badStatus = await supabase
    .from('equipment_requests')
    .insert({ event_request_id: randomUUID(), status: 'bogus' });
  check('an unknown request status refused (22P02)', badStatus.error?.code === '22P02', badStatus.error?.code);

  // --- usable quantity and the total floor, against real rows ----------------
  const marked = await supabase
    .from('equipment_types')
    .update({ damaged_quantity: 2, under_maintenance_quantity: 1 })
    .eq('id', type.id);
  check('damaged 2 and maintenance 1 accepted', marked.error === null, marked.error?.message);

  const catalogue = await listEquipmentTypes();
  const listed = catalogue.find((t) => t.id === type.id);
  check('usable is total minus damaged minus maintenance', listed?.usableQuantity === 7, `got ${listed?.usableQuantity}`);

  const tooLow = await failureOf(updateEquipmentType(type.id, { totalQuantity: 2 }));
  check(
    'total below damaged plus maintenance refused with the figure',
    tooLow?.status === 400 && /\(3\)/.test(tooLow.details?.[0]?.message ?? ''),
    tooLow?.message,
  );

  const exact = await updateEquipmentType(type.id, { totalQuantity: 3 });
  check('total equal to damaged plus maintenance allowed, usable 0', exact.usableQuantity === 0, `got ${exact.usableQuantity}`);

  // --- edit: only the fields sent change, and updated_at moves ---------------
  const before = (await listEquipmentTypes()).find((t) => t.id === type.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const edited = await updateEquipmentType(type.id, { location: 'Store 2' });
  check('location changed', edited.location === 'Store 2', edited.location);
  check('other fields untouched', edited.name === type.name && edited.category === 'Display');
  check('updated_at advanced by the trigger', new Date(edited.updatedAt) > new Date(before.updatedAt));

  const renamed = await updateEquipmentType(type.id, { name: type.name.toUpperCase() });
  check('renaming a type to its own name in another case is allowed', renamed.name === type.name.toUpperCase());

  const clash = await failureOf(updateEquipmentType(type.id, { name: percent.name }));
  check('renaming onto another type refused, listing name', clash?.status === 400 && clash.details.some((d) => d.field === 'name'));

  const missing = await failureOf(updateEquipmentType(randomUUID(), { name: `${PREFIX}_x` }));
  check('editing an unknown type answers not found', missing?.status === 404, missing?.message);

  // --- retired types: out of the picker, still in the catalogue ---------------
  const retired = await supabase
    .from('equipment_types')
    .update({ retired_at: new Date().toISOString() })
    .eq('id', percent.id);
  check('type marked retired', retired.error === null, retired.error?.message);

  const active = await listActiveEquipmentTypes();
  check('retired type absent from the active list', !active.some((t) => t.id === percent.id));
  check('active types still listed', active.some((t) => t.id === type.id));
  check('active list carries no quantities', !('totalQuantity' in (active[0] ?? {})));

  const all = await listEquipmentTypes();
  check('retired type still in the full catalogue', all.some((t) => t.id === percent.id && t.retiredAt));

  const editedRetired = await updateEquipmentType(percent.id, { category: 'Old' });
  check('a retired type can still be edited', editedRetired.category === 'Old');

  // --- change history (SCRUM-279) -----------------------------------------------
  const profile = await supabase
    .from('profiles')
    .select('id')
    .eq('role', 'technical_support_staff')
    .limit(1)
    .maybeSingle();
  const actor = profile.data?.id ?? null;
  check('a technical support user exists to attribute changes to', Boolean(actor));

  await updateEquipmentType(type.id, { location: 'Store 3' }, actor);
  const history = await getEquipmentTypeHistory(type.id);
  const byField = (field) => history.filter((row) => row.field === field);

  check('creation recorded', byField('created').length === 1 && byField('created')[0].newValue === type.name);
  check('the total change recorded with old and new values', byField('totalQuantity').some((r) => r.oldValue === '10' && r.newValue === '3'));
  check('a damaged change made directly is recorded by the trigger', byField('damagedQuantity').some((r) => r.oldValue === '0' && r.newValue === '2'));
  check('newest change is listed first', history[0]?.field === 'location', history[0]?.field);
  check(
    'the edit records the acting user and both values',
    history[0]?.changedBy === actor && history[0]?.oldValue === 'Store 2' && history[0]?.newValue === 'Store 3',
  );
  check('every row carries a timestamp', history.every((row) => Boolean(row.changedAt)));

  await updateEquipmentType(type.id, { location: 'Store 3' }, actor);
  check('an edit that changes nothing adds no history', (await getEquipmentTypeHistory(type.id)).length === history.length);

  const ghost = await failureOf(updateEquipmentType(type.id, { location: 'Store 4' }, randomUUID()));
  check('an acting user who does not exist is refused', ghost?.status === 400, ghost?.message);
  check('the refused edit left no history', (await getEquipmentTypeHistory(type.id)).length === history.length);

  check('an unknown type has an empty history', (await getEquipmentTypeHistory(randomUUID())).length === 0);

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nCheck aborted:', err);
  failures += 1;
} finally {
  await cleanup();
}

process.exit(failures === 0 ? 0 : 1);