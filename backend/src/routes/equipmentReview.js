/**
 * Reviewing an event's equipment request.
 *
 * SCRUM-290 "Review an Equipment Request - Technical Support Staff". Mounted at
 * /api/event-requests/:id/equipment-review, in its own file so the shared event
 * request router and the coordinator's equipment router are left alone.
 *
 *   GET    /                         the review screen's data (AC3, AC4)
 *   POST   /start                    start a review (AC2)
 *   POST   /take-over                take over a review (AC3)
 *   PUT    /lines/:lineId/outcome    mark a line "Cannot be provided" (AC7)
 *   DELETE /lines/:lineId/outcome    take that mark off
 *   POST   /complete                 complete the review (AC7)
 *
 * Who may do what, and why:
 *
 *   everything  Technical Support Staff only (AC1). Everyone else, signed in or
 *               not, is refused before any service runs, so a refused attempt
 *               cannot change anything. The coordinator reads the outcome
 *               through the equipment routes (AC8), not through here.
 *   writes      which status the request is in, and whether the caller is the
 *               current reviewer, are the database function's to answer under
 *               the event row's lock. It answers 403 and 409, and 404 for an
 *               event, request or line that does not exist.
 *
 * The caller is always req.user.id, from the token. Nothing about who is acting
 * is read from a body, and the body of a write is read for the note and nothing
 * else.
 *
 * Every write answers with the whole review state, so the screen can redraw from
 * one response.
 *
 * Statuses: 200; 400 listing every invalid field; 401; 403; 404; 409 with code
 * EQUIPMENT_REVIEW_NOT_ALLOWED; 500.
 */

import express from 'express';

import {
  getEquipmentReview,
  startEquipmentReview,
  takeOverEquipmentReview,
  markEquipmentLineUnavailable,
  clearEquipmentLineOutcome,
  completeEquipmentReview,
} from '../services/equipmentReviewService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';


/** Map an error to a response; see src/http/handleError.js. */
const handleError = createErrorHandler('equipment review route');


/**
 * Build the router, optionally over injected middleware and client, for the
 * reason routes/eventEquipment.js gives: the tests drive real Express routing
 * with fake authentication and a fake client.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]  a factory
 * @param {object}   [options.client]       a Supabase client, usually a test double
 * @returns {import('express').Router}
 */
export function createEquipmentReviewRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
  client,
} = {}) {
  // mergeParams: this router is mounted under /:id, and that id is the event's.
  const router = express.Router({ mergeParams: true });
  const technicalSupportOnly = requireRole(ROLE.TECHNICAL_SUPPORT_STAFF);

  router.use(requireAuth);

  /** AC3, AC4: the review screen's data. Reading changes nothing. */
  router.get('/', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await getEquipmentReview(req.params.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC2: start a review. */
  router.post('/start', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await startEquipmentReview(req.params.id, req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC3: take over a review that is Under review. */
  router.post('/take-over', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await takeOverEquipmentReview(req.params.id, req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC7: mark a line "Cannot be provided". The body is read for note only. */
  router.put('/lines/:lineId/outcome', technicalSupportOnly, async (req, res) => {
    try {
      const state = await markEquipmentLineUnavailable(
        req.params.id,
        req.params.lineId,
        req.body,
        req.user.id,
        { client },
      );
      res.status(200).json(state);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** Take the "Cannot be provided" mark off a line. */
  router.delete('/lines/:lineId/outcome', technicalSupportOnly, async (req, res) => {
    try {
      const state = await clearEquipmentLineOutcome(
        req.params.id,
        req.params.lineId,
        req.user.id,
        { client },
      );
      res.status(200).json(state);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC7: complete the review. */
  router.post('/complete', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await completeEquipmentReview(req.params.id, req.user.id, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createEquipmentReviewRouter();
