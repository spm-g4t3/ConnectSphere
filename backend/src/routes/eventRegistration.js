import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
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
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const organiserOnly = requireRole(ROLE.EVENT_ORGANISER);

  router.use(requireAuth);

  router.get('/events/:id/settings', organiserOnly, async (req, res) => {
    res.status(200).json(await getRegistrationSettings(req.params.id, req.user.id, { client }));
  });

  router.put('/events/:id/settings', organiserOnly, async (req, res) => {
    res.status(200).json(
      await updateRegistrationSettings(req.params.id, req.body, req.user.id, { client }),
    );
  });

  router.use(errorMiddleware);
  return router;
}

export default createEventRegistrationRouter();
