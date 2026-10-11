/**
 * Seed demo booking requests with suitability results (SCRUM-188 AC7).
 *
 * Run with: npm run booking-suitability:seed
 *
 * Run 040_venue_holds.sql first. Requests two venues on existing data, so
 * AC7 -- "the suitability result, including any criterion the coordinator
 * chose to override, is attached to the booking request so that Venue Staff
 * can see it" -- can be shown on the Venue Staff venue screen without
 * signing in as a coordinator and clicking through the request form:
 *
 *   - a SUITABLE request: pending, every one of the six criteria met, for an
 *     Approved event on an active venue that holds its expected attendance
 *     and offers a layout, which is requested.
 *   - an OVERRIDDEN request: pending, suitable false with Capacity unmet
 *     ("Capacity 80 < expected attendance 150", from the real numbers), and
 *     suitability_overridden true, for a second Approved event on an active
 *     venue smaller than its expected attendance. A venue where Capacity is
 *     the only unmet criterion is preferred.
 *
 * Why through createBookingRequest and not straight into bookings, unlike
 * venueHolds.js's lapsed hold. Nothing here needs a state the real path
 * refuses: an unsuitable venue is exactly what confirmUnsuitable exists for.
 * So the result stored is the one checkVenueSuitability really computes from
 * the stored event and venue -- real criteria, real details, real `checked`
 * -- and create_booking_request applies every rule the form does: one live
 * request per event, the period clear of blocks, approved bookings and
 * other events' holds, the venue active, the caller the event's assigned
 * coordinator. A hand-written result could claim a capacity the venue does
 * not have. The cost is that the outcome depends on the data: each kind is
 * placed on the first event and venue that work, and is skipped, with the
 * reason, when none does.
 *
 * The requester is each event's assigned coordinator, as the RPC requires.
 * The overridden request names its unmet criteria in acknowledgedCriteria,
 * as the form does since SCRUM-193/194: confirmUnsuitable alone is asked
 * again.
 *
 * Only events that have not started yet are used (SCRUM-193/194, B10): a
 * demo request on a past event would sit among real history.
 *
 * Skips cleanly, changing nothing, when there is no active venue. Each kind
 * is otherwise reported as kept, created or "none" with the reason -- for
 * instance when no Approved event with dates, an expected attendance and an
 * assigned coordinator is free of a live request, or (overridden) when no
 * active venue is smaller than such an event's expected attendance.
 *
 * Safe to run twice: each seeded request is marked in its setup notes, and a
 * kind already present as a live request (pending, approved, flagged) is left
 * exactly as it is. To seed one again, or to take the demo requests away,
 * run npm run booking-suitability:unseed (bookingSuitabilityCleanup.js),
 * which withdraws every live request carrying the marker, then run this
 * again.
 */

import { supabase } from '../../src/config/supabaseClient.js';
import { createBookingRequest } from '../../src/services/bookingRequestService.js';
import { checkVenueSuitability } from '../../src/services/venueSuitabilityService.js';
import { ConflictError } from '../../src/errors.js';

/**
 * What marks a seeded request. bookingSuitabilityCleanup.js finds them by the
 * same text; change both together.
 */
const SEED_NOTE_PREFIX = 'Seeded demo (SCRUM-188 AC7)';
const SUITABLE_NOTE = `${SEED_NOTE_PREFIX}: suitable request`;
const OVERRIDDEN_NOTE = `${SEED_NOTE_PREFIX}: overridden request`;
const LIVE_STATUSES = ['pending', 'approved', 'flagged_for_review'];
const EVENT_LIMIT = 20;

/** A ConflictError the next venue might not hit; anything else is a fault. */
const SKIPPABLE = new Set([
  'BOOKING_PERIOD_CONFLICT',
  'SUITABILITY_CONFIRMATION_REQUIRED',
  'VENUE_RETIRED',
]);

async function seededRequest(note) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, venue_id, event_request_id, status')
    .eq('setup_notes', note)
    .in('status', LIVE_STATUSES)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Approved events that can take a request: dated, not yet started, sized,
 * coordinated, none live yet.
 */
async function requestableEvents() {
  const { data, error } = await supabase
    .from('event_requests')
    .select('id, event_name, expected_attendance, assigned_coordinator_id')
    .eq('status', 'approved')
    .not('proposed_start', 'is', null)
    // SCRUM-193/194 (B10): never seed onto an event that has already started.
    .gt('proposed_start', new Date().toISOString())
    .not('proposed_end', 'is', null)
    .not('expected_attendance', 'is', null)
    .not('assigned_coordinator_id', 'is', null)
    .order('proposed_start', { ascending: true })
    .limit(EVENT_LIMIT);
  if (error) throw error;
  if (!data?.length) return [];

  const { data: live, error: liveError } = await supabase
    .from('bookings')
    .select('event_request_id')
    .in('event_request_id', data.map((event) => event.id))
    .in('status', LIVE_STATUSES);
  if (liveError) throw liveError;

  const taken = new Set((live ?? []).map((row) => row.event_request_id));
  return data.filter((event) => !taken.has(event.id));
}

async function activeVenues() {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, max_capacity, venue_room_layouts(room_layout_code)')
    .is('retired_at', null)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((venue) => ({
    id: venue.id,
    name: venue.name,
    maxCapacity: venue.max_capacity,
    // Sorted so the layout requested is the same on every run.
    layouts: (venue.venue_room_layouts ?? []).map((row) => row.room_layout_code).sort(),
  }));
}

/** Request through the real path; null when this venue cannot take it. */
async function tryRequest(event, venue, { note, confirmUnsuitable, acknowledgedCriteria = [] }) {
  try {
    return await createBookingRequest(
      {
        eventRequestId: event.id,
        venueId: venue.id,
        roomLayoutCode: venue.layouts[0] ?? null,
        setupNotes: note,
        confirmUnsuitable,
        acknowledgedCriteria,
      },
      event.assigned_coordinator_id,
      { client: supabase },
    );
  } catch (err) {
    if (err instanceof ConflictError && SKIPPABLE.has(err.code)) {
      console.log(`  skipped  ${venue.name} for ${event.event_name}: ${err.code}`);
      return null;
    }
    throw err;
  }
}

const unmetOf = (result) => result.criteria.filter((c) => c.met === false).map((c) => c.criterion);

function summarise(booking) {
  const unmet = unmetOf(booking.suitability);
  return unmet.length === 0 ? 'all six criteria met' : `unmet: ${unmet.join(', ')}`;
}

/** The suitable request: the first event and roomy venue the check calls suitable. */
async function seedSuitable(events, venues) {
  const existing = await seededRequest(SUITABLE_NOTE);
  if (existing) {
    console.log(`  kept     suitable request ${existing.id} (${existing.status})`);
    return existing.event_request_id;
  }

  for (const event of events) {
    for (const venue of venues.filter((v) => v.maxCapacity >= event.expected_attendance)) {
      const booking = await tryRequest(event, venue, { note: SUITABLE_NOTE, confirmUnsuitable: false });
      if (booking) {
        console.log(`  created  suitable request on ${venue.name} for ${event.event_name}`
          + ` (${summarise(booking)})`);
        return event.id;
      }
    }
  }

  console.log('  none     no Approved event has an active venue that suits it; no suitable request');
  return null;
}

/**
 * The overridden request: a venue too small for the event, requested anyway.
 * Checked first, so a venue failing on Capacity alone is preferred over one
 * that also fails on hours or layout, and one that is not free is not tried.
 */
async function seedOverridden(events, venues, avoidEventId) {
  const existing = await seededRequest(OVERRIDDEN_NOTE);
  if (existing) {
    console.log(`  kept     overridden request ${existing.id} (${existing.status})`);
    return;
  }

  const candidates = [];
  for (const event of events.filter((e) => e.id !== avoidEventId)) {
    for (const venue of venues.filter((v) => v.maxCapacity < event.expected_attendance)) {
      const result = await checkVenueSuitability({
        eventRequestId: event.id,
        venueId: venue.id,
        roomLayoutCode: venue.layouts[0] ?? null,
        client: supabase,
      });
      const unmet = unmetOf(result);
      if (unmet.includes('Capacity') && !unmet.includes('Availability')) {
        candidates.push({ event, venue, unmet, capacityOnly: unmet.length === 1 });
      }
    }
  }
  candidates.sort((a, b) => Number(b.capacityOnly) - Number(a.capacityOnly));

  for (const { event, venue, unmet } of candidates) {
    // The criteria the check found unmet, named as the form names them; if
    // one more fails by the time of the request, it is asked again and skipped.
    const booking = await tryRequest(event, venue, {
      note: OVERRIDDEN_NOTE,
      confirmUnsuitable: true,
      acknowledgedCriteria: unmet,
    });
    if (booking) {
      const capacity = booking.suitability.criteria.find((c) => c.criterion === 'Capacity');
      console.log(`  created  overridden request on ${venue.name} for ${event.event_name}`
        + ` (${summarise(booking)}; "${capacity.detail}")`);
      return;
    }
  }

  console.log('  none     no active venue is smaller than a remaining upcoming Approved event\'s'
    + ' expected attendance and free for it; no overridden request');
}

async function main() {
  console.log('\nSeeding demo booking requests with suitability results\n');

  const venues = await activeVenues();
  if (venues.length === 0) {
    console.log('  skipped  no active venue.\n');
    return;
  }

  // Not a reason to stop: a kind seeded on an earlier run is still reported
  // as kept, and one that cannot be placed says why.
  const events = await requestableEvents();
  if (events.length === 0) {
    console.log('  note     no upcoming Approved event with dates, an expected attendance and an'
      + ' assigned coordinator is free of live booking requests.\n');
  }

  const suitableEventId = await seedSuitable(events, venues);
  await seedOverridden(events, venues, suitableEventId);

  console.log('\nDone. Sign in as Venue Staff and open each venue\'s bookings to see the'
    + ' suitability result and any overridden criteria.\n');
}

try {
  await main();
} catch (err) {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
}
