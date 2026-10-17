// flaggedBookingService.test.js
//
// SCRUM-266. The three calls Venue Staff's flagged bookings list makes, and
// the one the coordinator's event screen makes for its own flagged bookings.
// apiClient is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  cancelFlaggedBooking,
  getEventFlaggedBookings,
  getFlaggedBookings,
  reinstateFlaggedBooking,
} from "../../src/services/flaggedBookingService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const failure = (status) => Object.assign(new Error(`status ${status}`), { response: { status } });

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("getFlaggedBookings", () => {
  it("SCRUM266_AC1_gets_/flagged-bookings_with_no_parameters_and_returns_the_body", async () => {
    const rows = [{ id: "b1" }, { id: "b2" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(getFlaggedBookings()).resolves.toBe(rows);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/flagged-bookings");
  });

  it("SCRUM266_AC1_lets_a_list_failure_through_for_the_caller_to_read", async () => {
    const err = failure(403);
    vi.mocked(apiClient.get).mockRejectedValue(err);

    await expect(getFlaggedBookings()).rejects.toBe(err);
  });
});

describe("getEventFlaggedBookings", () => {
  it("SCRUM266_AC1_gets_the_events_flagged_bookings_by_its_id_and_returns_the_body", async () => {
    const rows = [{ id: "b1", replacementRequests: [] }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(getEventFlaggedBookings("e1")).resolves.toBe(rows);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/flagged-bookings/events/e1");
  });

  it("SCRUM266_AC1_lets_a_load_failure_through_for_the_caller_to_read", async () => {
    const err = failure(403);
    vi.mocked(apiClient.get).mockRejectedValue(err);

    await expect(getEventFlaggedBookings("e1")).rejects.toBe(err);
  });
});

describe("reinstateFlaggedBooking", () => {
  it("SCRUM266_AC2_posts_the_reason_to_the_reinstate_route_and_returns_the_booking", async () => {
    const booking = { id: "b1", status: "approved", resolution: { action: "reinstated" } };
    vi.mocked(apiClient.post).mockResolvedValue({ data: booking });

    await expect(reinstateFlaggedBooking("b1", "Block lifted")).resolves.toBe(booking);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith("/flagged-bookings/b1/reinstate", { reason: "Block lifted" });
  });

  it("SCRUM266_AC2_lets_a_reinstate_failure_through_for_the_caller_to_read", async () => {
    const err = failure(409);
    vi.mocked(apiClient.post).mockRejectedValue(err);

    await expect(reinstateFlaggedBooking("b1", "x")).rejects.toBe(err);
  });
});

describe("cancelFlaggedBooking", () => {
  it("SCRUM266_AC3_posts_the_reason_to_the_cancel_route_and_returns_the_booking", async () => {
    const booking = { id: "b1", status: "cancelled", resolution: { action: "cancelled" } };
    vi.mocked(apiClient.post).mockResolvedValue({ data: booking });

    await expect(cancelFlaggedBooking("b1", "Venue closed")).resolves.toBe(booking);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith("/flagged-bookings/b1/cancel", { reason: "Venue closed" });
  });

  it("SCRUM266_AC3_lets_a_cancel_failure_through_for_the_caller_to_read", async () => {
    const err = failure(404);
    vi.mocked(apiClient.post).mockRejectedValue(err);

    await expect(cancelFlaggedBooking("b1", "x")).rejects.toBe(err);
  });
});
