// bookingRequestService.test.js
//
// SCRUM-254. The one call the request flow makes. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  approveBookingRequest,
  createBookingRequest,
  getMyBookingRequests,
  getPendingBookingRequests,
  rejectBookingRequest,
  withdrawBookingRequest,
} from "../../src/services/bookingRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("createBookingRequest", () => {
  it("SCRUM254_posts_to_/booking-requests_and_returns_the_body", async () => {
    const created = { id: "b1", status: "pending" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: created });
    const input = { eventRequestId: "e1", venueId: "v1", setupNotes: "Extra tables" };

    await expect(createBookingRequest(input)).resolves.toBe(created);

    expect(apiClient.post).toHaveBeenCalledWith("/booking-requests", input);
  });

  it("SCRUM254_lets_a_failure_through_for_the_caller_to_read", async () => {
    const failure = Object.assign(new Error("409"), { response: { status: 409 } });
    vi.mocked(apiClient.post).mockRejectedValue(failure);

    await expect(createBookingRequest({})).rejects.toBe(failure);
  });
});

describe("getMyBookingRequests (SCRUM-255)", () => {
  it("SCRUM255_gets_/booking-requests/mine_with_no_parameters_and_returns_the_body", async () => {
    const rows = [{ id: "b1", status: "pending" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(getMyBookingRequests()).resolves.toBe(rows);

    // No user id, no filter: the backend scopes the list to the token.
    expect(apiClient.get).toHaveBeenCalledWith("/booking-requests/mine");
  });
});

describe("withdrawBookingRequest (SCRUM-255)", () => {
  it("SCRUM255_posts_to_the_withdraw_route_with_no_body_and_returns_the_request", async () => {
    const withdrawn = { id: "b1", status: "withdrawn" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: withdrawn });

    await expect(withdrawBookingRequest("b1")).resolves.toBe(withdrawn);

    expect(apiClient.post).toHaveBeenCalledWith("/booking-requests/b1/withdraw");
  });
});

describe("Venue Staff decisions (SCRUM-258)", () => {
  it("SCRUM258_AC1_gets_/booking-requests/pending_and_returns_the_body", async () => {
    const rows = [{ id: "b1", status: "pending" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(getPendingBookingRequests()).resolves.toBe(rows);

    expect(apiClient.get).toHaveBeenCalledWith("/booking-requests/pending");
  });

  it("SCRUM258_AC3_posts_to_the_approve_route_with_no_body_and_returns_the_result", async () => {
    const approved = { id: "b1", status: "approved", markedConflicting: ["b2"], convertedHoldId: null };
    vi.mocked(apiClient.post).mockResolvedValue({ data: approved });

    await expect(approveBookingRequest("b1")).resolves.toBe(approved);

    expect(apiClient.post).toHaveBeenCalledWith("/booking-requests/b1/approve");
  });

  it("SCRUM258_AC4_posts_the_reason_and_alternative_to_the_reject_route", async () => {
    const rejected = { id: "b1", status: "rejected" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: rejected });

    await expect(
      rejectBookingRequest("b1", { reason: "Too small", suggestedAlternative: "Hall B" }),
    ).resolves.toBe(rejected);

    expect(apiClient.post).toHaveBeenCalledWith("/booking-requests/b1/reject", {
      reason: "Too small",
      suggestedAlternative: "Hall B",
    });
  });

  it("SCRUM258_AC4_an_empty_alternative_is_left_out_of_the_body", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await rejectBookingRequest("b1", { reason: "Too small", suggestedAlternative: "" });

    expect(apiClient.post).toHaveBeenCalledWith("/booking-requests/b1/reject", { reason: "Too small" });
  });

  it("SCRUM258_AC2_lets_a_refusal_through_for_the_caller_to_read", async () => {
    const failure = Object.assign(new Error("409"), { response: { status: 409, data: { code: "BOOKING_NOT_PENDING" } } });
    vi.mocked(apiClient.post).mockRejectedValue(failure);

    await expect(approveBookingRequest("b1")).rejects.toBe(failure);
  });
});
