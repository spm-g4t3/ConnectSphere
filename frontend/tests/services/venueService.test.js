// venueService.test.js
//
// SCRUM-140 (for SCRUM-20). findVenuesForEvent and the query it sends to
// GET /venues/event-search. apiClient is mocked, so nothing touches the
// network. The lists travel comma-joined, and optional criteria left blank or
// empty are not sent at all, so they are not filtered on.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { findVenuesForEvent } from "../../src/services/venueService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const HALL = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const REQUIRED = {
  startsAt: "2026-11-11T10:00:00+08:00",
  endsAt: "2026-11-11T12:00:00+08:00",
  expectedAttendance: 80,
};

function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

const paramsSent = () => apiClient.get.mock.calls[0][1].params;

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockResolvedValue({ data: [HALL] });
});

describe("findVenuesForEvent", () => {
  it("SCRUM20_AC1_calls_event_search_with_the_required_params", async () => {
    await findVenuesForEvent({ ...REQUIRED });

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/venues/event-search", { params: { ...REQUIRED } });
  });

  it("SCRUM20_AC1_sends_every_criterion_with_lists_comma_joined", async () => {
    await findVenuesForEvent({
      ...REQUIRED,
      layout: "theatre",
      accessibility: ["step_free_entrance", "hearing_loop"],
      facilities: ["projector", "wifi"],
    });

    expect(paramsSent()).toStrictEqual({
      ...REQUIRED,
      layout: "theatre",
      accessibility: "step_free_entrance,hearing_loop",
      facilities: "projector,wifi",
    });
  });

  it("SCRUM20_AC1_a_single_code_list_is_sent_as_that_code", async () => {
    await findVenuesForEvent({ ...REQUIRED, facilities: ["wifi"] });
    expect(paramsSent().facilities).toBe("wifi");
  });

  it("SCRUM20_AC1_empty_lists_and_a_blank_layout_are_left_out", async () => {
    await findVenuesForEvent({ ...REQUIRED, layout: "   ", accessibility: [], facilities: [] });

    expect(paramsSent()).toStrictEqual({ ...REQUIRED });
  });

  it("SCRUM20_AC1_missing_or_empty_layout_is_left_out", async () => {
    await findVenuesForEvent({ ...REQUIRED, layout: "" });
    expect(paramsSent()).not.toHaveProperty("layout");

    await findVenuesForEvent({ ...REQUIRED, layout: undefined, accessibility: undefined });
    const params = apiClient.get.mock.calls[1][1].params;
    expect(params).not.toHaveProperty("layout");
    expect(params).not.toHaveProperty("accessibility");
  });

  it("SCRUM20_AC7_returns_the_response_body", async () => {
    await expect(findVenuesForEvent({ ...REQUIRED })).resolves.toEqual([HALL]);
  });

  it("SCRUM20_AC8_an_empty_result_is_returned_as_an_empty_array", async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] });
    await expect(findVenuesForEvent({ ...REQUIRED })).resolves.toEqual([]);
  });

  it("SCRUM20_AC1_a_400_propagates_with_its_details", async () => {
    const err = httpError(400, {
      error: "Invalid venue search -- expectedAttendance: is required",
      details: [{ field: "expectedAttendance", message: "is required" }],
    });
    vi.mocked(apiClient.get).mockRejectedValueOnce(err);

    await expect(findVenuesForEvent({ ...REQUIRED })).rejects.toBe(err);
  });

  it("SCRUM20_AC1_a_403_propagates", async () => {
    const err = httpError(403, { error: "This action is restricted to Event Coordinators" });
    vi.mocked(apiClient.get).mockRejectedValueOnce(err);

    await expect(findVenuesForEvent({ ...REQUIRED })).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});
