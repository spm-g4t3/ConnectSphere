/**
 * Open events route.
 *
 * SCRUM-495: GET / lists the events an Attendee can register for.
 *
 * Attendee only (SCRUM-453 AC3, SCRUM-495 AC1): requireAuth establishes who is
 * calling from the token and the role comes from profiles, never from the
 * request, then requireRole refuses every other role with 403. A caller with no
 * token gets 401 before anything is read.
 *
 * A factory over an injected client, verifier and clock, like the other
 * routers, so the tests drive real Express routing without credentials.
 */

import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { listOpenEvents } from '../services/openEventService.js';

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

  /**
   * A bare array, like the other lists; none open is 200 [], never 404.
   *
   * no-store: eligibility changes with the clock and with the organiser's
   * settings, so a stored copy would keep listing an event that has closed.
   *
   * Statuses: 200, 401, 403 for any role but Attendee (or no role), 500 for
   * anything untyped.
   */
  router.get('/', requireRole(ROLE.ATTENDEE), async (req, res) => {
    try {
      const events = await listOpenEvents({ client, now: now() });
      res.set('Cache-Control', 'no-store');
      res.status(200).json(events);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createOpenEventRouter();
