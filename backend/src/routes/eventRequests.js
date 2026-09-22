/**
 * Event request routes.
 *
 * SCRUM-42, a subtask of SCRUM-14 (Track Event Request Status).
 *
 * The three reads an Event Organiser needs to track a request. Thin wrappers
 * around src/services/eventRequestService.js, with one job of their own:
 * attaching the Organiser-facing status payload from src/domain/
 * eventRequestStatus.js so the frontend keeps no copy of the status vocabulary.
 *
 * Status is served two ways on purpose:
 *
 *   - embedded, as `statusDisplay` on every request, because the list view
 *     renders a badge per row and fetching each one separately would be N+1
 *     round trips to draw one page;
 *   - on its own at GET /:id/status, because AC4 is satisfied by refetching on
 *     view, and re-downloading ten columns of prose requirements to learn that
 *     a one-word enum has not moved is the wrong payload for a call that fires
 *     on every tab focus.
 *
 * Both derive from the same getStatusDisplay() call, so there is no second
 * definition to keep in step.
 *
 * Deliberately NOT here: POST /, PATCH /:id and POST /:id/submit. The service
 * already supports create and submit, and frontend/src/services/
 * eventRequestService.js already calls all three -- but they are the route work
 * of SCRUM-29 and SCRUM-11, not of this sub-task. They 404 today and they will
 * 404 after this lands; naming them here is so the omission reads as a decision
 * rather than an oversight.
 */

import express from 'express';

import {
  listEventRequestsForOrganiser,
  getEventRequestForOrganiser,
} from '../services/eventRequestService.js';
import { getStatusDisplay } from '../domain/eventRequestStatus.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { AppError } from '../errors.js';


/**
 * Map an error to a response.
 *
 * The same helper as src/routes/venues.js, which is the established pattern on
 * this codebase: every typed error already carries its own status, so a route
 * never decides what a failure means. When a third router appears this is worth
 * lifting into one module; two copies do not yet earn one.
 */
function handleError(err, res) {
  if (err instanceof AppError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  // Untyped means nobody anticipated it, so the driver message is logged for
  // whoever is on call and never returned to the Organiser.
  console.error('Unexpected error in event requests route:', err);
  return res.status(500).json({ error: 'Unexpected server error' });
}


/**
 * Attach the Organiser-facing view of the status to a stored request.
 *
 * Nested under `statusDisplay` rather than spread onto the request, because
 * getStatusDisplay() returns a `description` -- and so does event_requests.
 * Spreading would overwrite the description the Organiser typed with the one
 * describing their status, silently and only for some statuses.
 *
 * Done here rather than in the service's toEventRequest, whose docstring calls
 * itself "the camelCase view of a stored row". This is a derived projection for
 * one audience, and the check scripts and future Coordinator flows have no use
 * for it.
 */
function withStatusDisplay(request) {
  return { ...request, statusDisplay: getStatusDisplay(request.status) };
}


/**
 * Build the router, optionally over an injected client and verifier.
 *
 * A factory for the same reason the middleware is one: the tests drive real
 * Express routing -- path parsing, JSON serialisation, status codes -- with a
 * fake Supabase client and a fake authenticator, while production supplies
 * neither and the service takes its usual lazy-import branch.
 *
 * @param {object} [options]
 * @param {object} [options.client]       Supabase client, for tests
 * @param {Function} [options.requireAuth] authentication middleware, for tests
 * @returns {import('express').Router}
 */
export function createEventRequestRouter({
  client,
  requireAuth = defaultRequireAuth,
} = {}) {
  const router = express.Router();

  // Applied to the whole router rather than per route. Every read below is
  // scoped to req.user.id, so a route reachable without it would not merely be
  // unauthenticated -- it would have no idea whose requests to return.
  router.use(requireAuth);

  /**
   * AC1: the Organiser's own requests, each carrying its status.
   *
   * A bare array, not { items: [...] }: MyEventRequests.jsx assigns the
   * response straight into state and maps over it, so a wrapper would cost a
   * frontend change and buy nothing.
   */
  router.get('/', async (req, res) => {
    try {
      const requests = await listEventRequestsForOrganiser(req.user.id, { client });
      res.status(200).json(requests.map(withStatusDisplay));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC4: the cheap refetch.
   *
   * Flattened rather than nested, unlike the two routes around it, because
   * there is no competing description in this response. updatedAt is included
   * so a caller can tell "re-read" from "changed", and the id is echoed so a
   * client firing several of these at once can match responses to requests.
   *
   * Declared before GET /:id so Express does not read 'status' as an id. The
   * two patterns do not actually collide -- /:id has one segment and this has
   * two -- but the ordering is what someone adding a route later will copy.
   */
  router.get('/:id/status', async (req, res) => {
    try {
      const request = await getEventRequestForOrganiser(req.params.id, req.user.id, { client });
      const display = getStatusDisplay(request.status);

      res.status(200).json({
        id: request.id,
        status: display.status,
        label: display.label,
        group: display.group,
        description: display.description,
        updatedAt: request.updatedAt,
        submittedAt: request.submittedAt,
      });
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC1: one request in full, with its status. */
  router.get('/:id', async (req, res) => {
    try {
      const request = await getEventRequestForOrganiser(req.params.id, req.user.id, { client });
      res.status(200).json(withStatusDisplay(request));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createEventRequestRouter();
