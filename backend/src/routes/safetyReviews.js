import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';
import {
  getSafetyReview,
  listSafetyReviewHistory,
  listSafetyReviews,
  respondToSafetyReview,
} from '../services/safetyReviewService.js';

const errorMiddleware = createErrorMiddleware('safety reviews route');

export function createSafetyReviewRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const safetyOfficerOnly = requireRole(ROLE.SAFETY_OFFICER);

  router.use(requireAuth, safetyOfficerOnly);

  router.get('/', async (_req, res) => {
    res.status(200).json(await listSafetyReviews({ client }));
  });

  router.get('/history', async (_req, res) => {
    res.status(200).json(await listSafetyReviewHistory({ client }));
  });

  router.get('/:eventRequestId', async (req, res) => {
    res.status(200).json(await getSafetyReview(req.params.eventRequestId, { client }));
  });

  router.post('/:eventRequestId/responses', async (req, res) => {
    const response = await respondToSafetyReview(
      req.params.eventRequestId,
      req.body,
      req.user.id,
      { client },
    );
    res.status(200).json(response);
  });

  router.use(errorMiddleware);
  return router;
}

export default createSafetyReviewRouter();
