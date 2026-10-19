/**
 * The Technical Support dashboard's equipment request queue, mounted at
 * /api/equipment-requests.
 *
 *   GET /    ?status=pending_review|under_review|arranged|cannot_be_fully_arranged|cancelled
 *            ?includePast=true   also events that have ended
 *
 * Technical Support Staff only; reading changes nothing.
 * Statuses: 200; 400 bad status or includePast; 401; 403; 500.
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
 * Build the router, optionally over injected middleware and client.
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

  router.get('/', requireRole(ROLE.TECHNICAL_SUPPORT_STAFF), async (req, res) => {
    try {
      res.status(200).json(await getEquipmentRequestQueue(req.query, { callerId: req.user.id, client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

/** The instance src/app.js mounts. */
export default createEquipmentQueueRouter();
