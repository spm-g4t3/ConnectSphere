/**
 * Venue catalogue service.
 *
 * SCRUM-106: create and update venue records.
 * SCRUM-110: retire a venue, and list the catalogue including retired ones.
 *
 * Writes go through the Postgres functions in 004_venue_functions.sql rather
 * than direct table calls. One venue spans five tables, and PostgREST gives
 * each supabase-js call its own request with no shared transaction -- so a
 * failure partway through would leave a half-built venue. A function body is a
 * single transaction, which removes that whole class of problem.
 *
 * Input is validated before any network call (SCRUM-94). The database
 * constraints in 002_venues.sql remain the backstop for anything validation
 * deliberately does not check -- unknown lookup codes, and writes made outside
 * this service -- and translateError turns those into typed errors.
 *
 * SCRUM-186: a venue's turnaround between events is written by create and
 * update and read back by getVenueById and findVenuesForEvent. searchVenues
 * and the list leave it out.
 *
 * SCRUM-137 (SCRUM-20): the setup time before an event follows exactly the
 * same path as turnaround -- written by create and update, read back by
 * getVenueById and findVenuesForEvent, and left out of searchVenues and the
 * list. findVenuesForEvent pads each period by the venue's setup and
 * turnaround through available_venue_ids() (SCRUM-484, below).
 *
 * SCRUM-130 (part of SCRUM-17 AC2): searchVenues leaves out venues blocked in
 * an optional date window. SCRUM-484 moved that onto available_venue_ids()
 * too, so it now leaves out booked venues as well (below).
 *
 * SCRUM-185 (SCRUM-178 AC1): searchVenues can include retired venues when
 * asked, so a retired venue's calendar is reachable. The route decides who
 * may ask.
 *
 * SCRUM-138 (SCRUM-20 AC1/AC3/AC4/AC7): findVenuesForEvent searches against
 * an event's requirements, keeping only venues that meet every supplied
 * criterion. The rule itself lives in domain/venueMatching.js; this file loads
 * the venues and checks the requested codes exist. searchVenues is untouched --
 * SCRUM-140 decides how the search page moves over.
 *
 * SCRUM-139 (SCRUM-20 AC5/AC6, Week 7): findVenuesForEvent also leaves out a
 * venue with an occupying booking or an active block overlapping the event,
 * each padded by the venue's setup and turnaround.
 *
 * SCRUM-484 (AC4): that rule used to be a JavaScript copy
 * (domain/venueOccupancy.js, read by venueOccupancyService.js). Both are
 * gone. Availability is now asked of available_venue_ids() in
 * 033_venue_occupancy_callers.sql, which calls venue_occupancy_conflicts()
 * (032) -- the same function the block writers, the booking request and the
 * calendar call. One formula, in one place, so search can never offer a venue
 * that a booking request at the same period would then refuse.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  validateCreateVenue,
  validateUpdateVenue,
  validateVenueId,
  validateSearchFilters,
  validateEventSearchCriteria,
} from '../validation/venueValidation.js';
import { DEFAULT_TURNAROUND_MINUTES } from '../domain/turnaroundOptions.js';
import { DEFAULT_SETUP_MINUTES } from '../domain/setupOptions.js';
import { matchesAllCriteria } from '../domain/venueMatching.js';
import { getBookingStatusDisplay } from '../domain/bookingStatus.js';
import { toBookingConflict } from './venueBlockService.js';

/**
 * The venue columns with every attribute joined: four join tables, flattened
 * by toVenueWithAttributes below.
 *
 * SCRUM-138: shared by getVenueById and findVenuesForEvent, so the one-venue
 * read and the search can never disagree on what a venue's attributes are.
 */
const VENUE_WITH_ATTRIBUTES_SELECT = `
      id, name, location, max_capacity, turnaround_minutes, setup_minutes,
      retired_at, created_at, updated_at, last_modified_by,
      venue_room_layouts ( room_layout_code ),
      venue_accessibility_features ( accessibility_feature_code ),
      venue_facilities ( facility_code ),
      venue_operating_hours ( day_of_week, opens_at, closes_at )
    `;

/**
 * Turn a raw Postgres error into a typed one.
 *
 * Without this the caller gets a driver message like
 * 'new row violates check constraint "venues_max_capacity_check"',
 * which says nothing useful to whoever submitted the form.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  // check constraint: capacity <= 0, closes_at <= opens_at, blank name, a
  // turnaround outside the allowed list (017), a setup time outside its own
  // list (023)
  if (code === '23514') {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // foreign key. Two very different causes, so read the constraint name out of
  // the message rather than blaming the lookup tables for both.
  if (code === '23503') {
    if (/last_modified_by/.test(detail)) {
      return new ValidationError(
        `The editing user does not exist: ${detail}`,
      );
    }
    return new ValidationError(
      `Unknown code referenced. Check the value exists in room_layouts, ` +
      `accessibility_features or facilities: ${detail}`,
    );
  }

  // unique violation: two sets of opening hours for the same day
  if (code === '23505') {
    return new ConflictError(`That record already exists: ${detail}`);
  }

  // raised by retire_venue when the venue has already been retired (005)
  if (code === 'PT409') {
    return new ConflictError(detail);
  }

  // raised by update_venue and retire_venue when the id matches nothing
  if (code === 'P0002' || /not found/i.test(detail)) {
    return new NotFoundError(detail || 'Venue not found');
  }

  return new Error(detail || 'Unexpected database error');
}

/**
 * Create a venue and everything attached to it, in one transaction.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.location
 * @param {number} input.maxCapacity
 * @param {string[]} [input.layouts]        room layout codes
 * @param {string[]} [input.accessibility]  accessibility feature codes
 * @param {string[]} [input.facilities]     facility codes
 * @param {Array<{day_of_week: number, opens_at: string, closes_at: string}>} [input.hours]
 * @param {number} [input.turnaroundMinutes]  SCRUM-186: one of 0, 15, 30, 45,
 *                                            60, 90, 120; defaults to 0 (none)
 * @param {number} [input.setupMinutes]  SCRUM-137: one of 0, 15, 30, 45, 60,
 *                                       90, 120; defaults to 0 (none)
 * @param {string|null} userId  the Venue Staff member making the change
 * @returns {Promise<object>} the created venue, fully populated
 */
export async function createVenue(input, userId = null) {
  // Throws before any network call, listing every problem at once.
  const venue = validateCreateVenue(input);

  const { data, error } = await supabase.rpc('create_venue', {
    p_name: venue.name,
    p_location: venue.location,
    p_max_capacity: venue.maxCapacity,
    p_layouts: venue.layouts ?? [],
    p_accessibility: venue.accessibility ?? [],
    p_facilities: venue.facilities ?? [],
    p_hours: venue.hours ?? [],
    p_turnaround_minutes: venue.turnaroundMinutes ?? DEFAULT_TURNAROUND_MINUTES,
    p_setup_minutes: venue.setupMinutes ?? DEFAULT_SETUP_MINUTES,
    p_user_id: userId,
  });

  if (error) throw translateError(error);

  return getVenueById(data);
}

/**
 * Update a venue.
 *
 * Omitting a field leaves it unchanged. Supplying an array REPLACES that
 * attribute set entirely, and supplying an empty array clears it -- so
 * forgetting to send facilities can never silently wipe them.
 *
 * SCRUM-186: turnaroundMinutes follows the same rule -- omitted keeps it, and
 * 0 sets it to none.
 *
 * SCRUM-137: so does setupMinutes.
 *
 * SCRUM-484 (AC8): when setup or turnaround really changes, update_venue
 * (034) re-checks the venue's approved, not-yet-started bookings in the same
 * transaction, flags any whose occupied period now overlaps another approved
 * booking or a block, and notifies each event's assigned coordinator. The
 * flagged bookings come back as flaggedBookings, shaped by toBookingConflict
 * like the block-override lists; [] when nothing was flagged (including
 * every edit that leaves both minutes alone).
 *
 * @param {string} id
 * @param {object} changes  same shape as createVenue input, all optional
 * @param {string|null} userId
 * @returns {Promise<object>} the updated venue, plus flaggedBookings
 */
export async function updateVenue(id, changes, userId = null) {
  const update = validateUpdateVenue(changes);

  const { data, error } = await supabase.rpc('update_venue', {
    p_id: id,
    p_name: update.name ?? null,
    p_location: update.location ?? null,
    p_max_capacity: update.maxCapacity ?? null,
    p_layouts: update.layouts ?? null,
    p_accessibility: update.accessibility ?? null,
    p_facilities: update.facilities ?? null,
    p_hours: update.hours ?? null,
    // ?? and never ||: NULL means "keep the current value", so || would turn
    // a change back to 0 into no change at all.
    p_turnaround_minutes: update.turnaroundMinutes ?? null,
    // Same pitfall, same fix: ?? never ||, or setting setup back to 0 would
    // silently keep the old value.
    p_setup_minutes: update.setupMinutes ?? null,
    p_user_id: userId,
  });

  if (error) throw translateError(error);

  const flaggedBookings = (data?.flagged_bookings ?? []).map(toBookingConflict);
  return { ...(await getVenueById(id)), flaggedBookings };
}

/**
 * Read one venue with all of its attributes joined.
 *
 * Retired venues are returned. AC3 requires a retired venue to stay viewable;
 * hiding them from *searches* is SCRUM-111's job, not this function's.
 *
 * SCRUM-186: includes turnaroundMinutes, which the edit form prefills from.
 * SCRUM-137: likewise setupMinutes.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getVenueById(id) {
  const { data, error } = await supabase
    .from('venues')
    .select(VENUE_WITH_ATTRIBUTES_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Venue ${id} not found`);

  return toVenueWithAttributes(data);
}

/**
 * One row of VENUE_WITH_ATTRIBUTES_SELECT, in camelCase.
 *
 * SCRUM-138: lifted out of getVenueById unchanged -- same keys, same order,
 * same sorting -- so findVenuesForEvent maps rows exactly as the one-venue
 * read does and getVenueById's result is what it was.
 *
 * Flattens the join rows into plain arrays of codes -- callers want
 * ['projector','wifi'], not [{facility_code:'projector'}, ...]. A venue with
 * none of something gets [] rather than null, because PostgREST returns an
 * empty embedded array for it (B-AC7-02).
 *
 * @param {object} data  a venues row with its four embedded join tables
 * @returns {object}
 */
function toVenueWithAttributes(data) {
  return {
    id: data.id,
    name: data.name,
    location: data.location,
    maxCapacity: data.max_capacity,
    turnaroundMinutes: data.turnaround_minutes,
    setupMinutes: data.setup_minutes,
    retiredAt: data.retired_at,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    lastModifiedBy: data.last_modified_by,
    layouts: data.venue_room_layouts.map((r) => r.room_layout_code).sort(),
    accessibility: data.venue_accessibility_features
      .map((r) => r.accessibility_feature_code).sort(),
    facilities: data.venue_facilities.map((r) => r.facility_code).sort(),
    hours: data.venue_operating_hours
      .map(({ day_of_week, opens_at, closes_at }) => ({ day_of_week, opens_at, closes_at }))
      .sort((a, b) => a.day_of_week - b.day_of_week),
  };
}

/**
 * Retire a venue.
 *
 * SCRUM-110. AC3: a retired venue no longer appears in searches, while its
 * past bookings remain viewable. This is a soft delete -- retire_venue (005)
 * stamps retired_at and never removes the row, so getVenueById still finds it
 * and anything referencing it keeps resolving.
 *
 * The editing user matters beyond bookkeeping: retire_venue writes it in the
 * same statement as retired_at so the audit trigger in 003 attributes the
 * retirement to the right Venue Staff member rather than to whoever happened
 * to edit the venue last.
 *
 * @param {string} id
 * @param {string|null} userId  the Venue Staff member retiring it
 * @returns {Promise<object>} the venue, with retiredAt now set
 * @throws {NotFoundError} no venue with that id
 * @throws {ConflictError} it was already retired
 */
export async function retireVenue(id, userId = null) {
  // Throws before any network call, so a malformed id never reaches Postgres
  // to come back as a cast error that names no field.
  validateVenueId(id);

  const { error } = await supabase.rpc('retire_venue', {
    p_id: id,
    p_user_id: userId,
  });

  if (error) throw translateError(error);

  // Read back rather than trusting the write: retired_at is set by the
  // database clock, so this is the only way to report the real timestamp.
  return getVenueById(id);
}

/**
 * Which of these venues nothing occupies during a period (SCRUM-484, AC4).
 *
 * One call to available_venue_ids() (033) for every candidate, so the rule --
 * bookings (approved or flagged_for_review) padded with the venue's setup and
 * turnaround, blocks raw, the requested period padded too, touching is clear
 * -- is decided in Postgres by venue_occupancy_conflicts() (032) and nowhere
 * else. This function only carries the answer back as a Set for the callers'
 * filters; it decides nothing.
 *
 * Shared by searchVenues and findVenuesForEvent so both searches ask the same
 * question the same way. An empty candidate list answers an empty Set without
 * a call.
 *
 * @param {string[]} venueIds  ids just read from venues
 * @param {string} startsAt    ISO 8601 with an offset, validated by the caller
 * @param {string} endsAt      ISO 8601 with an offset, validated by the caller
 * @returns {Promise<Set<string>>} the ids that are free
 * @throws {Error} a failed call, through translateError
 */
async function findAvailableVenueIds(venueIds, startsAt, endsAt) {
  if (venueIds.length === 0) return new Set();

  const { data, error } = await supabase.rpc('available_venue_ids', {
    p_venue_ids: venueIds,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
  });

  // 22P02 (invalid text representation: a bad uuid or timestamp reached the
  // cast) is the caller's input, not a server fault, so it is a 400 -- what
  // findOccupancies and findBlockedVenueIds answered before SCRUM-484 moved
  // both searches onto this call, with the same message. Mapped here rather
  // than in translateError so the other venue calls keep their exact
  // behaviour; everything else still goes through translateError.
  if (error?.code === '22P02') {
    throw new ValidationError(`A value was rejected by the database: ${error.message ?? ''}`);
  }
  if (error) throw translateError(error);

  // available_venue_ids returns table (venue_id uuid) rather than setof uuid:
  // PostgREST always answers a table result as an array of objects, while its
  // shape for a set of bare scalars is less certain. So each row is
  // { venue_id }.
  return new Set((data ?? []).map((row) => row.venue_id));
}

/**
 * Search the venue catalogue.
 *
 * SCRUM-111. AC3 again, from the other side: by default retired venues do
 * not appear here. The filter is applied once, server-side, by
 * .is('retired_at', null) -- the two partial indexes in 002 exist for exactly
 * this predicate. There is deliberately no second filter over the returned
 * rows: a duplicated rule is a rule that can disagree with itself.
 *
 * SCRUM-185 (SCRUM-178 AC1): includeRetired drops that filter and adds
 * retiredAt to each row, so a retired venue can be found and its calendar
 * opened. Only Venue Staff and Event Coordinators may set it, and the route
 * enforces that (routes/venues.js); this function trusts its caller on roles
 * like every other service here. Without the flag the query and each row's
 * keys are exactly as before.
 *
 * Attribute filters (facilities, layouts, accessibility) are not supported
 * yet. Those live in join tables and turn this into a multi-way join, which is
 * the known cost of the lookup-table design and a change worth its own ticket.
 *
 * SCRUM-130 (SCRUM-17 AC2): with a startsAt/endsAt window, venues blocked at
 * any point in it are left out.
 *
 * SCRUM-484 (AC4, decision 5): the window is now checked by
 * available_venue_ids(), the shared rule, rather than by a raw read of
 * venue_blocks. A deliberate side effect: a venue with an occupying booking
 * in the window -- including its setup and turnaround -- is now left out too,
 * exactly as findVenuesForEvent leaves it out. Keeping a blocks-only answer
 * here would have meant keeping a second, raw copy of the overlap rule, and
 * the catalogue would have offered venues that a booking request then
 * refused.
 *
 * Operating hours are still not checked. Whether a venue is open then is
 * SCRUM-20's.
 *
 * @param {object} [filters]
 * @param {string} [filters.location]     matched as a substring, case-insensitively
 * @param {number} [filters.minCapacity]  venues that seat at least this many
 * @param {string} [filters.startsAt]     SCRUM-130: ISO 8601 with an offset
 * @param {string} [filters.endsAt]       SCRUM-130: ISO 8601 with an offset
 * @param {boolean|string} [filters.includeRetired]  SCRUM-185: include retired
 *                                        venues; not with a date window
 * @returns {Promise<object[]>} active venues (retired too, each with
 *                              retiredAt, when includeRetired), ordered by
 *                              name, minus any occupied in the window
 */
export async function searchVenues(filters = {}) {
  const search = validateSearchFilters(filters);

  // SCRUM-185: two branches rather than one with a conditional column, so the
  // default search sends byte-for-byte the query it always has.
  let query = search.includeRetired
    ? supabase.from('venues').select('id, name, location, max_capacity, retired_at')
    : supabase
        .from('venues')
        .select('id, name, location, max_capacity')
        .is('retired_at', null);

  if (search.location !== undefined) {
    query = query.ilike('location', `%${search.location}%`);
  }

  if (search.minCapacity !== undefined) {
    query = query.gte('max_capacity', search.minCapacity);
  }

  const { data, error } = await query.order('name');

  if (error) throw translateError(error);

  let rows = data ?? [];

  // SCRUM-484: after the venues query, not before it as SCRUM-130's blocks
  // read was. available_venue_ids() answers for the venues it is given, so it
  // is asked only about the ones that passed location and capacity -- one
  // call, and none when nothing did. A dateless search sends exactly the
  // query it always has. Filtering keeps the name order; the Set is a
  // membership test, not a second copy of the rule.
  if (search.startsAt !== undefined && rows.length > 0) {
    const free = await findAvailableVenueIds(
      rows.map((row) => row.id),
      search.startsAt,
      search.endsAt,
    );
    rows = rows.filter((row) => free.has(row.id));
  }

  return rows.map((row) => {
    const venue = {
      id: row.id,
      name: row.name,
      location: row.location,
      maxCapacity: row.max_capacity,
    };
    // Only when asked for, so a default search's rows keep exactly their keys.
    if (search.includeRetired) venue.retiredAt = row.retired_at;
    return venue;
  });
}


/**
 * The lookup table behind each optional criterion, keyed by the criterion's
 * field name -- which is also the field an unknown code is reported under.
 */
const CRITERION_LOOKUPS = [
  { field: 'layout', table: 'room_layouts' },
  { field: 'accessibility', table: 'accessibility_features' },
  { field: 'facilities', table: 'facilities' },
];

/**
 * Refuse a search naming a layout, accessibility feature or facility that
 * does not exist.
 *
 * SCRUM-138, for SCRUM-20 B-AC1-11 to 13 (the case document's open point 2).
 * On create and update an unknown code hits a foreign key and translateError
 * names it. A search writes nothing, so there is no foreign key to hit: an
 * unknown code would simply match no venue, and the coordinator would read
 * "nothing matched" when the real fault was a typo. So it is checked here,
 * against the lookup tables, and answered with a 400 naming the code.
 *
 * Only the kinds actually supplied are read, one query each, and nothing at
 * all when no optional criterion was given. Every unknown code across every
 * kind is collected into one ValidationError, the same "every fault at once"
 * rule validation follows.
 *
 * @param {object} criteria  validated, so optional keys are present only when
 *                           they hold something to check
 * @throws {ValidationError} details [{ field, message: 'unknown code "x"' }]
 */
async function assertKnownCodes(criteria) {
  const details = [];

  for (const { field, table } of CRITERION_LOOKUPS) {
    if (criteria[field] === undefined) continue;

    // layout is one code, the others lists; a Set also stops a code repeated
    // in the request from being reported twice.
    const requested = [...new Set([criteria[field]].flat())];

    const { data, error } = await supabase
      .from(table)
      .select('code')
      .in('code', requested);

    if (error) throw translateError(error);

    const known = new Set((data ?? []).map((row) => row.code));
    for (const code of requested) {
      if (!known.has(code)) details.push({ field, message: `unknown code "${code}"` });
    }
  }

  if (details.length > 0) {
    const summary = details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid venue search -- ${summary}`, details);
  }
}

/**
 * Search for venues that can host an event.
 *
 * SCRUM-138, for SCRUM-20:
 *  - AC1: the event's period and expected attendance are required; layout,
 *    accessibility features and facilities are optional, and an optional
 *    criterion left out is not filtered on. SCRUM-141 adds an optional
 *    location, matched in matchesAllCriteria like the rest.
 *  - AC3/AC4: a venue is returned only if it meets every supplied criterion
 *    -- domain/venueMatching.js's matchesAllCriteria, which answers yes or no
 *    and never why.
 *  - AC7: each result carries name, location, maximum capacity, layouts,
 *    accessibility features and facilities, plus the id to book it by.
 *
 * Retired venues are never returned: .is('retired_at', null) in the query, the
 * predicate 002's partial indexes exist for, as in searchVenues (SCRUM-111).
 *
 * Why load every active venue and filter in JavaScript rather than in the
 * query: the rule then has exactly one home, matchesAllCriteria, which every
 * boundary case can test without a database (CI has none). Pushing half of it
 * into PostgREST would split it across two languages that could drift, and
 * the hours check -- a Singapore weekday and wall-clock time derived from the
 * request -- does not translate into a PostgREST filter at all. The catalogue
 * is small, so the cost is one query returning a few dozen rows. If it grows,
 * the first optimisation is a capacity pre-filter, .gte('max_capacity', ...),
 * which is safe because it can only remove venues the rule would remove too.
 *
 * SCRUM-139 (AC5/AC6, Week 7): a venue that passes the attributes is then
 * kept only if no occupying booking or active block overlaps the event once
 * setup and turnaround are added.
 *
 * SCRUM-484 (AC4): that question is now asked of available_venue_ids() (033),
 * which calls the shared venue_occupancy_conflicts() (032), instead of
 * SCRUM-139's JavaScript copy of the rule. Attributes first, so availability
 * is asked only for venues still in the running, in one call for all of them
 * -- and not at all when none are. The answer is a set of ids, yes or no per
 * venue, never why, as SCRUM-145 requires. Each result still carries
 * setupMinutes and turnaroundMinutes, and hours so a result can show when the
 * venue is open.
 *
 * Why the attribute rule stays in JavaScript while the period rule moved:
 * matchesAllCriteria is used by nothing but search, so it has one home
 * already. The period rule is also enforced by the block writers and the
 * booking request inside their transactions, which can only call SQL, so SQL
 * is the one place it can live once.
 *
 * @param {object} criteria  see validateEventSearchCriteria
 * @returns {Promise<object[]>} matching active venues, ordered by name, each
 *   { id, name, location, maxCapacity, layouts, accessibility, facilities,
 *     hours, setupMinutes, turnaroundMinutes }; [] when nothing matches
 * @throws {ValidationError} a malformed request or an unknown code, before
 *   the venues are read
 * @throws {Error} a failed availability call (SCRUM-484), through
 *   translateError
 */
export async function findVenuesForEvent(criteria) {
  const search = validateEventSearchCriteria(criteria);
  await assertKnownCodes(search);

  const { data, error } = await supabase
    .from('venues')
    .select(VENUE_WITH_ATTRIBUTES_SELECT)
    .is('retired_at', null)
    .order('name');

  if (error) throw translateError(error);

  const candidates = (data ?? [])
    .map(toVenueWithAttributes)
    .filter((venue) => matchesAllCriteria(venue, search));

  if (candidates.length === 0) return [];

  const free = await findAvailableVenueIds(
    candidates.map((venue) => venue.id),
    search.startsAt,
    search.endsAt,
  );

  return candidates
    .filter((venue) => free.has(venue.id))
    .map((venue) => ({
      id: venue.id,
      name: venue.name,
      location: venue.location,
      maxCapacity: venue.maxCapacity,
      layouts: venue.layouts,
      accessibility: venue.accessibility,
      facilities: venue.facilities,
      hours: venue.hours,
      setupMinutes: venue.setupMinutes,
      turnaroundMinutes: venue.turnaroundMinutes,
    }));
}


/**
 * The whole venue catalogue, retired venues included.
 *
 * SCRUM-110. AC3 from the staff side: searchVenues directly above is the same
 * read with .is('retired_at', null) on it, and this one deliberately has no
 * such filter. The people who retire venues are the one audience that still
 * needs to see them -- without this list a venue would vanish from the only
 * view its owners have the moment they retired it, and they could never tell
 * a retirement from a deletion.
 *
 * That missing filter is precisely why the route over this function is Venue
 * Staff only. SCRUM-111's invariant is that a retired venue never reaches a
 * list a non-staff caller can obtain, and the role gate is what keeps
 * /venues/search the only such list.
 *
 * No parameters and no validation, on purpose. There is no path param, no
 * body and no query string to check. Filters here would mean calling
 * SCRUM-111's validateSearchFilters and would leave two filtered reads over
 * the same table that a caller could mistake for one another, so
 * venueValidation.js is untouched by this story.
 *
 * The select is searchVenues' shape plus the one column that is the point,
 * not getVenueById's join select: four join tables per venue across the whole
 * catalogue is a far heavier query for data no row in a listing renders.
 *
 * There is no pagination. The whole table comes back, which is fine at the
 * scale this runs at today and is its own ticket when it stops being.
 *
 * @returns {Promise<object[]>} every venue, active and retired, ordered by
 *                              name; retiredAt is null on an active one
 */
export async function listVenues() {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, location, max_capacity, retired_at')
    .order('name');

  if (error) throw translateError(error);

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    location: row.location,
    maxCapacity: row.max_capacity,
    retiredAt: row.retired_at,
  }));
}


/**
 * A venue's change history, newest first.
 *
 * SCRUM-15 AC4: "every change records the editing user, a timestamp, and the
 * previous values." The trigger in 003 and the functions in 008 write those
 * rows; without this they could not be read back, which left the last third of
 * AC4 -- being able to see the previous values at all -- unmet.
 *
 * The venue is deliberately not checked for existence first. A venue with no
 * history and a venue that never existed both answer with an empty list: a
 * NotFoundError here would need an extra round trip to say something the
 * caller can already tell from GET /venues/:id.
 *
 * old_values and new_values are returned as they were stored. They hold only
 * the fields that differed, so their shape varies row to row by design -- an
 * attribute change carries arrays, a scalar change carries scalars, and a
 * creation carries an empty old_values.
 *
 * @param {string} venueId
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when the id is malformed, before any network call
 */
export async function getVenueHistory(venueId) {
  validateVenueId(venueId);

  const { data, error } = await supabase
    .from('venue_change_history')
    .select('id, venue_id, changed_by, changed_at, old_values, new_values')
    .eq('venue_id', venueId)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw translateError(error);

  return (data ?? []).map((row) => ({
    id: row.id,
    venueId: row.venue_id,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
    oldValues: row.old_values,
    newValues: row.new_values,
  }));
}


/**
 * The bookings held against a venue, most recent first.
 *
 * SCRUM-15 AC3, the half that retirement alone cannot demonstrate: "a venue
 * can be retired ... while its past bookings remain viewable."
 *
 * There is deliberately no filter on the venue's retired_at. That is the whole
 * point -- a retired venue's bookings must still be readable, or retirement
 * would be a delete wearing a different name. The same reasoning is why
 * getVenueById returns retired venues.
 *
 * Reads the provisional bookings table from 009. The booking story owns that
 * table and this function will grow with it.
 *
 * @param {string} venueId
 * @returns {Promise<object[]>} possibly empty, in camelCase
 * @throws {ValidationError} when the id is malformed, before any network call
 */
export async function getBookingsForVenue(venueId) {
  validateVenueId(venueId);

  const { data, error } = await supabase
    .from('bookings')
    .select('id, venue_id, event_request_id, starts_at, ends_at, status, created_at')
    .eq('venue_id', venueId)
    .order('starts_at', { ascending: false });

  if (error) throw translateError(error);

  return (data ?? []).map((row) => ({
    id: row.id,
    venueId: row.venue_id,
    eventRequestId: row.event_request_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    // SCRUM-243: a row here may be a venue booking request (pending, rejected,
    // withdrawn) and not only a hold, so the status travels with it.
    status: row.status,
    statusDisplay: getBookingStatusDisplay(row.status),
    createdAt: row.created_at,
  }));
}
