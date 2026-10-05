/**
 * Equipment catalogue routes.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and Status -
 * Technical Support Staff". Retire and reinstate (SCRUM-278) is added to this
 * router by its own subtask.
 *
 * Who may do what, and why:
 *
 *   writes  Technical Support Staff only (AC1). Creating and editing a type
 *           is the story's whole seat, and a refused attempt reaches no
 *           service function, so it cannot change anything.
 *   list    the full catalogue, retired types and every quantity: Technical
 *           Support Staff only. It is the one read that returns retired types
 *           and the damaged and under-maintenance figures, so it is the
 *           staff-only list, as GET /api/venues is for venues.
 *   history one type's change history (SCRUM-279): Technical Support Staff
 *           only. It names who changed what, so it is staff's own audit trail.
 *   active  active types only, in the reduced shape a picker needs:
 *           Technical Support Staff and Event Coordinators (AC1). This is
 *           what SCRUM-21's equipment picker reads. Organisers, Venue Staff
 *           and Attendees get 403: they have no equipment to choose.
 */

import express from 'express';

import {
  createEquipmentType,
  updateEquipmentType,
  listEquipmentTypes,
  listActiveEquipmentTypes,
  getEquipmentTypeHistory,
  recordEquipmentCondition,
} from '../services/equipmentService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';


/** Map an error to a response; see src/http/handleError.js. */
const handleError = createErrorHandler('equipment route');


/**
 * The acting user is the signed-in one, and the request body never gets a say.
 * It is recorded in the change history.
 */
function actingUser(req) {
  return req.user.id;
}


/**
 * Build the router, optionally over injected middleware.
 *
 * A factory for the same reason routes/venues.js is one: the tests drive real
 * Express routing with fake authentication, while production supplies neither.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]  a factory, so a test can widen or
 *                                          narrow the gate without rebuilding it
 * @returns {import('express').Router}
 */
export function createEquipmentRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const technicalSupportOnly = requireRole(ROLE.TECHNICAL_SUPPORT_STAFF);
  const activeReaders = requireRole(ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.EVENT_COORDINATOR);

  router.use(requireAuth);

  /**
   * The full catalogue, retired included. A bare array; none is 200 [].
   *
   * Statuses: 200; 401; 403 unless Technical Support Staff; 500.
   */
  router.get('/', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await listEquipmentTypes());
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC1: the active types, for SCRUM-21's picker.
   *
   * Statuses: 200; 401; 403 unless Technical Support Staff or an Event
   * Coordinator; 500.
   */
  router.get('/active', activeReaders, async (req, res) => {
    try {
      res.status(200).json(await listActiveEquipmentTypes());
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC2: create a type. The body goes to the service as sent; only the five
   * fields the criterion names are ever read from it.
   *
   * Statuses: 201 with the created type; 400 listing every invalid field,
   * including a name already in use; 401; 403; 409 with code
   * EQUIPMENT_NAME_TAKEN when two writers race to the same name; 500.
   */
  router.post('/', technicalSupportOnly, async (req, res) => {
    try {
      res.status(201).json(await createEquipmentType(req.body, actingUser(req)));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC8 (SCRUM-279): who changed what and when, newest first. A bare array,
   * like /api/venues/:id/history; none is 200 [].
   *
   * Statuses: 200; 400 for a malformed id; 401; 403 unless Technical Support
   * Staff; 500.
   */
  router.get('/:id/history', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await getEquipmentTypeHistory(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC4 and AC5 (SCRUM-277): record how many units are damaged and how many
   * are under maintenance, with a note. Either or both quantities may be sent;
   * the one left out stays as it was. Reducing a number is how units are
   * marked usable again. PATCH because only what is sent changes.
   *
   * Statuses: 200 with the updated type, usableQuantity being the new figure;
   * 400 listing every invalid field, including a missing note or damaged plus
   * under maintenance above the total; 401; 403; 404 when no type has that id;
   * 500.
   */
  router.patch('/:id/condition', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await recordEquipmentCondition(req.params.id, req.body, actingUser(req)));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC3: edit a type. PATCH because only the fields sent change.
   *
   * Statuses: 200 with the updated type; 400 for a malformed id or any invalid
   * field; 401; 403; 404 when no type has that id; 500.
   */
  router.patch('/:id', technicalSupportOnly, async (req, res) => {
    try {
      res.status(200).json(await updateEquipmentType(req.params.id, req.body, actingUser(req)));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createEquipmentRouter();