import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import {
  getRegistrationCounts,
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

  // The assigned Coordinator as well as the Organiser; the SQL function checks
  // which event is theirs.
  router.get(
    '/events/:id/counts',
    requireRole(ROLE.EVENT_ORGANISER, ROLE.EVENT_COORDINATOR),
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.status(200).json(await getRegistrationCounts(req.params.id, req.user.id, { client }));
    },
  );

  router.use(errorMiddleware);
  return router;
}

export default createEventRegistrationRouter();
