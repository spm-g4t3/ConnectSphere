// venueService.blocks.test.js
//
// SCRUM-127 (part of SCRUM-17, AC1, AC3, AC4). The four block calls in
// venueService. apiClient is mocked, so nothing touches the network. Each call
// must hit the documented path, pass its body through untouched (override
// fields included), hand back response.data, and let errors through as-is.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  createVenueBlock,
  getVenueBlockHistory,
  listVenueBlocks,
  removeVenueBlock,
  updateVenueBlock,
} from "../../src/services/venueService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const BLOCK_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";

const BLOCK = {
  id: BLOCK_ID,
  venueId: VENUE_ID,
  startsAt: "2026-11-01T09:00:00+08:00",
  endsAt: "2026-11-01T17:00:00+08:00",
  reason: "maintenance",
  notes: null,
};

function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });
}

beforeEach(() => {
  for (const method of ["get", "post", "patch", "delete"]) {
    vi.mocked(apiClient[method]).mockReset();
  }
});

describe("listVenueBlocks", () => {
  it("SCRUM17_AC1_gets_the_venue_blocks_path_and_returns_the_body", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [BLOCK] });

    await expect(listVenueBlocks(VENUE_ID)).resolves.toEqual([BLOCK]);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks`);
  });

  it("lets an error through unchanged", async () => {
    const err = httpError(403);
    vi.mocked(apiClient.get).mockRejectedValue(err);
    await expect(listVenueBlocks(VENUE_ID)).rejects.toBe(err);
  });
});

describe("createVenueBlock", () => {
  it("SCRUM17_AC1_posts_the_input_unchanged_and_returns_the_body", async () => {
    const input = {
      startsAt: BLOCK.startsAt,
      endsAt: BLOCK.endsAt,
      reason: "maintenance",
      notes: "Aircon",
    };
    const body = { block: BLOCK, flaggedBookings: [] };
    vi.mocked(apiClient.post).mockResolvedValue({ data: body });

    await expect(createVenueBlock(VENUE_ID, input)).resolves.toBe(body);

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks`, input);
    expect(apiClient.post.mock.calls[0][1]).toBe(input);
  });

  it("SCRUM17_AC3_passes_the_override_fields_through", async () => {
    const input = {
      startsAt: BLOCK.startsAt,
      endsAt: BLOCK.endsAt,
      reason: "safety",
      confirmOverride: true,
      acknowledgedBookingIds: ["a1b2c3d4-0000-4000-8000-000000000001"],
    };
    vi.mocked(apiClient.post).mockResolvedValue({ data: { block: BLOCK, flaggedBookings: [] } });

    await createVenueBlock(VENUE_ID, input);

    expect(apiClient.post).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks`, {
      startsAt: BLOCK.startsAt,
      endsAt: BLOCK.endsAt,
      reason: "safety",
      confirmOverride: true,
      acknowledgedBookingIds: ["a1b2c3d4-0000-4000-8000-000000000001"],
    });
  });

  it("lets a 409 through with its response intact", async () => {
    const err = httpError(409, { code: "BLOCK_BOOKING_CONFLICT", conflicts: [] });
    vi.mocked(apiClient.post).mockRejectedValue(err);
    await expect(createVenueBlock(VENUE_ID, {})).rejects.toBe(err);
  });
});

describe("updateVenueBlock", () => {
  it("SCRUM17_AC4_patches_the_block_path_with_the_changes_and_returns_the_body", async () => {
    const changes = { endsAt: "2026-11-02T17:00:00+08:00", notes: null };
    const body = { block: { ...BLOCK, ...changes }, flaggedBookings: [] };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: body });

    await expect(updateVenueBlock(VENUE_ID, BLOCK_ID, changes)).resolves.toBe(body);

    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    expect(apiClient.patch).toHaveBeenCalledWith(
      `/venues/${VENUE_ID}/blocks/${BLOCK_ID}`,
      { endsAt: "2026-11-02T17:00:00+08:00", notes: null },
    );
  });

  it("SCRUM17_AC3_passes_the_override_fields_through", async () => {
    const changes = {
      endsAt: "2026-11-02T17:00:00+08:00",
      confirmOverride: true,
      acknowledgedBookingIds: ["b1"],
    };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: {} });

    await updateVenueBlock(VENUE_ID, BLOCK_ID, changes);

    expect(apiClient.patch.mock.calls[0][1]).toEqual({
      endsAt: "2026-11-02T17:00:00+08:00",
      confirmOverride: true,
      acknowledgedBookingIds: ["b1"],
    });
  });

  it("lets an error through unchanged", async () => {
    const err = httpError(409, { code: "BLOCK_ENDED" });
    vi.mocked(apiClient.patch).mockRejectedValue(err);
    await expect(updateVenueBlock(VENUE_ID, BLOCK_ID, {})).rejects.toBe(err);
  });
});

describe("removeVenueBlock", () => {
  it("SCRUM17_AC4_deletes_the_block_path_and_resolves_undefined", async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ status: 204, data: "" });

    await expect(removeVenueBlock(VENUE_ID, BLOCK_ID)).resolves.toBeUndefined();

    expect(apiClient.delete).toHaveBeenCalledTimes(1);
    expect(apiClient.delete).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks/${BLOCK_ID}`);
  });

  it("lets an error through unchanged", async () => {
    const err = httpError(404);
    vi.mocked(apiClient.delete).mockRejectedValue(err);
    await expect(removeVenueBlock(VENUE_ID, BLOCK_ID)).rejects.toBe(err);
  });
});

describe("listVenueBlocks with a window (SCRUM-130)", () => {
  const FROM = "2026-11-01T00:00:00+08:00";
  const TO = "2026-12-01T00:00:00+08:00";

  it("SCRUM17_AC2_sends_the_window_as_params", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [BLOCK] });

    await expect(listVenueBlocks(VENUE_ID, { from: FROM, to: TO })).resolves.toEqual([BLOCK]);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks`, {
      params: { from: FROM, to: TO },
    });
  });

  it("SCRUM17_AC2_no_window_makes_a_one_argument_call", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await listVenueBlocks(VENUE_ID);

    expect(apiClient.get.mock.calls[0]).toHaveLength(1);
    expect(apiClient.get.mock.calls[0][0]).toBe(`/venues/${VENUE_ID}/blocks`);
  });

  it("SCRUM17_AC2_an_empty_window_object_makes_a_one_argument_call", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await listVenueBlocks(VENUE_ID, {});

    expect(apiClient.get.mock.calls[0]).toHaveLength(1);
    expect(apiClient.get.mock.calls[0][0]).toBe(`/venues/${VENUE_ID}/blocks`);
  });

  it("SCRUM17_AC2_blank_window_values_make_a_one_argument_call", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await listVenueBlocks(VENUE_ID, { from: "", to: undefined });

    expect(apiClient.get.mock.calls[0]).toHaveLength(1);
  });

  it("SCRUM17_AC2_a_one_sided_window_is_forwarded_for_the_backend_to_judge", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });

    await listVenueBlocks(VENUE_ID, { from: FROM });

    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks`, { params: { from: FROM } });
  });

  it("lets a windowed error through unchanged", async () => {
    const err = httpError(400, { details: [{ field: "to", message: "must be within 400 days of the start" }] });
    vi.mocked(apiClient.get).mockRejectedValue(err);
    await expect(listVenueBlocks(VENUE_ID, { from: FROM, to: TO })).rejects.toBe(err);
  });
});

describe("getVenueBlockHistory (SCRUM-131)", () => {
  const ENTRY = {
    id: "c1000000-0000-4000-8000-000000000001",
    blockId: BLOCK_ID,
    action: "amended",
    changedBy: "d1000000-0000-4000-8000-000000000001",
    changedAt: "2026-11-01T10:00:00+08:00",
    oldValues: { ends_at: "2026-11-01T17:00:00+08:00" },
    newValues: { ends_at: "2026-11-02T17:00:00+08:00" },
  };

  it("SCRUM17_AC4_gets_the_block_history_path_and_returns_the_body", async () => {
    const body = [ENTRY];
    vi.mocked(apiClient.get).mockResolvedValue({ data: body });

    await expect(getVenueBlockHistory(VENUE_ID, BLOCK_ID)).resolves.toBe(body);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/venues/${VENUE_ID}/blocks/${BLOCK_ID}/history`);
    expect(apiClient.get.mock.calls[0]).toHaveLength(1);
  });

  it("SCRUM17_AC4_returns_an_empty_history_as_is", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await expect(getVenueBlockHistory(VENUE_ID, BLOCK_ID)).resolves.toEqual([]);
  });

  for (const status of [400, 401, 403, 404, 500]) {
    it(`SCRUM17_AC4_lets_a_${status}_through_unchanged`, async () => {
      const err = httpError(status, { error: "nope" });
      vi.mocked(apiClient.get).mockRejectedValue(err);
      await expect(getVenueBlockHistory(VENUE_ID, BLOCK_ID)).rejects.toBe(err);
    });
  }

  it("SCRUM17_AC4_lets_a_network_error_through_unchanged", async () => {
    const err = new Error("Network Error");
    vi.mocked(apiClient.get).mockRejectedValue(err);
    await expect(getVenueBlockHistory(VENUE_ID, BLOCK_ID)).rejects.toBe(err);
  });
});
