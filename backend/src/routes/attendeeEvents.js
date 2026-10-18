import express from 'express';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import { getAttendeeEvent } from '../services/attendeeEventService.js';

const handleError = createErrorHandler('attendee events route');

export function createAttendeeEventRouter({ client, requireAuth = defaultRequireAuth } = {}) {
  const router = express.Router();
  // Withdrawals can revoke access; neither successes nor refusals may be cached.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAuth);
  router.get('/:id', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    try {
      res.status(200).json(await getAttendeeEvent({
        user: req.user, eventRequestId: req.params.id, client,
      }));
    } catch (error) {
      handleError(error, res);
    }
  });
  return router;
}

export default createAttendeeEventRouter();
