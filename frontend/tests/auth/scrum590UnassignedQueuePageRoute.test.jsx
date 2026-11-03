// scrum590UnassignedQueuePageRoute.test.jsx
//
// Pins App.jsx's `<UnassignedQueue asPage />`: the component tests render the
// queue with asPage themselves, so only the real route can show the page lost
// its h1. Auth and the reads are mocked; App, Navigation and the queue are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { listUnassignedEventRequests } from "../../src/services/eventRequestService";
import { getUnreadCount } from "../../src/services/notificationService";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  listUnassignedEventRequests: vi.fn(),
}));

vi.mock("../../src/services/notificationService", async (importOriginal) => ({
  ...(await importOriginal()),
  getUnreadCount: vi.fn(),
}));

const WAITING = [
  { id: "r1", eventName: "IS212 Industry Night", organiserName: "Aisha Rahman", submittedAt: "2026-10-01T00:00:00Z" },
  { id: "r2", eventName: "Freshers Welcome", organiserName: "Ben Lim", submittedAt: "2026-10-02T00:00:00Z" },
];

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(listUnassignedEventRequests).mockReset().mockResolvedValue(WAITING);
  vi.mocked(getUnreadCount).mockReset().mockResolvedValue(0);
});

describe("SCRUM590_AC2 /unassigned-queue", () => {
  it("SCRUM590_AC2_the_unassigned_queue_route_renders_one_h1_with_the_count", async () => {
    renderAppAt("/unassigned-queue", "event_coordinator_lead");

    await screen.findByText("IS212 Industry Night");
    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveAccessibleName("Unassigned queue (2)");
  });
});
