/**
 * Flagged booking routes: listing and resolving bookings flagged for review.
 *
 * GET / lists them, behind venueStaffOnly; GET /events/:eventRequestId lists
 * one event's, behind coordinatorOnly. POST /:id/reinstate approves a
 * flagged booking again, behind venueStaffOnly; POST /:id/cancel cancels it,
 * behind coordinatorOrVenueStaff. The functions (078, 076, 077) check the
 * role again, 076 and 077 under lock, and 078's event list and 077 also check
 * that a coordinator is the event's assigned one. The caller is always req.user.id,
 * and only the reason (and, to reinstate, the period shown) is read from the body.
 *
 * A factory over an injected client and verifier, as the other routers are, so
 * the tests drive real Express routing without credentials.
 */

import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromRecord } from '../middleware/finalEventGuard.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import {
  cancelFlaggedBooking,
  listEventFlaggedBookings,
  listFlaggedBookings,
  reinstateFlaggedBooking,
} from '../services/flaggedBookingService.js';

const errorMiddleware = createErrorMiddleware('flagged bookings route');

/**
 * @param {object} [options]
 * @param {object} [options.client]        Supabase client, for tests
 * @param {Function} [options.requireAuth] authentication middleware, for tests
 * @param {Function} [options.requireRole] a factory, as in the other routers
 * @param {Function} [options.checkSuitability] the N10 check, for tests
 * @returns {import('express').Router}
 */
export function createFlaggedBookingRouter({
  client,
  requireAuth = defaultRequireAuth,
  finalEventGuard = noopFinalEventGuard,
  requireRole = createRequireRole,
  checkSuitability,
} = {}) {
  const router = express.Router();

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  const guardBooking = finalEventGuard(eventIdFromRecord('bookings', 'id'));

  const venueStaffOnly = requireRole(ROLE.VENUE_STAFF);
  // Any coordinator passes the gate; 078 refuses one not assigned to the event.
  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);
  // Any coordinator passes the gate; 077 refuses one not assigned to the event.
  const coordinatorOrVenueStaff = requireRole(ROLE.EVENT_COORDINATOR, ROLE.VENUE_STAFF);

  router.use(requireAuth);

  /**
   * Every booking flagged for review, oldest flag first, each with what
   * flagged it. 200 and an array, possibly empty. SCRUM-593:
   * suitabilityAtNewTimes is the suitability at the event's current period
   * ({ suitable, criteria, checked }) when reinstating would move the booking
   * there; null when it would not, or when that check failed.
   *
   * Statuses: 401; 403 wrong role or no role.
   */
  router.get('/', venueStaffOnly, async (req, res) => {
    res.status(200).json(await listFlaggedBookings(req.user.id, { client, checkSuitability }));
  });

  /**
   * One event's flagged bookings, for its assigned coordinator, each with the
   * live requests replacing it. 200 and an array, possibly empty.
   *
   * Statuses: 400 malformed event id; 401; 403 wrong role or no role, or a
   * coordinator not assigned to the event; 404 no such event.
   */
  router.get('/events/:eventRequestId', coordinatorOnly, async (req, res) => {
    res.status(200).json(
      await listEventFlaggedBookings(req.params.eventRequestId, req.user.id, { client }),
    );
  });

  /**
   * Reinstate a flagged booking with a reason. 200 and the booking, now
   * approved, with `resolution`: who reinstated it, why and when, and the
   * period it moved from when the event's new period was booked instead.
   *
   * Body: { reason, expectedStartsAt, expectedEndsAt } -- the period Venue
   * Staff were shown (the booking's own, or the event's when it moves), ISO
   * 8601 with an offset, both required. A move records the suitability at the
   * new period, unsuitable or not.
   *
   * Statuses: 400 malformed id, a missing or blank reason, or one too long,
   * or a missing or malformed expected period; 401; 403 wrong role or no
   * role; 404 no such booking; 409 by code BOOKING_NOT_FLAGGED,
   * SAFETY_FLAG_NOT_REINSTATABLE, EVENT_NOT_BOOKABLE, BOOKING_PERIOD_STALE,
   * BOOKING_PERIOD_CHANGED (not the period shown), VENUE_RETIRED,
   * BOOKING_PERIOD_CONFLICT (with `conflicts`) or BOOKING_CHANGED.
   */
  router.post('/:id/reinstate', venueStaffOnly, guardBooking, async (req, res) => {
    res.status(200).json(
      await reinstateFlaggedBooking(req.params.id, req.user.id, req.body, { client, checkSuitability }),
    );
  });

  /**
   * Cancel a flagged booking with a reason. 200 and the booking, now
   * cancelled, with `resolution`: who cancelled it, why and when.
   *
   * Statuses: 400 malformed id, a missing or blank reason, or one too long;
   * 401; 403 wrong role or no role, or a coordinator not assigned to the
   * event; 404 no such booking; 409 by code BOOKING_NOT_FLAGGED or
   * BOOKING_CHANGED.
   */
  router.post('/:id/cancel', coordinatorOrVenueStaff, guardBooking, async (req, res) => {
    res.status(200).json(
      await cancelFlaggedBooking(req.params.id, req.user.id, req.body, { client }),
    );
  });

  router.use(errorMiddleware);
  return router;
}

export default createFlaggedBookingRouter({ finalEventGuard: createFinalEventGuard() });
