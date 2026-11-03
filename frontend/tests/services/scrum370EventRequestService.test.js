// scrum370EventRequestService.test.js
//
// SCRUM-370: the cancellation preview and the cancel itself. apiClient is
// mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { cancelEventRequest, getEventCancellationImpact } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM370 event request service", () => {
  it("SCRUM370_AC3_the_impact_is_read_before_anything_is_cancelled", async () => {
    const impact = { venueBookings: [], registrations: 3 };
    vi.mocked(apiClient.get).mockResolvedValue({ data: impact });

    await expect(getEventCancellationImpact(EVENT_ID)).resolves.toBe(impact);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/cancellation-impact`);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("SCRUM370_AC2_cancel_posts_the_reason_initiator_and_attendee_message_only", async () => {
    const cancelled = { id: EVENT_ID, status: "cancelled" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: cancelled });
    const body = { reason: "Speaker unavailable", initiator: "organiser_request", attendeeMessage: "Sorry" };

    await expect(cancelEventRequest(EVENT_ID, { ...body, status: "cancelled" })).resolves.toBe(cancelled);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/cancel`, body);
  });
});
