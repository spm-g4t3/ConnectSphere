// venueSuitabilityErrors.test.js
//
// SCRUM-191 (SCRUM-188 AC1). What a failed suitability check says, for every
// code and status the endpoint can answer.

import { describe, it, expect } from "vitest";

import { suitabilityErrorMessage } from "../../src/services/venueSuitabilityErrors.js";

const http = (status, data = {}) =>
  Object.assign(new Error(`status ${status}`), { response: { status, data } });
const conflict = (code) => http(409, { error: "database prose with a uuid", code });

describe("SCRUM-191 suitabilityErrorMessage", () => {
  it.each([
    ["EVENT_DATES_MISSING", /no proposed start and end/],
    ["VENUE_RETIRED", /retired/],
  ])("SCRUM188_AC1_explains_the_409_%s", (code, pattern) => {
    expect(suitabilityErrorMessage(conflict(code))).toMatch(pattern);
  });

  it.each([
    [400, /could not be checked with these requirements/],
    [401, /sign in again/],
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
