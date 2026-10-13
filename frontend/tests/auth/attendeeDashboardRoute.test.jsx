// attendeeDashboardRoute.test.jsx
//
// SCRUM-453 / SCRUM-457. Renders the REAL App with the REAL AuthProvider,
// Dashboard, Navigation and normaliseRole, so login, redirect, role map and
// nav all run as shipped. Only the network edge (apiClient) and the four
// other roles' dashboard bodies are stubbed: those bodies fetch their own
// data, and the question here is which dashboard is chosen, not what is in it.
// No live credentials or backend are involved.
//
// SCRUM453_AC1: logging in as an Attendee routes to a dedicated dashboard.
// SCRUM453_AC2: the dashboard offers navigation to Browse Open Events.
// SCRUM453_AC3: any other role is refused the attendee dashboard.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App.jsx";
import { apiClient } from "../../src/services/apiClient";

vi.mock("../../src/services/apiClient", () => {
  const client = { post: vi.fn(), get: vi.fn() };
  return { apiClient: client, default: client };
});

vi.mock("../../src/components/EventOrganiserDashboard", () => ({
  default: () => <p data-testid="organiser-dashboard">Organiser dashboard</p>,
}));
vi.mock("../../src/components/EventCoordinatorDashboard", () => ({
  default: () => <p data-testid="coordinator-dashboard">Coordinator dashboard</p>,
}));
vi.mock("../../src/components/VenueStaffDashboard", () => ({
  default: () => <p data-testid="venue-staff-dashboard">Venue staff dashboard</p>,
}));
vi.mock("../../src/components/TechnicalSupportDashboard", () => ({
  default: () => <p data-testid="tech-support-dashboard">Technical support dashboard</p>,
}));

const STORAGE_KEY = "connectsphere_auth";

const OTHER_ROLES = [
  ["event_organiser", "organiser-dashboard"],
  ["event_coordinator", "coordinator-dashboard"],
  ["venue_staff", "venue-staff-dashboard"],
  ["technical_support_staff", "tech-support-dashboard"],
];
const OTHER_DASHBOARD_IDS = OTHER_ROLES.map(([, id]) => id);

function renderAppAt(path) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

function restoreSession(role) {
  sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      user: { id: "u1", email: "person@example.com", role },
      session: { access_token: "test-token" },
    }),
  );
}

async function logInAs(role) {
  vi.mocked(apiClient.post).mockResolvedValue({
    data: {
      user: { id: "u1", email: "person@example.com", role },
      session: { access_token: "test-token" },
    },
  });
  renderAppAt("/login");

  await userEvent.type(await screen.findByLabelText("Email"), "person@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "not-a-real-password");
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
}

function expectNoOtherDashboard() {
  for (const id of OTHER_DASHBOARD_IDS) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(apiClient.get).mockReset();
});

describe("SCRUM453_AC1 logging in routes each role to its own dashboard", () => {
  it("SCRUM453_AC1_attendee_login_lands_on_the_attendee_dashboard", async () => {
    await logInAs("attendee");

    const heading = await screen.findByRole("heading", { name: "Welcome, person@example.com" });
    expect(heading.closest(".dashboard")).toHaveClass("dashboard--attendee");
    expect(window.location.pathname).toBe("/dashboard");
    expect(apiClient.post).toHaveBeenCalledWith("/auth/login", {
      email: "person@example.com",
      password: "not-a-real-password",
    });
    expectNoOtherDashboard();
  });

  it.each(["Attendee", " ATTENDEE "])(
    "SCRUM453_AC1_attendee_role_spelled_%j_still_reaches_the_attendee_dashboard",
    async (spelling) => {
      await logInAs(spelling);

      const heading = await screen.findByRole("heading", { name: "Welcome, person@example.com" });
      expect(heading.closest(".dashboard")).toHaveClass("dashboard--attendee");
      expectNoOtherDashboard();
    },
  );

  it("SCRUM453_AC1_a_restored_attendee_session_opens_the_attendee_dashboard", async () => {
    restoreSession("attendee");
    const { container } = renderAppAt("/dashboard");

    expect(await screen.findByRole("heading", { name: /^Welcome,/ })).toBeInTheDocument();
    expect(container.querySelector(".dashboard--attendee")).toBeInTheDocument();
  });

  it.each(OTHER_ROLES)(
    "SCRUM453_AC1_%s_login_keeps_its_own_dashboard_and_never_gets_the_attendee_one",
    async (role, dashboardId) => {
      await logInAs(role);

      expect(await screen.findByTestId(dashboardId)).toBeInTheDocument();
      expect(window.location.pathname).toBe("/dashboard");
      expect(document.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
      for (const id of OTHER_DASHBOARD_IDS.filter((other) => other !== dashboardId)) {
        expect(screen.queryByTestId(id)).not.toBeInTheDocument();
      }
    },
  );
});

describe("SCRUM453_AC2 the Attendee dashboard and nav", () => {
  it("SCRUM453_AC2_nav_gives_the_attendee_only_their_own_dashboard_link", async () => {
    restoreSession("attendee");
    renderAppAt("/dashboard");

    const nav = await screen.findByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/dashboard"]);
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toHaveClass("app-nav__link--active");
  });

  it("SCRUM453_AC2_dashboard_offers_Browse_Open_Events_and_links_to_no_staff_page", async () => {
    restoreSession("attendee");
    renderAppAt("/dashboard");

    expect(await screen.findByRole("heading", { name: "Browse Open Events" })).toBeInTheDocument();
    // Nothing on the page may lead an Attendee to a staff-facing screen.
    const main = document.querySelector(".dashboard--attendee");
    expect(within(main).queryAllByRole("link")).toHaveLength(0);
  });

  it("SCRUM453_AC2_Browse_Open_Events_is_not_offered_to_the_other_roles", async () => {
    for (const [role] of OTHER_ROLES) {
      sessionStorage.clear();
      restoreSession(role);
      const { unmount } = renderAppAt("/dashboard");

      await screen.findByRole("navigation");
      expect(screen.queryByRole("link", { name: /browse open events/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  // Blocked on SCRUM-495: it has no route yet, and /events is the Organiser's
  // page. Once it registers a path, assert the dashboard link and the nav link
  // both point at it, and that the route is guarded for "attendee" only.
  it.todo("SCRUM453_AC2_Browse_Open_Events_link_reaches_the_SCRUM-495_page");
});

describe("SCRUM453_AC3 other roles, unknown roles and signed-out visitors", () => {
  it.each(OTHER_ROLES)(
    "SCRUM453_AC3_%s_at_/dashboard_sees_their_own_view_and_no_attendee_content",
    async (role, dashboardId) => {
      restoreSession(role);
      renderAppAt("/dashboard");

      expect(await screen.findByTestId(dashboardId)).toBeInTheDocument();
      expect(document.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Browse Open Events" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["an unknown role", "guest"],
    ["a blank role", ""],
    ["a missing role", undefined],
  ])("SCRUM453_AC3_%s gets the no-dashboard fallback, not the attendee dashboard", async (_label, role) => {
    restoreSession(role);
    renderAppAt("/dashboard");

    expect(await screen.findByText(/No dashboard available for your role/)).toBeInTheDocument();
    expect(document.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
    expectNoOtherDashboard();
    expect(within(screen.getByRole("navigation")).queryAllByRole("link")).toHaveLength(0);
  });

  it("SCRUM453_AC3_a_signed_out_visitor_is_sent_to_login", async () => {
    renderAppAt("/dashboard");

    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(document.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
  });
});

describe("SCRUM453 existing roles keep their navigation", () => {
  it.each([
    ["event_organiser", ["/dashboard", "/events"]],
    ["event_coordinator", ["/dashboard", "/my-events", "/my-venue-requests", "/review-queue", "/venue-search"]],
    ["venue_staff", ["/dashboard", "/venue-catalogue", "/booking-requests"]],
    [
      "technical_support_staff",
      ["/dashboard", "/tickets", "/equipment", "/equipment-catalogue", "/equipment-availability"],
    ],
  ])("SCRUM453_%s_nav_is_unchanged", async (role, hrefs) => {
    restoreSession(role);
    renderAppAt("/dashboard");

    const nav = await screen.findByRole("navigation");
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(hrefs);
  });
});
