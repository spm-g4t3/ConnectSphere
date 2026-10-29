/**
 * An event's equipment: the lines a coordinator records for it.
 *
 * SCRUM-244, a subtask of SCRUM-21 "Record Equipment Requirements for an Event -
 * Event Coordinator". Mounted at /api/event-requests/:id/equipment, in its own
 * file so the shared event request router is left alone.
 *
 *   GET    /                  the event's current equipment request and lines
 *   POST   /lines             add a line
 *   PATCH  /lines/:lineId     amend a line's quantity or technical notes
 *   DELETE /lines/:lineId     remove a line
 *
 * Who may do what, and why:
 *
 *   everything  Event Coordinators only. Organisers, Venue Staff, Technical
 *               Support Staff and Attendees get 403 before any service runs,
 *               so a refused attempt cannot change anything. Technical Support
 *               Staff read an event's equipment through their own review
 *               screen (SCRUM-290), not through here.
 *   writes      the assigned coordinator of an Approved event. There is no
 *               ownership pre-check in the route, for the reason POST
 *               /:id/start-review gives: whether the caller is this event's
 *               assigned coordinator, and whether it is Approved, is what the
 *               database function checks under the row lock. It answers 403 and
 *               409, and 404 for an event or line that does not exist.
 *
 * The caller is always req.user.id, from the token. Nothing about who is acting
 * is read from the body.
 *
 * Every write answers with the whole current equipment state, not 204, so the
 * screen can redraw from one response: the request's new status, and the lines.
 *
 * Statuses: 200; 201 on add; 400 listing every invalid field; 401; 403; 404;
 * 409 with code EVENT_NOT_APPROVED; 500.
 */

import express from 'express';

import {
  listEventEquipment,
  addEquipmentLine,
  amendEquipmentLine,
  removeEquipmentLine,
} from '../services/equipmentLineService.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { noopFinalEventGuard, createFinalEventGuard, eventIdFromParam } from '../middleware/finalEventGuard.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorMiddleware } from '../http/handleError.js';


/** Answers whatever a handler throws or rejects with; see src/http/handleError.js. */
const errorMiddleware = createErrorMiddleware('event equipment route');


/**
 * Build the router, optionally over injected middleware and client.
 *
 * A factory for the same reason routes/equipment.js is one: the tests drive real
 * Express routing with fake authentication and a fake client, while production
 * supplies neither.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]  a factory, so a test can widen or
 *                                          narrow the gate without rebuilding it
 * @param {object}   [options.client]       a Supabase client, usually a test double
 * @returns {import('express').Router}
 */
export function createEventEquipmentRouter({
  requireAuth = defaultRequireAuth,
  finalEventGuard = noopFinalEventGuard,
  requireRole = createRequireRole,
  client,
} = {}) {
  // mergeParams: this router is mounted under /:id, and that id is the event's.
  const router = express.Router({ mergeParams: true });

  // SCRUM-382: a Completed or Cancelled event, or anything attached to it, is read-only.
  const guardEvent = finalEventGuard(eventIdFromParam('id'));
  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);
  // SCRUM-486 (SCRUM-521): the read only. The Event Coordinator Lead opens the
  // event screen to hand an event over, and that screen reads this list on
  // mount. The three writes below stay coordinatorOnly, and 037 still allows
  // only the event's assigned coordinator to change its equipment.
  const coordinatorOrLead = requireRole(ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD);

  router.use(requireAuth);

  /** AC11: the event's equipment. 404 for an event that does not exist. */
  router.get('/', coordinatorOrLead, async (req, res) => {
    res.status(200).json(await listEventEquipment(req.params.id, { client }));
  });

  /**
   * AC2 to AC5, AC7, AC9: add a line. The body is read for equipmentTypeId,
   * quantity and technicalNotes, and nothing else.
   */
  router.post('/lines', coordinatorOnly, guardEvent, async (req, res) => {
    const state = await addEquipmentLine(req.params.id, req.body, req.user.id, { client });
    res.status(201).json(state);
  });

  /**
   * AC6, AC7: amend a line. The body is read for quantity and technicalNotes.
   * An equipmentTypeId in it is refused with 400: change a type by removing the
   * line and adding another.
   */
  router.patch('/lines/:lineId', coordinatorOnly, guardEvent, async (req, res) => {
    const state = await amendEquipmentLine(
      req.params.id,
      req.params.lineId,
      req.body,
      req.user.id,
      { client },
    );
    res.status(200).json(state);
  });

  /** AC6 to AC8: remove a line. The last line cancels the request. */
  router.delete('/lines/:lineId', coordinatorOnly, guardEvent, async (req, res) => {
    const state = await removeEquipmentLine(
      req.params.id,
      req.params.lineId,
      req.user.id,
      { client },
    );
    res.status(200).json(state);
  });

  router.use(errorMiddleware);
  return router;
}


/** The instance src/app.js mounts. */
export default createEventEquipmentRouter({ finalEventGuard: createFinalEventGuard() });
