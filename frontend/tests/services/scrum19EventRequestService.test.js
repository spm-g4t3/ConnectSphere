// scrum19EventRequestService.test.js
//
// SCRUM-19: the coordinator's review read, starting a review and deciding.
// apiClient is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  decideEventRequest,
  getEventRequestForReview,
  startEventReview,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM19 event request service", () => {
  it("SCRUM19_AC1_starting_a_review_posts_to_start_review_with_no_body", async () => {
    const underReview = { id: EVENT_ID, status: "under_review" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: underReview });

    await expect(startEventReview(EVENT_ID)).resolves.toBe(underReview);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/start-review`);
  });

  it("SCRUM19_AC4_the_coordinator_reads_the_request_from_the_review_endpoint", async () => {
    const request = { id: EVENT_ID, status: "under_review" };
    vi.mocked(apiClient.get).mockResolvedValue({ data: request });

    await expect(getEventRequestForReview(EVENT_ID)).resolves.toBe(request);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/review`);
  });

  it("SCRUM19_AC5_a_decision_posts_only_the_decision_and_its_note", async () => {
    const rejected = { id: EVENT_ID, status: "rejected" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: rejected });

    await expect(
      decideEventRequest(EVENT_ID, { decision: "rejected", decisionNote: "Too large", decidedBy: "x" }),
    ).resolves.toBe(rejected);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/decision`, {
      decision: "rejected",
      decisionNote: "Too large",
    });
  });
});
