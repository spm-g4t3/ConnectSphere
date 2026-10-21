// equipmentQueueRouteGuard.test.jsx
//
// SCRUM-287, AC1 of SCRUM-284: only Technical Support Staff open the equipment
// request queue at /equipment. Renders the REAL App, as equipmentRouteGuard.test.jsx
// does, so it pins App.jsx's actual route table. Only the auth context and the
// queue component are mocked; the real ProtectedRoute and /unauthorized page run.
// The backend's technicalSupportOnly is what refuses the data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/components/EquipmentRequestQueue", () => ({
  default: () => <p data-testid="queue-stub">Equipment request queue</p>,
}));

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM-284 AC1: /equipment is for Technical Support Staff only", () => {
  it("SCRUM284_AC1_technical_support_staff_open_the_queue_under_its_own_heading", () => {
    renderAppAt("/equipment", "technical_support_staff");

    expect(screen.getByTestId("queue-stub")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Equipment request queue" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/equipment");
  });

  it.each([
    "event_organiser",
    "event_coordinator",
    "venue_staff",
    "attendee",
    "event_coordinator_lead",
    "safety_officer",
  ])("SCRUM284_AC1_sends_%s_to_unauthorized", (role) => {
    renderAppAt("/equipment", role);

    expect(screen.queryByTestId("queue-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/unauthorized");
  });

  it("SCRUM284_AC1_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt("/equipment", null);

    expect(screen.queryByTestId("queue-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
