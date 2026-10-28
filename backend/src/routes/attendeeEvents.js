import express from 'express';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromRecord } from '../middleware/finalEventGuard.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import { getAttendeeEvent, listAttendeeEvents, listAttendeeWaitlist } from '../services/attendeeEventService.js';
import { withdrawRegistration } from '../services/registrationWithdrawalService.js';
import { leaveWaitlist } from '../services/waitlistDepartureService.js';

const errorMiddleware = createErrorMiddleware('attendee events route');

export function createAttendeeEventRouter({ client, requireAuth = defaultRequireAuth, finalEventGuard = noopFinalEventGuard } = {}) {
  const router = express.Router();

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  const guardRegistration = finalEventGuard(eventIdFromRecord('event_registrations', 'registrationId'));
  // Withdrawals can revoke access; neither successes nor refusals may be cached.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAuth);
  router.get('/', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await listAttendeeEvents({ user: req.user, client }));
  });
  // Before /:id, which would otherwise read "waitlist" as an event id.
  router.get('/waitlist', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await listAttendeeWaitlist({ user: req.user, client }));
  });
  router.get('/:id', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await getAttendeeEvent({
      user: req.user, eventRequestId: req.params.id, client,
    }));
  });
  // The attendee is always req.user.id; eligibility is decided in SQL, never here.
  router.post('/registrations/:registrationId/withdrawal', createRequireRole(ROLE.ATTENDEE), guardRegistration, async (req, res) => {
    res.status(200).json(await withdrawRegistration({
      attendeeId: req.user.id, registrationId: req.params.registrationId, client,
    }));
  });
  // Separate from withdrawal: no deadline applies, and only a waitlisted entry qualifies.
  router.post('/registrations/:registrationId/leave-waitlist', createRequireRole(ROLE.ATTENDEE), async (req, res) => {
    res.status(200).json(await leaveWaitlist({
      attendeeId: req.user.id, registrationId: req.params.registrationId, client,
    }));
  });
  router.use(errorMiddleware);
  return router;
}

export default createAttendeeEventRouter({ finalEventGuard: createFinalEventGuard() });
