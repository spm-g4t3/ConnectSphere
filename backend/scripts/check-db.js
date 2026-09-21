/**
 * Connection proof: verifies the API can actually reach the database.
 *
 * Run with: npm run db:check
 *
 * Checks four things at once -- the client is configured, the secret key is
 * accepted, the migrations have been applied, and the seed data landed. The
 * seeded counts are the useful signal: room_layouts returning 6 means
 * 002_venues.sql ran correctly.
 *
 * Exits non-zero on any failure so it can be dropped into CI later.
 */

import { supabase } from '../src/config/supabaseClient.js';

/** Tables to probe, with the row count expected from the migrations. */
const TABLES = [
  { name: 'event_requests', migration: '001', expected: null },
  { name: 'venues', migration: '002', expected: null },
  { name: 'venue_operating_hours', migration: '002', expected: null },
  { name: 'room_layouts', migration: '002', expected: 6 },
  { name: 'accessibility_features', migration: '002', expected: 5 },
  { name: 'facilities', migration: '002', expected: 8 },
  { name: 'venue_change_history', migration: '003', expected: null },
  { name: 'event_change_requests', migration: '005', expected: null },
];

/** head: true asks for the count without transferring any rows. */
async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select('*', { count: 'exact', head: true });

  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  console.log(`\nChecking ${new URL(process.env.SUPABASE_URL).host}\n`);

  let failures = 0;
  let unreachable = 0;

  for (const { name, migration, expected } of TABLES) {
    let line = `  ${name.padEnd(24)}`;

    try {
      const count = await countRows(name);
      line += `${String(count).padStart(4)} rows`;

      if (expected !== null && count !== expected) {
        line += `   MISMATCH - expected ${expected} from migration ${migration}`;
        failures += 1;
      } else if (expected !== null) {
        line += `   seeded by ${migration}`;
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
      console.error('Some tables are missing or empty. Confirm the migrations in');
      console.error('backend/db/migrations/ have been run in the Supabase SQL Editor.\n');
    }

    process.exit(1);
  }

  console.log('\nAll checks passed. The API can reach the database.\n');
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
