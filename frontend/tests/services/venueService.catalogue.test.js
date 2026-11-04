// venueService.catalogue.test.js
//
// SCRUM-15. The venue catalogue calls Venue Staff use to create, update and
// retire a venue, and to read one venue, its bookings and its change history.
// apiClient is mocked, so nothing touches the network. Each call goes to its
// route with the caller's input unchanged and returns the response body.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  createVenue,
  getVenueBookings,
  getVenueDetails,
  getVenueHistory,
  retireVenue,
  updateVenue,
} from "../../src/services/venueService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const VENUE_ID = "11111111-1111-4111-8111-111111111111";
const VENUE = { id: VENUE_ID, name: "Hall A", location: "Level 2", maxCapacity: 200, retiredAt: null };

beforeEach(() => {
  for (const method of ["get", "post", "patch", "delete"]) {
    vi.mocked(apiClient[method]).mockReset();
  }
});

describe("createVenue", () => {
  it("SCRUM15_AC1_posts_the_input_unchanged_and_returns_the_created_venue", async () => {
    const input = { name: "Hall A", location: "Level 2", maxCapacity: 200, facilities: ["wifi"] };
    vi.mocked(apiClient.post).mockResolvedValue({ data: VENUE });

    await expect(createVenue(input)).resolves.toBe(VENUE);
    expect(apiClient.post).toHaveBeenCalledWith("/venues", input);
  });
});

describe("updateVenue", () => {
  it("SCRUM15_AC2_patches_the_venue_with_only_the_changes_and_returns_the_venue", async () => {
    const changes = { maxCapacity: 150 };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { ...VENUE, maxCapacity: 150 } });

    await expect(updateVenue(VENUE_ID, changes)).resolves.toEqual({ ...VENUE, maxCapacity: 150 });
    expect(apiClient.patch).toHaveBeenCalledWith(`/venues/${VENUE_ID}`, { maxCapacity: 150 });
  });
});

describe("retireVenue", () => {
  it("SCRUM15_AC4_posts_to_the_retire_path_with_an_empty_body_and_returns_the_venue", async () => {
    const retired = { ...VENUE, retiredAt: "2026-11-04T02:00:00Z" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: retired });

    await expect(retireVenue(VENUE_ID)).resolves.toBe(retired);
    expect(apiClient.post).toHaveBeenCalledWith(`/venues/${VENUE_ID}/retire`, {});
  });
});

describe("getVenueDetails", () => {
  it("SCRUM15_AC4_gets_one_venue_by_id_retired_or_not", async () => {
    const retired = { ...VENUE, retiredAt: "2026-11-04T02:00:00Z" };
    vi.mocked(apiClient.get).mockResolvedValue({ data: retired });

    await expect(getVenueDetails(VENUE_ID)).resolves.toBe(retired);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}`);
  });
});

describe("getVenueBookings", () => {
  it("SCRUM15_AC4_gets_the_venues_bookings_and_returns_them", async () => {
    const bookings = [{ id: "b1", venueId: VENUE_ID, eventRequestId: "e1" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: bookings });

    await expect(getVenueBookings(VENUE_ID)).resolves.toBe(bookings);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/bookings`);
  });
});

describe("getVenueHistory", () => {
  it("SCRUM15_AC5_gets_the_venues_change_history_and_returns_it", async () => {
    const history = [{ id: "h1", venueId: VENUE_ID, changedBy: "u1", oldValues: { maxCapacity: 200 } }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: history });

    await expect(getVenueHistory(VENUE_ID)).resolves.toBe(history);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/history`);
  });
});
