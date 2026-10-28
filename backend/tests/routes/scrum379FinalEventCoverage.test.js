/**
 * SCRUM-382 (SCRUM-379 AC3): no mutating endpoint is left out of the guard.
 *
 * Walks the routers src/app.js mounts (every file in src/routes, default
 * export, so the real guard is what is inspected) and lists each route that
 * is not a read. Every one must either carry the final-event guard or appear
 * in EXEMPT with the reason it does not change an event. A route added later
 * fails this test until someone decides which it is, which is how "every
 * endpoint that changes an event" stays true after this story merges.
 *
 * The GUARDED list is the list attached to SCRUM-382. It is written out here
 * so that a guard added or removed without a matching edit to
 * docs/SCRUM-382.md also fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

import { FINAL_EVENT_GUARD_TAG } from '../../src/middleware/finalEventGuard.js';

// Some routers import the shared client when built without one; nothing here reaches it.
vi.mock('../../src/config/supabaseClient.js', () => ({ supabase: {} }));

const ROUTES_DIR = fileURLToPath(new URL('../../src/routes/', import.meta.url));
const READ_METHODS = new Set(['get', 'head', 'options']);

// Routes that change nothing about an event, with the reason.
const EXEMPT = {
  'auth POST /login': 'signs a user in',
  'auth POST /logout': 'signs a user out',
  'eventRequests POST /': 'creates a new event request; there is no event to be final yet',
  'eventRequests POST /:id/significant-change-impact': 'a preview of a significant change; it writes nothing',
  'equipment POST /': 'adds an equipment type to the catalogue',
  'equipment POST /:id/change-preview': 'a preview of a catalogue change; it writes nothing',
  'equipment POST /:id/retire': 'retires a catalogue item, for every event alike',
  'equipment POST /:id/reinstate': 'reinstates a catalogue item, for every event alike',
  'equipment PATCH /:id/condition': 'records the condition of a catalogue item',
  'equipment PATCH /:id': 'edits a catalogue item',
  'notifications PATCH /:id/read': 'marks the caller\'s own notification read',
  'venues POST /:id/blocks': 'a maintenance block on a venue, not on an event',
  'venues PATCH /:id/blocks/:blockId': 'edits a venue block',
  'venues DELETE /:id/blocks/:blockId': 'removes a venue block',
  'venues POST /': 'creates a venue',
  'venues PATCH /:id': 'edits a venue',
  'venues POST /:id/retire': 'retires a venue',
};

// The endpoints that carry the guard: the list attached to SCRUM-382.
const GUARDED = [
  'eventRequests PATCH /:id',
  'eventRequests POST /:id/submit',
  'eventRequests POST /:id/reopen',
  'eventRequests POST /:id/safety-review',
  'eventRequests POST /:id/confirm',
  'eventRequests POST /:id/clarification',
  'eventRequests POST /:id/clarification/close',
  'eventRequests POST /:id/reassign',
  'eventRequests POST /:id/assign',
  'eventRequests POST /:id/start-review',
  'eventRequests POST /:id/decision',
  'eventRequests POST /:id/cancel',
  'eventRequests PATCH /:id/details',
  'eventRequests POST /:id/complete',
  'eventRequests POST /:id/rejection',
  'eventRequests POST /:id/significant-change',
  'eventRequests PATCH /:id/clarification-response',
  'eventRequests POST /:id/change-requests',
  'eventRequests POST /change-requests/:changeRequestId/decision',
  'eventEquipment POST /lines',
  'eventEquipment PATCH /lines/:lineId',
  'eventEquipment DELETE /lines/:lineId',
  'equipmentReview POST /start',
  'equipmentReview POST /take-over',
  'equipmentReview PUT /lines/:lineId/outcome',
  'equipmentReview DELETE /lines/:lineId/outcome',
  'equipmentReview POST /complete',
  'equipmentReview POST /lines/:lineId/reservations',
  'equipmentReview PATCH /reservations/:reservationId',
  'equipmentReview POST /reservations/:reservationId/release',
  'equipmentReview POST /reservations/:reservationId/move',
  'equipmentReview POST /reservations/:reservationId/keep',
  'bookingRequests POST /',
  'bookingRequests POST /:id/withdraw',
  'bookingRequests POST /:id/release',
  'bookingRequests POST /:id/approve',
  'bookingRequests POST /:id/reject',
  'flaggedBookings POST /:id/reinstate',
  'flaggedBookings POST /:id/cancel',
  'openEvents POST /:id/registrations',
  'openEvents POST /:id/waitlist',
  'attendeeEvents POST /registrations/:registrationId/withdrawal',
  'attendeeEvents POST /registrations/:registrationId/leave-waitlist',
  'eventRegistration PUT /events/:id/settings',
  'safetyReviews POST /:eventRequestId/responses',
  'venues POST /:id/holds',
];

// Every route the app mounts: { key, method, guarded }.
async function collectRoutes() {
  const files = readdirSync(ROUTES_DIR).filter((file) => file.endsWith('.js')).sort();
  const found = [];
  for (const file of files) {
    const router = (await import(pathToFileURL(path.join(ROUTES_DIR, file)).href)).default;
    for (const layer of router.stack.filter((l) => l.route)) {
      const guarded = layer.route.stack.some((l) => l.handle?.[FINAL_EVENT_GUARD_TAG] === true);
      for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m])) {
        found.push({
          file: file.replace(/\.js$/, ''),
          method,
          key: `${file.replace(/\.js$/, '')} ${method.toUpperCase()} ${layer.route.path}`,
          guarded,
        });
      }
    }
  }
  return found;
}

const routes = await collectRoutes();
const writes = routes.filter((r) => !READ_METHODS.has(r.method));

describe('SCRUM-382: every route that changes an event carries the guard', () => {
  it('SCRUM379_AC3_the_walk_finds_the_routers_and_their_routes', () => {
    expect(new Set(routes.map((r) => r.file)).size).toBeGreaterThanOrEqual(16);
    expect(writes.length).toBeGreaterThanOrEqual(60);
    expect(routes.some((r) => r.key === 'eventRequests POST /:id/complete')).toBe(true);
  });

  it('SCRUM379_AC3_no_mutating_route_is_neither_guarded_nor_exempt', () => {
    const undecided = writes.filter((r) => !r.guarded && !(r.key in EXEMPT)).map((r) => r.key);
    expect(undecided, `Guard these in the router or add them to EXEMPT with a reason: ${undecided.join(', ')}`).toEqual([]);
  });

  it('SCRUM379_AC3_the_guarded_routes_are_exactly_the_documented_list', () => {
    const guarded = writes.filter((r) => r.guarded).map((r) => r.key);
    expect([...guarded].sort()).toEqual([...GUARDED].sort());
    expect(guarded).toHaveLength(46);
  });

  it('SCRUM379_AC3_an_exempt_route_still_exists_and_is_not_also_guarded', () => {
    const byKey = new Map(writes.map((r) => [r.key, r]));
    const stale = Object.keys(EXEMPT).filter((key) => !byKey.has(key));
    expect(stale, `EXEMPT lists routes that no longer exist: ${stale.join(', ')}`).toEqual([]);
    const both = Object.keys(EXEMPT).filter((key) => byKey.get(key)?.guarded);
    expect(both, `Remove from EXEMPT, these are guarded: ${both.join(', ')}`).toEqual([]);
  });

  it('SCRUM379_AC3_every_exemption_has_a_reason', () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim().length, key).toBeGreaterThan(10);
    }
  });

  it('SCRUM379_AC5_reads_are_never_guarded_so_a_final_event_stays_viewable', () => {
    const guardedReads = routes.filter((r) => READ_METHODS.has(r.method) && r.guarded).map((r) => r.key);
    expect(guardedReads).toEqual([]);
  });

  it('SCRUM379_AC3_the_routes_are_unique_so_no_key_hides_another', () => {
    const keys = routes.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('SCRUM379_AC3_nothing_changes_an_event_without_being_listed_in_one_of_the_two_places', () => {
    const accounted = new Set([...GUARDED, ...Object.keys(EXEMPT)]);
    const unlisted = writes.map((r) => r.key).filter((key) => !accounted.has(key));
    expect(unlisted).toEqual([]);
  });
});
