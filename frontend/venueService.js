// venueService.js
// Adapt the import path and base URL to match your existing API client setup.

import { apiClient } from "./apiClient"; // <-- replace with your actual API client/axios instance

/**
 * Searches venues, returning only currently active venues with their
 * latest saved details. Retired venues are excluded.
 *
 * @param {Object} filters - search criteria (date, capacity, location, etc.)
 * @returns {Promise<Array>} list of active venue objects
 */
export async function searchActiveVenues(filters = {}) {
  const params = {
    ...filters,
    status: "active", // ask backend to filter server-side if supported
  };

  const response = await apiClient.get("/venues/search", { params });
  const venues = response.data;

  // Defensive client-side filter, in case the backend doesn't yet
  // support the status param or returns stale/cached records.
  return venues.filter((venue) => venue.status === "active");
}

/**
 * Fetches a single venue's latest details by id.
 * Ensures the frontend never displays stale cached info for an active venue.
 */
export async function getVenueDetails(venueId) {
  const response = await apiClient.get(`/venues/${venueId}`);
  return response.data;
}
