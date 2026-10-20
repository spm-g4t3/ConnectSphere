// venueService.search.test.js
//
// SCRUM-130 (part of SCRUM-17, AC2). searchActiveVenues and its optional
// startsAt/endsAt window. apiClient is mocked, so nothing touches the network.
// A dateless search must send exactly the params it always did.
//
// SCRUM-185 (for SCRUM-178 AC1): includeRetired is sent only when it is true.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { searchActiveVenues } from "../../src/services/venueService.js";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const STARTS_AT = "2026-11-10T10:00:00+08:00";
const ENDS_AT = "2026-11-10T14:00:00+08:00";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockResolvedValue({ data: [HALL] });
});

describe("searchActiveVenues", () => {
  it("returns the response body", async () => {
    await expect(searchActiveVenues({ location: "Level" })).resolves.toEqual([HALL]);
  });

  it("SCRUM17_AC2_no_filters_sends_empty_params", async () => {
    await searchActiveVenues();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/venues/search", { params: {} });
  });

  it("SCRUM17_AC2_blank_dates_add_no_date_keys", async () => {
    await searchActiveVenues({ location: "Level", minCapacity: 50, startsAt: "", endsAt: undefined });

    const params = apiClient.get.mock.calls[0][1].params;
    expect(params).toStrictEqual({ location: "Level", minCapacity: 50 });
    expect(Object.keys(params).sort()).toEqual(["location", "minCapacity"]);
  });

  it("SCRUM17_AC2_passes_the_window_through_unchanged", async () => {
    await searchActiveVenues({ location: "Level", minCapacity: 50, startsAt: STARTS_AT, endsAt: ENDS_AT });

    expect(apiClient.get).toHaveBeenCalledWith("/venues/search", {
      params: { location: "Level", minCapacity: 50, startsAt: STARTS_AT, endsAt: ENDS_AT },
    });
  });

  it("SCRUM17_AC2_passes_a_window_alone", async () => {
    await searchActiveVenues({ startsAt: STARTS_AT, endsAt: ENDS_AT });
    expect(apiClient.get.mock.calls[0][1].params).toStrictEqual({ startsAt: STARTS_AT, endsAt: ENDS_AT });
  });

  it("SCRUM17_AC2_does_not_judge_a_one_sided_window_leaving_that_to_the_backend", async () => {
    await searchActiveVenues({ startsAt: STARTS_AT });
    expect(apiClient.get.mock.calls[0][1].params).toStrictEqual({ startsAt: STARTS_AT });
  });

  it("SCRUM178_AC1_includeRetired_true_sends_the_flag", async () => {
    await searchActiveVenues({ location: "Level", includeRetired: true });
    expect(apiClient.get).toHaveBeenCalledWith("/venues/search", {
      params: { location: "Level", includeRetired: true },
    });
  });

  it("SCRUM178_AC1_includeRetired_alone_sends_only_the_flag", async () => {
    await searchActiveVenues({ includeRetired: true });
    expect(apiClient.get.mock.calls[0][1].params).toStrictEqual({ includeRetired: true });
  });

  it("SCRUM178_AC1_includeRetired_false_or_absent_sends_no_flag", async () => {
    await searchActiveVenues({ location: "Level", includeRetired: false });
    await searchActiveVenues({ location: "Level" });
    for (const [, { params }] of apiClient.get.mock.calls) {
      expect(params).toStrictEqual({ location: "Level" });
      expect(params).not.toHaveProperty("includeRetired");
    }
  });

  it("SCRUM178_AC1_only_the_boolean_true_sends_the_flag", async () => {
    // A string "true" or a truthy number is not the boolean the caller means.
    await searchActiveVenues({ includeRetired: "true" });
    await searchActiveVenues({ includeRetired: 1 });
    for (const [, { params }] of apiClient.get.mock.calls) {
      expect(params).toStrictEqual({});
    }
  });

  it("lets an error through unchanged", async () => {
    const err = httpError(400, { details: [{ field: "endsAt", message: "is required when a start is given" }] });
    vi.mocked(apiClient.get).mockRejectedValue(err);
    await expect(searchActiveVenues({ startsAt: STARTS_AT })).rejects.toBe(err);
  });
});
