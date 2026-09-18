// venueService.js
// Matches the real backend contract:
//   - GET /venues/search returns ALREADY-active-only venues
//     (backend filters retired_at IS NULL server-side — see searchVenues()
//     in backend/src/services/venueService.js)
//   - Response rows: { id, name, location, maxCapacity } — no `status` field
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

/** @returns {Promise<Array>} always empty for now */
export async function getVenueCatalogue() {
  console.warn("getVenueCatalogue: not implemented yet — no backend endpoint exists.");
  return [];
}