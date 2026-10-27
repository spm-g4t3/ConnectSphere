/**
 * SCRUM-382 (SCRUM-379 AC3): refuse a change to a Completed or Cancelled event.
 *
 * A router is given a `finalEventGuard` the way it is given `requireAuth`. Each
 * route that changes an event, or anything attached to it, names how to find
 * the event and puts the result after its role check:
 *
 *   router.post('/:id/clarification', coordinatorOnly, guardEvent, handler);
 *
 * After the role check on purpose: a caller who may not use the route is told
 * so (403) and learns nothing about the event. Only a permitted caller is told
 * the event is final.
 *
 * The guard reads the event's status once and refuses with 409 and the code
 * EVENT_FINAL when it is final (domain/finalEvent.js). It does not decide
 * anything else: every other rule stays with the service and the database
 * function behind the route, which still refuse an illegal change under their
 * own row lock. The guard is the first line, not the only one, because the
 * event can be completed between the guard's read and the handler's write.
 *
 * Three outcomes besides "final":
 *  - the event cannot be found, or the id is not a usable uuid: the guard lets
 *    the request through, and the handler gives its own 400 or 404, so the
 *    guard never answers differently about a missing event;
 *  - the read fails: the request is refused with a 500. A guard that cannot
 *    tell must not let a change through;
 *  - the router was built without a guard (the default, used by the route tests
 *    that stub the client): nothing is checked. src/app.js mounts the routers
 *    built with the real guard, and a test proves every mutating route has one.
 *
 * Imports only the lazy client resolver and the pure domain modules, as the
 * routers' tests do not mock config/supabaseClient.js.
 */

import { resolveClient } from '../config/resolveClient.js';
import { isPlausibleId } from '../validation/ids.js';
import { assertEventNotFinal } from '../domain/finalEvent.js';

/** Tag on the middleware, so a test can tell a guarded route from an unguarded one. */
export const FINAL_EVENT_GUARD_TAG = 'isFinalEventGuard';

/** The default for a router built without a guard: lets everything through. */
export function noopFinalEventGuard() {
  return (req, res, next) => next();
}

/** The event's id is a route parameter (default `id`). */
export function eventIdFromParam(name = 'id') {
  return async (req) => req.params?.[name] ?? null;
}

/** The event's id is a field of the JSON body (default `eventRequestId`). */
export function eventIdFromBody(name = 'eventRequestId') {
  return async (req) => req.body?.[name] ?? null;
}

/**
 * The route names a record attached to an event (a booking, a registration, a
 * change request), and the record carries the event's id.
 *
 * @param {string} table      table holding the record
 * @param {string} paramName  route parameter holding the record's id
 */
export function eventIdFromRecord(table, paramName = 'id') {
  return async (req, db) => {
    const recordId = req.params?.[paramName];
    if (!isUsableId(recordId)) return null;
    const { data, error } = await db
      .from(table)
      .select('event_request_id')
      .eq('id', recordId.trim().toLowerCase())
      .maybeSingle();
    if (error) throw guardReadError(error);
    return data?.event_request_id ?? null;
  };
}

function isUsableId(value) {
  return typeof value === 'string' && isPlausibleId(value);
}

function guardReadError(error) {
  const err = new Error(`The final-event guard could not read the event: ${error.message ?? error.code}`);
  err.cause = error;
  return err;
}

/**
 * Build the guard for a router.
 *
 * @param {object} [options]
 * @param {object} [options.client]  a supabase-js client; the shared one when omitted
 * @returns {function(function): import('express').RequestHandler}
 *          call it with a resolver (eventIdFromParam and friends) to get the
 *          middleware for one route
 */
export function createFinalEventGuard({ client } = {}) {
  return function finalEventGuard(resolveEventId) {
    const middleware = async (req, res, next) => {
      const db = await resolveClient(client);

      const eventId = await resolveEventId(req, db);
      if (!isUsableId(eventId)) return next();

      const { data, error } = await db
        .from('event_requests')
        .select('status')
        .eq('id', eventId.trim().toLowerCase())
        .maybeSingle();
      if (error) throw guardReadError(error);

      assertEventNotFinal(data?.status);
      return next();
    };
    middleware[FINAL_EVENT_GUARD_TAG] = true;
    return middleware;
  };
}
