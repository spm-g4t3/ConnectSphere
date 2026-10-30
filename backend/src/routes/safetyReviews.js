import express from 'express';

import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromParam } from '../middleware/finalEventGuard.js';
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
  finalEventGuard = noopFinalEventGuard,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  const guardEvent = finalEventGuard(eventIdFromParam('eventRequestId'));
  const safetyOfficerOnly = requireRole(ROLE.SAFETY_OFFICER);

  router.use(requireAuth, safetyOfficerOnly);

  router.get('/', async (req, res) => {
    res.status(200).json(await listSafetyReviews(req.user.id, { client }));
  });

  router.get('/history', async (req, res) => {
    res.status(200).json(await listSafetyReviewHistory(req.user.id, { client }));
  });

  router.get('/:eventRequestId', async (req, res) => {
    res.status(200).json(await getSafetyReview(req.params.eventRequestId, req.user.id, { client }));
  });

  router.post('/:eventRequestId/responses', guardEvent, async (req, res) => {
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

export default createSafetyReviewRouter({ finalEventGuard: createFinalEventGuard() });
