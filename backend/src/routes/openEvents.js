/**
 * GET / lists the events an Attendee can register for; GET /:id opens one.
 * Attendee only: the role comes from profiles via requireAuth, never the request.
 * A factory over an injected client and clock so tests need no credentials.
 */
import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { listOpenEvents, getOpenEvent } from '../services/openEventService.js';

const handleError = createErrorHandler('open events route');

/**
 * @param {object} [options]
 * @param {object} [options.client]        Supabase client, for tests
 * @param {Function} [options.requireAuth] authentication middleware, for tests
 * @param {Function} [options.requireRole] a factory, as in the other routers
 * @param {() => Date} [options.now]       the clock, for tests
 * @returns {import('express').Router}
 */
export function createOpenEventRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
  now = () => new Date(),
} = {}) {
  const router = express.Router();

  router.use(requireAuth);

  const attendeeOnly = requireRole(ROLE.ATTENDEE);

  /**
   * A bare array, like the other lists; none open is 200 [], never 404. Each
   * event says how many places are left, whether it is full, and whether the
   * caller is already registered; the caller is always req.user.id, never
   * anything in the query string or body.
   *
   * no-store: eligibility changes with the clock and with the organiser's
   * settings, so a stored copy would keep listing an event that has closed.
   *
   * Statuses: 200, 401, 403 for any role but Attendee (or no role), 500 for
   * anything untyped.
   */
  router.get('/', attendeeOnly, async (req, res) => {
    try {
      const events = await listOpenEvents({ attendeeId: req.user.id, client, now: now() });
      res.set('Cache-Control', 'no-store');
      res.status(200).json(events);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * One open event, for the details page. The same eligibility as the list,
   * judged now, so a direct URL gets no more than the list would show: an
   * event that is missing, not Confirmed, switched off, outside its window or
   * already started is 404 with one message for all of them.
   *
   * The browse preview: no venue and no internal planning information. The
   * registered-attendee view (SCRUM-24) is a separate endpoint and page.
   *
   * Statuses: 200, 401, 403 for any role but Attendee, 404, 500.
   */
  router.get('/:id', attendeeOnly, async (req, res) => {
    try {
      const event = await getOpenEvent({
        attendeeId: req.user.id,
        eventId: req.params.id,
        client,
        now: now(),
      });
      res.set('Cache-Control', 'no-store');
      res.status(200).json(event);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createOpenEventRouter();
