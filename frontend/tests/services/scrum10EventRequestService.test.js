// scrum10EventRequestService.test.js
//
// SCRUM-10: creating, submitting and reading an Organiser's own request.
// apiClient is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  createEventRequest,
  getEventRequestById,
  submitEventRequest,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM10 event request service", () => {
  it("SCRUM10_AC3_create_posts_the_form_fields_and_returns_the_draft", async () => {
    const draft = { id: EVENT_ID, status: "draft" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: draft });
    const input = { eventName: "IS212 Industry Night", expectedAttendance: 80 };

    await expect(createEventRequest(input)).resolves.toBe(draft);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith("/event-requests", input);
  });

  it("SCRUM10_AC5_submit_posts_to_the_submit_endpoint_with_no_body", async () => {
    const submitted = { id: EVENT_ID, status: "submitted" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: submitted });

    await expect(submitEventRequest(EVENT_ID)).resolves.toBe(submitted);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/submit`);
  });

  it("SCRUM10_AC8_one_request_is_read_by_id_with_no_organiser_sent", async () => {
    const request = { id: EVENT_ID, status: "submitted" };
    vi.mocked(apiClient.get).mockResolvedValue({ data: request });

    await expect(getEventRequestById(EVENT_ID)).resolves.toBe(request);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}`);
  });
});
