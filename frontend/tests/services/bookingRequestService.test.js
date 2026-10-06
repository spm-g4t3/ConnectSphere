// bookingRequestService.test.js
//
// SCRUM-254. The one call the request flow makes. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { createBookingRequest } from "../../src/services/bookingRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { post: vi.fn() },
}));

beforeEach(() => {
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
