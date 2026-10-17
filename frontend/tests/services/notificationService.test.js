// notificationService.test.js
//
// SCRUM-128 (part of SCRUM-17, AC3). The two calls the Coordinator's
// notifications card makes. apiClient is mocked, so nothing touches the
// network; the backend scopes both calls to the token, so neither sends a
// user id.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from "../../src/services/notificationService.js";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), patch: vi.fn() },
}));

const ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const NOTIFICATION = {
  id: ID,
  type: "booking_flagged",
  bookingId: "a1b2c3d4-0000-4000-8000-000000000001",
  blockId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  payload: { venueName: "Hall A" },
  readAt: null,
  createdAt: "2026-09-26T11:00:00+08:00",
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.patch).mockReset();
});

describe("listNotifications", () => {
  it("SCRUM17_AC3_gets_/notifications_and_returns_the_body", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [NOTIFICATION] });

    await expect(listNotifications()).resolves.toEqual([NOTIFICATION]);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/notifications");
  });

  it("returns an empty list as it is", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
    await expect(listNotifications()).resolves.toEqual([]);
  });
});

describe("markNotificationRead", () => {
  it("SCRUM17_AC3_patches_/notifications/:id/read_with_no_body", async () => {
    const read = { ...NOTIFICATION, readAt: "2026-09-28T06:30:00.000Z" };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: read });

    await expect(markNotificationRead(ID)).resolves.toEqual(read);

    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    expect(apiClient.patch).toHaveBeenCalledWith(`/notifications/${ID}/read`);
  });
});

describe("getUnreadCount", () => {
  it("SCRUM172_AC4_get_unread_count_reads_the_count_endpoint", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { unreadCount: 73 } });

    await expect(getUnreadCount()).resolves.toBe(73);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/notifications/unread-count");
  });
});

// The callers read err.response.status, so each call must pass the error on
// as it came, not wrap it.
describe("errors", () => {
  it.each([
    ["listNotifications", 401, "get", () => listNotifications()],
    ["markNotificationRead", 404, "patch", () => markNotificationRead(ID)],
    ["getUnreadCount", 401, "get", () => getUnreadCount()],
  ])("%s lets a %s through with its response intact", async (_name, status, method, call) => {
    const err = httpError(status);
    vi.mocked(apiClient[method]).mockRejectedValue(err);

    await expect(call()).rejects.toBe(err);
  });
});
