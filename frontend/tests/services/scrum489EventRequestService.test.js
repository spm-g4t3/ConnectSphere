// scrum489EventRequestService.test.js
//
// SCRUM-489 (SCRUM-557): the two calls the safety check submission panel
// makes. apiClient is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getEventReadiness,
  submitForSafetyReview,
  confirmEventRequest,
  getConfirmedArrangements,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const CHECKLIST = { eventRequestId: EVENT_ID, ready: false, items: [{ key: "venue", met: false, detail: "No venue booking" }] };

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset().mockResolvedValue({ data: CHECKLIST });
  vi.mocked(apiClient.post).mockReset().mockResolvedValue({ data: { id: EVENT_ID, status: "safety_review" } });
});

describe("SCRUM363 confirmation service", () => {
  it("SCRUM363_AC7_reads_organiser_arrangements_through_the_narrow_endpoint", async () => {
    const data = { eventRequestId: EVENT_ID, status: "confirmed", venues: [], equipment: [] };
    vi.mocked(apiClient.get).mockResolvedValue({ data });
    await expect(getConfirmedArrangements(EVENT_ID)).resolves.toBe(data);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/confirmed-arrangements`);
  });

  it.each([undefined, { noEquipmentConfirmed: true }])("SCRUM363_AC5_posts_%j_to_the_actual_confirmation_endpoint", async (options) => {
    const confirmed = { id: EVENT_ID, status: "confirmed" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: confirmed });
    await expect(confirmEventRequest(EVENT_ID, options)).resolves.toBe(confirmed);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/confirm`, {
      noEquipmentConfirmed: options?.noEquipmentConfirmed ?? false,
    });
  });

  it("SCRUM363_AC5_posts_the_observed_revision_with_the_explicit_acknowledgement", async () => {
    apiClient.post.mockResolvedValue({ data: { id: EVENT_ID, status: "confirmed" } });
    const options = { noEquipmentConfirmed: true, expectedUpdatedAt: "2026-06-01T09:00:00.123456Z" };
    await confirmEventRequest(EVENT_ID, options);
    expect(apiClient.post).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/confirm`, options);
  });

  it("SCRUM363_AC3_passes_backend_refusals_through_unchanged", async () => {
    const error = { response: { status: 409, data: { code: "EVENT_NOT_READY", conflicts: CHECKLIST.items } } };
    vi.mocked(apiClient.post).mockRejectedValue(error);
    await expect(confirmEventRequest(EVENT_ID)).rejects.toBe(error);
  });
});

describe("SCRUM489 the panel's calls", () => {
  it.each([
    ["no_options", undefined],
    ["the_flag_off", { noEquipmentConfirmed: false }],
  ])("SCRUM489_AC3_with_%s_the_checklist_is_a_get_of_the_path_alone", async (_label, options) => {
    await expect(getEventReadiness(EVENT_ID, options)).resolves.toEqual(CHECKLIST);

    expect(vi.mocked(apiClient.get).mock.calls).toEqual([[`/event-requests/${EVENT_ID}/readiness`]]);
  });

  it("SCRUM489_AC4_with_the_flag_on_the_checklist_is_read_with_no_equipment_confirmed", async () => {
    await getEventReadiness(EVENT_ID, { noEquipmentConfirmed: true });

    expect(vi.mocked(apiClient.get).mock.calls).toEqual([
      [`/event-requests/${EVENT_ID}/readiness`, { params: { noEquipmentConfirmed: "true" } }],
    ]);
  });

  it("SCRUM489_AC6_submitting_posts_the_note_and_the_confirmation_and_returns_the_event", async () => {
    await expect(submitForSafetyReview(EVENT_ID, { note: "East doors.", noEquipmentConfirmed: true }))
      .resolves.toEqual({ id: EVENT_ID, status: "safety_review" });

    expect(vi.mocked(apiClient.post).mock.calls).toEqual([
      [`/event-requests/${EVENT_ID}/safety-review`, { note: "East doors.", noEquipmentConfirmed: true }],
    ]);
  });

  it("SCRUM489_AC5_with_nothing_given_no_note_and_no_confirmation_are_sent", async () => {
    await submitForSafetyReview(EVENT_ID);

    expect(apiClient.post).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/safety-review`, {
      note: undefined, noEquipmentConfirmed: false,
    });
  });

  it("SCRUM489_AC3_a_refusal_reaches_the_caller_unchanged", async () => {
    const refusal = Object.assign(new Error("HTTP 409"), {
      response: { status: 409, data: { code: "EVENT_NOT_READY", conflicts: CHECKLIST.items } },
    });
    vi.mocked(apiClient.post).mockRejectedValue(refusal);

    await expect(submitForSafetyReview(EVENT_ID, {})).rejects.toBe(refusal);
  });
});
