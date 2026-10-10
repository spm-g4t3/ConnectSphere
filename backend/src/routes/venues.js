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
 *   reads   search and read-by-id: any authenticated user. The customer
 *           briefing has Event Coordinators searching for venues ("Event
 *           Coordinators can search for potential venues using requirements
 *           such as date, time, attendance..."), so restricting those to
 *           Venue Staff would break the feature they exist to serve.
 *           One exception inside search (SCRUM-185, SCRUM-178 AC1):
 *           ?includeRetired=true is Venue Staff and Event Coordinators only,
 *           the same pair as the calendar it leads to. Anyone else asking
 *           for it gets 403, so a retired venue still never reaches a list
 *           an Organiser or Attendee can obtain.
 *           The full catalogue listing is the one exception -- Venue Staff
 *           only (SCRUM-110), because it is the only read that returns
 *           retired venues, and SCRUM-111's invariant is that a retired one
 *           never reaches a list a non-staff caller can obtain.
 *   writes  Venue Staff only. AC2 says an *authorised* change, and the story
 *           is written from the Venue Staff member's seat.
 *   history Venue Staff only. It is an audit trail, and it names who changed
 *           what.
 *   blocks  writes Venue Staff only (SCRUM-127, part of SCRUM-17): creating,
 *           amending and removing a block is the story's whole seat.
 *           Reads are Venue Staff and Event Coordinators (SCRUM-130). The
 *           venue calendar (SCRUM-178) shows Coordinators a venue's blocks
 *           as "Blocked", and Coordinators are who resolve the bookings a
 *           block flags. Organisers, Attendees and Technical Support still
 *           get 403: a block's notes are staff's own words and its rows name
 *           who made it, and what those roles need -- "is this venue free
 *           then?" -- is answered by /search's date window instead.
 *           A block's history is Venue Staff only (SCRUM-131), like venue
 *           history: it keeps superseded notes and names every editor, and
 *           Coordinators already see the block as it stands.
 *   calendar Venue Staff and Event Coordinators (SCRUM-179), the same as
 *           block reads, because it shows the same blocks beside bookings.
 *   bookings Venue Staff and Event Coordinators (SCRUM-182), the same as
 *           the calendar. Before SCRUM-182 any authenticated user could read
 *           them, which made the calendar's 403 a formality: an Organiser
 *           could fetch the bookings half of it here. A retired venue's
 *           bookings stay readable (SCRUM-15 AC3).
 *   event-search  Event Coordinators only (SCRUM-140, for SCRUM-20). The
 *           story is written from the Event Coordinator's seat, and its
 *           results reveal when venues are busy: a venue left out is one
 *           with a booking or block in that period. Every other role gets
 *           403. Venue Staff keep the old /search, which is unchanged.
 *   holds   Venue Staff only (SCRUM-491). Placing a tentative hold is the
 *           story's whole seat (AC1), and the list of a venue's active holds
 *           is the panel that places them. Everyone else sees a hold only as
 *           "Tentatively held" on the calendar (AC6) and as a venue missing
 *           from their search (AC5).
 */

import express from 'express';

import {
  createVenue,
  updateVenue,
  getVenueById,
  listVenues,
  retireVenue,
  searchVenues,
  getVenueHistory,
  getBookingsForVenue,
  findVenuesForEvent,
} from '../services/venueService.js';
import {
  listVenueBlocks,
  createVenueBlock,
  updateVenueBlock,
  removeVenueBlock,
  getVenueBlockHistory,
} from '../services/venueBlockService.js';
import { getVenueCalendar } from '../services/venueCalendarService.js';
import { listActiveVenueHolds, placeVenueHold } from '../services/venueHoldService.js';
import {
  validateVenueId,
  validateSearchFilters,
} from '../validation/venueValidation.js';
import { requireAuth as defaultRequireAuth } from '../middleware/requireAuth.js';
import { createRequireRole } from '../middleware/requireRole.js';
import { ROLE } from '../domain/userRole.js';
import { createErrorHandler } from '../http/handleError.js';


/** Map an error to a response; see src/http/handleError.js (SCRUM-127). */
const handleError = createErrorHandler('venues route');


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

  // SCRUM-130: passed through as sent, like location -- timestamps are text,
  // so there is nothing to convert, and the validator owns every rule.
  if (query.startsAt !== undefined) {
    filters.startsAt = query.startsAt;
  }

  if (query.endsAt !== undefined) {
    filters.endsAt = query.endsAt;
  }

  // SCRUM-185: passed through as sent too. 'true' and 'false' are the
  // validator's to read, so a junk value gets its 400 rather than being
  // quietly coerced here.
  if (query.includeRetired !== undefined) {
    filters.includeRetired = query.includeRetired;
  }

  return filters;
}


/**
 * Split comma-separated codes into one list, for accessibility and facilities.
 *
 * Why commas: axios's default serialisation of an array param is `key[]=a&
 * key[]=b`, and Express 5's default query parser ('simple', which is Node's
 * querystring.parse -- express/lib/application.js sets it, utils.js
 * compileQueryParser maps it) keeps that as a key literally named 'key[]', so
 * req.query.key would be undefined and the criterion silently lost. A single
 * `key=a,b` survives any client and any parser, and codes never contain
 * commas. A repeated `key=a&key=b`, which querystring.parse does turn into an
 * array, is accepted too and split the same way.
 *
 * Blank pieces are dropped (`a,,b`, a trailing comma, an untouched field), and
 * if nothing is left the result is undefined so the caller leaves the key out
 * -- the validator treats a missing list as "not filtered on".
 *
 * Only strings are split. Anything else -- a non-string array entry, or an
 * object a different query parser might build -- is passed through as it
 * came, so validateEventSearchCriteria reports it ("must be an array of
 * codes", "entry N must be a non-empty code") rather than this quietly
 * dropping it. The simple parser only produces strings, so in production that
 * is a guard, not a path.
 */
function parseCodeList(value) {
  if (typeof value !== 'string' && !Array.isArray(value)) return value;

  const pieces = typeof value === 'string' ? [value] : value;
  const codes = pieces.flatMap((piece) =>
    typeof piece === 'string'
      ? piece.split(',').map((code) => code.trim()).filter((code) => code !== '')
      : [piece],
  );

  return codes.length > 0 ? codes : undefined;
}


/**
 * Turn an event search's query string into what validateEventSearchCriteria
 * expects (SCRUM-140, for SCRUM-20 AC1).
 *
 * Shaped like parseSearchFilters: convert only what the transport mangles,
 * and leave every rule to the validator.
 *
 * startsAt, endsAt, layout and location (SCRUM-141) pass through as sent --
 * they are text already.
 *
 * expectedAttendance becomes a number, but only when non-blank, so a missing
 * or empty one reaches the validator as absent and gets "is required" rather
 * than becoming 0 or NaN. Number('abc') is NaN and Number('12.5') 12.5, so
 * both still get the message they deserve.
 *
 * accessibility and facilities are comma-separated lists; see parseCodeList.
 * Each key is set only when something is left to filter by.
 */
function parseEventSearch(query) {
  const criteria = {};

  if (query.startsAt !== undefined) {
    criteria.startsAt = query.startsAt;
  }

  if (query.endsAt !== undefined) {
    criteria.endsAt = query.endsAt;
  }

  if (
    query.expectedAttendance !== undefined &&
    String(query.expectedAttendance).trim() !== ''
  ) {
    criteria.expectedAttendance = Number(query.expectedAttendance);
  }

  if (query.layout !== undefined) {
    criteria.layout = query.layout;
  }

  if (query.location !== undefined) {
    criteria.location = query.location;
  }

  for (const field of ['accessibility', 'facilities']) {
    if (query[field] === undefined) continue;
    const codes = parseCodeList(query[field]);
    if (codes !== undefined) criteria[field] = codes;
  }

  // SCRUM-491 (AC5): the event being searched for, passed through as sent.
  // The validator checks its shape; the service decides whether the caller
  // may leave its holds out.
  if (query.eventRequestId !== undefined) {
    criteria.eventRequestId = query.eventRequestId;
  }

  return criteria;
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
  // The internal roles: Venue Staff and Event Coordinators. SCRUM-130 opened
  // block reads to them, wider than block writes; SCRUM-179 gave the calendar
  // the same pair, and SCRUM-182 put bookings behind it too, so the calendar
  // cannot be reassembled from an ungated read. See the header.
  const internalReaders = requireRole(ROLE.VENUE_STAFF, ROLE.EVENT_COORDINATOR);
  // SCRUM-140: the event search (SCRUM-20) is the Event Coordinator's alone.
  // The story is written from their seat, and its results reveal when venues
  // are busy -- a venue missing from them has a booking or block then. Venue
  // Staff keep the old /search. See the header.
  const coordinatorsOnly = requireRole(ROLE.EVENT_COORDINATOR);

  /**
   * SCRUM-185: /search is open to every signed-in user, but including retired
   * venues is the internal roles' only, so this gate applies internalReaders
   * just when the flag is set. Reusing it keeps one list of roles and one 403
   * body. Validated first, so the gate reads the flag the service will act on
   * ('false' is off, junk is 400) -- and all of it before any database call.
   * searchVenues validates again; it is pure, and keeping its own check means
   * the service stays safe for any other caller.
   */
  function gateRetiredSearch(req, res, next) {
    let filters;
    try {
      filters = validateSearchFilters(parseSearchFilters(req.query));
    } catch (err) {
      return handleError(err, res);
    }
    if (filters.includeRetired) return internalReaders(req, res, next);
    return next();
  }

  // Every route below needs to know who is calling -- reads to prove they are
  // signed in, writes to attribute the change.
  router.use(requireAuth);

  /**
   * SCRUM-110, AC3 from the staff side: the whole catalogue, retired included.
   *
   * venueStaffOnly, and here the gate is the feature rather than a reflex.
   * This is the only list in the API that contains retired venues, so leaving
   * it open to any authenticated user would hand an Event Coordinator a back
   * door straight around SCRUM-111's invariant that a retired venue never
   * appears in a venue list. The role check is what keeps /search the only
   * venue list a non-staff caller can obtain.
   *
   * SCRUM-185 since lets Event Coordinators reach retired venues through
   * /search?includeRetired=true, for the calendar. That is a narrower read
   * (no turnaround, no audit fields) and gated in its own right; this full
   * listing stays Venue Staff only.
   *
   * Declared first is convention, not correctness. Unlike /search against
   * /:id below -- where declaration order genuinely is load-bearing -- /:id
   * cannot match an empty segment, so nothing breaks if this moves. It sits
   * here so read order follows the resource: / then /search then
   * /event-search then /:id then /:id/bookings then /:id/history, and the
   * writes after.
   *
   * Nothing is read off the request -- no path param, no body, no query
   * string -- so there is nothing here to validate or sanitise.
   */
  router.get('/', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await listVenues());
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * AC2 and AC3, the read half: search only ever returns active venues.
   *
   * Declared before GET /:id, and that order is load-bearing rather than
   * stylistic: Express matches in declaration order, so /:id would otherwise
   * swallow this with id === 'search'. The frontend already calls this path.
   *
   * SCRUM-17 AC2 (SCRUM-130): ?startsAt=&endsAt=, both or neither, leaves out
   * venues blocked at any point in that window -- and, since SCRUM-484, venues
   * booked in it too, setup and turnaround included. The offsets must be
   * URL-encoded: a raw '+' in a query string decodes to a space, so
   * '...T09:00:00+08:00' arrives as '...T09:00:00 08:00'. That is answered
   * with 400 rather than guessed back into '+' -- a guessed offset is a
   * silently different instant. axios params encodes it; Z needs no encoding.
   *
   * SCRUM-178 AC1 (SCRUM-185): ?includeRetired=true also returns retired
   * venues, each row then carrying retiredAt, so a retired venue's calendar
   * can be reached from search. Venue Staff and Event Coordinators only
   * (gateRetiredSearch above); 'false' or absent is the ordinary search. It
   * cannot be combined with a date window -- a retired venue cannot be booked.
   *
   * Statuses: 200; 400 for a bad capacity, a one-sided, malformed or
   * reversed window, an includeRetired other than true/false, or
   * includeRetired with a window; 401; 403 for includeRetired unless Venue
   * Staff or an Event Coordinator; 500.
   */
  router.get('/search', gateRetiredSearch, async (req, res) => {
    try {
      const venues = await searchVenues(parseSearchFilters(req.query));
      res.status(200).json(venues);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-20 (SCRUM-140): search venues against an event's requirements.
   *
   * ?startsAt=&endsAt=&expectedAttendance= are required; ?layout=,
   * ?accessibility=, ?facilities= and ?location= (SCRUM-141) are optional,
   * accessibility and facilities as comma-separated codes (parseEventSearch).
   * findVenuesForEvent does the rest: AC1 the criteria themselves; active
   * venues only (SCRUM-15 AC3); AC3 capacity and opening hours cover the
   * event, the layout and every requested accessibility feature and facility
   * are provided, and the location contains the requested text; AC4 every
   * supplied criterion must match, a partial match is not returned; AC5/AC6
   * no occupying booking -- approved or flagged_for_review, the SCRUM-139
   * decision -- and no active block overlaps the event, on the strict rule,
   * once the venue's setup and turnaround are added (SCRUM-484: decided in
   * Postgres by available_venue_ids, 033); AC7 each result carries the venue's details; AC8 no match is an
   * empty list. AC2's pre-fill is the client's.
   *
   * No includeRetired here: parseEventSearch copies only the keys it knows,
   * so it is never read and retired venues are always left out -- unlike
   * /search, which validates it.
   *
   * The '+' in an offset must be URL-encoded as %2B, as /search explains;
   * axios params does it.
   *
   * A separate route rather than more /search parameters: /search's contract
   * is what the catalogue, the calendar links and Venue Staff rely on, and it
   * has different required fields, a different role and a different result
   * shape. Leaving it untouched keeps every existing caller working.
   *
   * Declared before GET /:id, and like /search that order is load-bearing:
   * otherwise /:id would match this with id === 'event-search'.
   *
   * SCRUM-491 (AC5): ?eventRequestId= optionally names the event being
   * searched for. A venue another event holds tentatively is left out; one
   * this event holds is not, but only when the caller is the event's
   * assigned coordinator (venueService.findVenuesForEvent). A malformed id is
   * 400.
   *
   * Statuses: 200 with the matching venues, and 200 [] when none match (AC8)
   * -- never 404, since an empty result is an answer, not a missing resource;
   * 400 {error, details} for a missing or malformed period, a bad attendance,
   * a non-text location or an unknown code; 401; 403 for any role but Event Coordinator; 500.
   */
  router.get('/event-search', coordinatorsOnly, async (req, res) => {
    try {
      // SCRUM-491: the caller, so an optional ?eventRequestId= leaves out
      // that event's own holds only when they are its assigned coordinator.
      const criteria = parseEventSearch(req.query);
      res.status(200).json(await findVenuesForEvent(criteria, { userId: req.user.id }));
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
   *
   * It is gated on role, though (SCRUM-182): Venue Staff and Event
   * Coordinators only, the same as /:id/calendar. The calendar shows these
   * same bookings, and SCRUM-178 AC6 keeps Organisers and Attendees out of
   * it; left open, this route would be a side door to what the calendar's
   * 403 refuses.
   *
   * Statuses: 200; 400 for a malformed id (the service validates it); 401;
   * 403 unless Venue Staff or an Event Coordinator; 500.
   */
  router.get('/:id/bookings', internalReaders, async (req, res) => {
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

  /**
   * SCRUM-17: a venue's active blocks, soonest first. A bare array, like
   * /:id/history; none is 200 [].
   *
   * SCRUM-130 (AC2): ?from=&to=, both or neither, narrows it to blocks
   * overlapping [from, to), ended ones included, for the venue calendar. At
   * most 400 days. The '+' in an offset must be URL-encoded, as /search
   * explains.
   *
   * Statuses: 200; 400 for a malformed id, or a one-sided, malformed or
   * reversed window, or one over 400 days; 401; 403 unless Venue Staff or an
   * Event Coordinator; 500.
   */
  router.get('/:id/blocks', internalReaders, async (req, res) => {
    try {
      const window = { from: req.query.from, to: req.query.to };
      res.status(200).json(await listVenueBlocks(req.params.id, window));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-178 (SCRUM-179): a venue's availability calendar -- its approved
   * and flagged bookings and its active blocks overlapping [from, to), merged
   * and soonest first. A bare array of entries, each with kind 'booking' or
   * 'block'; nothing in the window is 200 [].
   *
   * ?from=&to= is required here, unlike /:id/blocks: a calendar always shows
   * a range. At most 400 days. The '+' in an offset must be URL-encoded as
   * %2B, as /search explains. Readable by the same roles as /:id/blocks, and
   * for a retired venue too.
   *
   * Statuses: 200; 400 for a malformed id, or a missing, one-sided,
   * malformed or reversed window, or one over 400 days; 401; 403 unless Venue
   * Staff or an Event Coordinator; 404 for an unknown venue; 500.
   */
  router.get('/:id/calendar', internalReaders, async (req, res) => {
    try {
      const window = { from: req.query.from, to: req.query.to };
      res.status(200).json(await getVenueCalendar(req.params.id, window));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-491: a venue's active tentative holds, soonest expiry first, each
   * with its event's name and period and who placed it. A bare array; none
   * is 200 []. A hold past its expiry is not listed, even before the expiry
   * job has marked it (AC7).
   *
   * Statuses: 200; 400 for a malformed id; 401; 403 unless Venue Staff; 404
   * for an unknown venue; 500.
   */
  router.get('/:id/holds', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await listActiveVenueHolds(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-491 AC1-AC4: place a tentative hold on the venue for an Approved
   * event, until { expiresAt }. Body: { eventRequestId, expiresAt }; the
   * placer is only ever actingUser(req).
   *
   * Venue Staff only. Any other role gets requireRole's 403, "This action is
   * restricted to Venue Staff", which is AC1's message stating why.
   *
   * Statuses: 201 {hold}; 400 for a malformed id, a missing or malformed
   * event, or an expiry that is missing, malformed or not in the future; 401;
   * 403; 404 for an unknown venue or event; 409 with code EVENT_NOT_APPROVED,
   * EVENT_DATES_MISSING, VENUE_RETIRED, HOLD_EXISTS or HOLD_PERIOD_CONFLICT
   * (conflicts list each booking, block or hold in the way, with its
   * occupied period); 500.
   */
  router.post('/:id/holds', venueStaffOnly, async (req, res) => {
    try {
      const hold = await placeVenueHold(req.params.id, req.body, actingUser(req));
      res.status(201).json({ hold });
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-17 AC4 (SCRUM-131): who created, amended and removed a block, and
   * when, newest first. A bare array, like /:id/history. Removed blocks still
   * answer: their trail is what this route keeps.
   *
   * Statuses: 200; 400 for a malformed id; 401; 403 unless Venue Staff; 404
   * for a missing venue or a block not on it; 500.
   */
  router.get('/:id/blocks/:blockId/history', venueStaffOnly, async (req, res) => {
    try {
      res.status(200).json(await getVenueBlockHistory(req.params.id, req.params.blockId));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-17 AC1 and AC3: block a venue for a period.
   *
   * The body goes to the service as sent, without changeSet: the block
   * validators ignore unknown keys, so a body userId never reaches the RPC,
   * and a non-object body is refused there with its own message. The acting
   * user is still only ever actingUser(req).
   *
   * Statuses: 201 {block, flaggedBookings}; 400; 401; 403; 404 for a missing
   * venue; 409 with code VENUE_RETIRED, BLOCK_OVERLAPS_BLOCK or
   * BLOCK_BOOKING_CONFLICT (resend with confirmOverride and the listed
   * booking ids to override); 500.
   */
  router.post('/:id/blocks', venueStaffOnly, async (req, res) => {
    try {
      const result = await createVenueBlock(req.params.id, req.body, actingUser(req));
      res.status(201).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-17 AC4 (and AC3 when the change widens the period): shorten,
   * extend, or change the reason or notes. PATCH because only the fields sent
   * change.
   *
   * Statuses: 200 {block, flaggedBookings}; 400; 401; 403; 404 for a missing
   * venue or a block not on it; 409 with code BLOCK_REMOVED, BLOCK_ENDED,
   * VENUE_RETIRED, BLOCK_OVERLAPS_BLOCK or BLOCK_BOOKING_CONFLICT; 500.
   */
  router.patch('/:id/blocks/:blockId', venueStaffOnly, async (req, res) => {
    try {
      const result = await updateVenueBlock(
        req.params.id,
        req.params.blockId,
        req.body,
        actingUser(req),
      );
      res.status(200).json(result);
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * SCRUM-17 AC4: remove a block.
   *
   * DELETE, unlike venue retirement's POST /:id/retire. Removal is also a
   * soft delete, but from the client's side the block really is gone -- it
   * leaves the list, and nothing about it can be changed again -- whereas a
   * retired venue stays readable by id. 204 because there is
   * nothing left to show.
   *
   * Statuses: 204; 400; 401; 403; 404; 409 with code BLOCK_REMOVED or
   * BLOCK_ENDED; 500.
   */
  router.delete('/:id/blocks/:blockId', venueStaffOnly, async (req, res) => {
    try {
      await removeVenueBlock(req.params.id, req.params.blockId, actingUser(req));
      res.status(204).end();
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

  /**
   * AC2: an authorised change, saved and visible to the next search.
   *
   * SCRUM-484 (AC8): 200 with the venue plus flaggedBookings -- the approved
   * bookings a setup or turnaround change flagged for review ([] when none).
   */
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
