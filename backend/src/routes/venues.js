/**
 * Venue catalogue routes.
 *
 * SCRUM-15 "Maintain Venue Catalogue Details - Venue Staff".
 *
 * Until now this file existed but was never mounted, so every venue capability
 * was unreachable: four migrations, five service functions and 1,245 lines of
 * tests that no client could touch. Two of those service functions --
 * retireVenue (SCRUM-110) and searchVenues (SCRUM-111) -- had no route even
 * here, so AC2 and AC3 could not have been met by mounting it as it stood.
 *
 * Who may do what, and why:
 *
 *   reads   any authenticated user. The customer briefing has Event
 *           Coordinators searching for venues ("Event Coordinators can search
 *           for potential venues using requirements such as date, time,
 *           attendance..."), so restricting search to Venue Staff would break
 *           the feature it exists to serve.
 *   writes  Venue Staff only. AC2 says an *authorised* change, and the story
 *           is written from the Venue Staff member's seat.
 *   history Venue Staff only. It is an audit trail, and it names who changed
 *           what.
 */

import express from 'express';

import {
  createVenue,
  updateVenue,
  getVenueById,
  retireVenue,
  searchVenues,
  getVenueHistory,
  getBookingsForVenue,
} from '../services/venueService.js';
import { validateVenueId } from '../validation/venueValidation.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { AppError } from '../errors.js';


/**
 * Map an error to a response.
 *
 * Every typed error already carries its own status, so a route never decides
 * what a failure means. Same helper as routes/eventRequests.js.
 */
function handleError(err, res) {
  if (err instanceof AppError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json(body);
  }

  console.error('Unexpected error in venues route:', err);
  return res.status(500).json({ error: 'Unexpected server error' });
}


/**
 * Turn query-string filters into what validateSearchFilters expects.
 *
 * Query parameters are always strings, and checkCapacity requires an actual
 * number (venueValidation.js:92) -- so ?minCapacity=100 would be refused as
 * "must be a number" without this. Converting here rather than loosening the
 * validator keeps one rule: a capacity is a number, and it is the transport's
 * job to present it as one.
 *
 * Only converts a non-blank value, so an empty search box stays unset rather
 * than becoming 0, which would be a filter the user never asked for.
 * Number('abc') is NaN and Number('12.5') is 12.5, so both still reach the
 * validator and get the message they deserve.
 */
function parseSearchFilters(query) {
  const filters = {};

  if (query.location !== undefined) {
    filters.location = query.location;
  }

  if (query.minCapacity !== undefined && String(query.minCapacity).trim() !== '') {
    filters.minCapacity = Number(query.minCapacity);
  }

  return filters;
}


/**
 * The acting user is the signed-in one, and the request body never gets a say.
 *
 * This replaces `req.body.userId ?? null`, which let a client name whoever it
 * liked as the editor of a venue -- against a table whose row level security
 * is deny-all precisely because the API is supposed to be the gate. It is also
 * the single change that finally populates venue_change_history.changed_by,
 * which had been NULL on every row ever written, leaving AC4's "records the
 * editing user" unmet however many rows the trigger produced.
 */
function actingUser(req) {
  return req.user.id;
}


/**
 * Strip fields a caller must not be able to set.
 *
 * userId in particular: validateUpdateVenue refuses an empty change set, so a
 * body of {userId: "..."} alone would otherwise pass that guard as though it
 * were a real edit and send all-nulls into update_venue.
 */
function changeSet(body) {
  const { userId, ...changes } = body ?? {};
  return changes;
}


/**
 * Build the router, optionally over injected middleware.
 *
 * A factory for the same reason routes/eventRequests.js is one: the tests
 * drive real Express routing -- path matching, query parsing, status codes --
 * with fake authentication, while production supplies neither.
 *
 * @param {object} [options]
 * @param {Function} [options.requireAuth]
 * @param {Function} [options.requireRole]  a factory, so a test can widen or
 *                                          narrow the gate without rebuilding it
 * @returns {import('express').Router}
 */
export function createVenueRouter({
  requireAuth = defaultRequireAuth,
  requireRole = createRequireRole,
} = {}) {
  const router = express.Router();
  const venueStaffOnly = requireRole(ROLE.VENUE_STAFF);

  // Every route below needs to know who is calling -- reads to prove they are
  // signed in, writes to attribute the change.
  router.use(requireAuth);

  /**
   * AC2 and AC3, the read half: search only ever returns active venues.
   *
   * Declared before GET /:id, and that order is load-bearing rather than
   * stylistic: Express matches in declaration order, so /:id would otherwise
   * swallow this with id === 'search'. The frontend already calls this path.
   */
  router.get('/search', async (req, res) => {
    try {
      const venues = await searchVenues(parseSearchFilters(req.query));
      res.status(200).json(venues);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC3: a retired venue is still readable by id.
   *
   * validateVenueId is called here because getVenueById is the one service
   * function that does not call it itself -- without this a non-uuid reaches
   * Postgres as a 22P02 cast error that translateError does not recognise, and
   * the caller gets a 500 for what is plainly a bad request.
   */
  router.get('/:id', async (req, res) => {
    try {
      validateVenueId(req.params.id);
      res.status(200).json(await getVenueById(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC3: "while its past bookings remain viewable."
   *
   * Deliberately not gated on the venue being active -- a retired venue's
   * bookings are exactly what this exists to serve.
   */
  router.get('/:id/bookings', async (req, res) => {
    try {
      res.status(200).json(await getBookingsForVenue(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC4: the previous values, readable at last. */
  router.get('/:id/history', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await getVenueHistory(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC1: create a venue with every field the criterion names. */
  router.post('/', venueStaffOnly, async (req, res) => {
    try {
      const venue = await createVenue(changeSet(req.body), actingUser(req));
      res.status(201).json(venue);
    } catch (err) {
      handleError(err, res);
    }
  });

  /** AC2: an authorised change, saved and visible to the next search. */
  router.patch('/:id', venueStaffOnly, async (req, res) => {
    try {
      validateVenueId(req.params.id);
      const venue = await updateVenue(req.params.id, changeSet(req.body), actingUser(req));
      res.status(200).json(venue);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC3: retire a venue.
   *
   * POST rather than DELETE, and the path says "retire" rather than the method
   * implying it: retirement is a soft delete that the record survives, and a
   * DELETE would describe the opposite of what happens. Nothing in this API
   * ever hard-deletes a venue, and 003's on-delete-restrict enforces that.
   */
  router.post('/:id/retire', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await retireVenue(req.params.id, actingUser(req)));
    } catch (err) {
      handleError(err, res);
    }
  });

  return router;
}


/** The instance src/app.js mounts. */
export default createVenueRouter();
