/**
 * Map a service error to an HTTP response.
 *
 * SCRUM-127, a subtask of SCRUM-17 (Block a Venue for Unavailability).
 *
 * Lifted out of routes/venues.js, routes/eventRequests.js and
 * routes/notifications.js, which each carried an identical copy. Both of the
 * reasons those copies gave for waiting have now arrived: a third router
 * exists, and SCRUM-127 has to change the helper -- the venue block routes
 * answer ConflictErrors whose code and conflicts a client needs to act on, and
 * three copies would be three places to remember that.
 *
 * Every typed error already carries its own status, so a route never decides
 * what a failure means.
 *
 * Imports only errors.js, which imports nothing. routes/eventRequests.js's
 * tests do not mock config/supabaseClient.js, so anything here that reached
 * it would throw at collection time and take that whole test file down.
 */

import { AppError, ConflictError } from '../errors.js';


/**
 * Build the handler for one router.
 *
 * A factory rather than one shared function so each router keeps its own log
 * label, and the on-call reader can still tell which router a 500 came from.
 *
 * @param {string} context  named in the log line, e.g. 'venues route'
 * @returns {function(Error, import('express').Response): import('express').Response}
 */
export function createErrorHandler(context) {
  return function handleError(err, res) {
    if (err instanceof AppError) {
      const body = { error: err.message };
      if (err.details) body.details = err.details;

      // instanceof, not "has a code": a stray err.code on some other error --
      // a Postgres code, say -- must never reach a client. A ConflictError
      // always carries both keys, so a client can read them without first
      // checking they exist.
      if (err instanceof ConflictError) {
        body.code = err.code ?? null;
        body.conflicts = err.conflicts ?? [];
      }

      return res.status(err.status).json(body);
    }

    // Untyped means nobody anticipated it, so the driver message is logged for
    // whoever is on call and never returned to the caller.
    console.error(`Unexpected error in ${context}:`, err);
    return res.status(500).json({ error: 'Unexpected server error' });
  };
}
