// scrum487AssignedEventsRoute.test.jsx
//
// SCRUM-487 AC1 (SCRUM-546): only the Lead opens the coordinator overview.
// The backend refuses everyone else (SCRUM487_AC1_%s_is_refused_the_
// coordinator_overview_with_403_and_queries_nothing); this is the second
// layer, App.jsx's route table, rendered for real as unassignedQueueRoute
// .test.jsx does: only the auth context and the page itself are mocked, and
// the real ProtectedRoute, Navigation and /unauthorized page run. AC1-06, who
// is offered the link, is read off the same rendered nav, for every role.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/components/AssignedEvents", () => ({
  default: function AssignedEventsStub() {
    return <p data-testid="assigned-events-stub">Assigned events</p>;
  },
}));

const NOT_A_LEAD = ["event_coordinator", "event_organiser", "venue_staff", "technical_support_staff", "attendee", "safety_officer"];

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM487_AC1 only the Lead opens the overview", () => {
  it("SCRUM487_AC1_the_lead_opens_the_overview_and_is_offered_its_link", () => {
    // AC1-05, AC1-06: the page mounts, and the Lead's nav links to it.
    renderAppAt("/assigned-events", "event_coordinator_lead");

    expect(screen.getByTestId("assigned-events-stub")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/assigned-events");
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByRole("link", { name: "Assigned Events" })).toHaveAttribute("href", "/assigned-events");
  });

  it.each(NOT_A_LEAD)("SCRUM487_AC1_sends_%s_to_unauthorized_and_never_mounts_the_overview", (role) => {
    // AC1-05. A coordinator too: every coordinator's caseload is the Lead's
    // to supervise, and coordinators have the shared queue and My events.
    renderAppAt("/assigned-events", role);

    expect(screen.queryByTestId("assigned-events-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/unauthorized");
  });

  it("SCRUM487_AC1_sends_a_signed_out_visitor_to_login", () => {
    renderAppAt("/assigned-events", null);

    expect(screen.queryByTestId("assigned-events-stub")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });

  it.each(NOT_A_LEAD)("SCRUM487_AC1_%s_is_not_offered_the_overview_in_the_nav", (role) => {
    // AC1-06. Read off the nav each role is shown, on the page that turns
    // them away: no link to the overview, by name or by address.
    renderAppAt("/assigned-events", role);

    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: "Assigned Events" })).not.toBeInTheDocument();
    expect(within(nav).queryAllByRole("link").map((link) => link.getAttribute("href"))).not.toContain("/assigned-events");
  });
});
