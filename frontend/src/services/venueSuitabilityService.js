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
 * EVENT_DATES_MISSING, EVENT_ATTENDANCE_MISSING or VENUE_RETIRED.
 * venueSuitabilityErrors.js words them.
 *
 * SCRUM-188: a Layout entry may also carry { layout, offers } and an
 * Accessibility or Facilities entry { missing, requested }, as codes;
 * venueSuitabilityDisplay.js turns them into labels, falling back to detail.
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

/**
 * SCRUM-192 (SCRUM-188 AC6, Week 7). Rechecks every venue this event has
 * requested or booked (GET /event-requests/:id/venue-suitability/bookings).
 *
 * Nothing but the id travels. The server rechecks each live booking against
 * the event's current period and attendance and the venue's current details,
 * so a moved date, a changed attendance or an edited venue (setup and
 * turnaround included) shows here without any stored flag going stale.
 *
 * An event with no live booking is a 200 with [], not an error. A retired
 * venue comes back as an item with `error` (code VENUE_RETIRED) and
 * current: null, while the event's other bookings still come back.
 *
 * SCRUM-188: each item also carries bookingStartsAt/bookingEndsAt, and an
 * item's error.code may be VENUE_RETIRED, STORED_REQUIREMENTS_INVALID or
 * RECHECK_FAILED (current: null, newlyUnmet: []). EventVenueSuitability words
 * them from the code.
 *
 * Failures: 400 (a malformed id), 401, 403 (not the event's assigned
 * coordinator), 404, and 409 EVENT_DATES_MISSING or EVENT_ATTENDANCE_MISSING
 * for the whole event.
 * venueSuitabilityErrors.js words them.
 *
 * @param {string} eventRequestId
 * @returns {Promise<Array<{bookingId: string, venueId: string,
 *   venueName: string, venueLocation: string, status: string,
 *   statusDisplay: Object, suitabilityOverridden: boolean,
 *   bookingStartsAt: string, bookingEndsAt: string,
 *   current: Object|null, atRequest: {suitable: boolean, unmet: string[]}|null,
 *   newlyUnmet: string[], error?: {code: string, message: string}}>>}
 */
export async function getEventVenueSuitability(eventRequestId) {
  const response = await apiClient.get(`/event-requests/${eventRequestId}/venue-suitability/bookings`);
  return response.data;
}
