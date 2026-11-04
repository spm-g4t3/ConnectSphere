// scrum395EventRequestService.test.js
//
// SCRUM-395: the significant change preview and apply. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  applySignificantEventChange,
  previewSignificantEventChange,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM395 event request service", () => {
  it("SCRUM395_AC3_the_preview_posts_only_the_changes_to_the_impact_endpoint", async () => {
    const impact = { venueFlagged: true, attendeesNotified: 4 };
    vi.mocked(apiClient.post).mockResolvedValue({ data: impact });
    const changes = { expectedAttendance: 200 };

    await expect(previewSignificantEventChange(EVENT_ID, changes)).resolves.toBe(impact);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/${EVENT_ID}/significant-change-impact`,
      { changes },
    );
  });

  it("SCRUM395_AC4_applying_posts_the_changes_reason_and_previewed_impact_only", async () => {
    const updated = { id: EVENT_ID, status: "approved" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: updated });
    const body = {
      changes: { expectedAttendance: 200 },
      reason: "More sign-ups",
      expectedImpact: { venueFlagged: true },
    };

    await expect(applySignificantEventChange(EVENT_ID, { ...body, confirmed: true })).resolves.toBe(updated);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/significant-change`, body);
  });
});
