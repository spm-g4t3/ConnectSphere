// venueService.holds.test.js
//
// SCRUM-491. The three hold calls in venueService. apiClient is mocked, so
// nothing touches the network. Each call must hit the documented path, pass
// its body through untouched, hand back response.data, and let errors through
// as-is.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getHoldCandidates,
  listVenueHolds,
  placeVenueHold,
} from "../../src/services/venueService.js";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const EVENT_ID = "e1000000-0000-4000-8000-000000000001";

const HOLD = {
  id: "h1000000-0000-4000-8000-000000000001",
  eventRequestId: EVENT_ID,
  venueId: VENUE_ID,
  placedBy: "d1000000-0000-4000-8000-000000000001",
  placedAt: "2026-10-10T09:00:00+08:00",
  expiresAt: "2026-10-20T18:00:00+08:00",
  status: "active",
  expiredAt: null,
};

beforeEach(() => {
  for (const method of ["get", "post", "patch", "delete"]) {
    vi.mocked(apiClient[method]).mockReset();
  }
});

describe("listVenueHolds", () => {
  it("SCRUM491_AC2_gets_the_venues_active_holds", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [HOLD] });

    await expect(listVenueHolds(VENUE_ID)).resolves.toEqual([HOLD]);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/holds`);
  });

  it("SCRUM491_AC1_lets_a_403_through_untouched", async () => {
    const err = httpError(403, { error: "This action is restricted to Venue Staff" });
    vi.mocked(apiClient.get).mockRejectedValue(err);

    await expect(listVenueHolds(VENUE_ID)).rejects.toBe(err);
  });
});

describe("placeVenueHold", () => {
  it("SCRUM491_AC2_posts_the_event_and_expiry_and_returns_the_body", async () => {
    const input = { eventRequestId: EVENT_ID, expiresAt: HOLD.expiresAt };
    vi.mocked(apiClient.post).mockResolvedValue({ data: { hold: HOLD } });

    await expect(placeVenueHold(VENUE_ID, input)).resolves.toEqual({ hold: HOLD });
    expect(apiClient.post).toHaveBeenCalledWith(`/venues/${VENUE_ID}/holds`, input);
  });

  it("SCRUM491_AC4_lets_a_HOLD_PERIOD_CONFLICT_through_untouched", async () => {
    const err = httpError(409, { code: "HOLD_PERIOD_CONFLICT", conflicts: [] });
    vi.mocked(apiClient.post).mockRejectedValue(err);

    await expect(placeVenueHold(VENUE_ID, {})).rejects.toBe(err);
  });
});

describe("getHoldCandidates", () => {
  it("SCRUM491_AC2_gets_the_approved_events_a_hold_can_be_placed_for", async () => {
    const candidates = [{ id: EVENT_ID, eventName: "Product Launch" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: candidates });

    await expect(getHoldCandidates()).resolves.toEqual(candidates);
    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/hold-candidates");
  });

  it("SCRUM491_AC1_lets_a_403_through_untouched", async () => {
    const err = httpError(403, {});
    vi.mocked(apiClient.get).mockRejectedValue(err);

    await expect(getHoldCandidates()).rejects.toBe(err);
  });
});
