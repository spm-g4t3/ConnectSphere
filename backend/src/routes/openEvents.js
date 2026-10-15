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

  // The caller is always req.user.id. No-store: eligibility changes with the
  // clock, so a stored copy would keep listing an event that has closed.
  router.get('/', attendeeOnly, async (req, res) => {
    try {
      const events = await listOpenEvents({ attendeeId: req.user.id, client, now: now() });
      res.set('Cache-Control', 'no-store');
      res.status(200).json(events);
    } catch (err) {
      handleError(err, res);
    }
  });

  // Same eligibility as the list, so a direct URL gets no more than the list
  // shows; every reason it is not on offer is the same 404.
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
