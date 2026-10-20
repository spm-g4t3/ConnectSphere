// Navigation.test.jsx
//
// Which links each role's nav renders. Pins the change that took "Find a
// Venue" away from Event Organisers: venue search is the Coordinator's
// planning tool, and an Organiser states venue needs on the request instead.
// Roles are written as the token sends them (lower snake case), so these tests
// also exercise normaliseRole's mapping onto the nav's keys.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Navigation from "../../src/components/Navigation.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { useUnreadCount } from "../../src/notifications/UnreadCountContext";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

// The count's own behaviour is tested in tests/notifications; here only what
// the nav does with a given count matters.
vi.mock("../../src/notifications/UnreadCountContext", () => ({
  useUnreadCount: vi.fn(),
}));

function renderAs(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { name: "Test User", role },
    logout: vi.fn().mockResolvedValue({ success: true }),
  });
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Navigation />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
  vi.mocked(useUnreadCount).mockReturnValue({ unreadCount: null, refreshUnreadCount: vi.fn() });
});

describe("Navigation links by role", () => {
  it("gives an Event Organiser Dashboard and My Events but no Find a Venue", () => {
    renderAs("event_organiser");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "My Events" })).toHaveAttribute("href", "/events");
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /venue/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Registration" })).toHaveAttribute("href", "/registration");
    expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(3);
  });

  it("treats the American spelling of organiser the same way", () => {
    renderAs("event_organizer");

    expect(screen.getByRole("link", { name: "My Events" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
  });

  it("keeps Find a Venue for an Event Coordinator, pointing at /venue-search", () => {
    renderAs("event_coordinator");

    expect(screen.getByRole("link", { name: "Find a Venue" })).toHaveAttribute("href", "/venue-search");
    expect(screen.getByRole("link", { name: "Review Queue" })).toHaveAttribute("href", "/review-queue");
  });

  it("SCRUM255_gives_only_an_Event_Coordinator_the_Venue_Requests_link", () => {
    renderAs("event_coordinator");
    expect(screen.getByRole("link", { name: "Venue Requests" })).toHaveAttribute("href", "/my-venue-requests");
  });

  it.each(["event_organiser", "venue_staff", "technical_support_staff"])(
    "SCRUM255_does_not_show_the_Venue_Requests_link_to_%s",
    (role) => {
      renderAs(role);
      expect(screen.queryByRole("link", { name: "Venue Requests" })).not.toBeInTheDocument();
    },
  );
  it("gives Venue Staff no Find a Venue link", () => {
    renderAs("venue_staff");

    expect(screen.getByRole("link", { name: "Venue Catalogue" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Find a Venue" })).not.toBeInTheDocument();
  });

  it("gives Technical Support Staff an Equipment Catalogue link", () => {
  renderAs("technical_support_staff");

  expect(screen.getByRole("link", { name: "Equipment Catalogue" })).toHaveAttribute("href", "/equipment-catalogue");
  });

  it("gives Technical Support Staff a Check Availability link", () => {
  renderAs("technical_support_staff");

  expect(screen.getByRole("link", { name: "Check Availability" })).toHaveAttribute("href", "/equipment-availability");
});

  it("SCRUM495_AC5_gives_an_attendee_dashboard_and_browse_open_events_with_no_staff_facing_pages", () => {
    renderAs("attendee");

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "Browse Open Events" })).toHaveAttribute("href", "/open-events");
    expect(screen.getByRole("link", { name: "Registered events" })).toHaveAttribute("href", "/registered-events");
    expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(3);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-485: the Event Coordinator Lead and the Safety Officer
// ---------------------------------------------------------------------------
// docs/test-cases/SCRUM-485.md, AC4 and AC6-04. NAV_LINKS_BY_ROLE does a
// lookup that falls back to `|| []`, so a misspelt role key gives an empty nav
// and throws nothing. Counting each role's links exactly is what turns that
// into a failure.

/** Every role the nav can be asked about, as the server sends it. */
const ALL_ROLES = [
  "event_organiser",
  "event_coordinator",
  "venue_staff",
  "technical_support_staff",
  "attendee",
  "event_coordinator_lead",
  "safety_officer",
];

/**
 * The links a role's nav actually renders, as [label, href] in order.
 *
 * Read off the rendered component rather than typed out, so a link added to
 * any role's set later is picked up by the cross-role check below without
 * anyone editing this file. (NAV_LINKS_BY_ROLE is not exported: an object
 * export from a component file fails react-refresh/only-export-components,
 * and reading what renders is the stronger test anyway.)
 */
function linksOf(role) {
  const { unmount } = renderAs(role);
  // The role's own list; the Notifications link beside it is the same for every role.
  const links = within(screen.getByRole("list"))
    .queryAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
  unmount();
  return links;
}

const DASHBOARD_ONLY = [["Dashboard", "/dashboard"]];

/**
 * The Lead's links: the unassigned queue since SCRUM-486 (SCRUM-519) gave it a
 * route, and the assigned events since SCRUM-486 AC6 gave the Lead a way to an
 * event to hand over.
 */
const LEAD_LINKS = [
  ["Dashboard", "/dashboard"],
  ["Unassigned Queue", "/unassigned-queue"],
  ["Assigned Events", "/assigned-events"],
];

describe("SCRUM485_AC4 each new role sees only its own links", () => {
  it("SCRUM486_AC6_an_event_coordinator_lead_has_exactly_the_dashboard_unassigned_queue_and_assigned_events_links", () => {
    // AC4-01 of SCRUM-485. By count: a link leaking into this block fails here.
    //
    // Was SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_link,
    // expecting DASHBOARD_ONLY. Right when written: SCRUM-485 gave the Lead
    // no page but the dashboard, and a link to a route that did not exist
    // would have landed on the catch-all redirect. SCRUM-486 (SCRUM-519)
    // added the /unassigned-queue route and its link, and the test became
    // SCRUM485_AC4_an_event_coordinator_lead_has_exactly_the_dashboard_and_unassigned_queue_links,
    // with two links. That was right too, until SCRUM-486 AC6 added
    // /assigned-events, so the Lead could reach an assigned event by clicking.
    // Each time the expectation moved because a link was added, which is what
    // this count case exists to force (docs/SCRUM-485.md); the count is still
    // exact, now three. Renamed so the name says what it pins.
    expect(linksOf("event_coordinator_lead")).toEqual(LEAD_LINKS);
  });

  it("SCRUM486_AC6_the_lead_sees_the_assigned_events_link", () => {
    // The Lead's way to an event to hand over, by clicking (AC6).
    renderAs("event_coordinator_lead");

    expect(screen.getByRole("link", { name: "Assigned Events" })).toHaveAttribute("href", "/assigned-events");
  });

  it("SCRUM490_a_safety_officer_has_the_safety_review_link", () => {
    expect(linksOf("safety_officer")).toEqual([
      ...DASHBOARD_ONLY,
      ["Safety review", "/safety-review"],
      ["Review history", "/safety-review/history"],
    ]);
  });

  it("SCRUM485_AC4_a_lead_sees_none_of_the_coordinators_links", () => {
    // AC4-03. The Lead inherits nothing from Event Coordinator, its links
    // included. Dashboard is every role's, so it is not the Coordinator's.
    const coordinatorOnly = linksOf("event_coordinator").filter(([, href]) => href !== "/dashboard");
    const lead = linksOf("event_coordinator_lead");

    expect(coordinatorOnly.length).toBeGreaterThan(0);
    for (const [label, href] of coordinatorOnly) {
      expect(lead).not.toContainEqual([label, href]);
      expect(lead.map(([l]) => l)).not.toContain(label);
    }
  });

  it.each(["event_coordinator_lead", "safety_officer"])(
    "SCRUM485_AC4_%s_sees_no_link_from_any_other_role",
    (role) => {
      // AC4-04. Every other role's links, by label and by target, gathered by
      // rendering each one. Dashboard is shared by every role, so it is left
      // out; everything else belongs to someone.
      const others = ALL_ROLES.filter((r) => r !== role)
        .flatMap((r) => linksOf(r))
        .filter(([, href]) => href !== "/dashboard");
      const mine = linksOf(role);

      // So the check cannot pass on an empty list. Not a fixed number: the
      // exact sets are pinned by the AC6 cases below.
      expect(others.length).toBeGreaterThan(0);
      for (const [label, href] of others) {
        expect(mine.map(([l]) => l)).not.toContain(label);
        expect(mine.map(([, h]) => h)).not.toContain(href);
      }
    },
  );

  it.each(["Safety Officer", "safety officer"])(
    "SCRUM490_the_role_spelt_%j_reaches_the_safety_officer_links",
    (spelling) => {
      expect(linksOf(spelling)).toEqual(linksOf("safety_officer"));
    },
  );

  it.each(["event-coordinator-lead", "EVENT_COORDINATOR_LEAD"])(
    "SCRUM486_AC2_the_role_spelt_%j_reaches_the_leads_links",
    (spelling) => {
      // AC4-05's Lead rows, carried over unchanged in what they prove: any
      // spelling normaliseRole accepts reaches the Lead's whole set.
      expect(linksOf(spelling)).toEqual(LEAD_LINKS);
    },
  );

  it("SCRUM485_AC4_an_unknown_role_renders_an_empty_nav_and_throws_nothing", () => {
    // AC4-06. The failure mode a misspelt key produces, on record: the nav
    // still renders, with no links and no error. The two count tests above
    // are what catch it.
    expect(() => renderAs("saftey_officer")).not.toThrow();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});


describe("SCRUM485_AC6 the existing roles keep exactly their links", () => {
  // AC6-04. Written out, in order, rather than read back from the component:
  // a regression test that derived its expectation from the code under test
  // would agree with any change. Until now only the Organiser's count was
  // pinned; this pins every role whose links predate SCRUM-485. The Attendee's
  // are pinned in their own case below, because they are SCRUM-453's.
  it.each([
    ["event_organiser", [
      ["Dashboard", "/dashboard"],
      ["My Events", "/events"],
      ["Registration", "/registration"],
    ]],
    ["event_coordinator", [
      ["Dashboard", "/dashboard"],
      ["My Events", "/my-events"],
      ["Venue Requests", "/my-venue-requests"],
      ["Review Queue", "/review-queue"],
      ["Find a Venue", "/venue-search"],
    ]],
    ["venue_staff", [
      ["Dashboard", "/dashboard"],
      ["Venue Catalogue", "/venue-catalogue"],
      ["Booking Requests", "/booking-requests"],
      ["Flagged Bookings", "/flagged-bookings"],
    ]],
    ["technical_support_staff", [
      ["Dashboard", "/dashboard"],
      ["Support Tickets", "/tickets"],
      ["Equipment Requests", "/equipment"],
      ["Equipment Catalogue", "/equipment-catalogue"],
      ["Check Availability", "/equipment-availability"],
    ]],
  ])("SCRUM485_AC6_%s_keeps_exactly_its_links", (role, expected) => {
    const links = linksOf(role);

    expect(links).toHaveLength(expected.length);
    expect(links).toEqual(expected);
  });

  it("SCRUM485_AC6_an_attendee_keeps_the_links_scrum453_gave_it", () => {
    // Pins the Attendee's links exactly and by count.
    const links = linksOf("attendee");

    expect(links).toHaveLength(3);
    expect(links).toEqual([
      ["Dashboard", "/dashboard"],
      ["Registered events", "/registered-events"],
      ["Browse Open Events", "/open-events"],
    ]);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-172 AC4: the unread count in the nav
// ---------------------------------------------------------------------------

function withCount(unreadCount) {
  vi.mocked(useUnreadCount).mockReturnValue({ unreadCount, refreshUnreadCount: vi.fn() });
}

describe("SCRUM172_AC4 the nav's Notifications link", () => {
  it("SCRUM172_AC4_nav_shows_the_unread_count", () => {
    withCount(3);
    renderAs("attendee");

    const link = screen.getByRole("link", { name: "Notifications, 3 unread" });
    expect(link).toHaveAttribute("href", "/dashboard#notifications");
    expect(link.querySelector(".app-nav__badge")).toHaveTextContent(/^3$/);
  });

  it("SCRUM172_AC4_nav_shows_the_exact_count_past_the_list_cap", () => {
    withCount(73);
    renderAs("event_coordinator");

    expect(screen.getByRole("link", { name: "Notifications, 73 unread" })).toHaveTextContent(/^Notifications73$/);
  });

  it.each([
    ["zero", 0],
    ["unknown", null],
  ])("SCRUM172_AC4_nav_shows_no_badge_when_the_count_is_%s", (_label, count) => {
    withCount(count);
    const { container } = renderAs("venue_staff");

    const link = screen.getByRole("link", { name: "Notifications" });
    expect(link).toHaveAttribute("href", "/dashboard#notifications");
    expect(link).toHaveTextContent(/^Notifications$/);
    expect(container.querySelector(".app-nav__badge")).not.toBeInTheDocument();
  });

  it.each(ALL_ROLES)("SCRUM172_AC1_%s_has_the_notifications_link", (role) => {
    // Every role has a dashboard, and every dashboard mounts the inbox.
    withCount(null);
    renderAs(role);

    expect(screen.getByRole("link", { name: "Notifications" })).toHaveAttribute("href", "/dashboard#notifications");
  });

  it("SCRUM172_AC4_a_role_with_no_links_gets_no_notifications_link", () => {
    withCount(3);
    renderAs("saftey_officer");

    expect(screen.queryByRole("link", { name: /Notifications/ })).not.toBeInTheDocument();
  });
});
