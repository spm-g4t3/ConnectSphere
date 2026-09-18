/**
 * End-to-end proof for the venue service (SCRUM-106).
 *
 * Run with: npm run venue:check
 *
 * Exercises the whole stack in one go -- service, the transactional RPC,
 * the schema constraints from 002, and the audit trigger from 003 -- then
 * removes everything it created.
 *
 * Exits non-zero on any failure.
 */

import { supabaseAdmin } from '../src/config/supabaseClient.js';
import { createVenue, updateVenue, getVenueById } from '../src/services/venueService.js';

const NAME = `__check_venue_${Date.now()}`;

let created = null;
let failures = 0;

function check(label, passed, detail = '') {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!passed) failures += 1;
}

async function cleanup() {
  if (!created) return;
  // History first: ON DELETE RESTRICT blocks deleting a venue that has any.
  await supabaseAdmin.from('venue_change_history').delete().eq('venue_id', created.id);
  await supabaseAdmin.from('venues').delete().eq('id', created.id);
}

async function main() {
  console.log('\nVenue service check\n');

  // --- create, with attributes across all four child tables ---------------
  created = await createVenue({
    name: NAME,
    location: 'Level 2, SCIS',
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

  // --- the audit trigger from SCRUM-108 -----------------------------------
  const { data: history } = await supabaseAdmin
    .from('venue_change_history')
    .select('old_values, new_values')
    .eq('venue_id', created.id);

  check('exactly one audit row', history?.length === 1, `${history?.length ?? 0} rows`);
  check(
    'audit recorded only the changed field',
    JSON.stringify(history?.[0]?.old_values) === '{"max_capacity":40}',
    JSON.stringify(history?.[0]?.old_values),
  );
  check(
    'audit recorded the new value',
    JSON.stringify(history?.[0]?.new_values) === '{"max_capacity":80}',
    JSON.stringify(history?.[0]?.new_values),
  );

  // --- replacing an attribute set -----------------------------------------
  const cleared = await updateVenue(created.id, { facilities: [] }, null);
  check('empty array clears facilities', cleared.facilities.length === 0, `${cleared.facilities.length} left`);

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
}

async function countVenues() {
  const { count } = await supabaseAdmin.from('venues').select('*', { count: 'exact', head: true });
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
    console.log('\nAll checks passed. Created, updated, audited, rolled back, cleaned up.\n');
  });
