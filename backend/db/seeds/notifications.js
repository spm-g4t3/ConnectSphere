/**
 * Seed demo notifications for every role's inbox (SCRUM-172).
 *
 * Run with: npm run notifications:seed
 *          npm run notifications:seed -- --many
 *
 * Notifications have no create route: the database writes each one inside the
 * action it describes (an assignment, a clarification, a booking decision, a
 * safety review). Showing every kind in the inbox that way would mean walking
 * each workflow by hand, so this demo seed inserts rows directly with the
 * secret-key client instead. Every row carries the marker below in its
 * payload; remove them all with npm run notifications:unseed
 * (notificationsCleanup.js).
 *
 * Recipients: one account per role -- the first profile of each role ordered
 * by email -- so teammates' inboxes on the shared project stay clean. The log
 * names who received what. A role with no profile is skipped, with the reason.
 *
 * Every row points at a real non-draft event, so its link opens a real page:
 * one assigned to the seeded coordinator and owned by the seeded organiser is
 * preferred. With no non-draft event at all, nothing is changed.
 *
 * Payloads are the shapes the migrations write (052 assignment, 030
 * clarification, 064 safety submission, 066 booking decisions, 031 withdrawal,
 * and SCRUM-490's 058 safety outcomes), plus the marker. Types about a booking
 * use the event's own booking and are skipped when it has none (066 and 031
 * require booking_id). Not seeded, because a faked row would claim something
 * that did not happen or break a uniqueness rule:
 *   - booking_flagged, booking_flagged_setup_change: need a block or an
 *     occupancy change on a real booking;
 *   - venue_hold_expired: needs a hold, and is unique per hold (040);
 *   - event_cancelled: unique per recipient and event (048), and announces a
 *     cancellation that did not happen.
 * Attendees get nothing: no notification type addresses them yet.
 *
 * Every seeded row is unread, with created_at spread over the last few days
 * so the newest-first order is visible.
 *
 * --many also gives the seeded coordinator 55 older unread rows, so the
 * unread count can be shown past the 50-row list.
 *
 * Safe to run twice: a (recipient, type, outcome) already carrying the marker
 * is kept as it is, and --many tops up to 55 rather than adding 55 more.
 */

import { supabase } from '../../src/config/supabaseClient.js';
import { SEED_MARKER } from './lib.js';

const ROLES = [
  'event_coordinator',
  'event_coordinator_lead',
  'event_organiser',
  'venue_staff',
  'technical_support_staff',
  'safety_officer',
  'attendee',
];
const MANY_COUNT = 55;
const EVENT_LIMIT = 50;
const HOUR = 60 * 60 * 1000;

/** Every auth user's email by id; profiles has no email column (007). */
async function emailsById() {
  const emails = new Map();
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const user of data.users) emails.set(user.id, user.email ?? '');
    if (data.users.length < 1000) return emails;
  }
}

/** Mirrors profile_display_name (052): the full name, or the id when there is none. */
const displayName = (profile) => profile?.full_name?.trim() || profile?.id || null;

async function loadProfiles() {
  const { data, error } = await supabase.from('profiles').select('id, role, full_name');
  if (error) throw error;
  const emails = await emailsById();
  return (data ?? []).map((profile) => ({ ...profile, email: emails.get(profile.id) ?? '' }));
}

/** The first profile of each role by email; a profile with no email sorts last. */
function recipientsByRole(profiles) {
  const byRole = {};
  for (const role of ROLES) {
    const [first] = profiles
      .filter((profile) => profile.role === role)
      .sort((a, b) => Number(!a.email) - Number(!b.email)
        || a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
    byRole[role] = first ?? null;
  }
  return byRole;
}

/**
 * A non-draft event, preferring the seeded coordinator's and the seeded
 * organiser's, then one with a booking so the booking types can be shown.
 */
async function pickEvent(coordinator, organiser) {
  const { data, error } = await supabase
    .from('event_requests')
    .select('id, event_name, status, organiser_id, assigned_coordinator_id, proposed_start, submitted_at')
    .neq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(EVENT_LIMIT);
  if (error) throw error;
  if (!data?.length) return null;

  const { data: booked, error: bookedError } = await supabase
    .from('bookings')
    .select('event_request_id')
    .in('event_request_id', data.map((event) => event.id));
  if (bookedError) throw bookedError;
  const hasBooking = new Set((booked ?? []).map((row) => row.event_request_id));

  const score = (event) => (event.assigned_coordinator_id === coordinator?.id ? 4 : 0)
    + (event.organiser_id === organiser?.id ? 2 : 0)
    + (hasBooking.has(event.id) ? 1 : 0);
  // Stable sort keeps the newest first among equals.
  return [...data].sort((a, b) => score(b) - score(a))[0];
}

async function firstBooking(eventId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, venue_id, starts_at, ends_at, decided_at, venues(name)')
    .eq('event_request_id', eventId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/** An approved booking of another event at the same venue, for the clash notice. */
async function approvedRival(booking, eventId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, event_request_id, starts_at, ends_at, event_requests(event_name)')
    .eq('venue_id', booking.venue_id)
    .eq('status', 'approved')
    .neq('event_request_id', eventId)
    .order('starts_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function firstEquipmentRequestId(eventId) {
  const { data, error } = await supabase
    .from('equipment_requests')
    .select('id')
    .eq('event_request_id', eventId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

const one = (embedded) => (Array.isArray(embedded) ? embedded[0] : embedded) ?? {};

/**
 * Every notification to seed, in newest-first order. A spec with a `skip`
 * reason is logged and not inserted.
 */
function buildSpecs({ event, recipients, profiles, booking, rival, equipmentRequestId }) {
  const { event_coordinator: coordinator, event_coordinator_lead: lead } = recipients;
  const eventRef = { eventRequestId: event.id, eventName: event.event_name };
  const coordinatorId = event.assigned_coordinator_id ?? coordinator?.id ?? null;
  const coordinatorName = displayName(profiles.find((p) => p.id === coordinatorId)) ?? coordinatorId;
  const venueName = one(booking?.venues).name ?? null;
  const bookingRef = booking && {
    ...eventRef,
    venueId: booking.venue_id,
    venueName,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
  };
  const noBooking = booking ? null : `${event.event_name} has no booking (booking_id is required)`;
  const replyBy = new Date(Date.now() + 7 * 24 * HOUR).toISOString().slice(0, 10);

  return [
    { role: 'safety_officer', type: 'event_submitted_for_safety_review',
      payload: (at) => ({ ...eventRef, coordinatorId, coordinatorName,
        startsAt: event.proposed_start, submittedAt: at }) },
    { role: 'event_coordinator', type: 'safety_review_response', outcome: 'changes_requested',
      payload: (at) => ({ eventName: event.event_name, outcome: 'changes_requested',
        note: 'Add a second marshal at the main exit, then resubmit.', responseId: null, respondedAt: at }) },
    { role: 'venue_staff', type: 'safety_booking_flagged', bookingId: booking?.id, skip: noBooking,
      payload: () => ({ eventName: event.event_name, venueName, startsAt: booking.starts_at,
        endsAt: booking.ends_at, reason: 'Safety review', responseId: null }) },
    { role: 'technical_support_staff', type: 'safety_equipment_review',
      payload: () => ({ eventName: event.event_name, equipmentRequestId, responseId: null }) },
    { role: 'event_coordinator', type: 'safety_review_response', outcome: 'approved',
      payload: (at) => ({ eventName: event.event_name, outcome: 'approved', note: null,
        responseId: null, respondedAt: at }) },
    { role: 'event_organiser', type: 'safety_review_response', outcome: 'approved',
      payload: (at) => ({ eventName: event.event_name, outcome: 'approved', note: null,
        responseId: null, respondedAt: at }) },
    { role: 'event_coordinator', type: 'booking_request_conflicting', bookingId: booking?.id,
      skip: noBooking ?? (rival ? null : `no other event holds an approved booking at ${venueName}`),
      payload: () => ({ ...bookingRef, approvedBookingId: rival.id,
        approvedEventRequestId: rival.event_request_id,
        approvedEventName: one(rival.event_requests).event_name ?? null,
        approvedStartsAt: rival.starts_at, approvedEndsAt: rival.ends_at }) },
    { role: 'event_coordinator', type: 'booking_request_rejected', bookingId: booking?.id, skip: noBooking,
      payload: (at) => ({ ...bookingRef, decidedAt: at,
        reason: 'The room is being repainted that week.',
        suggestedAlternative: 'The same room the following week, or the seminar room that day.' }) },
    { role: 'event_coordinator', type: 'booking_request_approved', bookingId: booking?.id, skip: noBooking,
      payload: (at) => ({ ...bookingRef, decidedAt: booking.decided_at ?? at,
        reason: null, suggestedAlternative: null }) },
    { role: 'venue_staff', type: 'booking_request_withdrawn', bookingId: booking?.id, skip: noBooking,
      payload: () => ({ ...bookingRef }) },
    { role: 'event_coordinator', type: 'clarification_replied',
      payload: () => ({ ...eventRef, message: 'Expected attendance is now 120; the rest is unchanged.' }) },
    { role: 'event_organiser', type: 'clarification_requested',
      payload: () => ({ ...eventRef, message: 'Please confirm the expected attendance.', replyByDate: replyBy }) },
    { role: 'event_organiser', type: 'event_request_coordinator_assigned',
      payload: () => ({ ...eventRef, coordinatorId, coordinatorName,
        previousCoordinatorId: null, previousCoordinatorName: null }) },
    { role: 'event_coordinator', type: 'event_request_assigned',
      payload: () => ({ ...eventRef, assignedById: lead?.id ?? null, assignedByName: displayName(lead),
        previousCoordinatorId: null, previousCoordinatorName: null,
        note: 'Please check the venue options first.' }) },
    { role: 'event_coordinator_lead', type: 'event_request_awaiting_assignment',
      payload: (at) => ({ ...eventRef, submittedAt: event.submitted_at ?? at }) },
  ];
}

/** A marked row already there for this recipient, type and outcome; --many rows never count. */
async function alreadySeeded(recipientId, type, outcome) {
  let query = supabase
    .from('notifications')
    .select('id')
    .eq('recipient_id', recipientId)
    .eq('type', type)
    .eq('payload->>seeded', SEED_MARKER)
    .is('payload->>seededMany', null)
    .limit(1);
  if (outcome) query = query.eq('payload->>outcome', outcome);
  const { data, error } = await query;
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

const label = (profile) => `${profile.email || profile.id} (${profile.role})`;

async function seedSpecs(specs, recipients, event) {
  const counts = { kept: 0, created: 0, skipped: 0 };
  // Newest first: the first spec is an hour old, each next one five hours older.
  for (const [index, spec] of specs.entries()) {
    const recipient = recipients[spec.role];
    const name = spec.outcome ? `${spec.type} (${spec.outcome})` : spec.type;
    if (!recipient) {
      console.log(`  skipped  ${name}: no ${spec.role} profile`);
      counts.skipped += 1;
      continue;
    }
    if (spec.skip) {
      console.log(`  skipped  ${name} for ${label(recipient)}: ${spec.skip}`);
      counts.skipped += 1;
      continue;
    }
    if (await alreadySeeded(recipient.id, spec.type, spec.outcome)) {
      console.log(`  kept     ${name} for ${label(recipient)}`);
      counts.kept += 1;
      continue;
    }

    const at = new Date(Date.now() - (1 + index * 5) * HOUR).toISOString();
    const { error } = await supabase.from('notifications').insert({
      recipient_id: recipient.id,
      type: spec.type,
      booking_id: spec.bookingId ?? null,
      event_request_id: event.id,
      payload: { ...spec.payload(at), seeded: SEED_MARKER },
      created_at: at,
    });
    if (error) throw error;
    console.log(`  created  ${name} for ${label(recipient)}`);
    counts.created += 1;
  }
  return counts;
}

/** --many: top the seeded coordinator up to 55 older unread rows. */
async function seedMany(coordinator, event) {
  if (!coordinator) {
    console.log('  skipped  --many: no event_coordinator profile');
    return;
  }
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', coordinator.id)
    .eq('payload->>seeded', SEED_MARKER)
    .eq('payload->>seededMany', 'true');
  if (error) throw error;
  if (count >= MANY_COUNT) {
    console.log(`  kept     ${count} --many rows for ${label(coordinator)}`);
    return;
  }

  // Older than every row above, so the demo types stay at the top of the list.
  const rows = [];
  for (let n = count + 1; n <= MANY_COUNT; n += 1) {
    const at = new Date(Date.now() - (4 * 24 + n) * HOUR).toISOString();
    rows.push({
      recipient_id: coordinator.id,
      type: 'clarification_replied',
      event_request_id: event.id,
      payload: {
        eventRequestId: event.id,
        eventName: event.event_name,
        message: `Demo reply ${n} of ${MANY_COUNT}.`,
        seeded: SEED_MARKER,
        seededMany: true,
      },
      created_at: at,
    });
  }
  const { error: insertError } = await supabase.from('notifications').insert(rows);
  if (insertError) throw insertError;
  console.log(`  created  ${rows.length} --many rows for ${label(coordinator)} (now ${MANY_COUNT})`);
}

async function main() {
  const many = process.argv.includes('--many');
  console.log(`\nSeeding demo notifications${many ? ' (with --many)' : ''}\n`);

  const profiles = await loadProfiles();
  const recipients = recipientsByRole(profiles);
  for (const role of ROLES) {
    const recipient = recipients[role];
    console.log(recipient
      ? `  recipient ${role}: ${recipient.email || recipient.id}`
      : `  recipient ${role}: none (no profile with this role)`);
  }

  const event = await pickEvent(recipients.event_coordinator, recipients.event_organiser);
  if (!event) {
    console.log('\n  skipped  no non-draft event to point the notifications at; nothing changed.\n');
    return;
  }
  console.log(`\n  event    ${event.event_name} (${event.status}, ${event.id})`);

  const booking = await firstBooking(event.id);
  const rival = booking ? await approvedRival(booking, event.id) : null;
  const equipmentRequestId = await firstEquipmentRequestId(event.id);
  console.log(`  booking  ${booking ? `${one(booking.venues).name ?? booking.venue_id} (${booking.id})` : 'none'}`);
  console.log(`  equipment request ${equipmentRequestId ?? 'none (equipmentRequestId left null)'}\n`);

  const specs = buildSpecs({ event, recipients, profiles, booking, rival, equipmentRequestId });
  const counts = await seedSpecs(specs, recipients, event);
  if (recipients.attendee) {
    console.log(`  skipped  ${label(recipients.attendee)}: no notification type addresses attendees yet`);
  }

  if (many) await seedMany(recipients.event_coordinator, event);

  console.log(`\nDone. Created ${counts.created}, kept ${counts.kept}, skipped ${counts.skipped}.`
    + ' Sign in as each recipient above to see the inbox; npm run notifications:unseed removes them.\n');
}

try {
  await main();
} catch (err) {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
}
