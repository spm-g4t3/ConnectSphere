/**
 * Booking request routes.
 *
 * SCRUM-252 and SCRUM-253, subtasks of SCRUM-243 (Submit a Venue Booking Request).
 *
 * POST / creates a request for a venue against an approved or confirmed event,
 * and POST /:id/withdraw withdraws a pending one, both behind coordinatorOnly.
 * Whether the caller is that event's assigned coordinator is checked in the
 * service and again, under lock, in create_booking_request (030), or only
 * under lock in withdraw_booking_request (031); the route only passes on what
 * was asked and
 * takes the caller from the token. The body is passed whole and the service
 * reads only the coordinator's choices from it, so a body naming a status, a
 * period or another requester matches nothing.
 *
 * Like the other routers this is a factory over an injected client, a verifier
 * and a suitability checker, so the tests drive real Express routing without
 * credentials. Nothing imported here reaches config/supabaseClient.js.
 */

import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { createBookingRequest, withdrawBookingRequest } from '../services/bookingRequestService.js';

const handleError = createErrorHandler('booking requests route');

/**
 * @param {object} [options]
 * @param {object} [options.client]            Supabase client, for tests
 * @param {Function} [options.requireAuth]     authentication middleware, for tests
 * @param {Function} [options.requireRole]     a factory, as in the other routers
 * @param {Function} [options.checkSuitability] the N10 check, for tests
 * @returns {import('express').Router}
 */
export function createBookingRequestRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
  checkSuitability,
} = {}) {
  const router = express.Router();

  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);

  router.use(requireAuth);

  /**
   * Request a venue. 201 and the new request, which is always pending.
   *
   * Body: { eventRequestId, venueId, roomLayoutCode?, setupNotes?,
   * confirmUnsuitable? }.
   *
   * Statuses: 400 bad input; 401; 403 wrong role, or not this event's
   * coordinator; 404 no such event or venue; 409 with `code` and `conflicts`
   * (see createBookingRequest); 503 while suitability checking is unavailable.
   */
  router.post('/', coordinatorOnly, async (req, res) => {
    try {
      const booking = await createBookingRequest(req.body, req.user.id, {
        client,
        checkSuitability,
      });
      res.status(201).json(booking);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-253: withdraw a pending request. 200 and the request, now withdrawn.
   *
   * Behind coordinatorOnly, with no pre-check, like POST /:id/reassign: whether
   * the caller is the event's assigned coordinator, and whether the request is
   * still pending, are answered by withdraw_booking_request under its locks.
   * There is no body; the caller is always req.user.id.
   *
   * Statuses: 400 malformed id; 401; 403 wrong role, or not this event's
   * coordinator; 404 no such request; 409 BOOKING_NOT_PENDING, which includes a
   * request that was already withdrawn -- repeating the call is refused, not
   * answered as a success.
   */
  router.post('/:id/withdraw', coordinatorOnly, async (req, res) => {
    try {
      const booking = await withdrawBookingRequest(req.params.id, req.user.id, { client });
      res.status(200).json(booking);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createBookingRequestRouter();
