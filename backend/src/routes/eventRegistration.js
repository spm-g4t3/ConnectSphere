import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';
import {
  getRegistrationSettings,
  listOpenRegistrationEvents,
  registerForEvent,
  updateRegistrationSettings,
} from '../services/eventRegistrationService.js';

const handleError = createErrorHandler('event registration route');

export function createEventRegistrationRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const organiserOnly = requireRole(ROLE.EVENT_ORGANISER);
  const attendeeOnly = requireRole(ROLE.ATTENDEE);

  router.use(requireAuth);

  router.get('/open', attendeeOnly, async (req, res) => {
    try {
      res.status(200).json(await listOpenRegistrationEvents(req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/events/:id/settings', organiserOnly, async (req, res) => {
    try {
      res.status(200).json(await getRegistrationSettings(req.params.id, req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.put('/events/:id/settings', organiserOnly, async (req, res) => {
    try {
      res.status(200).json(
        await updateRegistrationSettings(req.params.id, req.body, req.user.id, { client }),
      );
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/events/:id/register', attendeeOnly, async (req, res) => {
    try {
      res.status(201).json(await registerForEvent(req.params.id, req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

export default createEventRegistrationRouter();
