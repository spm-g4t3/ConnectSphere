/**
 * Venue catalogue service.
 *
 * SCRUM-106: create and update venue records.
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
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  validateCreateVenue,
  validateUpdateVenue,
  validateVenueId,
  validateSearchFilters,
} from '../validation/venueValidation.js';

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

  // check constraint: capacity <= 0, closes_at <= opens_at, blank name
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
 * @param {string} id
 * @param {object} changes  same shape as createVenue input, all optional
 * @param {string|null} userId
 * @returns {Promise<object>} the updated venue
 */
export async function updateVenue(id, changes, userId = null) {
  const update = validateUpdateVenue(changes);

  const { error } = await supabase.rpc('update_venue', {
    p_id: id,
    p_name: update.name ?? null,
    p_location: update.location ?? null,
    p_max_capacity: update.maxCapacity ?? null,
    p_layouts: update.layouts ?? null,
    p_accessibility: update.accessibility ?? null,
    p_facilities: update.facilities ?? null,
    p_hours: update.hours ?? null,
    p_user_id: userId,
  });

  if (error) throw translateError(error);

  return getVenueById(id);
}

/**
 * Read one venue with all of its attributes joined.
 *
 * Retired venues are returned. AC3 requires a retired venue to stay viewable;
 * hiding them from *searches* is SCRUM-111's job, not this function's.
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getVenueById(id) {
  const { data, error } = await supabase
    .from('venues')
    .select(`
      id, name, location, max_capacity, retired_at,
      created_at, updated_at, last_modified_by,
      venue_room_layouts ( room_layout_code ),
      venue_accessibility_features ( accessibility_feature_code ),
      venue_facilities ( facility_code ),
      venue_operating_hours ( day_of_week, opens_at, closes_at )
    `)
    .eq('id', id)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Venue ${id} not found`);

  // Flatten the join rows into plain arrays of codes -- callers want
  // ['projector','wifi'], not [{facility_code:'projector'}, ...].
  return {
    id: data.id,
    name: data.name,
    location: data.location,
    maxCapacity: data.max_capacity,
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
 * Search the venue catalogue.
 *
 * SCRUM-111. AC3 again, from the other side: retired venues must not appear
 * here. The filter is applied once, server-side, by .is('retired_at', null) --
 * the two partial indexes in 002 exist for exactly this predicate. There is
 * deliberately no second filter over the returned rows: a duplicated rule is a
 * rule that can disagree with itself, and the caller cannot opt out of this
 * one anyway.
 *
 * Attribute filters (facilities, layouts, accessibility) are not supported
 * yet. Those live in join tables and turn this into a multi-way join, which is
 * the known cost of the lookup-table design and a change worth its own ticket.
 *
 * @param {object} [filters]
 * @param {string} [filters.location]     matched as a substring, case-insensitively
 * @param {number} [filters.minCapacity]  venues that seat at least this many
 * @returns {Promise<object[]>} active venues, ordered by name
 */
export async function searchVenues(filters = {}) {
  const search = validateSearchFilters(filters);

  let query = supabase
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

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    location: row.location,
    maxCapacity: row.max_capacity,
  }));
}
