/**
 * Event request routes.
 *
 * SCRUM-42 (track a request), SCRUM-29 (create one), SCRUM-11 (edit a draft,
 * and request a change once it is no longer one).
 *
 * Everything an Event Organiser does with their own requests. Thin wrappers
 * around src/services/eventRequestService.js and
 * src/services/eventChangeRequestService.js, with one job of their own:
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
 * POST /, PATCH /:id, POST /:id/submit and both change-request paths used to
 * be listed here as deliberate omissions. They are now mounted: every call
 * frontend/src/services/eventRequestService.js and changeRequestService.js
 * make resolves to a real route, and the change-request list that was polling
 * a 404 every fifteen seconds is served.
 *
 * Deliberately NOT here, so each omission still reads as a decision:
 *
 *  - No role gate on the Organiser's routes. Every one of them is scoped by
 *    req.user.id against organiser_id, so a role check removes no capability
 *    ownership has not already removed. GET /queue is the single exception,
 *    and it is one because it meets the criterion routes/venues.js already
 *    sets at its own :36-39: a gate is earned when a route returns rows no
 *    ownership check could scope. A review queue crosses every Organiser by
 *    definition, so there is nothing for req.user.id to narrow it to and the
 *    role is the only thing left that can decide who may read it.
 *    The gate is therefore a second argument on that one router.get and is
 *    NEVER mounted with router.use: the tests' fake authenticator sets no
 *    role, so a router-wide gate would 403 every route in this file at once.
 *    Residual, named rather than hidden: any authenticated user can POST /
 *    and own the draft they create. Low harm; if the team wants it closed the
 *    gate belongs on POST / alone, using the same requireRole option.
 *  - No Coordinator write routes. Deciding a change request
 *    (processChangeRequest) and moving a request through the later statuses
 *    are a different audience with a different gate, and belong with the
 *    story that adds one. Reading the queue is here; acting on what you read
 *    is not.
 *
 * Ownership is proved by this router, not assumed from the service. Three of
 * the routes below open with an explicit getEventRequestForOrganiser call and
 * each says why at the call site; the short version is that the two services
 * disagree about what a foreign event is worth -- eventRequestService answers
 * 404 for both missing and foreign, eventChangeRequestService answers 404 for
 * missing but 400 for foreign, and 400 is an enumeration oracle. This router
 * settles it at 404 on the way in.
 */

import express from 'express';

import {
  listEventRequestsForOrganiser,
  getEventRequestForOrganiser,
  listEventRequestsForReview,
  createEventRequest,
  updateEventRequest,
  submitEventRequest,
} from '../services/eventRequestService.js';
import {
  createChangeRequestFromClient,
  getChangeRequestsForEvent,
} from '../services/eventChangeRequestService.js';
import { getStatusDisplay } from '../domain/eventRequestStatus.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
// Both of these are credential-free on purpose, and that is worth knowing
// before adding a third: this router's tests do not mock config/
// supabaseClient.js -- they rely on the service's lazy resolveClient -- so any
// import that reaches that module would throw at collection time and take the
// whole test file down with it. middleware/requireRole.js imports only
// domain/userRole.js, which imports nothing at all. services/venueService.js,
// by contrast, imports the client statically; never pull it in here.
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
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
 * itself "the camelCase view of a stored row". This is a derived projection,
 * and the check scripts have no use for it.
 *
 * It is no longer for one audience only. GET /queue applies it too, so a
 * Coordinator's row carries exactly the same statusDisplay a row on the
 * Organiser's own list does -- one status vocabulary, rendered by one frontend
 * helper, for both screens.
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
 * @param {Function} [options.requireRole] a factory, mirroring createVenueRouter,
 *                                         so a test can widen or narrow the one
 *                                         gated route without rebuilding it
 * @returns {import('express').Router}
 */
export function createEventRequestRouter({
  client,
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();

  // Built once here, applied to exactly one route below. Calling the factory
  // at build time is safe: createRequireRole only throws when handed zero
  // roles, and with one it just closes over the list.
  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);

  // Authentication is applied to the whole router rather than per route.
  // Every Organiser read below is scoped to req.user.id, so a route reachable
  // without it would not merely be unauthenticated -- it would have no idea
  // whose requests to return. Authorisation is the opposite and stays off the
  // router: see coordinatorOnly's single use on GET /queue.
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
   * SCRUM-45: everything awaiting a decision, for an Event Coordinator.
   *
   * The one route in this file that is not scoped to req.user.id, and the fix
   * for the reported bug that a submitted request never reached the
   * Coordinator side. Which rows qualify is decided by
   * COORDINATOR_QUEUE_STATUSES in the domain -- notably, a draft never appears
   * here, which is what keeps a shared queue from exposing an Organiser's
   * private working copy.
   *
   * DECLARATION ORDER HERE IS LOAD-BEARING, and this is the one place in this
   * router where that is literally true. Every other ordering note in this
   * file -- on /:id/status below, and above the writes -- carefully explains
   * that the paths cannot actually collide because /:id is one segment and
   * /:id/... is two. This one can and does: '/queue' is also one segment, so
   * declared after GET /:id Express would match it with id === 'queue', hand
   * Postgres a uuid comparison against a word, and return a 500 built out of
   * an unrecognised 22P02. Do not move it below /:id.
   *
   * coordinatorOnly is passed as a per-route argument and must stay one. See
   * the factory above.
   *
   * A bare array, like GET / above, and for the same reason: the Coordinator
   * dashboard maps over the response directly. An empty queue is 200 [] and
   * never a 404 -- nothing waiting is the good state, not a missing resource.
   *
   * Statuses: 200, 401 from requireAuth, 403 for the wrong role (or for an
   * authenticated account with no profiles row, which requireAuth resolves to
   * a null role), 500 for anything untyped. No 400: nothing is read off the
   * request -- no param, no body, no query string -- so there is nothing here
   * to validate, the same stance routes/venues.js takes on GET /.
   */
  router.get('/queue', coordinatorOnly, async (req, res) => {
    try {
      const requests = await listEventRequestsForReview({ client });
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

  /**
   * SCRUM-34 AC4: which of this event's change requests are outstanding, in
   * progress or processed.
   *
   * A bare array, like GET / above, because ChangeRequestStatusList maps over
   * the response directly. An event with no change requests is 200 [] and not
   * a 404 -- "none yet" is the ordinary state of a request nobody has needed
   * to change.
   *
   * Deliberately NOT wrapped in withStatusDisplay. That helper speaks the
   * *event* status vocabulary, and a change request's statuses are its own
   * ('outstanding', 'in_progress', 'processed'), so it would label every row
   * UNKNOWN and look like a bug in the data.
   *
   * The ownership pre-check is not belt-and-braces. getChangeRequestsForEvent
   * answers 404 for an event that does not exist but 400 for one belonging to
   * another Organiser, which tells a caller the difference -- exactly the
   * enumeration oracle the three routes around it are built to avoid, in the
   * same router. Fixing it in the service is not available: a hand-run check
   * script asserts that 400. So it is fixed here and the service's own check
   * stays as defence in depth.
   *
   * Declared before GET /:id for the same reason /:id/status is: the two
   * cannot actually collide, since /:id matches one segment and this matches
   * two, but the ordering is what someone adding a route later will copy.
   */
  router.get('/:id/change-requests', async (req, res) => {
    try {
      await getEventRequestForOrganiser(req.params.id, req.user.id, { client });

      const changeRequests = await getChangeRequestsForEvent(
        req.params.id,
        req.user.id,
        { client },
      );

      res.status(200).json(changeRequests);
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

  // Writes below the reads, mirroring routes/venues.js. Declaration order is
  // not load-bearing anywhere in this router -- /:id is one segment and every
  // /:id/... path is two, so none of them can swallow another, and the two
  // paths that do coincide differ by method. Worth saying out loud, because
  // the comment on /:id/status above explains an ordering that *is* copied
  // deliberately, and a reader could reasonably assume it applies here too.

  /**
   * SCRUM-29: create a request. It is born a draft; submitting is a separate
   * call, because SCRUM-10 AC3 says a draft may be saved incomplete.
   *
   * 201 with the full request, including statusDisplay, because
   * EventRequestForm reads saved.id and saved.status straight off the
   * response and would otherwise have to refetch to learn what it just made.
   *
   * The body is passed raw -- no changeSet()-style strip, unlike
   * routes/venues.js, and the difference is worth naming because a reader
   * coming from that file will look for one. toColumns in the service is an
   * allow-list of nine columns built from COLUMN_BY_FIELD, so a body carrying
   * organiserId, status or id matches nothing and is dropped on the floor.
   * The organiser is stamped from the token, never from the body.
   */
  router.post('/', async (req, res) => {
    try {
      const created = await createEventRequest(req.body, req.user.id, { client });
      res.status(201).json(withStatusDisplay(created));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-11: save edits to a draft.
   *
   * 200 and the whole request rather than 204, for the same reason POST /
   * returns a body: the form reads saved.id and saved.status back.
   *
   * No ownership pre-check here, and that is not an inconsistency with the
   * three routes that have one -- updateEventRequest takes the organiserId
   * and enforces it itself, answering the same 404 for a missing request and
   * a foreign one. A 409 means the body was fine but the row is no longer a
   * draft, either because it was submitted earlier or because a submit landed
   * between the service's read and its write.
   */
  router.patch('/:id', async (req, res) => {
    try {
      const saved = await updateEventRequest(
        req.params.id,
        req.body,
        req.user.id,
        { client },
      );

      res.status(200).json(withStatusDisplay(saved));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-10 AC4-AC7: submit a draft for review.
   *
   * The pre-check is mandatory, not defensive. submitEventRequest takes no
   * organiserId and checks nothing -- its own header says ownership belongs to
   * the caller -- so without this line any authenticated Organiser could
   * submit any other Organiser's draft by guessing its id. It costs a third
   * round trip, and that is accepted over adding an organiserId parameter to a
   * service whose header argues at length that it should hold none and against
   * which 36 tests are written.
   *
   * A 400 from here carries details[] listing every gap at once, which is the
   * whole of AC4; the form renders them as a list.
   */
  router.post('/:id/submit', async (req, res) => {
    try {
      await getEventRequestForOrganiser(req.params.id, req.user.id, { client });

      const submitted = await submitEventRequest(req.params.id, { client });
      res.status(200).json(withStatusDisplay(submitted));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-32 AC1/AC2: ask for a change to an event already submitted.
   *
   * Same ownership pre-check as the GET, for the same reason and against the
   * same service: createChangeRequest answers 400 for a foreign event and 404
   * for one that does not exist, so the pre-check is what makes the two
   * indistinguishable from outside.
   *
   * 201, and deliberately without withStatusDisplay -- see the GET above; the
   * event vocabulary does not describe a change request. The response is
   * toChangeRequest, which carries no fieldLabel, so the frontend refetches
   * the list rather than splicing this into it.
   */
  router.post('/:id/change-requests', async (req, res) => {
    try {
      await getEventRequestForOrganiser(req.params.id, req.user.id, { client });

      const created = await createChangeRequestFromClient(
        req.params.id,
        req.body,
        req.user.id,
        { client },
      );

      res.status(201).json(created);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createEventRequestRouter();
