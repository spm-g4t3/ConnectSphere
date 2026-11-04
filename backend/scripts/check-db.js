/**
 * Connection proof: verifies the API can actually reach the database.
 *
 * Run with: npm run db:check
 *
 * Checks four things at once -- the client is configured, the secret key is
 * accepted, the schema has been applied, and the seed data landed. The
 * seeded counts are the useful signal: room_layouts returning 6 means
 * db/baseline/03_venues.sql ran correctly.
 *
 * Exits non-zero on any failure so it can be dropped into CI later.
 */

import { supabase } from '../src/config/supabaseClient.js';

/** Tables to probe, with the row count expected from the baseline file that creates them. */
const TABLES = [
  { name: 'event_requests', source: '02_event_requests.sql', expected: null },
  { name: 'venues', source: '03_venues.sql', expected: null },
  { name: 'venue_operating_hours', source: '03_venues.sql', expected: null },
  { name: 'room_layouts', source: '03_venues.sql', expected: 6 },
  { name: 'accessibility_features', source: '03_venues.sql', expected: 5 },
  { name: 'facilities', source: '03_venues.sql', expected: 8 },
  { name: 'venue_change_history', source: '03_venues.sql', expected: null },
  { name: 'event_change_requests', source: '02_event_requests.sql', expected: null },
  { name: 'venue_blocks', source: '04_venue_bookings.sql', expected: null },
  { name: 'notifications', source: '05_notifications.sql', expected: null },
  { name: 'venue_block_history', source: '04_venue_bookings.sql', expected: null },
  { name: 'equipment_types', source: '06_equipment.sql', expected: null },
  { name: 'equipment_requests', source: '06_equipment.sql', expected: null },
  { name: 'equipment_lines', source: '06_equipment.sql', expected: null },
  { name: 'equipment_reservations', source: '06_equipment.sql', expected: null },
  { name: 'equipment_type_history', source: '06_equipment.sql', expected: null },
];

/** Read one id while asking PostgREST for the exact count. */
async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact' })
    .limit(1);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  console.log(`\nChecking ${new URL(process.env.SUPABASE_URL).host}\n`);

  let failures = 0;
  let unreachable = 0;

  for (const { name, source, expected } of TABLES) {
    let line = `  ${name.padEnd(24)}`;

    try {
      const count = await countRows(name);
      line += `${String(count).padStart(4)} rows`;

      if (expected !== null && count !== expected) {
        line += `   MISMATCH - expected ${expected} from ${source}`;
        failures += 1;
      } else if (expected !== null) {
        line += `   seeded by ${source}`;
      }
    } catch (err) {
      line += `   UNREACHABLE - ${err.message}`;
      failures += 1;
      // A network-level failure means we never reached Supabase at all, which
      // is a different problem from a table that has not been created yet.
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(err.message)) {
        unreachable += 1;
      }
    }

    console.log(line);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);

    if (unreachable === TABLES.length) {
      // Nothing responded, so this is the connection itself, not the schema.
      console.error('Nothing responded, so the database was never reached.');
      console.error('Check SUPABASE_URL and SUPABASE_SECRET_KEY in backend/.env');
      console.error('against Settings -> API in the Supabase dashboard.\n');
    } else {
      console.error('Some tables are missing or empty. Confirm backend/db/baseline/ and any');
      console.error('backend/db/migrations/ files have been run in the Supabase SQL Editor.\n');
    }

    process.exit(1);
  }

  console.log('\nAll checks passed. The API can reach the database.\n');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
