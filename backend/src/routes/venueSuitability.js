/**
 * Check one venue's suitability for an event.
 *
 * SCRUM-190, a subtask of SCRUM-188 (Check Venue Suitability for an Event).
 * Mounted at /api/event-requests/:id/venue-suitability, in its own file so the
 * shared event request router is left alone, as the equipment routes are.
 *
 *   GET /?venueId=…&layout=…&accessibility=a,b&facilities=x,y
 *
 * Answers the check's result: { suitable, criteria, checked }, the six
 * criteria each met or not with the values compared, and the values judged
 * (see venueSuitabilityService.js). The SCRUM-191 panel calls this before the
 * coordinator submits a booking request, and the booking request repeats the
 * same check on submit.
 *
 * Who may ask, and why:
 *
 *   Event Coordinators only. Every other role gets 403 before the service
 *   runs. The result reveals when a venue is busy and for which event, as
 *   the event search does, and the search is Event Coordinators only too.
 *   Among coordinators, only the event's assigned one: the service enforces
 *   that with userId, from the token, and answers 403 to anyone else.
 *
 * Only the venue and the requirement codes come from the query string. The
 * event's period and attendance are always the stored ones; a query naming
 * them is not an error, the keys are simply never read.
 *
 * The code lists are comma-separated, read by the event search's
 * parseCodeList (http/parseCodeList.js), for the reason given there.
 *
 * A venue that is not suitable is still a 200: it is an answer, not an error,
 * for the same reason the event search answers [] rather than 404.
 *
 * Statuses: 200; 400 a malformed id or code, or an unknown code; 401; 403
 * wrong role, or not the event's assigned coordinator; 404 no such event or
 * venue; 409 with code EVENT_DATES_MISSING, EVENT_ATTENDANCE_MISSING
 * (SCRUM-193/194: an event with no expected attendance cannot be judged on
 * Capacity) or VENUE_RETIRED; 500.
 *
 *   GET /bookings
 *
 * SCRUM-192 (SCRUM-188 AC6, Week 7): every venue the event has requested or
 * booked -- pending, approved or flagged for review -- checked again now,
 * against the event's current period and attendance and the venue's current
 * details, setup and turnaround included. Computed on each view rather than
 * stored; venueSuitabilityService.checkEventVenues says why. The same callers
 * as the one-venue check, for the same reasons: Event Coordinators only, and
 * among them only the event's assigned one.
 *
 * Answers an array, oldest booking first, each with the live verdict
 * (current), the stored one (atRequest) and newlyUnmet. An event with no live
 * bookings is 200 with [], not 404. Each item also carries its booking's own
 * period (bookingStartsAt, bookingEndsAt); when that no longer matches the
 * event's, Availability is not met and says so (SCRUM-193/194).
 *
 * A failure that belongs to one booking is that item's error, not the
 * response's: the item has current null, newlyUnmet [] and error { code,
 * message }, with code VENUE_RETIRED, STORED_REQUIREMENTS_INVALID (the stored
 * accessibility or facility codes cannot be judged) or RECHECK_FAILED
 * (anything else, such as a venue or availability read that failed).
 *
 * Statuses: 200; 400 a malformed event id; 401; 403 wrong role, or not the
 * event's assigned coordinator; 404 no such event; 409 with code
 * EVENT_DATES_MISSING or EVENT_ATTENDANCE_MISSING; 500, including a failed
 * read of the event's bookings.
 */

import express from 'express';

import {
  checkEventVenues as checkEventVenuesService,
  checkVenueSuitability,
} from '../services/venueSuitabilityService.js';
import {
  validateEventVenuesQuery,
  validateSuitabilityQuery,
} from '../validation/venueSuitabilityValidation.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { parseCodeList } from '../http/parseCodeList.js';


/** Map an error to a response; see src/http/handleError.js. */
const handleError = createErrorHandler('venue suitability route');


/**
 * The query string, and the event id from the path, as validateSuitabilityQuery
 * expects them. Only the code lists need converting; the ids and layout are
 * text already and pass through as sent, so every rule stays the validator's.
 */
function parseSuitabilityQuery(eventRequestId, query) {
  const input = {
    eventRequestId,
    venueId: query.venueId,
    layout: query.layout,
  };
  for (const field of ['accessibility', 'facilities']) {
    if (query[field] === undefined) continue;
    const codes = parseCodeList(query[field]);
    if (codes !== undefined) input[field] = codes;
  }
  return input;
}


/**
 * Build the router, optionally over injected middleware, client and checker.
 *
 * A factory for the reason routes/eventEquipment.js gives: the tests drive
 * real Express routing with fake authentication and a fake client, while
 * production supplies neither.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]       a factory, as in the other routers
 * @param {object}   [options.client]            a Supabase client, usually a test double
 * @param {Function} [options.checkSuitability]  the check, for tests
 * @param {Function} [options.checkEventVenues]  the recheck of the event's
 *                                               bookings (SCRUM-192), for tests
 * @returns {import('express').Router}
 */
export function createVenueSuitabilityRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
  client,
  checkSuitability = checkVenueSuitability,
  checkEventVenues = checkEventVenuesService,
} = {}) {
  // mergeParams: this router is mounted under /:id, and that id is the event's.
  const router = express.Router({ mergeParams: true });
  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);

  router.use(requireAuth);

  router.get('/', coordinatorOnly, async (req, res) => {
    try {
      const input = validateSuitabilityQuery(parseSuitabilityQuery(req.params.id, req.query));
      const result = await checkSuitability({ ...input, userId: req.user.id, client });
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/bookings', coordinatorOnly, async (req, res) => {
    try {
      const { eventRequestId } = validateEventVenuesQuery({ eventRequestId: req.params.id });
      const result = await checkEventVenues(eventRequestId, { userId: req.user.id, client });
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createVenueSuitabilityRouter();
