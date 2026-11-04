import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromParam, organisesEvent } from '../middleware/finalEventGuard.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import {
  getRegistrationCounts,
  getRegistrationSettings,
  updateRegistrationSettings,
} from '../services/eventRegistrationService.js';
import { listEventRegistrations } from '../services/registrationListService.js';

const errorMiddleware = createErrorMiddleware('event registration route');

export function createEventRegistrationRouter({
  client,
  requireAuth = defaultRequireAuth,
  finalEventGuard = noopFinalEventGuard,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  // Only the event's Organiser is told so; the handler answers anyone else with its 404.
  const guardEvent = finalEventGuard(eventIdFromParam('id'), { entitled: organisesEvent });
  const organiserOnly = requireRole(ROLE.EVENT_ORGANISER);
  // list_event_registrations narrows this to the event's own organiser and coordinator.
  const organiserOrCoordinator = requireRole(ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR);

  router.use(requireAuth);

  router.get('/events/:id/settings', organiserOnly, async (req, res) => {
    res.status(200).json(await getRegistrationSettings(req.params.id, req.user.id, { client }));
  });

  router.put('/events/:id/settings', organiserOnly, guardEvent, async (req, res) => {
    res.status(200).json(
      await updateRegistrationSettings(req.params.id, req.body, req.user.id, { client }),
    );
  });

  // Read only: the list has no write routes, so other methods fall through to 404.
  router.get('/events/:id/registrations', organiserOrCoordinator, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(await listEventRegistrations({
      eventRequestId: req.params.id,
      userId: req.user.id,
      hideWithdrawn: req.query.hideWithdrawn,
      client,
    }));
  });

  // The SQL function checks which event is the caller's.
  router.get('/events/:id/counts', organiserOrCoordinator, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json(await getRegistrationCounts(req.params.id, req.user.id, { client }));
  });

  router.use(errorMiddleware);
  return router;
}

export default createEventRegistrationRouter({ finalEventGuard: createFinalEventGuard() });
