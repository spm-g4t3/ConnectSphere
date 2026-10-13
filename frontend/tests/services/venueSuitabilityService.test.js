// venueSuitabilityService.test.js
//
// SCRUM-191 (SCRUM-188 AC1). The one call the suitability panel makes.
// apiClient is mocked, so nothing touches the network.
//
// SCRUM-192 (SCRUM-188 AC6) adds the live recheck of the event's requested
// and booked venues.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  checkVenueSuitability,
  getEventVenueSuitability,
} from "../../src/services/venueSuitabilityService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn() },
}));

const RESULT = { suitable: true, criteria: [], checked: {} };

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockResolvedValue({ data: RESULT });
});

describe("SCRUM-191 checkVenueSuitability", () => {
  it("SCRUM188_AC1_gets_the_events_suitability_route_and_returns_the_body", async () => {
    await expect(checkVenueSuitability("e1", "v1")).resolves.toBe(RESULT);

    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/e1/venue-suitability", {
      params: { venueId: "v1" },
    });
  });

  it("SCRUM188_AC1_sends_the_layout_and_joins_the_code_lists_with_commas", async () => {
    await checkVenueSuitability("e1", "v1", {
      layout: "theatre",
      accessibility: ["step_free_entrance", "hearing_loop"],
      facilities: ["projector", "wifi"],
    });

    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/e1/venue-suitability", {
      params: {
        venueId: "v1",
        layout: "theatre",
        accessibility: "step_free_entrance,hearing_loop",
        facilities: "projector,wifi",
      },
    });
  });

  it.each([
    ["blank values", { layout: "", accessibility: [], facilities: [] }],
    ["missing values", {}],
    ["null requirements", null],
    ["non-array lists", { accessibility: "hearing_loop", facilities: undefined }],
  ])("SCRUM188_AC1_leaves_out_%s", async (_label, requirements) => {
    await checkVenueSuitability("e1", "v1", requirements);

    const [, config] = vi.mocked(apiClient.get).mock.calls[0];
    expect(config.params).toEqual({ venueId: "v1" });
  });

  // SCRUM-525 (AC3): the request form's attendance reaches the check, and an
  // absent or null one leaves the key out so the server judges the event's
  // (an "attendance=null" query would be a 400).
  it("SCRUM525_AC3_attendance_is_sent_as_a_query_param", async () => {
    await checkVenueSuitability("e1", "v1", { layout: "theatre" }, { attendance: 80 });

    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/e1/venue-suitability", {
      params: { venueId: "v1", layout: "theatre", attendance: 80 },
    });
  });

  it.each([
    ["no options", undefined],
    ["no attendance", {}],
    ["a null attendance", { attendance: null }],
  ])("SCRUM525_AC3_%s_sends_no_attendance_param", async (_label, options) => {
    await checkVenueSuitability("e1", "v1", {}, options);

    const [, config] = vi.mocked(apiClient.get).mock.calls[0];
    expect(config.params).toEqual({ venueId: "v1" });
  });

  it("SCRUM188_AC1_lets_a_failure_through_for_the_caller_to_read", async () => {
    const failure = Object.assign(new Error("409"), { response: { status: 409 } });
    vi.mocked(apiClient.get).mockRejectedValue(failure);

    await expect(checkVenueSuitability("e1", "v1")).rejects.toBe(failure);
  });
});

describe("SCRUM-192 getEventVenueSuitability", () => {
  it("SCRUM188_AC6_gets_the_events_bookings_recheck_route_and_returns_the_body", async () => {
    const items = [{ bookingId: "b1", current: RESULT, newlyUnmet: [] }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: items });

    await expect(getEventVenueSuitability("e1")).resolves.toBe(items);

    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/e1/venue-suitability/bookings");
  });

  it("SCRUM188_AC6_lets_a_failure_through_for_the_caller_to_read", async () => {
    const failure = Object.assign(new Error("409"), {
      response: { status: 409, data: { code: "EVENT_DATES_MISSING" } },
    });
    vi.mocked(apiClient.get).mockRejectedValue(failure);

    await expect(getEventVenueSuitability("e1")).rejects.toBe(failure);
  });
});
