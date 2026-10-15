/**
 * The Technical Support dashboard's equipment request queue.
 *
 * SCRUM-285, for SCRUM-284 "Technical Support Dashboard and Request Queue".
 * Mounted at /api/equipment-requests, in its own file so the review router, which
 * is about one event's request, is left alone.
 *
 *   GET /    the queue: { needsAction, requests }
 *            ?status=pending_review|under_review|arranged|cannot_be_fully_arranged|cancelled
 *            ?includePast=true   also events that have ended (the default hides them)
 *
 * Technical Support Staff only (AC1). Everyone else, signed in or not, is refused
 * before any service runs. Reading changes nothing.
 *
 * Statuses: 200; 400 for a status or includePast that is not valid; 401; 403; 500.
 */

import express from 'express';

import { getEquipmentRequestQueue } from '../services/equipmentQueueService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';


/** Map an error to a response; see src/http/handleError.js. */
const handleError = createErrorHandler('equipment request queue route');


/**
 * Build the router, optionally over injected middleware and client, for the
 * reason routes/equipmentReview.js gives.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]  a factory
 * @param {object}   [options.client]       a Supabase client, usually a test double
 * @returns {import('express').Router}
 */
export function createEquipmentQueueRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
  client,
} = {}) {
  const router = express.Router();

  router.use(requireAuth);

  /** AC2, AC4: the dashboard's data. */
  router.get('/', requireRole(ROLE.TECHNICAL_SUPPORT_STAFF), async (req, res) => {
    try {
      res.status(200).json(await getEquipmentRequestQueue(req.query, { client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

/** The instance src/app.js mounts. */
export default createEquipmentQueueRouter();
