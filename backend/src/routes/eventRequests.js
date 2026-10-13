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
 *  - Coordinator routes are role-gated per route. Clarification and, since
 *    SCRUM-331, handing an event to a colleague (POST /:id/reassign) are the
 *    Coordinator actions in this router, alongside deciding change requests.
 *    The role says who may reach them; which coordinator may act is checked
 *    against the event's assigned coordinator (SCRUM-332), by the service for
 *    clarification and by the database functions for the other two. Reading
 *    is the opposite: since SCRUM-332, any coordinator can read any event
 *    past draft through GET /:id/review. Moving requests through later
 *    planning statuses remains a separate workflow.
 *  - The Event Coordinator Lead's routes (SCRUM-486) are gated per route too,
 *    by leadOnly: the unassigned queue, the picker's coordinator workload, the
 *    list of assigned events (AC6) and the first assignment; since SCRUM-487,
 *    the coordinator overview's counts too. POST
 *    /:id/reassign admits a Lead as well as a coordinator; which of them may
 *    hand over this event is the database's question, as before.
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
  getEventRequestForCoordinator,
  getEventRequestStatusHistory,
  getEventClarificationHistory,
  closeEventClarification,
  listEventRequestsForReview,
  listEventRequestsForCoordinator,
  listCoordinators,
  listUnassignedEventRequests,
  listCoordinatorWorkload,
  listCoordinatorOverview,
  listAssignedEventsForLead,
  listAssignmentHistory,
  createEventRequest,
  updateEventRequest,
  submitEventRequest,
  requestEventClarification,
  respondToEventClarification,
  reassignEventRequest,
  assignEventRequest,
  startEventReview,
  decideEventRequest,
  getEventCancellationImpact,
  cancelEventRequest,
} from '../services/eventRequestService.js';
import {
  createChangeRequestFromClient,
  getChangeRequestsForCoordinator,
  getChangeRequestsForEvent,
  processChangeRequest,
} from '../services/eventChangeRequestService.js';
// SCRUM-491. Credential-free like the two services above: it resolves the
// client lazily and never imports venueService.js.
import { listHoldCandidates } from '../services/venueHoldService.js';
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
// Credential-free too: http/handleError.js imports only errors.js.
import { createErrorHandler } from '../http/handleError.js';
import { ForbiddenError, ValidationError } from '../errors.js';


/** Map an error to a response; see src/http/handleError.js (SCRUM-127). */
const handleError = createErrorHandler('event requests route');


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

  // Built once here, and passed per route to every coordinator path below,
  // never mounted with router.use (see GET /queue). Calling the factory at
  // build time is safe: createRequireRole only throws when handed zero roles,
  // and with one it just closes over the list.
  const coordinatorOnly = requireRole(ROLE.EVENT_COORDINATOR);
  // SCRUM-491: the hold form's event picker is Venue Staff's alone.
  const venueStaffOnly = requireRole(ROLE.VENUE_STAFF);
  // SCRUM-486 (SCRUM-519): the unassigned queue, the picker's workload and the
  // first assignment are the Event Coordinator Lead's alone (AC1, AC2, AC3).
  const leadOnly = requireRole(ROLE.EVENT_COORDINATOR_LEAD);
  // SCRUM-486 AC6: a handover may be made by the coordinator who holds the
  // event or by a Lead. requireRole is an exact match on one role per
  // account, so the Lead has to be named; coordinatorOnly refused them before
  // reassign_event_request (052) could say yes. Since SCRUM-521 it also gates
  // the three reads the event screen makes on mount (/:id/review,
  // /:id/assignments/review, /:id/change-requests/review), so the Lead can
  // open the screen they hand an event over from.
  const coordinatorOrLead = requireRole(ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD);

  // Authentication is applied to the whole router rather than per route.
  // Every Organiser read below is scoped to req.user.id, so a route reachable
  // without it would not merely be unauthenticated -- it would have no idea
  // whose requests to return. Authorisation is the opposite and stays off the
  // router: coordinatorOnly is a per-route argument wherever it is used.
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
   * The first route in this file that was not scoped to req.user.id (GET
   * /:id/review, since SCRUM-332, is the other), and the fix
   * for the reported bug that a submitted request never reached the
   * Coordinator side. Which rows qualify is decided by
   * COORDINATOR_QUEUE_STATUSES in the domain -- notably, a draft never appears
   * here, which is what keeps a shared queue from exposing an Organiser's
   * private working copy.
   *
   * DECLARATION ORDER HERE IS LOAD-BEARING, and this, GET /mine (SCRUM-333)
   * and GET /coordinators (SCRUM-334) below are the only places in this
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
   * SCRUM-333 (SCRUM-327 AC11): "My events", every event assigned to the
   * signed-in coordinator, soonest first, each with its organiser's name.
   *
   * Beside GET /queue, not replacing it. The queue is every coordinator's view
   * of work awaiting a decision, whoever holds it; this is the work the caller
   * does hold. (Until SCRUM-486 the queue was described as work nobody holds
   * yet; that work is now the Lead's, at GET /unassigned.) Which one the
   * dashboard opens on is the frontend's choice.
   *
   * DECLARATION ORDER IS LOAD-BEARING, exactly as for /queue above. '/mine' is
   * one segment, so declared after GET /:id Express would match it with
   * id === 'mine' and send a coordinator to the Organiser's read, which
   * answers 404. Do not move it below /:id.
   *
   * coordinatorOnly as a per-route argument, like every gate in this file.
   * The list is narrowed to req.user.id as the assigned coordinator, never to
   * anything in the query string, so one coordinator cannot read another's.
   *
   * A bare array, like GET / and GET /queue. The frontend groups it by status;
   * grouping is presentation. An empty list is 200 [], never 404: nothing
   * assigned is not a missing resource.
   *
   * Statuses: 200, 401 from requireAuth, 403 for the wrong role or no role,
   * 500 for anything untyped.
   */
  router.get('/mine', coordinatorOnly, async (req, res) => {
    try {
      const requests = await listEventRequestsForCoordinator(req.user.id, { client });
      res.status(200).json(requests.map(withStatusDisplay));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-334 (SCRUM-327 AC9): every Event Coordinator, as { id, fullName },
   * for the reassign picker.
   *
   * Behind coordinatorOnly. This is the first endpoint in the API that lists
   * users, so the first that could be used to enumerate staff, and no
   * Organiser or attendee feature needs it: only the reassign picker does. The
   * gate fails closed, and a future story that needs the list elsewhere can
   * widen it and give its reason.
   *
   * DECLARATION ORDER IS LOAD-BEARING, as for /queue and /mine above:
   * '/coordinators' is one segment, so declared after GET /:id it would be
   * read as id === 'coordinators'. Do not move it below /:id.
   *
   * A bare array. It includes the caller; leaving them out of the picker is
   * presentation.
   */
  router.get('/coordinators', coordinatorOnly, async (req, res) => {
    try {
      res.status(200).json(await listCoordinators({ client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-491 (AC2): the Approved events a tentative hold can be placed for,
   * as { id, eventName, proposedStart, proposedEnd, expectedAttendance,
   * assignedCoordinatorId, assignedCoordinatorName }, soonest first. The hold
   * form's event picker.
   *
   * Venue Staff only: placing a hold is their seat (AC1), and the list names
   * every Approved event and its coordinator, which no other role's screen
   * needs.
   *
   * DECLARATION ORDER IS LOAD-BEARING, as for /queue, /mine and /coordinators
   * above: '/hold-candidates' is one segment, so declared after GET /:id it
   * would be read as an id. Do not move it below /:id.
   *
   * A bare array; none is 200 []. Statuses: 200, 401, 403 unless Venue
   * Staff, 500.
   */
  router.get('/hold-candidates', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await listHoldCandidates({ client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-486 AC2 (SCRUM-519): the Event Coordinator Lead's unassigned queue,
   * every submitted request nobody has been assigned, oldest submission first,
   * each with its organiser's name and statusDisplay.
   *
   * Lead only. The coordinators' shared queue (GET /queue) is theirs; this one
   * is the Lead's worklist, and a coordinator has nothing to do with a row in
   * it: only a Lead can assign (052).
   *
   * DECLARATION ORDER IS LOAD-BEARING, as for /queue, /mine, /coordinators and
   * /hold-candidates above: '/unassigned' is one segment, so declared after
   * GET /:id it would be read as an id. Do not move it below /:id.
   *
   * A bare array; an empty queue is 200 [], the good state. Statuses: 200,
   * 401, 403 unless a Lead, 500.
   */
  router.get('/unassigned', leadOnly, async (req, res) => {
    try {
      const requests = await listUnassignedEventRequests({ client });
      res.status(200).json(requests.map(withStatusDisplay));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-486 AC3 (SCRUM-519): every Event Coordinator, as
   * { id, fullName, activeEvents }, for the Lead's assignment picker.
   *
   * A route of its own rather than GET /coordinators widened to the Lead.
   * /coordinators is SCRUM-334's handover picker: it is read by every
   * coordinator, so adding workload to it would show each of them everyone's
   * caseload, which no story asked for; and SCRUM-485 pins that a Lead is
   * refused it (SCRUM485_AC5_GET /coordinators_refuses_...), a refusal this
   * leaves standing. Here the gate says exactly who reads workload: the Lead.
   *
   * DECLARATION ORDER IS LOAD-BEARING, as above. A bare array, ordered by name,
   * never by workload. Statuses: 200, 401, 403 unless a Lead, 500.
   */
  router.get('/coordinator-workload', leadOnly, async (req, res) => {
    try {
      res.status(200).json(await listCoordinatorWorkload({ client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-487 AC2 (SCRUM-541): every Event Coordinator, as
   * { id, fullName, activeEvents, byStatus }, for the Lead's coordinator
   * overview: how many active events each holds, and how many in each status.
   *
   * A route of its own rather than byStatus added to /coordinator-workload
   * (SCRUM-487 D3): that response is the assignment picker's, and SCRUM-486
   * pins it to a name and a count. Both are counted by one shared read in the
   * service, so the totals agree.
   *
   * leadOnly, for the reason /coordinator-workload is: it shows every
   * coordinator's caseload, which is the Lead's supervision and no
   * coordinator's business.
   *
   * DECLARATION ORDER IS LOAD-BEARING, as above: '/coordinator-overview' is
   * one segment, so declared after GET /:id it would be read as an id and the
   * Lead would get the Organiser's 404. Do not move it below /:id.
   *
   * A bare array, by name; none is 200 []. Statuses: 200, 401, 403 unless a
   * Lead, 500.
   */
  router.get('/coordinator-overview', leadOnly, async (req, res) => {
    try {
      res.status(200).json(await listCoordinatorOverview({ client }));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-486 AC6: every event someone holds in an active status, earliest
   * first, each with its organiser's and coordinator's names and statusDisplay.
   * The Lead's way to the event page they hand an event over from.
   *
   * leadOnly, not coordinatorOrLead. Coordinators already have the shared
   * queue and "My events"; this list is the Lead's supervision ("view all
   * coordinator assignments"), and widening it would show every coordinator
   * everyone's caseload, the reason /coordinator-workload is the Lead's alone.
   *
   * DECLARATION ORDER IS LOAD-BEARING, as above: '/assigned' is one segment,
   * so declared after GET /:id it would be read as id === 'assigned' and the
   * Lead would get the Organiser's 404 instead of the list. Do not move it
   * below /:id.
   *
   * SCRUM-487 AC3 (SCRUM-542): three optional query parameters, filtered in
   * the query (SCRUM-487 D2). ?coordinatorId= and ?status= go to the service
   * as they arrive, and it refuses a malformed one with 400 before reading.
   * ?includeFinished= is a string on the wire, so it is mapped here: 'true'
   * is true, 'false' or absent is false, and anything else is 400. A stray
   * ?includeFinished=yes must not quietly mean false: the Lead would be shown
   * a list without finished events while believing they had asked for them.
   * With no parameters this is exactly SCRUM-486 AC6's list.
   *
   * A bare array; none is 200 []. Statuses: 200, 400 for a refused filter, 401,
   * 403 unless a Lead, 500.
   */
  router.get('/assigned', leadOnly, async (req, res) => {
    try {
      const { coordinatorId, status, includeFinished: rawIncludeFinished } = req.query;
      if (rawIncludeFinished !== undefined && rawIncludeFinished !== 'true' && rawIncludeFinished !== 'false') {
        throw new ValidationError(
          'Invalid filter -- includeFinished: must be true or false',
          [{ field: 'includeFinished', message: 'must be true or false' }],
        );
      }
      const events = await listAssignedEventsForLead({
        client,
        coordinatorId,
        status,
        includeFinished: rawIncludeFinished === 'true',
      });
      res.status(200).json(events.map(withStatusDisplay));
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
   * SCRUM-322 (SCRUM-318 AC6): an event's full status history, oldest first.
   *
   * A bare array, like GET /:id/change-requests: the screen maps over it
   * directly. An event with no recorded change is 200 [], not a 404.
   *
   * Open to any signed-in user at the router, and no role gate here, because
   * the two people who may read it hold different roles: the Organiser, and
   * the event's assigned coordinator. Who may read is decided in the service,
   * against the stored event, and anyone else, a coordinator the event is not
   * assigned to included, gets a 404 worded exactly like a missing event. A
   * coordinatorOnly gate would have shut the Organiser out, and a role check
   * on its own would have let every coordinator in.
   *
   * No ownership pre-check, unlike POST /:id/submit: the service takes the
   * caller and enforces the rule itself, as getEventRequestForOrganiser does
   * for its routes. The caller is always req.user.id, from the token.
   *
   * Not wrapped in withStatusDisplay. Each row carries the raw statuses and the
   * Organiser-facing label for each (SCRUM-323), and no more.
   */
  router.get('/:id/status-history', async (req, res) => {
    try {
      const history = await getEventRequestStatusHistory(req.params.id, req.user.id, { client });
      res.status(200).json(history);
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/:id/clarification-history', async (req, res) => {
    try {
      const history = await getEventClarificationHistory(
        req.params.id,
        req.user.id,
        req.user.role,
        { client },
      );
      res.status(200).json(history);
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

  // SCRUM-486 (SCRUM-521): coordinatorOrLead, for the reason GET /:id/review
  // gives. The event screen reads this on mount; deciding a change request
  // (POST /change-requests/:id/decision) stays coordinatorOnly, and 019 still
  // checks the caller holds the event.
  router.get('/:id/change-requests/review', coordinatorOrLead, async (req, res) => {
    try {
      const changeRequests = await getChangeRequestsForCoordinator(req.params.id, { client });
      res.status(200).json(changeRequests);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-332 (SCRUM-327 AC7): one event, for any Event Coordinator.
   *
   * The previous coordinator can still view an event they handed over, and
   * every coordinator can open an event the queue no longer lists, such as an
   * approved or confirmed one. The service reads with no organiser or
   * coordinator comparison, so coordinatorOnly is the whole of the check, as on
   * GET /queue. A draft is a 404, worded exactly like a missing event, because
   * no coordinator is meant to know a draft exists.
   *
   * A separate route, not a role branch inside GET /:id, for four reasons:
   *
   *  - Who may call it is visible here, as a second argument, like every other
   *    coordinator path in this file. requireAuth.js keeps authorisation out of
   *    shared code so that it can be read off the route.
   *  - It fails closed. A branch in GET /:id would choose between two
   *    authorisation rules inside the handler, and a mistake in its condition,
   *    such as a missing role falling through to the coordinator side, would
   *    turn the Organiser's 404 into an open read of every event. Here,
   *    requireRole answers 403 to anyone without the role before the handler
   *    runs.
   *  - GET /:id is unchanged, so the Organiser's 404 for someone else's event
   *    stays exactly as it is. For an Organiser, whether an id exists is itself
   *    the secret; for a coordinator, who sees every event in the queue, it is
   *    not.
   *  - It follows GET /:id/change-requests/review just above: the
   *    coordinator's read of an event's change requests, beside the
   *    Organiser's.
   *
   * The cost is two URLs for one event. The frontend picks by role, as it
   * already does between GET / and GET /queue.
   *
   * Cannot collide with GET /:id: that matches one segment and this two.
   * Same withStatusDisplay as GET /:id, so the coordinator's screen renders it
   * with the same helper.
   *
   * SCRUM-486 (SCRUM-521): behind coordinatorOrLead, not coordinatorOnly. The
   * Lead may hand over any event (052, AC6), and the event screen they do it
   * from (CoordinatorRequestDetail) makes this read on mount. Left
   * coordinatorOnly, it refused the Lead the screen the reassign route had
   * already been opened for: the reassign gate's fault, one layer up. A read
   * only; every write beside it keeps its own gate, and the database still
   * decides who may act.
   */
  router.get('/:id/review', coordinatorOrLead, async (req, res) => {
    try {
      const request = await getEventRequestForCoordinator(req.params.id, { client });
      res.status(200).json(withStatusDisplay(request));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.get('/:id/cancellation-impact', coordinatorOnly, async (req, res) => {
    try {
      const event = await getEventRequestForCoordinator(req.params.id, { client });
      if (event.assignedCoordinatorId !== req.user.id) {
        throw new ForbiddenError('Only the coordinator assigned to this event can preview its cancellation.');
      }
      const impact = await getEventCancellationImpact(req.params.id, { client });
      res.status(200).json(impact);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-334 (SCRUM-327 AC9, AC10): an event's assignment history, in two
   * routes. This one is the Organiser's; GET /:id/assignments/review below is
   * the coordinators'.
   *
   * Two routes rather than one that branches on role, for the reasons
   * GET /:id/review gives for sitting beside GET /:id, and the pattern
   * /:id/change-requests and /:id/change-requests/review already follow. Who
   * may call each can be read off its declaration. And it fails closed: one
   * handler choosing between the two views on req.user.role, with its
   * condition wrong, would hand every Organiser every event's history, notes
   * included, while the coordinators' route is refused by requireRole before
   * its handler runs.
   *
   * The ownership pre-check is the proof, as on GET /:id/change-requests:
   * listAssignmentHistory takes no owner. Someone else's event is the same 404
   * as a missing one, and the history is never read. A coordinator calling
   * this route is treated like any other caller who did not organise the
   * event; their view is /assignments/review.
   *
   * Without notes. The handover note is written by one coordinator for
   * another, and the Organiser sees who and when, never the note. The key is
   * absent, not null, so "not sent to you" is not confused with "none was
   * written" (the service's docstring gives the argument).
   *
   * Its own endpoint rather than a field on the event, so the event reads,
   * /mine and /queue included, do not carry a growing array nothing displays.
   */
  router.get('/:id/assignments', async (req, res) => {
    try {
      await getEventRequestForOrganiser(req.params.id, req.user.id, { client });

      const history = await listAssignmentHistory(req.params.id, { includeNotes: false }, { client });
      res.status(200).json(history);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-334 (SCRUM-327 AC9): the coordinators' view of an event's
   * assignment history, with the handover notes.
   *
   * Behind coordinatorOnly. Every coordinator gets the notes, not only the one
   * now assigned. They can already read the event (GET /:id/review), and the
   * note is written for the coordinator team; the Organiser is the reader it is
   * kept from, and the role gate does that. Limiting it to the current
   * assignee would also hide every note from the coordinator who wrote it,
   * since writing one means handing the event away, and from whoever takes the
   * event next.
   *
   * Reads the event through getEventRequestForCoordinator first, so a draft or
   * a missing id is a 404 here as it is on GET /:id/review.
   *
   * SCRUM-486 (SCRUM-521): behind coordinatorOrLead, not coordinatorOnly. The
   * Lead may hand over any event (052, AC6), and the event screen they do it
   * from (CoordinatorRequestDetail) makes this read on mount. Left
   * coordinatorOnly, it refused the Lead the screen the reassign route had
   * already been opened for: the reassign gate's fault, one layer up. A read
   * only; every write beside it keeps its own gate, and the database still
   * decides who may act.
   * The Lead gets the notes too: they write them when they hand an event over
   * (052 records theirs), and the reader the note is kept from is the
   * Organiser, whom this gate still refuses.
   */
  router.get('/:id/assignments/review', coordinatorOrLead, async (req, res) => {
    try {
      await getEventRequestForCoordinator(req.params.id, { client });

      const history = await listAssignmentHistory(req.params.id, { includeNotes: true }, { client });
      res.status(200).json(history);
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

      const submitted = await submitEventRequest(req.params.id, { client, changedBy: req.user.id });
      res.status(200).json(withStatusDisplay(submitted));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/:id/clarification', coordinatorOnly, async (req, res) => {
    try {
      const updated = await requestEventClarification(
        req.params.id,
        req.body?.note,
        req.user.id,
        {
          replyByDate: req.body?.replyByDate,
          requestedFields: req.body?.requestedFields,
          client,
        },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/:id/clarification/close', coordinatorOnly, async (req, res) => {
    try {
      const updated = await closeEventClarification(
        req.params.id,
        req.body?.note,
        req.user.id,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-331 (SCRUM-327 AC6, AC7, AC9): the assigned coordinator hands the
   * event to a colleague, with an optional note.
   *
   * Behind coordinatorOnly, as a per-route argument like every other gate in
   * this file. An Organiser is refused before the handler runs and the
   * database is never touched.
   *
   * No ownership pre-check, and that is deliberate, not an omission next to
   * POST /:id/submit. The submit route's pre-check is the only thing proving
   * an Organiser owns the draft, because submitEventRequest checks no owner;
   * the route tests call that pre-check "the single most important test in
   * this file". Here the caller is a coordinator, not the Organiser, so
   * organiser_id says nothing about whether they may act. The question that
   * matters is whether the caller is this event's assigned coordinator, and
   * reassign_event_request (018) answers it while holding the row lock, which
   * is the only point where the answer cannot change before the write. A
   * pre-check here would ask the same thing in a separate request and could
   * already be out of date. A coordinator who does not hold the event gets the
   * function's 403, not a 404: they can already see the event in the shared
   * queue (errors.js gives the full argument).
   *
   * The body is passed whole. The service reads only newCoordinatorId and
   * handoverNote from it, so a body naming someone else as assignedBy matches
   * nothing. The caller is always req.user.id, from the token.
   *
   * 200 and the whole request, so the screen can redraw from the response.
   * The function's refusals arrive through translateError: 403 (not the
   * assigned coordinator), 400 (no such coordinator, or already theirs), 409
   * (status does not allow a handover), 404 (no such event).
   *
   * SCRUM-486 AC6 (SCRUM-519): behind coordinatorOrLead, not coordinatorOnly.
   * 052 widened reassign_event_request to let a Lead hand over any event, but
   * this gate refused the Lead first, so the widening was unreachable over
   * HTTP. Nothing else changes: the function still decides, under the lock,
   * whether this caller may hand over this event, and a coordinator who does
   * not hold it is still its 403.
   */
  router.post('/:id/reassign', coordinatorOrLead, async (req, res) => {
    try {
      const updated = await reassignEventRequest(
        req.params.id,
        req.body,
        req.user.id,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-486 AC3, AC4 (SCRUM-519): the Lead assigns an unassigned request to
   * one Event Coordinator. Body: { coordinatorId, note }.
   *
   * Lead only, with no pre-check, for the reason POST /:id/reassign gives:
   * assign_event_request (052) checks the caller is a Lead, the request is
   * still unassigned and submitted, and the assignee is an Event Coordinator,
   * all under the row lock. Only coordinatorId and note are taken from the
   * body; the one assigning is always req.user.id, from the token.
   *
   * 200 and the whole request. Refusals: 400 (no coordinatorId, or the person
   * chosen is not an Event Coordinator), 403 (not a Lead), 404 (no such
   * request), 409 (already assigned, with code ALREADY_ASSIGNED and the holder
   * in `conflicts`, so the screen can name them; or no longer submitted).
   */
  router.post('/:id/assign', leadOnly, async (req, res) => {
    try {
      const updated = await assignEventRequest(
        req.params.id,
        { coordinatorId: req.body?.coordinatorId, note: req.body?.note },
        req.user.id,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-346 (SCRUM-19 AC1): the assigned coordinator starts reviewing a
   * submitted request, which moves it to under_review and makes them its
   * reviewing coordinator, the person 025 allows to decide it.
   *
   * /start-review, not POST /:id/review. GET /:id/review already exists: it
   * is the coordinator's read of one event (SCRUM-332). Two verbs on one path
   * for unrelated actions, one reading the event and one changing its status,
   * would read as one resource and mislead whoever adds the next route.
   * /start-review says what it does.
   *
   * Behind coordinatorOnly, with no ownership pre-check, for the reason
   * POST /:id/reassign gives above: whether the caller is this event's
   * assigned coordinator is what start_event_review (029) checks under the
   * row lock. Nothing is read from the body. The caller is always
   * req.user.id, from the token.
   *
   * 200 and the whole request. Refusals through translateError: 403 (not the
   * assigned coordinator), 409 (not submitted), 404 (no such event).
   */
  router.post('/:id/start-review', coordinatorOnly, async (req, res) => {
    try {
      const updated = await startEventReview(req.params.id, req.user.id, { client });
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-119 and SCRUM-121 (SCRUM-19): the assigned coordinator approves or
   * rejects a request under review. Body: { decision, decisionNote }.
   *
   * Cannot collide with POST /change-requests/:changeRequestId/decision
   * below: that path has three segments and this one two.
   *
   * Behind coordinatorOnly, with no pre-check, for the reason given at
   * /start-review. Only decision and decisionNote are taken from the body, so
   * a body naming someone else as the decider changes nothing: decidedBy is
   * always req.user.id. The decision time is the server's clock (the
   * service's default `now`), never the client's.
   *
   * 200 and the whole request, decision fields included. Refusals: 400 (a bad
   * decision value, or a rejection with no reason, with details naming the
   * field), 403 (not the assigned coordinator or reviewer), 409 (not under
   * review, or an approval whose start date has passed), 404 (no such event).
   */
  router.post('/:id/decision', coordinatorOnly, async (req, res) => {
    try {
      const updated = await decideEventRequest(
        req.params.id,
        { decision: req.body?.decision, decisionNote: req.body?.decisionNote },
        req.user.id,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.post('/:id/cancel', coordinatorOnly, async (req, res) => {
    try {
      const updated = await cancelEventRequest(
        req.params.id,
        {
          reason: req.body?.reason,
          initiator: req.body?.initiator,
          attendeeMessage: req.body?.attendeeMessage,
        },
        req.user.id,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
    } catch (err) {
      handleError(err, res);
    }
  });

  router.patch('/:id/clarification-response', async (req, res) => {
    try {
      const updated = await respondToEventClarification(
        req.params.id,
        req.body?.message,
        req.user.id,
        req.body?.amendments,
        { client },
      );
      res.status(200).json(withStatusDisplay(updated));
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

  router.post('/change-requests/:changeRequestId/decision', coordinatorOnly, async (req, res) => {
    try {
      const processed = await processChangeRequest(
        req.params.changeRequestId,
        req.body,
        req.user.id,
        { client },
      );
      res.status(200).json(processed);
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createEventRequestRouter();
