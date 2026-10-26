/**
 * GET / and /:id browse events; POST /:id/registrations and /:id/waitlist use
 * the atomic RPCs.
 * Attendee only: the role comes from profiles via requireAuth, never the request.
 * A factory over an injected client and clock so tests need no credentials.
 */
import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import { listOpenEvents, getOpenEvent } from '../services/openEventService.js';
import { registerForEvent, joinEventWaitlist } from '../services/registrationService.js';

const errorMiddleware = createErrorMiddleware('open events route');

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

  router.post('/:id/registrations', attendeeOnly, async (req, res) => {
    const registration = await registerForEvent({
      attendeeId: req.user.id,
      eventId: req.params.id,
      client,
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json(registration);
  });

  router.post('/:id/waitlist', attendeeOnly, async (req, res) => {
    const { created, registration } = await joinEventWaitlist({
      attendeeId: req.user.id,
      eventId: req.params.id,
      client,
    });
    res.set('Cache-Control', 'no-store');
    // 200 for a repeat join: nothing new was created, the entry is unchanged.
    res.status(created ? 201 : 200).json(registration);
  });

  // The caller is always req.user.id. No-store: eligibility changes with the
  // clock, so a stored copy would keep listing an event that has closed.
  router.get('/', attendeeOnly, async (req, res) => {
    const events = await listOpenEvents({ attendeeId: req.user.id, client, now: now() });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(events);
  });

  // Same eligibility as the list, so a direct URL gets no more than the list
  // shows; every reason it is not on offer is the same 404.
  router.get('/:id', attendeeOnly, async (req, res) => {
    const event = await getOpenEvent({
      attendeeId: req.user.id,
      eventId: req.params.id,
      client,
      now: now(),
    });
    res.set('Cache-Control', 'no-store');
    res.status(200).json(event);
  });

  router.use(errorMiddleware);
  return router;
}

export default createOpenEventRouter();
