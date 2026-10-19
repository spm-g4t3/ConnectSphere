// equipmentReviewService.test.js
//
// SCRUM-296, for SCRUM-290. Each call goes to the right route and returns the
// response body unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiClient } from "../../src/services/apiClient";
import {
  clearEquipmentLineOutcome,
  completeEquipmentReview,
  getEquipmentReview,
  markEquipmentLineUnavailable,
  startEquipmentReview,
  takeOverEquipmentReview,
} from "../../src/services/equipmentReviewService";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const EVENT = "22222222-2222-4222-8222-222222222222";
const LINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BODY = { event: {}, request: {} };

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of ["get", "post", "put", "delete"]) apiClient[method].mockResolvedValue({ data: BODY });
});

describe("equipmentReviewService", () => {
  it("SCRUM290_AC4_service_reads_the_review", async () => {
    expect(await getEquipmentReview(EVENT)).toBe(BODY);
    expect(apiClient.get).toHaveBeenCalledWith(`/event-requests/${EVENT}/equipment-review`);
  });

  it("SCRUM290_AC2_service_start_and_take_over_post_with_no_body", async () => {
    await startEquipmentReview(EVENT);
    await takeOverEquipmentReview(EVENT);
    expect(apiClient.post).toHaveBeenNthCalledWith(1, `/event-requests/${EVENT}/equipment-review/start`);
    expect(apiClient.post).toHaveBeenNthCalledWith(2, `/event-requests/${EVENT}/equipment-review/take-over`);
  });

  it("SCRUM290_AC7_service_mark_sends_only_the_note", async () => {
    await markEquipmentLineUnavailable(EVENT, LINE, "None left");
    expect(apiClient.put).toHaveBeenCalledWith(`/event-requests/${EVENT}/equipment-review/lines/${LINE}/outcome`, {
      note: "None left",
    });
  });

  it("SCRUM290_AC7_service_clear_deletes_the_mark", async () => {
    await clearEquipmentLineOutcome(EVENT, LINE);
    expect(apiClient.delete).toHaveBeenCalledWith(`/event-requests/${EVENT}/equipment-review/lines/${LINE}/outcome`);
  });

  it("SCRUM290_AC7_service_complete_posts", async () => {
    expect(await completeEquipmentReview(EVENT)).toBe(BODY);
    expect(apiClient.post).toHaveBeenCalledWith(`/event-requests/${EVENT}/equipment-review/complete`);
  });
});
