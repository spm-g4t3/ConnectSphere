/**
 * Booking request routes.
 *
 * SCRUM-252, SCRUM-253 and SCRUM-255, subtasks of SCRUM-243 (Submit a Venue
 * Booking Request).
 *
 * GET /mine lists the signed-in coordinator's requests, POST / creates a request
 * for a venue against an approved, safety-checked or confirmed event, and
 * POST /:id/withdraw withdraws a pending one, all behind coordinatorOnly. GET /pending (SCRUM-259)
 * lists every pending request for Venue Staff, and POST /:id/approve and
 * POST /:id/reject (SCRUM-260) decide one, behind venueStaffOnly.
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
import {
  approveBookingRequest,
  createBookingRequest,
  listBookingRequestsForCoordinator,
  listPendingBookingRequests,
  rejectBookingRequest,
  withdrawBookingRequest,
} from '../services/bookingRequestService.js';

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
  const venueStaffOnly = requireRole(ROLE.VENUE_STAFF);

  router.use(requireAuth);

  /**
   * SCRUM-255: the signed-in coordinator's booking requests, newest first,
   * every status, each with its event, venue and period, and Venue Staff's
   * decision once made (SCRUM-258 AC6).
   *
   * Narrowed to the events assigned to req.user.id, never to anything in the
   * query string or body, so one coordinator cannot read another's. Behind
   * coordinatorOnly, so an Organiser or Venue Staff is refused before the
   * database is touched. A bare array, like the other lists; an empty one is
   * 200 [], never 404.
   *
   * Statuses: 200, 401, 403 for the wrong role or no role, 500 for anything
   * untyped.
   */
  router.get('/mine', coordinatorOnly, async (req, res) => {
    try {
      const requests = await listBookingRequestsForCoordinator(req.user.id, { client });
      res.status(200).json(requests);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-259: every pending or conflicting booking request (066), oldest
   * first, for Venue Staff to decide on, each with its status and the other
   * events' open requests whose occupied periods overlap it, in submission
   * order. A conflicting one also carries conflictingWith: the bookings
   * occupying its period now, [] once that clash is gone (and on pending rows).
   *
   * Behind venueStaffOnly, and list_pending_booking_requests (066) checks the
   * caller's role again. A bare array; none pending is 200 [], never 404.
   * Declared before any /:id route, so "pending" is never read as an id.
   *
   * Statuses: 200, 401, 403 for the wrong role or no role, 500 for anything
   * untyped.
   */
  router.get('/pending', venueStaffOnly, async (req, res) => {
    try {
      const requests = await listPendingBookingRequests(req.user.id, { client });
      res.status(200).json(requests);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * Request a venue. 201 and the new request, which is always pending.
   *
   * Body: { eventRequestId, venueId, roomLayoutCode?, setupNotes?,
   * confirmUnsuitable?, accessibility?, facilities?, acknowledgedCriteria?,
   * expectedAttendance?, replacesBookingId? } -- expectedAttendance (SCRUM-525) is this venue's
   * own attendance, a whole number from 1, defaulting to the event's; the two
   * code lists are SCRUM-190's, judged by the suitability check and
   * stored in its result. acknowledgedCriteria (SCRUM-193/194) names, by
   * label, the criteria the coordinator accepts the venue does not meet; an
   * unsuitable venue is requested only when confirmUnsuitable is true and it
   * names every unmet criterion, else 409 SUITABILITY_CONFIRMATION_REQUIRED.
   * replacesBookingId? (SCRUM-266) names this event's flagged booking that the
   * request replaces; approving the request then cancels that booking.
   *
   * Statuses: 400 bad input, or an unknown requirement code; 401; 403 wrong
   * role, or not this event's coordinator; 404 no such event or venue; 409
   * with `code` and `conflicts` (see createBookingRequest), including
   * EVENT_ATTENDANCE_MISSING when neither the body nor the event gives an
   * expected attendance, and REPLACED_BOOKING_NOT_ON_EVENT or
   * REPLACED_BOOKING_NOT_FLAGGED for a replacesBookingId that is not this
   * event's flagged booking.
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

  /**
   * SCRUM-260: approve a pending or conflicting request. 200 and the request,
   * now approved, with who decided and when, `markedConflicting`: the ids of
   * other events' requests it made conflicting, and `convertedHoldId`: the
   * event's hold on the venue it converted, or null (both 066).
   *
   * Behind venueStaffOnly, and decide_booking_request (066) checks the role
   * again. No pre-check: whether the request is still pending, the event still
   * live and on the same dates, and the venue still free for the padded period
   * are answered under its locks. There is no body; the caller is always
   * req.user.id.
   *
   * Statuses: 400 malformed id; 401; 403 wrong role or no role; 404 no such
   * request; 409 with `code`: BOOKING_NOT_PENDING, EVENT_NOT_BOOKABLE,
   * BOOKING_PERIOD_STALE, VENUE_RETIRED, or BOOKING_PERIOD_CONFLICT with
   * `conflicts` (see approveBookingRequest).
   */
  router.post('/:id/approve', venueStaffOnly, async (req, res) => {
    try {
      const booking = await approveBookingRequest(req.params.id, req.user.id, { client });
      res.status(200).json(booking);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-260: reject a pending request. 200 and the request, now rejected,
   * with who decided, when, the reason and any suggested alternative.
   *
   * Body: { reason, suggestedAlternative? } -- reason is required and not
   * blank; both are at most 1000 characters. Behind venueStaffOnly, and
   * decide_booking_request (066) checks the role again. The caller is always
   * req.user.id.
   *
   * Statuses: 400 malformed id, a missing or blank reason, or a text too long;
   * 401; 403 wrong role or no role; 404 no such request; 409
   * BOOKING_NOT_PENDING.
   */
  router.post('/:id/reject', venueStaffOnly, async (req, res) => {
    try {
      const booking = await rejectBookingRequest(req.params.id, req.user.id, req.body, { client });
      res.status(200).json(booking);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createBookingRequestRouter();
