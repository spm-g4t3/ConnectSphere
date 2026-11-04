// safetyReviewService.test.js
//
// SCRUM-490: the Safety Officer's reads and response. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getSafetyReview,
  getSafetyReviewHistory,
  submitSafetyReviewResponse,
} from "../../src/services/safetyReviewService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM490 safety review service", () => {
  it("SCRUM490_AC13_the_history_is_read_from_its_endpoint", async () => {
    const history = [{ eventRequestId: EVENT_ID, outcome: "approved" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: history });

    await expect(getSafetyReviewHistory()).resolves.toBe(history);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith("/safety-reviews/history");
  });

  it("SCRUM490_AC3_one_review_is_read_by_event_id", async () => {
    const review = { eventRequestId: EVENT_ID, status: "safety_review" };
    vi.mocked(apiClient.get).mockResolvedValue({ data: review });

    await expect(getSafetyReview(EVENT_ID)).resolves.toBe(review);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/safety-reviews/${EVENT_ID}`);
  });

  it("SCRUM490_a_response_is_posted_to_the_events_responses", async () => {
    const result = { eventRequestId: EVENT_ID, status: "safety_approved" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: result });
    const input = { outcome: "approved", note: "All clear" };

    await expect(submitSafetyReviewResponse(EVENT_ID, input)).resolves.toBe(result);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/safety-reviews/${EVENT_ID}/responses`, input);
  });
});
