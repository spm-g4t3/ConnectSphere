/**
 * Take away the demo notifications notifications.js seeded (SCRUM-172).
 *
 * Run with: npm run notifications:unseed
 *
 * Deletes every notification whose payload carries the seed's marker, and
 * nothing else. Unlike bookingSuitabilityCleanup.js, which withdraws its
 * requests so their history stays, this deletes: a seeded notification
 * describes nothing that happened, so there is no history to keep.
 *
 * Logs how many it removed per recipient and type. Safe to run twice: a
 * second run finds nothing carrying the marker.
 */

import { supabase } from '../../src/config/supabaseClient.js';
import { SEED_MARKER } from './lib.js';

async function main() {
  console.log('\nDeleting seeded demo notifications\n');

  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('payload->>seeded', SEED_MARKER)
    .select('recipient_id, type');
  if (error) throw error;

  if (!data?.length) {
    console.log('  none     no notification carries the marker.\n');
    return;
  }

  const counts = new Map();
  for (const row of data) {
    const key = `${row.recipient_id} ${row.type}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...counts].sort()) {
    console.log(`  deleted  ${count} x ${key}`);
  }

  console.log(`\nDone. Deleted ${data.length} seeded notification(s).\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nCleanup failed:', err.message ?? err);
  process.exit(1);
}
