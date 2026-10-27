import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromParam } from '../middleware/finalEventGuard.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import {
  getRegistrationSettings,
  updateRegistrationSettings,
} from '../services/eventRegistrationService.js';

const errorMiddleware = createErrorMiddleware('event registration route');

export function createEventRegistrationRouter({
  client,
  requireAuth = defaultRequireAuth,
  finalEventGuard = noopFinalEventGuard,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  const guardEvent = finalEventGuard(eventIdFromParam('id'));
  const organiserOnly = requireRole(ROLE.EVENT_ORGANISER);

  router.use(requireAuth);

  router.get('/events/:id/settings', organiserOnly, async (req, res) => {
    res.status(200).json(await getRegistrationSettings(req.params.id, req.user.id, { client }));
  });

  router.put('/events/:id/settings', organiserOnly, guardEvent, async (req, res) => {
    res.status(200).json(
      await updateRegistrationSettings(req.params.id, req.body, req.user.id, { client }),
    );
  });

  router.use(errorMiddleware);
  return router;
}

export default createEventRegistrationRouter({ finalEventGuard: createFinalEventGuard() });
