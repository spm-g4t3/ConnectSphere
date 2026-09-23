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
