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
