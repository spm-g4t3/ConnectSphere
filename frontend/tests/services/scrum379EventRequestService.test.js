// scrum379EventRequestService.test.js
//
// SCRUM-384: the two calls the coordinator screens make for SCRUM-379, against
// POST /event-requests/:id/complete and GET /event-requests/needs-attention. apiClient is mocked,
// so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { completeEventRequest, getNeedsAttention } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM379 completeEventRequest", () => {
  it("SCRUM379_AC1_posts_to_the_complete_endpoint_and_returns_the_event", async () => {
    const event = { id: EVENT_ID, status: "completed", closingNotes: "All went well." };
    vi.mocked(apiClient.post).mockResolvedValue({ data: event });

    await expect(completeEventRequest(EVENT_ID, { closingNotes: "All went well." })).resolves.toBe(event);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/${EVENT_ID}/complete`,
      { closingNotes: "All went well." },
    );
  });

  it("SCRUM379_AC2_notes_are_trimmed_before_they_are_sent", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await completeEventRequest(EVENT_ID, { closingNotes: "  padded  \n" });

    expect(apiClient.post.mock.calls[0][1]).toEqual({ closingNotes: "padded" });
  });

  it.each([undefined, null, "", "   \n  "])("SCRUM379_AC2_%j_notes_send_no_notes_at_all", async (closingNotes) => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await completeEventRequest(EVENT_ID, { closingNotes });

    expect(apiClient.post.mock.calls[0][1]).toEqual({});
  });

  it("SCRUM379_AC2_no_options_at_all_sends_no_notes", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await completeEventRequest(EVENT_ID);

    expect(apiClient.post.mock.calls[0][1]).toEqual({});
  });

  it("SCRUM379_AC2_line_breaks_inside_the_notes_are_kept", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });

    await completeEventRequest(EVENT_ID, { closingNotes: "One\n\nTwo" });

    expect(apiClient.post.mock.calls[0][1]).toEqual({ closingNotes: "One\n\nTwo" });
  });

  it("SCRUM379_AC1_a_refusal_reaches_the_caller_unchanged", async () => {
    const refusal = Object.assign(new Error("conflict"), { response: { status: 409 } });
    vi.mocked(apiClient.post).mockRejectedValue(refusal);

    await expect(completeEventRequest(EVENT_ID)).rejects.toBe(refusal);
  });
});

describe("SCRUM379 getNeedsAttention", () => {
  it("SCRUM379_AC7_reads_the_needs_attention_endpoint", async () => {
    const items = [{ id: `${EVENT_ID}:MARK_COMPLETED:0`, code: "MARK_COMPLETED" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: items });

    await expect(getNeedsAttention()).resolves.toBe(items);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith("/event-requests/needs-attention");
  });

  it("SCRUM379_AC7_an_empty_list_is_returned_as_is", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await expect(getNeedsAttention()).resolves.toEqual([]);
  });

  it("SCRUM379_AC7_a_refusal_reaches_the_caller_unchanged", async () => {
    const refusal = Object.assign(new Error("forbidden"), { response: { status: 403 } });
    vi.mocked(apiClient.get).mockRejectedValue(refusal);

    await expect(getNeedsAttention()).rejects.toBe(refusal);
  });
});
