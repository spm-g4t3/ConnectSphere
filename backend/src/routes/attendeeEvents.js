import express from 'express';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import { getAttendeeEvent, listAttendeeEvents } from '../services/attendeeEventService.js';
import { withdrawRegistration } from '../services/registrationWithdrawalService.js';

const errorMiddleware = createErrorMiddleware('attendee events route');

export function createAttendeeEventRouter({ client, requireAuth = defaultRequireAuth } = {}) {
  const router = express.Router();
  // Withdrawals can revoke access; neither successes nor refusals may be cached.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAuth);
  router.get('/', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await listAttendeeEvents({ user: req.user, client }));
  });
  router.get('/:id', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await getAttendeeEvent({
      user: req.user, eventRequestId: req.params.id, client,
    }));
  });
  // The attendee is always req.user.id; eligibility is decided in SQL, never here.
  router.post('/registrations/:registrationId/withdrawal', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await withdrawRegistration({
      attendeeId: req.user.id, registrationId: req.params.registrationId, client,
    }));
  });
  router.use(errorMiddleware);
  return router;
}

export default createAttendeeEventRouter();
