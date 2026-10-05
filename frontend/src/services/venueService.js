// venueService.js
// Matches the real backend contract:
//   - GET /venues returns the WHOLE catalogue, retired venues included.
//     Venue Staff only, for exactly that reason (SCRUM-110) — it is the one
//     venue list in the API that a retired venue can appear in.
//   - GET /venues/search returns ALREADY-active-only venues
//     (backend filters retired_at IS NULL server-side — see searchVenues()
//     in backend/src/services/venueService.js), unless includeRetired=true
//     (SCRUM-185, for SCRUM-178 AC1): Venue Staff and Event Coordinators
//     only (403 otherwise), never with a date window (400), and each row then
//     carries retiredAt.
//   - POST /venues/:id/retire retires one venue. Venue Staff only, and
//     one-way: 005_venue_retirement.sql defines no un-retire.
//   - Response rows: { id, name, location, maxCapacity }, plus retiredAt on
//     the catalogue listing — and no `status` field. `status` is not a
//     backend concept anywhere in this API, so nothing should read one.
//   - Supported filters: location (substring, case-insensitive), minCapacity,
//     and an optional startsAt/endsAt window -- both or neither -- that drops
//     venues blocked during it (SCRUM-130). Bookings are not considered.
//   - /venues/:id/blocks lists, creates, changes and removes venue blocks.
//     Venue Staff and Event Coordinators may list them (SCRUM-130); every
//     write is Venue Staff only (SCRUM-127), and so is reading one block's
//     change history (SCRUM-131). See the block section below.
//   - /venues/:id/calendar merges a venue's bookings and blocks over a
//     required window (SCRUM-179), for the venue calendar (SCRUM-178).

import { apiClient } from "./apiClient"; // <-- replace with your actual API client

/**
 * Searches active venues. Retired venues are left out by the backend, so
 * there's nothing to filter client-side -- unless includeRetired is set
 * (SCRUM-185), which returns them too, each row with retiredAt (ISO or null).
 * Only Venue Staff and Event Coordinators may set it (403 otherwise), and not
 * together with a window (400 naming includeRetired). It is sent only when
 * true, so a default search is exactly the request it always was.
 *
 * With startsAt and endsAt (SCRUM-130), venues with a block overlapping the
 * half-open window [startsAt, endsAt) are left out too; a block that only
 * touches an edge does not count. Send both or neither -- one alone is a 400
 * naming the missing field in details[]. Each date is omitted from the query
 * when unset, so a dateless search is exactly the request it always was.
 *
 * @param {Object} filters
 * @param {string} [filters.location]     substring match, case-insensitive
 * @param {number} [filters.minCapacity]  minimum seats needed
 * @param {string} [filters.startsAt]     ISO with an explicit offset
 * @param {string} [filters.endsAt]       ISO with an explicit offset, after startsAt
 * @param {boolean} [filters.includeRetired]  also return retired venues
 * @returns {Promise<Array<{id, name, location, maxCapacity, retiredAt?}>>}
 */
export async function searchActiveVenues(filters = {}) {
  const params = {};
  if (filters.location) params.location = filters.location;
  if (filters.minCapacity) params.minCapacity = filters.minCapacity;
  if (filters.startsAt) params.startsAt = filters.startsAt;
  if (filters.endsAt) params.endsAt = filters.endsAt;
  if (filters.includeRetired === true) params.includeRetired = true;

  const response = await apiClient.get("/venues/search", { params });
  return response.data;
}

/**
 * Fetches a single venue's full details by id, including retired ones —
 * the backend intentionally still returns retired venues by id so past
 * bookings referencing them stay viewable.
 *
 * Carries turnaroundMinutes (SCRUM-186), a number -- 0 means none. Only this
 * endpoint returns it; search and the catalogue list do not.
 *
 * Carries setupMinutes (SCRUM-137) the same way: a number, 0 means none, and
 * only this endpoint returns it.
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
 * @param {number} [input.turnaroundMinutes] one of 0, 15, 30, 45, 60, 90, 120 (SCRUM-186); 0 when omitted
 * @param {number} [input.setupMinutes]      one of 0, 15, 30, 45, 60, 90, 120 (SCRUM-137); 0 when omitted
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
 * bookings are exactly what this exists to serve.
 *
 * Venue Staff and Event Coordinators only (SCRUM-182), the same roles as the
 * venue calendar, which shows these same bookings. Any other signed-in role
 * gets a 403: before SCRUM-182 this was open to every authenticated user, a
 * side door around the calendar's gate. Wider than getVenueHistory, which is
 * Venue Staff only.
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

// --- Venue blocks (SCRUM-127, part of SCRUM-17) ---------------------------
// Five calls: list, create, update, remove, and one block's history
// (SCRUM-131). Listing is open to Venue Staff and Event Coordinators
// (SCRUM-130); the three writes and the history are Venue Staff only. A block row is { id, venueId, startsAt,
// endsAt, reason, notes, createdBy, createdAt, lastModifiedBy, updatedAt,
// removedAt, removedBy }; the *By fields are unjoined uuids, like
// getVenueHistory's changedBy.
//
// The server's `error` string on these routes is database prose that carries
// raw uuids, so callers should map status and `code` to their own words
// (venueBlockErrors.js) and render only details[].message from a 400.

/**
 * One venue's blocks: every block not removed, ended ones included, so the
 * list doubles as a record of past closures.
 *
 * With from and to (SCRUM-130), only blocks overlapping the half-open window
 * [from, to) come back -- ended ones inside it included, because a calendar
 * shows the past too. Both or neither, and at most 400 days apart; otherwise
 * a 400 with details[] on `from`/`to`.
 *
 * Readable by Venue Staff and Event Coordinators; anyone else gets a 403.
 *
 * Failures: 400 (the id is not a uuid, or a bad window), 401, 403, 404 (no
 * such venue).
 *
 * @param {string} venueId
 * @param {Object} [window]
 * @param {string} [window.from]  ISO with an explicit offset
 * @param {string} [window.to]    ISO with an explicit offset, after from
 * @returns {Promise<Array<Object>>} block rows
 */
export async function listVenueBlocks(venueId, { from, to } = {}) {
  const path = `/venues/${venueId}/blocks`;
  const params = {};
  if (from) params.from = from;
  if (to) params.to = to;

  // No second argument at all without a window, so the unwindowed call is
  // byte-for-byte the one VenueBlocksPanel has always made.
  const response =
    Object.keys(params).length === 0
      ? await apiClient.get(path)
      : await apiClient.get(path, { params });
  return response.data;
}

/**
 * One venue's calendar (SCRUM-178, served by SCRUM-179): its approved and
 * flagged bookings and its active blocks overlapping the half-open window
 * [from, to), merged into one array sorted by start. Each entry is either
 *   { kind: 'booking', id, startsAt, endsAt, status, eventRequestId, eventName }
 * with status 'approved' or 'flagged_for_review', or
 *   { kind: 'block', id, startsAt, endsAt, reason, notes }.
 * An empty window is 200 [].
 *
 * Unlike listVenueBlocks the window is REQUIRED -- a calendar always shows a
 * range -- and at most 400 days long. Both ends need an explicit offset; axios
 * encodes the '+' in one as %2B, which the backend asks for.
 *
 * Readable by Venue Staff and Event Coordinators, retired venues included.
 *
 * Failures: 400 (the id is not a uuid, or the window is missing, one-sided,
 * malformed, reversed or over 400 days), 401, 403 (any other role), 404 (no
 * such venue), 500.
 *
 * @param {string} venueId
 * @param {Object} window
 * @param {string} window.from  ISO with an explicit offset
 * @param {string} window.to    ISO with an explicit offset, after from
 * @returns {Promise<Array<Object>>} calendar entries, soonest first
 */
export async function getVenueCalendar(venueId, { from, to }) {
  const response = await apiClient.get(`/venues/${venueId}/calendar`, {
    params: { from, to },
  });
  return response.data;
}

/**
 * Blocks a venue for a period (SCRUM-17, AC1 and AC3).
 *
 * A block over approved bookings is refused with a 409 BLOCK_BOOKING_CONFLICT
 * whose `conflicts` lists them. Resending with confirmOverride: true and the
 * bookingIds the user saw in acknowledgedBookingIds creates the block and
 * flags those bookings; if a new booking has arrived since, the 409 comes back
 * with the fresh list instead.
 *
 * Failures: 400 with details[] (every bad field at once, including mismatched
 * override fields), 401, 403, 404 (no such venue), and 409 with `code`:
 * BLOCK_BOOKING_CONFLICT, BLOCK_OVERLAPS_BLOCK (`conflicts` is [{ blockId }])
 * or VENUE_RETIRED.
 *
 * @param {string} venueId
 * @param {Object} input
 * @param {string} input.startsAt   ISO with an explicit offset
 * @param {string} input.endsAt     ISO with an explicit offset, in the future
 * @param {string} input.reason     a venue_block_reason code
 * @param {string} [input.notes]    required when reason is "other"
 * @param {boolean} [input.confirmOverride]
 * @param {string[]} [input.acknowledgedBookingIds]
 * @returns {Promise<{block: Object, flaggedBookings: Array<{bookingId, eventRequestId, eventName, startsAt, endsAt}>}>}
 */
export async function createVenueBlock(venueId, input) {
  const response = await apiClient.post(`/venues/${venueId}/blocks`, input);
  return response.data;
}

/**
 * Shortens, extends or otherwise changes a block (SCRUM-17, AC4).
 *
 * Send only what changed: an omitted field is kept, and `notes: null` clears
 * the notes. The override fields work as they do on create, and only bookings
 * the new period newly overlaps count as conflicts -- ones this block already
 * flagged are no longer approved.
 *
 * Failures: 400 with details[] (including an empty change set), 401, 403, 404
 * (no such venue, or the block is on another venue), and 409 with `code`:
 * BLOCK_BOOKING_CONFLICT, BLOCK_OVERLAPS_BLOCK, VENUE_RETIRED, BLOCK_REMOVED
 * or BLOCK_ENDED (ended blocks are read-only).
 *
 * @param {string} venueId
 * @param {string} blockId
 * @param {Object} changes  createVenueBlock's input, every field optional
 * @returns {Promise<{block: Object, flaggedBookings: Array<Object>}>}
 */
export async function updateVenueBlock(venueId, blockId, changes) {
  const response = await apiClient.patch(`/venues/${venueId}/blocks/${blockId}`, changes);
  return response.data;
}

/**
 * Removes a block (SCRUM-17, AC4). A soft delete: the row keeps removedAt and
 * removedBy, and bookings it flagged stay flagged for a Coordinator to resolve.
 *
 * Resolves undefined, because the 204 has no body to return.
 *
 * Failures: 400 (an id is not a uuid), 401, 403, 404, and 409 with `code`
 * BLOCK_REMOVED or BLOCK_ENDED. There is no VENUE_RETIRED here: removing a
 * block only reduces blocking.
 *
 * @param {string} venueId
 * @param {string} blockId
 * @returns {Promise<void>}
 */
export async function removeVenueBlock(venueId, blockId) {
  await apiClient.delete(`/venues/${venueId}/blocks/${blockId}`);
}

/**
 * One block's change history, newest first (SCRUM-131; SCRUM-17 AC4: "with
 * the creating or amending user and timestamp recorded").
 *
 * Venue Staff only, like getVenueHistory -- the trail keeps superseded notes,
 * and coordinators already see a block's current state. A 403 means the
 * caller is not staff, not that anything is broken.
 *
 * Shape: { id, blockId, action, changedBy, changedAt, oldValues, newValues }.
 * Conventions a renderer has to know:
 *   - `action` is "created", "amended" or "removed".
 *   - oldValues/newValues are raw jsonb, snake_case (starts_at, ends_at,
 *     reason, notes, ...). A created entry has oldValues {} and the whole new
 *     row; the others hold ONLY the keys that differed.
 *   - `changedBy` is an unjoined uuid, or null for a change made outside the
 *     application. No endpoint resolves it to a name.
 *   - A save that changed nothing writes no entry.
 *
 * A removed block's history is still readable, if its id is known.
 *
 * Failures: 400 (an id is not a uuid), 401, 403, 404 (no such block on this
 * venue).
 *
 * @param {string} venueId
 * @param {string} blockId
 * @returns {Promise<Array<{id, blockId, action, changedBy, changedAt, oldValues, newValues}>>}
 */
export async function getVenueBlockHistory(venueId, blockId) {
  const response = await apiClient.get(`/venues/${venueId}/blocks/${blockId}/history`);
  return response.data;
}

// --- STUB below: no backend endpoint exists yet for this ------------------
// It exists purely so the import in VenueStaffDashboard.jsx resolves and the
// app can actually run. Its Coordinator twin was removed by SCRUM-128, when
// CoordinatorNotifications took the section that called it.

/** @returns {Promise<Array>} always empty for now */
export async function getPendingBookingRequests() {
  console.warn("getPendingBookingRequests: not implemented yet — no backend endpoint exists.");
  return [];
}
