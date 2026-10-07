/**
 * Equipment availability route.
 *
 * SCRUM-23 and SCRUM-68. One read-only endpoint, Technical Support Staff only
 * (AC1): anyone else, signed in or not, never reaches the service.
 *
 *   GET /api/equipment/availability
 *       ?equipmentTypeId=&quantity=&startAt=&endAt=&eventRequestId=
 *
 * Lives under /api/equipment but in its own router file, so it can be mounted
 * from app.js without touching routes/equipment.js. app.js must mount it BEFORE
 * /api/equipment: a later GET /api/equipment/:id would otherwise answer
 * "availability" as an id.
 *
 * GET, because a check changes nothing (AC12). The query is turned into what
 * the validator expects, and every rule lives in the validator.
 *
 * The offsets in startAt and endAt must be URL-encoded: a raw '+' in a query
 * string decodes to a space, so '...T09:00:00+08:00' arrives as '...T09:00:00
 * 08:00' and is answered with 400 rather than guessed back into '+', because a
 * guessed offset is a silently different instant. axios params encodes it, and
 * a Z needs no encoding.
 *
 * Statuses: 200 with the result; 400 listing every invalid input; 401; 403
 * unless Technical Support Staff; 500.
 */

import express from 'express';

import { checkEquipmentAvailability } from '../services/equipmentAvailabilityService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';

const handleError = createErrorHandler('equipment availability route');

/**
 * Query-string values are always strings, and the validator wants a real
 * number for the quantity, so a non-blank one is converted. A blank one is left
 * out, so an empty box is "required" and not 0. Anything that is not a string
 * (a repeated parameter arrives as an array) is passed through for the
 * validator to refuse.
 */
function parseAvailabilityQuery(query) {
  const { equipmentTypeId, quantity, startAt, endAt, eventRequestId } = query;

  return {
    equipmentTypeId,
    quantity: typeof quantity === 'string' ? (quantity.trim() === '' ? undefined : Number(quantity)) : quantity,
    startAt,
    endAt,
    eventRequestId,
  };
}

/**
 * Build the router, optionally over injected middleware, as routes/venues.js
 * does, so the tests drive real Express routing with fake authentication.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]
 * @returns {import('express').Router}
 */
export function createEquipmentAvailabilityRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const technicalSupportOnly = requireRole(ROLE.TECHNICAL_SUPPORT_STAFF);

  router.use(requireAuth);

  router.get('/', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await checkEquipmentAvailability(parseAvailabilityQuery(req.query)));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}

/** The instance src/app.js mounts. */
export default createEquipmentAvailabilityRouter();