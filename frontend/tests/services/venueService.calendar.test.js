// venueService.calendar.test.js
//
// SCRUM-180 (part of SCRUM-178). getVenueCalendar in venueService. apiClient
// is mocked, so nothing touches the network. The call must hit
// /venues/:id/calendar with the window as query params (axios encodes the
// '+' of an offset), hand back response.data, and let errors through as-is.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { getVenueCalendar } from "../../src/services/venueService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const WINDOW = { from: "2026-10-05T00:00:00+08:00", to: "2026-10-12T00:00:00+08:00" };

const ENTRIES = [
  {
    kind: "booking",
    id: "b1",
    startsAt: "2026-10-06T09:00:00+08:00",
    endsAt: "2026-10-06T17:00:00+08:00",
    status: "approved",
    eventRequestId: "e1",
    eventName: "Gala Dinner",
  },
  {
    kind: "block",
    id: "k1",
    startsAt: "2026-10-07T09:00:00+08:00",
    endsAt: "2026-10-07T17:00:00+08:00",
    reason: "maintenance",
    notes: null,
  },
];

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: "x" } },
  });
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe("getVenueCalendar", () => {
  it("SCRUM178_AC4_gets_the_calendar_path_with_the_window_and_returns_the_body", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: ENTRIES });

    await expect(getVenueCalendar(VENUE_ID, WINDOW)).resolves.toEqual(ENTRIES);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/calendar`, {
      params: { from: WINDOW.from, to: WINDOW.to },
    });
  });

  it("SCRUM178_AC4_passes_only_from_and_to_as_params", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await getVenueCalendar(VENUE_ID, { ...WINDOW, extra: "ignored" });

    const [, config] = vi.mocked(apiClient.get).mock.calls[0];
    expect(Object.keys(config.params).sort()).toEqual(["from", "to"]);
  });

  it("SCRUM178_AC4_returns_an_empty_array_for_an_empty_window", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await expect(getVenueCalendar(VENUE_ID, WINDOW)).resolves.toEqual([]);
  });

  it.each([400, 401, 403, 404, 500])("lets a %s error through unchanged", async (status) => {
    const err = httpError(status);
    vi.mocked(apiClient.get).mockRejectedValue(err);
    await expect(getVenueCalendar(VENUE_ID, WINDOW)).rejects.toBe(err);
  });
});
