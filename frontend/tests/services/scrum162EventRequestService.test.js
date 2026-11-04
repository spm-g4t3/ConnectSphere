// scrum162EventRequestService.test.js
//
// SCRUM-162: the clarification calls. apiClient is mocked, so nothing touches
// the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  closeEventClarification,
  getEventClarificationHistory,
  requestEventClarification,
  respondToEventClarification,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(apiClient.patch).mockReset();
});

describe("SCRUM162 event request service", () => {
  it("SCRUM162_AC1_a_question_alone_sends_no_reply_by_date_and_no_requested_fields", async () => {
    const pending = { id: EVENT_ID, status: "pending_clarification" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: pending });

    await expect(requestEventClarification(EVENT_ID, "Which room layout?")).resolves.toBe(pending);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/clarification`, {
      note: "Which room layout?",
      replyByDate: null,
      requestedFields: [],
    });
  });

  it("SCRUM162_AC1_the_reply_by_date_and_requested_fields_are_sent_as_given", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await requestEventClarification(EVENT_ID, "Confirm numbers", "2026-12-01", ["expectedAttendance"]);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/clarification`, {
      note: "Confirm numbers",
      replyByDate: "2026-12-01",
      requestedFields: ["expectedAttendance"],
    });
  });

  it("SCRUM162_AC4_a_reply_alone_patches_the_message_with_no_amendments", async () => {
    const underReview = { id: EVENT_ID, status: "under_review" };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: underReview });

    await expect(respondToEventClarification(EVENT_ID, "Theatre style")).resolves.toBe(underReview);
    expect(apiClient.patch).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/${EVENT_ID}/clarification-response`,
      { message: "Theatre style", amendments: {} },
    );
  });

  it("SCRUM162_AC4_a_reply_sends_the_amendments_given", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: {} });

    await respondToEventClarification(EVENT_ID, "Updated", { expectedAttendance: 120 });
    expect(apiClient.patch).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/${EVENT_ID}/clarification-response`,
      { message: "Updated", amendments: { expectedAttendance: 120 } },
    );
  });

  it("SCRUM162_AC6_closing_posts_the_note_to_the_close_endpoint", async () => {
    const underReview = { id: EVENT_ID, status: "under_review" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: underReview });

    await expect(closeEventClarification(EVENT_ID, "Answered by phone")).resolves.toBe(underReview);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/${EVENT_ID}/clarification/close`,
      { note: "Answered by phone" },
    );
  });

  it("SCRUM162_AC9_the_history_is_read_from_its_endpoint", async () => {
    const history = [{ id: "c1", type: "question" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: history });

    await expect(getEventClarificationHistory(EVENT_ID)).resolves.toBe(history);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/clarification-history`);
  });
});
