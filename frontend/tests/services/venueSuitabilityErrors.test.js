// venueSuitabilityErrors.test.js
//
// SCRUM-191 (SCRUM-188 AC1). What a failed suitability check says, for every
// code and status the endpoint can answer.

import { describe, it, expect } from "vitest";

import { recheckErrorMessage, suitabilityErrorMessage } from "../../src/services/venueSuitabilityErrors.js";

const http = (status, data = {}) =>
  Object.assign(new Error(`status ${status}`), { response: { status, data } });
const conflict = (code) => http(409, { error: "database prose with a uuid", code });

describe("SCRUM-191 suitabilityErrorMessage", () => {
  it.each([
    ["EVENT_DATES_MISSING", /no proposed start and end/],
    ["VENUE_RETIRED", /retired/],
    // SCRUM-188 review fix F11.
    // SCRUM-525: the venue can still be requested with its own attendance,
    // so the message must not say no venue can be checked or requested.
    [
      "EVENT_ATTENDANCE_MISSING",
      /^This event has no expected attendance yet, so capacity can't be checked here\. You can still request the venue and enter an attendance for it\.$/,
    ],
  ])("SCRUM188_AC1_explains_the_409_%s", (code, pattern) => {
    expect(suitabilityErrorMessage(conflict(code))).toMatch(pattern);
  });

  it.each([
    [400, /could not be checked with these requirements/],
    [403, /^Only the coordinator assigned to this event can check a venue for it\.$/],
    [404, /no longer exists/],
  ])("SCRUM188_AC1_explains_a_%i", (status, pattern) => {
    expect(suitabilityErrorMessage(http(status))).toMatch(pattern);
  });

  it.each([
    ["an unknown 409 code", conflict("SOMETHING_NEW")],
    ["a 409 with no code", http(409, {})],
    ["a 500", http(500)],
    ["no response at all", new Error("network")],
    ["nothing", undefined],
  ])("SCRUM188_AC1_falls_back_to_the_default_for_%s", (_label, err) => {
    expect(suitabilityErrorMessage(err)).toBe("Could not check this venue. Please try again.");
  });

  it("SCRUM188_AC1_never_shows_the_servers_error_text", () => {
    const err = http(500, { error: "relation venues violates constraint 1234-uuid" });
    expect(suitabilityErrorMessage(err)).not.toMatch(/relation|uuid/);
  });
});

// SCRUM-188 review fix F11.
describe("SCRUM-188 the event recheck", () => {
  it("SCRUM188_AC6_a_400_from_the_recheck_does_not_point_at_the_layout_or_features", () => {
    const message = recheckErrorMessage(http(400, { error: "Invalid id", details: [{ field: "id" }] }));
    expect(message).toBe("This event's venues could not be rechecked. Please try again.");
    expect(message).not.toMatch(/layout|accessibility|facilities/i);
    // A single check's 400 still does, since it sends those codes.
    expect(suitabilityErrorMessage(http(400))).toMatch(/layout, accessibility features and facilities/);
  });
});
