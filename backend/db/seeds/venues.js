/**
 * Seed demo venues for manual testing.
 *
 * Run with: npm run venues:seed
 *
 * Adds a venue catalogue varied enough to exercise venue search, the
 * suitability check and multi-venue booking requests (SCRUM-525):
 *
 *   - capacity from 12 to 800, so Capacity is met for one event and unmet for
 *     another, and one large event can be split across several smaller rooms
 *   - layouts, accessibility features and facilities spread so that each code
 *     is met by some venues and missing from others
 *   - operating hours of several shapes: weekdays only, every day, evenings,
 *     overnight (closing after midnight, or at it), weekends only, and none
 *     recorded (Operating hours not met)
 *   - setup and turnaround from none to 120 minutes, so the padded period
 *     around a booking can be seen
 *   - emergency access and known restrictions recorded on some, not others
 *   - one venue with no layouts, features or facilities at all
 *   - one venue that is retired after creation, so it drops out of search
 *
 * Safe to run twice: a venue whose name already exists (ignoring
 * capitalisation) is left exactly as it is, so edits made since the first run
 * are not undone. Remove demo venues by retiring them in the app.
 *
 * Goes through venueService.createVenue rather than inserting rows, so every
 * venue passes the same validation as the venue form and gets its audit trail.
 */

import { supabase } from '../../src/config/supabaseClient.js';
import { createVenue, retireVenue } from '../../src/services/venueService.js';
import { escapeLike } from './lib.js';

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Operating hours as create_venue expects them, one row per day. */
const hours = (days, opensAt, closesAt) =>
  days.map((day) => ({ day_of_week: day, opens_at: opensAt, closes_at: closesAt }));

const DEMO_VENUES = [
  {
    name: 'Demo Grand Ballroom',
    location: 'Level 1, Main Building',
    maxCapacity: 800,
    layouts: ['theatre', 'banquet', 'exhibition'],
    accessibility: ['step_free_entrance', 'accessible_toilet', 'hearing_loop', 'lift_access', 'accessible_parking'],
    facilities: ['projector', 'screen', 'wifi', 'air_conditioning', 'pa_system', 'catering'],
    hours: hours(EVERY_DAY, '07:00', '23:00'),
    setupMinutes: 120,
    turnaroundMinutes: 120,
    emergencyAccess: 'Four fire exits; assembly point at the north car park.',
    knownRestrictions: 'No open flames. Amplified music must end by 22:30.',
  },
  {
    name: 'Demo Lecture Theatre A',
    location: 'Level 2, Main Building',
    maxCapacity: 250,
    layouts: ['theatre'],
    accessibility: ['step_free_entrance', 'hearing_loop', 'lift_access'],
    facilities: ['projector', 'screen', 'wifi', 'air_conditioning', 'pa_system'],
    hours: hours(WEEKDAYS, '08:00', '21:00'),
    setupMinutes: 30,
    turnaroundMinutes: 30,
    emergencyAccess: 'Exits at the front and rear of the tiered seating.',
  },
  {
    name: 'Demo Lecture Theatre B',
    location: 'Level 2, Main Building',
    maxCapacity: 120,
    layouts: ['theatre', 'classroom'],
    accessibility: ['step_free_entrance', 'lift_access'],
    facilities: ['projector', 'screen', 'wifi', 'air_conditioning'],
    hours: hours(WEEKDAYS, '08:00', '21:00'),
    setupMinutes: 15,
    turnaroundMinutes: 15,
  },
  {
    name: 'Demo Seminar Room 3-01',
    location: 'Level 3, East Wing',
    maxCapacity: 60,
    layouts: ['classroom', 'u_shape'],
    accessibility: ['lift_access', 'accessible_toilet'],
    facilities: ['projector', 'whiteboard', 'wifi', 'air_conditioning'],
    hours: hours(WEEKDAYS, '08:00', '18:00'),
  },
  {
    name: 'Demo Seminar Room 3-02',
    location: 'Level 3, East Wing',
    maxCapacity: 40,
    layouts: ['classroom', 'u_shape', 'boardroom'],
    accessibility: ['lift_access'],
    facilities: ['whiteboard', 'wifi', 'air_conditioning'],
    hours: hours(WEEKDAYS, '08:00', '18:00'),
    turnaroundMinutes: 15,
  },
  {
    name: 'Demo Executive Boardroom',
    location: 'Level 5, East Wing',
    maxCapacity: 16,
    layouts: ['boardroom'],
    accessibility: ['lift_access', 'accessible_toilet', 'hearing_loop'],
    facilities: ['screen', 'video_conferencing', 'wifi', 'air_conditioning', 'catering'],
    hours: hours(WEEKDAYS, '09:00', '18:00'),
    knownRestrictions: 'Booking requires director sign-off. No food after 17:00.',
  },
  {
    name: 'Demo Huddle Room',
    location: 'Level 4, East Wing',
    maxCapacity: 12,
    layouts: ['boardroom'],
    accessibility: [],
    facilities: ['screen', 'wifi'],
    hours: hours(EVERY_DAY, '00:00', '23:59'),
  },
  {
    name: 'Demo Exhibition Hall',
    location: 'Ground Floor, West Annex',
    maxCapacity: 500,
    layouts: ['exhibition', 'banquet'],
    accessibility: ['step_free_entrance', 'accessible_toilet', 'accessible_parking'],
    facilities: ['wifi', 'pa_system', 'catering'],
    hours: hours(EVERY_DAY, '09:00', '22:00'),
    setupMinutes: 90,
    turnaroundMinutes: 60,
    emergencyAccess: 'Roller doors on the west side open for vehicle and stretcher access.',
    knownRestrictions: 'Floor load limit 500 kg per square metre. No air conditioning.',
  },
  {
    name: 'Demo Rooftop Terrace',
    location: 'Rooftop, Main Building',
    maxCapacity: 150,
    layouts: ['banquet', 'exhibition'],
    accessibility: ['lift_access'],
    facilities: ['pa_system', 'catering'],
    hours: hours(EVERY_DAY, '17:00', '23:00'),
    setupMinutes: 60,
    turnaroundMinutes: 45,
    knownRestrictions: 'Outdoor; events move indoors in heavy rain. Evenings only.',
  },
  {
    name: 'Demo Late-Night Lounge',
    location: 'Level 5, Main Building',
    maxCapacity: 120,
    layouts: ['banquet'],
    accessibility: ['step_free_entrance', 'lift_access'],
    facilities: ['pa_system', 'catering', 'air_conditioning'],
    // Friday and Saturday run to 02:00 the next morning; Thursday closes at midnight.
    hours: [...hours([4], '18:00', '00:00'), ...hours([5, 6], '18:00', '02:00')],
    setupMinutes: 30,
    turnaroundMinutes: 30,
    knownRestrictions: 'Amplified music must end by 01:30.',
  },
  {
    name: 'Demo Weekend Studio',
    location: 'Ground Floor, Arts Block',
    maxCapacity: 80,
    layouts: ['classroom', 'theatre', 'u_shape'],
    accessibility: ['step_free_entrance', 'accessible_toilet'],
    facilities: ['projector', 'screen', 'pa_system', 'air_conditioning'],
    hours: hours(WEEKEND, '10:00', '20:00'),
    setupMinutes: 45,
  },
  {
    name: 'Demo Basement Hall (no hours recorded)',
    location: 'Basement, West Annex',
    maxCapacity: 200,
    layouts: ['theatre', 'classroom'],
    accessibility: [],
    facilities: ['projector', 'screen'],
    hours: [],
  },
  {
    name: 'Demo Bare Room',
    location: 'Level 1, Arts Block',
    maxCapacity: 30,
    layouts: [],
    accessibility: [],
    facilities: [],
    hours: hours(WEEKDAYS, '09:00', '17:00'),
  },
  {
    name: 'Demo Old Auditorium (retired)',
    location: 'Old Wing',
    maxCapacity: 300,
    layouts: ['theatre'],
    accessibility: [],
    facilities: ['projector', 'pa_system'],
    hours: hours(WEEKDAYS, '08:00', '22:00'),
    retire: true,
  },
];

async function main() {
  console.log('\nSeeding demo venues\n');

  let created = 0;
  let kept = 0;

  for (const { retire, ...venue } of DEMO_VENUES) {
    const existing = await supabase
      .from('venues')
      .select('id')
      .ilike('name', escapeLike(venue.name))
      .limit(1);
    if (existing.error) throw existing.error;

    if (existing.data.length > 0) {
      console.log(`  kept     ${venue.name}`);
      kept += 1;
      continue;
    }

    const saved = await createVenue(venue);
    if (retire) await retireVenue(saved.id);

    console.log(`  created  ${venue.name}  (capacity ${venue.maxCapacity}${retire ? ', retired' : ''})`);
    created += 1;
  }

  console.log(`\nDone: ${created} created, ${kept} already present.\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
}
