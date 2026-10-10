/**
 * Seed demo tentative venue holds (SCRUM-491).
 *
 * Run with: npm run venue-holds:seed
 *
 * Run 040_venue_holds.sql first. Places two holds on existing data, so AC5-AC8
 * can be shown without clicking through the hold form:
 *
 *   - an ACTIVE hold, expiring 5 minutes from now, for the first Approved
 *     event (soonest first) on the first active venue it can hold. Placed
 *     through place_venue_hold, so it obeys every rule the form does. Until
 *     it expires, the venue is missing from other events' searches, other
 *     events' requests for it are refused, and its calendar shows
 *     "Tentatively held" (AC5, AC6). Once the 5 minutes pass it occupies
 *     nothing at once (AC7), and the expiry job notifies the event's
 *     coordinator within a minute (AC8).
 *   - a LAPSED hold, still marked active but already past its expiry, for the
 *     second Approved event (the first again if there is only one) on another
 *     active venue. It occupies nothing already (AC7: the venue is free at
 *     once, job or no job), and the next run of the expiry job marks it
 *     expired and notifies that event's coordinator (AC8). Written straight to
 *     the table, because place_venue_hold refuses an expiry in the past.
 *
 * The placer is the first Venue Staff user found in profiles.
 *
 * Skips cleanly, changing nothing, when there is no Approved event with dates,
 * no active venue, or no Venue Staff user.
 *
 * Safe to run twice: an event that already has an unexpired active hold, or
 * already has a seeded lapsed hold, is left exactly as it is. To show the
 * expiry again, delete that event's rows from venue_holds in the Supabase
 * Table Editor (its notifications go with them) and run this again.
 */

import { supabase } from '../../src/config/supabaseClient.js';

const ACTIVE_FOR_MINUTES = 5;
const LAPSED_MINUTES_AGO = 5;
const LAPSED_PLACED_HOURS_AGO = 2;

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

async function firstVenueStaff() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('role', 'venue_staff')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function approvedEvents() {
  const { data, error } = await supabase
    .from('event_requests')
    .select('id, event_name, proposed_start, proposed_end, assigned_coordinator_id')
    .eq('status', 'approved')
    .not('proposed_start', 'is', null)
    .not('proposed_end', 'is', null)
    .order('proposed_start', { ascending: true })
    .limit(2);
  if (error) throw error;
  return data ?? [];
}

async function activeVenues() {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name')
    .is('retired_at', null)
    .order('name', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function holdsFor(eventId) {
  const { data, error } = await supabase
    .from('venue_holds')
    .select('id, venue_id, status, expires_at')
    .eq('event_request_id', eventId);
  if (error) throw error;
  return data ?? [];
}

/** The active hold: the first venue place_venue_hold accepts. Returns its venue id. */
async function seedActiveHold(event, venues, staff) {
  const now = Date.now();
  const existing = (await holdsFor(event.id)).find(
    (hold) => hold.status === 'active' && new Date(hold.expires_at).getTime() > now,
  );
  if (existing) {
    const venue = venues.find((v) => v.id === existing.venue_id);
    console.log(`  kept     active hold on ${venue?.name ?? existing.venue_id} for ${event.event_name}`
      + ` (expires ${existing.expires_at})`);
    return existing.venue_id;
  }

  const expiresAt = minutesFromNow(ACTIVE_FOR_MINUTES);
  for (const venue of venues) {
    const { data, error } = await supabase.rpc('place_venue_hold', {
      p_event_request_id: event.id,
      p_venue_id: venue.id,
      p_expires_at: expiresAt,
      p_placed_by: staff.id,
    });
    if (error) throw error;

    if (data?.outcome === 'placed') {
      console.log(`  created  active hold on ${venue.name} for ${event.event_name}`
        + ` (expires ${expiresAt}, in ${ACTIVE_FOR_MINUTES} minutes)`);
      return venue.id;
    }
    console.log(`  skipped  ${venue.name}: something else occupies it for ${event.event_name}`);
  }

  console.log(`  none     no active venue is free for ${event.event_name}; no active hold placed`);
  return null;
}

/** The lapsed hold: written directly, on a venue other than `avoidVenueId` when there is one. */
async function seedLapsedHold(event, venues, staff, avoidVenueId) {
  const existing = (await holdsFor(event.id)).find(
    (hold) => hold.status === 'expired' || new Date(hold.expires_at).getTime() <= Date.now(),
  );
  if (existing) {
    const venue = venues.find((v) => v.id === existing.venue_id);
    console.log(`  kept     lapsed hold on ${venue?.name ?? existing.venue_id} for ${event.event_name}`
      + ` (status ${existing.status})`);
    return;
  }

  const venue = venues.find((v) => v.id !== avoidVenueId) ?? venues[0];
  const expiresAt = minutesFromNow(-LAPSED_MINUTES_AGO);
  const { error } = await supabase.from('venue_holds').insert({
    event_request_id: event.id,
    venue_id: venue.id,
    placed_by: staff.id,
    placed_at: minutesFromNow(-LAPSED_PLACED_HOURS_AGO * 60),
    expires_at: expiresAt,
    status: 'active',
  });
  if (error) throw error;

  console.log(`  created  lapsed hold on ${venue.name} for ${event.event_name}`
    + ` (expired ${expiresAt}; still marked active until the expiry job runs)`);
  if (!event.assigned_coordinator_id) {
    console.log('           note: this event has no assigned coordinator, so no expiry notice will be sent');
  }
}

async function main() {
  console.log('\nSeeding demo venue holds\n');

  const staff = await firstVenueStaff();
  if (!staff) {
    console.log('  skipped  no Venue Staff user in profiles; nothing to place holds as.\n');
    return;
  }

  const events = await approvedEvents();
  if (events.length === 0) {
    console.log('  skipped  no Approved event with a proposed start and end.\n');
    return;
  }

  const venues = await activeVenues();
  if (venues.length === 0) {
    console.log('  skipped  no active venue.\n');
    return;
  }

  console.log(`  placing as ${staff.full_name ?? staff.id}\n`);

  const [first, second = first] = events;
  const heldVenueId = await seedActiveHold(first, venues, staff);
  await seedLapsedHold(second, venues, staff, heldVenueId);

  console.log('\nDone. Watch the API log for "Venue hold expiry" lines; the coordinator\'s'
    + ' notifications show each expiry once.\n');
}

try {
  await main();
} catch (err) {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
}
