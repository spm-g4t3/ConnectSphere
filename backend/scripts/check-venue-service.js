/**
 * End-to-end proof for the venue service (SCRUM-106, SCRUM-110, SCRUM-111,
 * SCRUM-186, SCRUM-137).
 *
 * Run with: npm run venue:check
 *
 * Exercises the whole stack in one go -- service, the transactional RPC,
 * the schema constraints from 002, the audit trigger from 003 and retirement
 * from 005 -- then removes everything it created.
 *
 * This is the counterpart to tests/services/venueService.test.js, which mocks
 * the database. Only this script can show that Postgres really raises the
 * codes the service claims to translate, so it is what proves PT409 and the
 * retirement audit row actually happen.
 *
 * SCRUM-186's turnaround steps run last, on a second venue of their own, so
 * every count and "latest row" read above sees exactly what it did before.
 * SCRUM-137's setup steps follow, on a third venue, for the same reason.
 *
 * Exits non-zero on any failure.
 */

import { supabase } from '../src/config/supabaseClient.js';
import {
  createVenue,
  updateVenue,
  getVenueById,
  retireVenue,
  searchVenues,
} from '../src/services/venueService.js';

const NAME = `__check_venue_${Date.now()}`;
const LOCATION = 'Level 2, SCIS';

let created = null;
let turnaroundVenue = null;
let setupVenue = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

async function cleanup() {
  for (const venue of [created, turnaroundVenue, setupVenue]) {
    if (!venue) continue;
    // History first: ON DELETE RESTRICT blocks deleting a venue that has any.
    await supabase.from('venue_change_history').delete().eq('venue_id', venue.id);
    await supabase.from('venues').delete().eq('id', venue.id);
  }
}

async function main() {
  console.log('\nVenue service check\n');

  // --- create, with attributes across all four child tables ---------------
  created = await createVenue({
    name: NAME,
    location: LOCATION,
    maxCapacity: 40,
    layouts: ['classroom', 'theatre'],
    facilities: ['projector', 'wifi'],
    accessibility: ['lift_access'],
    hours: [
      { day_of_week: 1, opens_at: '09:00', closes_at: '18:00' },
      { day_of_week: 2, opens_at: '09:00', closes_at: '18:00' },
    ],
  });

  check('venue created', Boolean(created.id));
  check('capacity stored', created.maxCapacity === 40, `got ${created.maxCapacity}`);
  check('layouts stored', created.layouts.join(',') === 'classroom,theatre', created.layouts.join(','));
  check('facilities stored', created.facilities.join(',') === 'projector,wifi', created.facilities.join(','));
  check('accessibility stored', created.accessibility.join(',') === 'lift_access', created.accessibility.join(','));
  check('opening hours stored', created.hours.length === 2, `${created.hours.length} days`);

  // --- update: capacity only, attributes must survive ---------------------
  const updated = await updateVenue(created.id, { maxCapacity: 80 }, null);

  check('capacity updated', updated.maxCapacity === 80, `got ${updated.maxCapacity}`);
  check(
    'omitted attributes untouched',
    updated.facilities.join(',') === 'projector,wifi',
    updated.facilities.join(','),
  );

  // --- the audit trail from SCRUM-108, completed by 008 -------------------
  //
  // Row counts changed with 008_venue_audit_completion.sql. Creating a venue
  // used to write nothing, so this block asserted "exactly one audit row" --
  // meaning the update. There are now two: the creation, and the capacity
  // change. Rows are matched on what they contain rather than by position,
  // because two rows written moments apart have no reliable order.
  const { data: history } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', created.id);

  check('two audit rows: the creation and the update', history?.length === 2,
    `${history?.length ?? 0} rows`);

  const creationRow = history?.find((h) => Object.keys(h.old_values).length === 0);
  check('creating a venue is recorded (008)', Boolean(creationRow),
    JSON.stringify(creationRow?.new_values ?? null));
  check(
    'the creation row carries the venue as it was first stored',
    creationRow?.new_values?.max_capacity === 40,
    JSON.stringify(creationRow?.new_values?.max_capacity ?? null),
  );

  const capacityRow = history?.find((h) => h.old_values?.max_capacity !== undefined);
  check(
    'audit recorded only the changed field',
    JSON.stringify(capacityRow?.old_values) === '{"max_capacity":40}',
    JSON.stringify(capacityRow?.old_values),
  );
  check(
    'audit recorded the new value',
    JSON.stringify(capacityRow?.new_values) === '{"max_capacity":80}',
    JSON.stringify(capacityRow?.new_values),
  );

  // --- replacing an attribute set -----------------------------------------
  const cleared = await updateVenue(created.id, { facilities: [] }, null);
  check('empty array clears facilities', cleared.facilities.length === 0, `${cleared.facilities.length} left`);

  // Before 008 this produced no audit row at all: the trigger fires on venues
  // and diffs its columns, while facilities live in a join table. Clearing
  // every facility on a venue was invisible to the trail.
  const { data: attributeHistory } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', created.id);

  const facilitiesRow = attributeHistory?.find((h) => h.old_values?.facilities !== undefined);
  check('an attribute-only change is recorded (008)', Boolean(facilitiesRow),
    JSON.stringify(facilitiesRow?.old_values ?? null));
  check(
    'it records the facilities the venue used to have',
    JSON.stringify(facilitiesRow?.old_values?.facilities) === '["projector","wifi"]',
    JSON.stringify(facilitiesRow?.old_values?.facilities ?? null),
  );
  check(
    'and that they are now empty',
    JSON.stringify(facilitiesRow?.new_values?.facilities) === '[]',
    JSON.stringify(facilitiesRow?.new_values?.facilities ?? null),
  );

  // --- rollback: the whole reason these writes go through an RPC ----------
  const before = await countVenues();
  let rejected = false;
  try {
    await createVenue({
      name: `${NAME}_rollback`,
      location: 'Nowhere',
      maxCapacity: 10,
      facilities: ['not_a_real_facility'],
    });
  } catch {
    rejected = true;
  }
  const after = await countVenues();

  check('bad facility code rejected', rejected);
  check('no half-built venue left behind', before === after, `${before} -> ${after}`);

  // --- not found ----------------------------------------------------------
  let notFound = false;
  try {
    await getVenueById('00000000-0000-0000-0000-000000000000');
  } catch (err) {
    notFound = err.status === 404;
  }
  check('missing venue raises NotFoundError', notFound);

  // --- search sees it while it is active (SCRUM-111) -----------------------
  const activeBefore = await searchVenues({ location: LOCATION });
  check(
    'active venue appears in search',
    activeBefore.some((venue) => venue.id === created.id),
    `${activeBefore.length} active here`,
  );

  // --- retirement (SCRUM-110) ---------------------------------------------
  // last_modified_by is the only column retire_venue writes and it is a
  // foreign key to auth.users, so an unknown user has to be named as such
  // rather than blamed on the lookup tables.
  let badUser = '';
  try {
    await retireVenue(created.id, '00000000-0000-0000-0000-000000000000');
  } catch (err) {
    badUser = err.message;
  }
  check('unknown editing user rejected', /editing user/i.test(badUser), badUser.slice(0, 48));

  const retired = await retireVenue(created.id, null);
  check('retiredAt stamped', Boolean(retired.retiredAt), String(retired.retiredAt));

  const activeAfter = await searchVenues({ location: LOCATION });
  check(
    'retired venue gone from search',
    !activeAfter.some((venue) => venue.id === created.id),
    `${activeAfter.length} active here`,
  );

  // AC3: gone from searches, but its past bookings -- and so the venue they
  // point at -- stay viewable.
  const stillReadable = await getVenueById(created.id);
  check('retired venue still readable by id', stillReadable.id === created.id);

  // AC4: the retirement is a change, so it belongs in the history.
  const { data: retireHistory } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values, changed_by')
    .eq('venue_id', created.id)
    .order('changed_at', { ascending: false })
    .limit(1);

  check(
    'retirement recorded as a change from active',
    JSON.stringify(retireHistory?.[0]?.old_values) === '{"retired_at":null}',
    JSON.stringify(retireHistory?.[0]?.old_values),
  );
  check(
    'retirement recorded the timestamp',
    Boolean(retireHistory?.[0]?.new_values?.retired_at),
    JSON.stringify(retireHistory?.[0]?.new_values),
  );

  // Retiring twice is the conflict PT409 exists for.
  let conflictStatus = 0;
  try {
    await retireVenue(created.id, null);
  } catch (err) {
    conflictStatus = err.status;
  }
  check('retiring twice raises ConflictError', conflictStatus === 409, `status ${conflictStatus}`);

  await checkTurnaround();
  await checkSetup();
}

/**
 * SCRUM-186: the turnaround column (017) through the service, the audit
 * trail, and the database CHECK on its own.
 */
async function checkTurnaround() {
  // --- default: a venue created without one reads back 0 -------------------
  turnaroundVenue = await createVenue({
    name: `${NAME}_turnaround`,
    location: LOCATION,
    maxCapacity: 20,
  });
  check('new venue defaults to no turnaround (017)', turnaroundVenue.turnaroundMinutes === 0,
    `got ${turnaroundVenue.turnaroundMinutes}`);

  const { data: creation } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', turnaroundVenue.id);
  const turnaroundCreation = creation?.find((h) => Object.keys(h.old_values).length === 0);
  check(
    'the creation row stores the initial turnaround',
    turnaroundCreation?.new_values?.turnaround_minutes === 0,
    JSON.stringify(turnaroundCreation?.new_values?.turnaround_minutes ?? null),
  );

  // --- a change is audited by 003's diff trigger, with no snapshot change --
  const thirty = await updateVenue(turnaroundVenue.id, { turnaroundMinutes: 30 }, null);
  check('turnaround updated to 30', thirty.turnaroundMinutes === 30, `got ${thirty.turnaroundMinutes}`);

  const { data: changes } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', turnaroundVenue.id);
  const turnaroundRow = changes?.find((h) => h.old_values?.turnaround_minutes !== undefined);
  check(
    'turnaround change recorded as 0 -> 30',
    JSON.stringify(turnaroundRow?.old_values) === '{"turnaround_minutes":0}' &&
      JSON.stringify(turnaroundRow?.new_values) === '{"turnaround_minutes":30}',
    `${JSON.stringify(turnaroundRow?.old_values)} -> ${JSON.stringify(turnaroundRow?.new_values)}`,
  );

  // --- back to 0: the ?? null pitfall, end to end --------------------------
  const none = await updateVenue(turnaroundVenue.id, { turnaroundMinutes: 0 }, null);
  check('turnaround set back to 0', none.turnaroundMinutes === 0, `got ${none.turnaroundMinutes}`);

  // --- the CHECK holds without validation in front of it -------------------
  // Straight to the rpc, past venueValidation, so only the database can refuse.
  const { error: rejectedTurnaround } = await supabase.rpc('update_venue', {
    p_id: turnaroundVenue.id,
    p_turnaround_minutes: 25,
  });
  check('database refuses a turnaround of 25', rejectedTurnaround?.code === '23514',
    `code ${rejectedTurnaround?.code ?? 'none'}`);
}

/**
 * SCRUM-137: the setup column (023), checked step for step like turnaround.
 * A venue of its own, so the "find the row whose old_values has the key"
 * reads below cannot pick up a turnaround row by mistake.
 */
async function checkSetup() {
  // --- default: a venue created without one reads back 0 -------------------
  setupVenue = await createVenue({
    name: `${NAME}_setup`,
    location: LOCATION,
    maxCapacity: 20,
  });
  check('new venue defaults to no setup time (023)', setupVenue.setupMinutes === 0,
    `got ${setupVenue.setupMinutes}`);

  // 008's creation trigger snapshots the whole row with to_jsonb, so the new
  // column is in it with no change to 008.
  const { data: creation } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', setupVenue.id);
  const setupCreation = creation?.find((h) => Object.keys(h.old_values).length === 0);
  check(
    'the creation row stores the initial setup time',
    setupCreation?.new_values?.setup_minutes === 0,
    JSON.stringify(setupCreation?.new_values?.setup_minutes ?? null),
  );

  // --- a change is audited by 003's diff trigger, with no snapshot change --
  const thirty = await updateVenue(setupVenue.id, { setupMinutes: 30 }, null);
  check('setup time updated to 30', thirty.setupMinutes === 30, `got ${thirty.setupMinutes}`);

  const { data: changes } = await supabase
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', setupVenue.id);
  const setupRow = changes?.find((h) => h.old_values?.setup_minutes !== undefined);
  check(
    'setup change recorded as 0 -> 30',
    JSON.stringify(setupRow?.old_values) === '{"setup_minutes":0}' &&
      JSON.stringify(setupRow?.new_values) === '{"setup_minutes":30}',
    `${JSON.stringify(setupRow?.old_values)} -> ${JSON.stringify(setupRow?.new_values)}`,
  );

  // --- back to 0: the ?? null pitfall, end to end --------------------------
  const none = await updateVenue(setupVenue.id, { setupMinutes: 0 }, null);
  check('setup time set back to 0', none.setupMinutes === 0, `got ${none.setupMinutes}`);

  // --- the CHECK holds without validation in front of it -------------------
  const { error: rejectedSetup } = await supabase.rpc('update_venue', {
    p_id: setupVenue.id,
    p_setup_minutes: 25,
  });
  check('database refuses a setup time of 25', rejectedSetup?.code === '23514',
    `code ${rejectedSetup?.code ?? 'none'}`);
}

async function countVenues() {
  const { count } = await supabase.from('venues').select('*', { count: 'exact', head: true });
  return count ?? 0;
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Created, updated, audited, searched, retired, turnaround and setup checked, cleaned up.\n');
  });
