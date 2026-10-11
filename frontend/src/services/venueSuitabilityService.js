// venueSuitabilityService.js
//
// SCRUM-191 (part of SCRUM-188). The frontend call to SCRUM-190's suitability
// check, kept beside the other service files so components never build a URL
// themselves.

import { apiClient } from "./apiClient";

/**
 * Checks one venue against one event
 * (GET /event-requests/:id/venue-suitability).
 *
 * Only the venue and the coordinator's requirement codes travel. The period
 * and expected attendance are always the stored event's, so none is sent.
 * The code lists go comma-joined (?facilities=projector,wifi), the form the
 * backend's parseCodeList reads, for the same reason findVenuesForEvent sends
 * them that way. A blank layout and empty lists are left out of the query, so
 * the server judges them "None requested".
 *
 * A venue that fails is still a 200 with suitable: false; that is an answer,
 * not an error.
 *
 * Failures, as the backend answers them: 400 with details[] (a malformed id
 * or an unknown code), 401, 403 (not an Event Coordinator, or not the event's
 * assigned one), 404 (no such event or venue), and 409 with a `code`:
 * EVENT_DATES_MISSING or VENUE_RETIRED. venueSuitabilityErrors.js words them.
 *
 * @param {string} eventRequestId
 * @param {string} venueId
 * @param {Object} [requirements]
 * @param {string} [requirements.layout]           one room layout code
 * @param {string[]} [requirements.accessibility]  accessibility feature codes
 * @param {string[]} [requirements.facilities]     facility codes
 * @returns {Promise<{suitable: boolean, criteria: Array<{criterion: string,
 *   met: boolean, detail: string, conflicts?: Array}>, checked: Object}>}
 */
export async function checkVenueSuitability(eventRequestId, venueId, requirements = {}) {
  const { layout, accessibility, facilities } = requirements ?? {};
  const params = { venueId };
  if (layout) params.layout = layout;
  if (Array.isArray(accessibility) && accessibility.length > 0) {
    params.accessibility = accessibility.join(",");
  }
  if (Array.isArray(facilities) && facilities.length > 0) {
    params.facilities = facilities.join(",");
  }

  const response = await apiClient.get(`/event-requests/${eventRequestId}/venue-suitability`, {
    params,
  });
  return response.data;
}
