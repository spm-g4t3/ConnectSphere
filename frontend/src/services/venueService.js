// venueService.js
// Matches the real backend contract:
//   - GET /venues returns the WHOLE catalogue, retired venues included.
//     Venue Staff only, for exactly that reason (SCRUM-110) — it is the one
//     venue list in the API that a retired venue can appear in.
//   - GET /venues/search returns ALREADY-active-only venues
//     (backend filters retired_at IS NULL server-side — see searchVenues()
//     in backend/src/services/venueService.js)
//   - POST /venues/:id/retire retires one venue. Venue Staff only, and
//     one-way: 005_venue_retirement.sql defines no un-retire.
//   - Response rows: { id, name, location, maxCapacity }, plus retiredAt on
//     the catalogue listing — and no `status` field. `status` is not a
//     backend concept anywhere in this API, so nothing should read one.
//   - Supported filters: location (substring, case-insensitive), minCapacity

import { apiClient } from "./apiClient"; // <-- replace with your actual API client

/**
 * Searches active venues. Retired venues are never returned — the backend
 * enforces that unconditionally, so there's nothing to filter client-side.
 *
 * @param {Object} filters
 * @param {string} [filters.location]     substring match, case-insensitive
 * @param {number} [filters.minCapacity]  minimum seats needed
 * @returns {Promise<Array<{id, name, location, maxCapacity}>>}
 */
export async function searchActiveVenues(filters = {}) {
  const params = {};
  if (filters.location) params.location = filters.location;
  if (filters.minCapacity) params.minCapacity = filters.minCapacity;

  const response = await apiClient.get("/venues/search", { params });
  return response.data;
}

/**
 * Fetches a single venue's full details by id, including retired ones —
 * the backend intentionally still returns retired venues by id so past
 * bookings referencing them stay viewable.
 */
export async function getVenueDetails(venueId) {
  const response = await apiClient.get(`/venues/${venueId}`);
  return response.data;
}

/**
 * The whole venue catalogue, active and retired together (SCRUM-110).
 *
 * This is the staff view, not search: searchActiveVenues above cannot show a
 * retired venue and does not even select the column, so it could never label
 * one. Each row carries retiredAt — null while the venue is active — which is
 * the only signal of retirement the API gives. There is deliberately no
 * `status` string to key off.
 *
 * Venue Staff only server-side: a 403 here means the signed-in user is not
 * Venue Staff, not that anything is broken.
 *
 * Unpaginated — the backend returns the whole table, ordered by name.
 *
 * @returns {Promise<Array<{id, name, location, maxCapacity, retiredAt}>>}
 */
export async function getVenueCatalogue() {
  const response = await apiClient.get("/venues");
  return response.data;
}

/**
 * Retires one venue, so it stops appearing in searches while its past
 * bookings stay viewable (SCRUM-110, AC3).
 *
 * One-way. There is no un-retire endpoint, so callers should confirm before
 * calling this rather than offering an undo they cannot honour.
 *
 * Returns the full venue — getVenueById's shape, not the flat catalogue row —
 * with retiredAt now set from the database clock. Callers that render the
 * catalogue should refetch rather than splice this in, or the list ends up
 * holding two different row shapes.
 *
 * Failures worth telling apart: 409 means it was already retired, 404 that no
 * such venue exists, 403 that the caller is not Venue Staff, 400 that the id
 * is not a uuid.
 *
 * The empty body is deliberate. The route ignores it, but sending one keeps
 * axios applying the instance's Content-Type, the same way AuthContext's
 * logout call does.
 *
 * @param {string} venueId
 * @returns {Promise<Object>} the venue, with retiredAt set
 */
export async function retireVenue(venueId) {
  const response = await apiClient.post(`/venues/${venueId}/retire`, {});
  return response.data;
}

/**
 * Creates a venue (SCRUM-15, AC1). Venue Staff only.
 *
 * Returns the FAT shape -- getVenueById's, the same one retireVenue answers
 * with, because routes/venues.js:233 returns createVenue's result and the
 * service ends on `return getVenueById(data)`. It is NOT the flat five-field
 * catalogue row, so a caller rendering the catalogue must refetch rather than
 * push this object into the list; see retireVenue's docblock for why mixing
 * the two shapes in one array goes wrong.
 *
 * `hours` uses the database's snake_case keys, not this file's camelCase. That
 * is the wire contract: venueValidation.checkHours reads day_of_week, opens_at
 * and closes_at off each entry and getVenueById hands the same keys straight
 * back, so translating them here would only have to be undone on the way in.
 * day_of_week is 0 = Sunday, matching Date.getDay() (002_venues.sql:50).
 *
 * maxCapacity must be a real number. venueValidation.js:92 rejects "40" rather
 * than coercing it, so a form holding capacity as a string has to convert
 * before calling this.
 *
 * Failures: 400 with a details[] naming every bad field at once (the validator
 * collects rather than throws on the first), 401, 403 for a non-staff caller,
 * 500. A layout/facility/accessibility code that does not exist in the lookup
 * tables is also a 400 -- the foreign key fires and the service translates it.
 *
 * @param {Object} input
 * @param {string} input.name
 * @param {string} input.location
 * @param {number} input.maxCapacity        positive whole number
 * @param {string[]} [input.layouts]        room layout codes
 * @param {string[]} [input.accessibility]  accessibility feature codes
 * @param {string[]} [input.facilities]     facility codes
 * @param {Array<{day_of_week: number, opens_at: string, closes_at: string}>} [input.hours]
 * @returns {Promise<Object>} the created venue, fully populated
 */
export async function createVenue(input) {
  const response = await apiClient.post("/venues", input);
  return response.data;
}

/**
 * Updates a venue (SCRUM-15, AC2). Venue Staff only.
 *
 * Returns the same fat shape createVenue does, for the same reason.
 *
 * THE TRAP, and the reason callers must send a diff rather than the whole
 * form: omitting a field leaves it unchanged, but supplying an ARRAY REPLACES
 * that attribute set outright and an empty array clears it. So a form that
 * re-sends `facilities` on every save silently deletes any facility code it
 * failed to render -- an unknown code, a code added after the page loaded.
 * Send only what actually changed.
 *
 * An empty change set is a 400, not a no-op: validateUpdateVenue:240 refuses
 * it before any round trip. A caller that diffs properly never triggers this,
 * which is the point -- it only ever catches a caller bug.
 *
 * There is no retirement check server-side (update_venue has none), so a PATCH
 * against a retired venue succeeds. Keeping Edit disabled on a retired row is
 * a client-side courtesy, not an enforced rule.
 *
 * Failures: 400 (bad id, empty change set, field faults with details[]), 401,
 * 403, 404, 500.
 *
 * @param {string} venueId
 * @param {Object} changes  createVenue's shape, every field optional
 * @returns {Promise<Object>} the updated venue, fully populated
 */
export async function updateVenue(venueId, changes) {
  const response = await apiClient.patch(`/venues/${venueId}`, changes);
  return response.data;
}

/**
 * The bookings held against one venue, most recent first (SCRUM-110, AC3's
 * second clause: "while its past bookings remain viewable").
 *
 * Deliberately NOT gated on the venue being active -- a retired venue's
 * bookings are exactly what this exists to serve. Any authenticated user may
 * call it; unlike getVenueHistory there is no staff-only gate.
 *
 * Rows join nothing. The service selects six columns and none of them is a
 * name, so eventRequestId arrives as a bare uuid with no event name attached;
 * render it as an identifier, not as a label.
 *
 * The id is validated inside the *service* (getBookingsForVenue calls
 * validateVenueId before any round trip), not at the route, so a malformed
 * uuid is a 400 carrying details[] rather than a 500.
 *
 * A 500 here most likely means the `bookings` table does not exist: 009 is a
 * hand-run migration, and a missing table falls past every branch of
 * translateError into a generic 500. Say so to the user rather than reporting
 * a system working as built as a breakage.
 *
 * @param {string} venueId
 * @returns {Promise<Array<{id, venueId, eventRequestId, startsAt, endsAt, createdAt}>>}
 */
export async function getVenueBookings(venueId) {
  const response = await apiClient.get(`/venues/${venueId}/bookings`);
  return response.data;
}

/**
 * One venue's change history, newest first (SCRUM-15, AC4: "every change
 * records the editing user, a timestamp, and the previous values").
 *
 * Venue Staff only -- a 403 means the caller is not staff, not that anything
 * is broken.
 *
 * Shape: { id, venueId, changedBy, changedAt, oldValues, newValues }, where
 * oldValues/newValues are raw jsonb objects holding ONLY the keys that
 * differed. Two conventions a renderer has to know:
 *   - `oldValues` of {} means the venue was created (008_venue_audit_completion
 *     .sql:34), not that nothing changed.
 *   - `changedBy` is an unjoined uuid, or null for a change made outside the
 *     application (008:14-15). No endpoint resolves it to a name.
 *
 * One save can produce up to TWO rows -- one for the scalar columns from 003's
 * trigger, one for the attribute sets from 008's function -- sharing a
 * changedBy and near-identical changedAt values. That is by design, not a
 * duplicate.
 *
 * Like bookings, the id is validated in the service, so a bad uuid is a 400.
 *
 * @param {string} venueId
 * @returns {Promise<Array<{id, venueId, changedBy, changedAt, oldValues, newValues}>>}
 */
export async function getVenueHistory(venueId) {
  const response = await apiClient.get(`/venues/${venueId}/history`);
  return response.data;
}

// --- STUBS below: no backend endpoint exists yet for these -----------------
// They exist purely so imports in EventCoordinatorDashboard.jsx and
// VenueStaffDashboard.jsx resolve and the app can actually run.

/** @returns {Promise<Array>} always empty for now */
export async function getPendingVenueBookings() {
  console.warn("getPendingVenueBookings: not implemented yet — no backend endpoint exists.");
  return [];
}

/** @returns {Promise<Array>} always empty for now */
export async function getPendingBookingRequests() {
  console.warn("getPendingBookingRequests: not implemented yet — no backend endpoint exists.");
  return [];
}
