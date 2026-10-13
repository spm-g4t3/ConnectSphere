// Dashboard.test.jsx
//
// SCRUM-485 (SCRUM-509), AC3 and AC6: which dashboard each role lands on.
//
// Dashboard.jsx picks a page by DASHBOARD_BY_ROLE[normaliseRole(user.role)].
// When that lookup misses, it throws nothing: it shows "No dashboard available
// for your role". So a misspelt key looks exactly like a user with no role,
// and only a test that asserts each role's own page notices. That is this
// file's main job.
//
// Since the merge of dev on 11 October this file also holds SCRUM-453's own
// tests of the Attendee dashboard (SCRUM-454, SCRUM-456), kept as David wrote
// them, at the end. Both stories created a Dashboard.test.jsx; one file holds
// both. This story's helper is renderDashboardAs, so his renderAs is unchanged.
//
// The two new dashboards render for real, and so does AttendeeDashboard: it
// fetches nothing, and SCRUM-453's tests below assert its real content. The
// four dashboards that predate both stories are stubs:
// what is under test is Dashboard.jsx's choice of page, and the real pages
// fetch on mount (TechnicalSupportDashboard calls supportService, the
// Coordinator's sections call the API), which would make this a test of four
// other screens. Their own tests cover them.
//
// "No service is called" (AC3-08) is asserted at the one place every real
// service makes its HTTP call, apiClient, plus supportService, the one stub
// that does not go through it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Dashboard from "../../src/components/Dashboard.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { apiClient } from "../../src/services/apiClient";
import { getOpenTickets, getEquipmentRequests } from "../../src/services/supportService";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/apiClient", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/services/supportService", () => ({
  getOpenTickets: vi.fn(),
  getEquipmentRequests: vi.fn(),
}));

vi.mock("../../src/components/EventOrganiserDashboard", () => ({
  default: () => <p data-testid="dashboard-stub">Organiser dashboard</p>,
}));
vi.mock("../../src/components/EventCoordinatorDashboard", () => ({
  default: () => <p data-testid="dashboard-stub">Coordinator dashboard</p>,
}));
vi.mock("../../src/components/VenueStaffDashboard", () => ({
  default: () => <p data-testid="dashboard-stub">Venue Staff dashboard</p>,
}));
vi.mock("../../src/components/TechnicalSupportDashboard", () => ({
  default: () => <p data-testid="dashboard-stub">Technical Support dashboard</p>,
}));

const NO_DASHBOARD = "No dashboard available for your role. Please contact support.";
// SCRUM-487 (SCRUM-544): the overview is built; the placeholder sentence is replaced.
const NEW_OVERVIEW_TEXT =
  "See every coordinator's events and workload, and filter them, in Assigned Events.";

// In a MemoryRouter since SCRUM-486 AC6: the Lead's overview card holds a
// router Link to /assigned-events, which cannot render outside a router (the
// app always has one). No other dashboard reads the router, so for them it
// changes nothing.
const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

function renderDashboardAs(role) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", email: "someone@example.com", role } });
  return inRouter(<Dashboard />);
}

function anyServiceCalled() {
  return [
    ...Object.values(apiClient),
    getOpenTickets,
    getEquipmentRequests,
  ].some((fn) => vi.mocked(fn).mock.calls.length > 0);
}

beforeEach(() => {
  vi.clearAllMocks();
});


describe("SCRUM485_AC3 each new role lands on its own dashboard", () => {
  it("SCRUM486_AC6_an_event_coordinator_lead_gets_the_lead_dashboard_whose_overview_links_to_assigned_events", () => {
    // SCRUM-485 AC3-04, and AC1-04: the heading names the role exactly.
    //
    // Was SCRUM485_AC3_an_event_coordinator_lead_gets_the_lead_dashboard,
    // which asserted /built by SCRUM-487/ on the overview card, whose sentence
    // ended "until then there is nothing to show". Right when written: no
    // screen listed any coordinator's events. SCRUM-486 AC6 built Assigned
    // Events, which lists every event a coordinator holds, so that sentence
    // became false; the card now points there and keeps SCRUM-487 for the
    // full overview. Renamed so the name says what it pins.
    renderDashboardAs("event_coordinator_lead");

    expect(screen.getByRole("heading", { level: 1, name: "Event Coordinator Lead" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Unassigned queue" })).toBeInTheDocument();
    const overview = screen.getByRole("heading", { level: 2, name: "Coordinator overview" }).closest("section");
    // This used to assert "built by SCRUM-486" too, right while the queue was
    // a placeholder; SCRUM-519 built it, so its absence is pinned.
    expect(screen.queryByText(/built by SCRUM-486/)).not.toBeInTheDocument();
    expect(overview.querySelector("p")).toHaveTextContent(NEW_OVERVIEW_TEXT);
    expect(screen.queryByText(/nothing to show/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Assigned Events" })).toHaveAttribute("href", "/assigned-events");
  });

  it("SCRUM485_AC3_a_safety_officer_gets_the_safety_officer_dashboard", () => {
    // AC3-05, and AC1-04.
    renderDashboardAs("safety_officer");

    expect(screen.getByRole("heading", { level: 1, name: "Safety Officer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Safety review list" })).toBeInTheDocument();
    expect(screen.getByText(/built by SCRUM-490/)).toBeInTheDocument();
  });

  it.each(["event_coordinator_lead", "safety_officer"])(
    "SCRUM485_AC3_%s_never_sees_no_dashboard_available",
    (role) => {
      // AC3-06. The silent-failure case: a misspelt key in DASHBOARD_BY_ROLE
      // would show this message and throw nothing.
      renderDashboardAs(role);

      expect(screen.queryByText(NO_DASHBOARD)).not.toBeInTheDocument();
    },
  );

  it("SCRUM485_AC3_a_lead_does_not_get_the_coordinator_dashboard", () => {
    // AC3-07. EVENT_COORDINATOR_LEAD is not EVENT_COORDINATOR; the Lead
    // inherits nothing from Event Coordinator.
    renderDashboardAs("event_coordinator_lead");

    expect(screen.queryByText("Coordinator dashboard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-stub")).not.toBeInTheDocument();
  });

  it.each(["safety_officer"])(
    "SCRUM485_AC3_the_%s_dashboard_calls_no_service",
    (role) => {
      // AC3-08. The Safety Officer's section has no endpoint yet; a call to
      // one that does not exist would fail at every demo.
      //
      // The event_coordinator_lead row was right when written: the Lead's
      // sections had no endpoint either. SCRUM-486 (SCRUM-519) built the
      // queue's and mounted the notifications card, so the Lead's dashboard
      // now reads exactly those two; the case below pins that.
      renderDashboardAs(role);

      expect(anyServiceCalled()).toBe(false);
    },
  );

  it("SCRUM486_AC2_the_lead_dashboard_reads_only_the_unassigned_queue_and_its_notifications", () => {
    // Every call the Lead's dashboard makes on render, and nothing else: no
    // write, no coordinator queue, no "my events", no support stub. Each read
    // is one that exists and that the Lead is allowed.
    renderDashboardAs("event_coordinator_lead");

    expect(vi.mocked(apiClient.get).mock.calls.map(([path]) => path).sort()).toEqual([
      "/event-requests/unassigned",
      "/notifications",
    ]);
    for (const method of ["post", "put", "patch", "delete"]) {
      expect(apiClient[method]).not.toHaveBeenCalled();
    }
    expect(getOpenTickets).not.toHaveBeenCalled();
    expect(getEquipmentRequests).not.toHaveBeenCalled();
  });

  it.each(["safety_officer"])(
    "SCRUM485_AC3_the_%s_dashboard_has_no_link_to_a_page_that_does_not_exist",
    (role) => {
      // No link: App.jsx has no route for the Safety Officer's section yet.
      //
      // The event_coordinator_lead row moved to the case below. It was right
      // when written: the Lead's dashboard had no link, since the queue is
      // mounted on it and its Assign actions are buttons. SCRUM-486 AC6 gave
      // the overview card a link to Assigned Events, a page that exists.
      renderDashboardAs(role);

      expect(screen.queryAllByRole("link")).toHaveLength(0);
    },
  );

  it("SCRUM486_AC6_the_lead_dashboards_one_link_is_to_assigned_events", () => {
    // The Lead's row of the case above, carried on: still no link to a page
    // that does not exist. Exactly one link, to /assigned-events, which
    // App.jsx routes (SCRUM-486 AC6).
    renderDashboardAs("event_coordinator_lead");

    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/assigned-events"]);
  });

  it.each([
    ["Safety Officer", "Safety Officer"],
    ["safety-officer", "Safety Officer"],
    ["SAFETY_OFFICER", "Safety Officer"],
    ["EVENT_COORDINATOR_LEAD", "Event Coordinator Lead"],
    ["event coordinator lead", "Event Coordinator Lead"],
    ["  event_coordinator_lead  ", "Event Coordinator Lead"],
  ])("SCRUM485_AC3_the_role_spelt_%j_reaches_the_%s_dashboard", (spelling, heading) => {
    // normaliseRole absorbs case, spaces, hyphens and surrounding whitespace,
    // as it does for every role.
    renderDashboardAs(spelling);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
  });

  it("SCRUM485_AC3_shows_the_email_when_the_user_has_no_name", () => {
    // Login returns no name, so the email stands in. A name, if one is ever
    // sent, is used instead.
    vi.mocked(useAuth).mockReturnValue({ user: { email: "lead@example.com", role: "event_coordinator_lead" } });
    const { unmount } = inRouter(<Dashboard />);
    expect(screen.getByText("Signed in as lead@example.com.")).toBeInTheDocument();
    unmount();

    vi.mocked(useAuth).mockReturnValue({ user: { name: "Priya Nair", email: "so@example.com", role: "safety_officer" } });
    render(<Dashboard />);
    expect(screen.getByText("Signed in as Priya Nair.")).toBeInTheDocument();
  });
});


describe("SCRUM485_AC6 the existing roles land where they did", () => {
  it.each([
    ["event_organiser", "Organiser dashboard"],
    ["event_coordinator", "Coordinator dashboard"],
    ["venue_staff", "Venue Staff dashboard"],
    ["technical_support_staff", "Technical Support dashboard"],
  ])("SCRUM485_AC6_%s_still_gets_the_%s", (role, stub) => {
    // AC6-03. The same page for each, and only that page.
    renderDashboardAs(role);

    expect(screen.getByTestId("dashboard-stub")).toHaveTextContent(stub);
    expect(screen.getAllByTestId("dashboard-stub")).toHaveLength(1);
    expect(screen.queryByText(NO_DASHBOARD)).not.toBeInTheDocument();
  });

  it("SCRUM485_AC6_an_attendee_gets_the_attendee_dashboard_scrum485_left_it_as_scrum453_built_it", () => {
    // AC6-06. When this story began an attendee had no dashboard, and this
    // case pinned that. SCRUM-453 (merged into dev on 11 October) gave the
    // Attendee one. That is another story's change, not one this story made:
    // what AC6 asks of SCRUM-485 is that it leaves the Attendee as it finds it,
    // which is now SCRUM-453's dashboard, and not the fallback or a new role's.
    const { container } = renderDashboardAs("attendee");

    expect(container.querySelector(".dashboard--attendee")).toBeInTheDocument();
    expect(screen.queryByText(NO_DASHBOARD)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Event Coordinator Lead" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Safety Officer" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-stub")).not.toBeInTheDocument();
  });

  it("SCRUM485_AC6_a_misspelt_role_still_falls_back_to_the_message", () => {
    // The failure mode the tests above guard against, shown once so it is on
    // record: no error, just the message.
    renderDashboardAs("saftey_officer");

    expect(screen.getByText(NO_DASHBOARD)).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-453 (SCRUM-454, SCRUM-456): the Attendee dashboard
// ---------------------------------------------------------------------------
// From dev's Dashboard.test.jsx, unchanged. Its header read: "The role-to-
// dashboard map: an Attendee reaches the Attendee dashboard, and a role with no
// entry still gets the fallback rather than someone else's view." Its imports
// and its AuthContext mock are the same as this file's, so they are not
// repeated.

function renderAs(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", email: "user@example.com", role },
  });
  return render(<Dashboard />);
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("Dashboard role map", () => {
  it("renders the Attendee dashboard for an attendee", () => {
    const { container } = renderAs("attendee");

    expect(container.querySelector(".dashboard--attendee")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome, user@example.com" })).toBeInTheDocument();
  });

  it("shows the Browse Open Events entry, with no invented event data", () => {
    renderAs("attendee");

    expect(screen.getByRole("heading", { name: "Browse Open Events" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("not available yet");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("falls back for an unrecognised role", () => {
    const { container } = renderAs("guest");

    expect(container.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
    expect(screen.getByText(/No dashboard available for your role/)).toBeInTheDocument();
  });
});
