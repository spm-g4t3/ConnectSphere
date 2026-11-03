// scrum586CoordinatorPageRoutes.test.jsx
//
// Pins App.jsx's `asPage` on the Coordinator's three list routes: the
// component tests pass asPage themselves, so only the real routes can show a
// page lost its h1. Auth and the reads are mocked; App, Navigation and the lists are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { getMyBookingRequests } from "../../src/services/bookingRequestService";
import { getEventRequestQueue, getMyAssignedEvents } from "../../src/services/eventRequestService";
import { getUnreadCount } from "../../src/services/notificationService";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/services/eventRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", async (importOriginal) => ({
  ...(await importOriginal()),
  getMyBookingRequests: vi.fn(),
}));

vi.mock("../../src/services/notificationService", async (importOriginal) => ({
  ...(await importOriginal()),
  getUnreadCount: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(getEventRequestQueue).mockReset().mockResolvedValue([]);
  vi.mocked(getMyAssignedEvents).mockReset().mockResolvedValue([]);
  vi.mocked(getMyBookingRequests).mockReset().mockResolvedValue([]);
  vi.mocked(getUnreadCount).mockReset().mockResolvedValue(0);
});

describe("SCRUM586_AC2 the Coordinator's list routes", () => {
  it.each([
    { path: "/review-queue", title: "Review queue", empty: "Nothing is waiting for review right now." },
    { path: "/my-events", title: "My events", empty: "No events are assigned to you right now." },
    { path: "/my-venue-requests", title: "Venue requests", empty: "You have not requested a venue yet." },
  ])("SCRUM586_AC2_the_route_renders_one_h1 ($path)", async ({ path, title, empty }) => {
    renderAppAt(path, "event_coordinator");

    await screen.findByText(empty);
    const titles = screen.getAllByRole("heading", { level: 1 });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveTextContent(title);
  });
});
