/**
 * Flagged booking routes: Venue Staff resolving a booking flagged for review.
 *
 * POST /:id/reinstate approves a flagged booking again, behind venueStaffOnly;
 * reinstate_flagged_booking (076) checks the role again under lock. The caller
 * is always req.user.id, and only the reason is read from the body.
 *
 * A factory over an injected client and verifier, as the other routers are, so
 * the tests drive real Express routing without credentials.
 */

import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { reinstateFlaggedBooking } from '../services/flaggedBookingService.js';

const handleError = createErrorHandler('flagged bookings route');

/**
 * @param {object} [options]
 * @param {object} [options.client]        Supabase client, for tests
 * @param {Function} [options.requireAuth] authentication middleware, for tests
 * @param {Function} [options.requireRole] a factory, as in the other routers
 * @returns {import('express').Router}
 */
export function createFlaggedBookingRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();

  const venueStaffOnly = requireRole(ROLE.VENUE_STAFF);

  router.use(requireAuth);

  /**
   * Reinstate a flagged booking with a reason. 200 and the booking, now
   * approved, with `resolution`: who reinstated it, why and when.
   *
   * Statuses: 400 malformed id, a missing or blank reason, or one too long;
   * 401; 403 wrong role or no role; 404 no such booking; 409 by code
   * BOOKING_NOT_FLAGGED, SAFETY_FLAG_NOT_REINSTATABLE, EVENT_NOT_BOOKABLE,
   * BOOKING_PERIOD_STALE, VENUE_RETIRED, BOOKING_PERIOD_CONFLICT (with
   * `conflicts`) or BOOKING_CHANGED.
   */
  router.post('/:id/reinstate', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(
        await reinstateFlaggedBooking(req.params.id, req.user.id, req.body, { client }),
      );
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createFlaggedBookingRouter();
