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
 * Input validation belongs to SCRUM-94. For now the database constraints from
 * 002_venues.sql are the backstop, and this module translates the resulting
 * Postgres error codes into something a caller can act on.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';

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

  // foreign key: a layout / facility / accessibility code that does not exist
  if (code === '23503') {
    return new ValidationError(
      `Unknown code referenced. Check the value exists in room_layouts, ` +
      `accessibility_features or facilities: ${detail}`,
    );
  }

  // unique violation: two sets of opening hours for the same day
  if (code === '23505') {
    return new ConflictError(`That record already exists: ${detail}`);
  }

  // raised by update_venue when the id matches nothing
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
  const { data, error } = await supabase.rpc('create_venue', {
    p_name: input.name,
    p_location: input.location,
    p_max_capacity: input.maxCapacity,
    p_layouts: input.layouts ?? [],
    p_accessibility: input.accessibility ?? [],
    p_facilities: input.facilities ?? [],
    p_hours: input.hours ?? [],
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
  const { error } = await supabase.rpc('update_venue', {
    p_id: id,
    p_name: changes.name ?? null,
    p_location: changes.location ?? null,
    p_max_capacity: changes.maxCapacity ?? null,
    p_layouts: changes.layouts ?? null,
    p_accessibility: changes.accessibility ?? null,
    p_facilities: changes.facilities ?? null,
    p_hours: changes.hours ?? null,
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
