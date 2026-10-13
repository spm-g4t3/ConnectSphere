/**
 * Take away the demo booking requests bookingSuitability.js seeded
 * (SCRUM-188 AC7; SCRUM-193/194, B10).
 *
 * Run with: npm run booking-suitability:unseed
 *
 * Finds every live request (pending, approved, flagged for review) whose
 * setup notes carry the seed's marker, and withdraws each through the app's
 * own path -- bookingRequestService.withdrawBookingRequest, that is the
 * withdraw_booking_request RPC (031) -- acting as the event's assigned
 * coordinator, as the RPC requires. Nothing is deleted, so the history of
 * what was seeded stays readable, and the RPC's own rules apply: Venue Staff
 * are told of each withdrawal as they would be for a real one.
 *
 * Only pending requests can be withdrawn (031). A seeded request that Venue
 * Staff have since approved or that a block has flagged is reported and left
 * alone, for Venue Staff to deal with as they would a real one.
 *
 * Logs every request it finds and what it did with it. Safe to run twice: a
 * second run finds nothing live to withdraw.
 */

import { supabase } from '../../src/config/supabaseClient.js';
import { withdrawBookingRequest } from '../../src/services/bookingRequestService.js';
import { ConflictError } from '../../src/errors.js';

/** The marker bookingSuitability.js writes into setup_notes; change both together. */
const SEED_NOTE_PREFIX = 'Seeded demo (SCRUM-188 AC7)';
const LIVE_STATUSES = ['pending', 'approved', 'flagged_for_review'];

async function seededRequests() {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, status, setup_notes, event_requests(event_name, assigned_coordinator_id), venues(name)')
    .like('setup_notes', `${SEED_NOTE_PREFIX}%`)
    .in('status', LIVE_STATUSES)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

const one = (embedded) => (Array.isArray(embedded) ? embedded[0] : embedded) ?? {};

async function main() {
  console.log('\nWithdrawing seeded demo booking requests\n');

  const requests = await seededRequests();
  if (requests.length === 0) {
    console.log('  none     no live seeded request found.\n');
    return;
  }

  let withdrawn = 0;
  for (const row of requests) {
    const event = one(row.event_requests);
    const label = `${row.id} (${one(row.venues).name ?? 'unknown venue'} for `
      + `${event.event_name ?? 'unknown event'}, ${row.status}; "${row.setup_notes}")`;

    if (row.status !== 'pending') {
      console.log(`  left     ${label}: only a pending request can be withdrawn`);
      continue;
    }
    if (!event.assigned_coordinator_id) {
      console.log(`  left     ${label}: its event has no assigned coordinator to act as`);
      continue;
    }

    try {
      await withdrawBookingRequest(row.id, event.assigned_coordinator_id, { client: supabase });
      withdrawn += 1;
      console.log(`  withdrew ${label}`);
    } catch (err) {
      if (err instanceof ConflictError) {
        console.log(`  left     ${label}: ${err.code ?? err.message}`);
        continue;
      }
      throw err;
    }
  }

  console.log(`\nDone. Withdrew ${withdrawn} of ${requests.length} live seeded request(s).\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nCleanup failed:', err.message ?? err);
  process.exit(1);
}
