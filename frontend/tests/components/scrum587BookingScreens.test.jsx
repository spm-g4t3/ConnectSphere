// scrum587BookingScreens.test.jsx
//
// The UI standard on Venue Staff's booking screens: one h1 per page, the
// shared Button for actions, and StatusBadge tones for booking statuses. Only
// apiClient is mocked, so the real services feed the real screens; the venue
// catalogue is stubbed on the dashboard as it has its own tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import PendingBookingRequests from "../../src/components/PendingBookingRequests.jsx";
import FlaggedBookings from "../../src/components/FlaggedBookings.jsx";
import VenueStaffDashboard from "../../src/components/VenueStaffDashboard.jsx";
import { apiClient } from "../../src/services/apiClient";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock("../../src/components/VenueCatalogue", () => ({ default: () => null }));

const PERIOD = {
  startsAt: "2026-12-01T09:00:00+08:00",
  endsAt: "2026-12-01T17:00:00+08:00",
  occupiedStartsAt: "2026-12-01T09:00:00+08:00",
  occupiedEndsAt: "2026-12-01T17:00:00+08:00",
};

function pendingItem(id, status, label, group) {
  return {
    id,
    eventName: `Event ${id}`,
    eventStatus: "approved",
    venueName: `Hall ${id}`,
    status,
    statusDisplay: { status, label, group, description: "x" },
    ...PERIOD,
    createdAt: "2026-10-06T10:00:00+08:00",
    overlapping: [],
  };
}

const PENDING = [
  pendingItem("1", "pending", "Pending", "PENDING"),
  pendingItem("2", "conflicting", "Conflicting", "CONFLICTING"),
];

const FLAGGED = [
  {
    id: "f1",
    eventName: "Board Retreat",
    eventStatus: "approved",
    venueName: "Hall B",
    ...PERIOD,
    flaggedAt: "2026-11-20T10:00:00+08:00",
    reviewReason: "setup_or_turnaround_changed",
    block: null,
    reinstatable: true,
  },
];

function answer({ pending = PENDING, flagged = FLAGGED } = {}) {
  vi.mocked(apiClient.get).mockImplementation(async (url) => ({
    data: url === "/booking-requests/pending" ? pending : url === "/flagged-bookings" ? flagged : [],
  }));
}

function renderIn(ui) {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <div className="dashboard dashboard--venue-staff">{ui}</div>
    </MemoryRouter>,
  );
  return user;
}

const levelOf = (heading) => Number(heading.tagName.slice(1));
const toggleFor = (name) =>
  screen.getAllByRole("button").find((b) => b.hasAttribute("aria-expanded") && b.textContent.includes(name));

// The card's collapse row is a disclosure, not an action, so it stays a native
// button. Named here so no other native button can hide behind it.
function expectEveryActionIsTheSharedButton() {
  const buttons = screen.getAllByRole("button");
  const native = buttons.filter((b) => !b.classList.contains("ui-button"));
  for (const b of native) {
    expect(b).toHaveClass("pending-bookings__toggle");
    expect(b).toHaveAttribute("aria-expanded");
  }
  expect(buttons.length).toBeGreaterThan(native.length);
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  answer();
});

describe("SCRUM587 AC2 one h1 per Venue Staff booking screen", () => {
  it("SCRUM587_AC2_booking_requests_page_has_one_h1", async () => {
    const user = renderIn(<PendingBookingRequests asPage />);
    await screen.findByText("Event 1");
    await user.click(toggleFor("Event 1"));

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Pending booking requests"]);
    const below = screen.getAllByRole("heading").filter((h) => h !== h1s[0]);
    expect(below.length).toBeGreaterThan(0);
    for (const h of below) expect(levelOf(h)).toBeGreaterThan(1);
  });

  it("SCRUM587_AC2_flagged_bookings_page_has_one_h1", async () => {
    const user = renderIn(<FlaggedBookings asPage />);
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Board Retreat"));

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Flagged bookings"]);
    const below = screen.getAllByRole("heading").filter((h) => h !== h1s[0]);
    expect(below.map((h) => h.textContent)).toContain("Why it was flagged");
    for (const h of below) expect(levelOf(h)).toBeGreaterThan(1);
  });

  it("SCRUM587_AC2_venue_staff_dashboard_has_one_h1_with_its_sections_at_h2", async () => {
    render(
      <MemoryRouter>
        <VenueStaffDashboard user={{ id: "u1", email: "staff@example.com", role: "venue_staff" }} />
      </MemoryRouter>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Welcome, staff@example.com"]);
    expect(screen.getByRole("heading", { name: "Pending booking requests" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "Flagged bookings" }).tagName).toBe("H2");
  });
});

describe("SCRUM587 AC3 shared components on the booking screens", () => {
  it("SCRUM587_AC3_booking_screens_use_the_shared_button", async () => {
    const user = renderIn(
      <>
        <PendingBookingRequests asPage />
        <FlaggedBookings />
      </>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Event 1"));
    await user.click(toggleFor("Board Retreat"));

    const pending = screen.getByRole("region", { name: "Event 1 at Hall 1" });
    expect(within(pending).getByRole("button", { name: "Approve" })).toHaveClass("ui-button--primary");
    expect(within(pending).getByRole("button", { name: "Reject" })).toHaveClass("ui-button--danger");
    const flagged = screen.getByRole("region", { name: "Board Retreat at Hall B" });
    expect(within(flagged).getByRole("button", { name: "Reinstate" })).toHaveClass("ui-button--primary");
    expect(within(flagged).getByRole("button", { name: "Cancel booking" })).toHaveClass("ui-button--danger");
    expectEveryActionIsTheSharedButton();
  });

  it("SCRUM587_AC3_no_booking_screen_keeps_its_own_badge_class", async () => {
    const user = renderIn(
      <>
        <PendingBookingRequests asPage />
        <FlaggedBookings />
      </>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Event 2"));
    await user.click(toggleFor("Board Retreat"));

    expect(document.querySelectorAll(".ui-status-badge")).toHaveLength(PENDING.length);
    expect(document.querySelector(".status-badge")).toBeNull();
    expect(document.querySelector('[class*="status--"]')).toBeNull();
  });
});

describe("SCRUM587 AC5 one tone per booking status meaning", () => {
  it.each([
    ["Pending", "warning"],
    ["Conflicting", "warning"],
  ])("SCRUM587_AC5_booking_statuses_use_one_tone_per_meaning (%s is %s)", async (label, tone) => {
    renderIn(<PendingBookingRequests asPage />);
    await screen.findByText("Event 1");

    const badge = screen.getByText(label, { selector: ".ui-status-badge" });
    expect(badge).toHaveClass(`ui-status-badge--${tone}`);
  });
});

const LISTS = [
  ["pending", () => <PendingBookingRequests asPage />, "Event 1"],
  ["flagged", () => <FlaggedBookings asPage />, "Board Retreat"],
];

const httpError = (status, data = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

const ddFor = (region, term) => within(region).getByText(term, { selector: "dt" }).nextElementSibling;

describe("SCRUM587 AC4 loading, empty and error states on the booking screens", () => {
  it.each(LISTS)("SCRUM587_AC4_booking_lists_show_the_standard_loading_text (%s)", async (_, ui) => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));
    renderIn(ui());

    const status = screen.getByRole("status");
    expect(status).toHaveClass("ui-loading-text");
    expect(status).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it.each([
    [
      "pending",
      () => <PendingBookingRequests asPage />,
      "No pending booking requests.",
      "A request appears here when a coordinator asks to book a venue for their event.",
    ],
    [
      "flagged",
      () => <FlaggedBookings asPage />,
      "No bookings are flagged for review.",
      "An approved booking appears here when a venue block, a change to the venue, a change to the event or a safety review affects it.",
    ],
  ])(
    "SCRUM587_AC4_empty_booking_lists_say_what_is_missing_and_what_happens_next (%s)",
    async (_, ui, message, nextStep) => {
      answer({ pending: [], flagged: [] });
      renderIn(ui());

      const empty = (await screen.findByText(message)).closest(".ui-empty-state");
      expect(empty).not.toBeNull();
      expect(within(empty).getByText(nextStep)).toHaveClass("ui-empty-state__next-step");
    },
  );

  it.each(LISTS)(
    "SCRUM587_AC4_a_booking_list_that_fails_to_load_offers_try_again_and_reloads (%s)",
    async (_, ui, firstName) => {
      vi.mocked(apiClient.get).mockRejectedValueOnce(httpError(500));
      const user = renderIn(ui());

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/could not be loaded/);
      await user.click(within(alert).getByRole("button", { name: "Try again" }));

      expect(await screen.findByText(firstName)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    },
  );

  it.each(LISTS)(
    "SCRUM587_AC4_a_booking_list_refused_for_the_role_offers_no_try_again (%s)",
    async (_, ui) => {
      vi.mocked(apiClient.get).mockRejectedValueOnce(httpError(403));
      renderIn(ui());

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Only Venue Staff can see/);
      expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    },
  );

  // Approve is one click, so repeating it is the retry, but only when the
  // server never answered. The reason forms are retried by submitting again.
  it.each([
    ["approve after a server failure", "approve", httpError(500), "Could not record the decision. Please try again.", true],
    ["approve refused with a 409", "approve", httpError(409, { code: "VENUE_RETIRED" }), "This venue has been retired, so the request can't be approved.", false],
    ["approve with an expired session", "approve", httpError(401), "Your session has expired. Please sign in again.", false],
    ["reject after a server failure", "reject", httpError(500), "Could not record the decision. Please try again.", false],
    ["reinstate after a server failure", "reinstate", httpError(500), "Could not resolve the flagged booking. Please try again.", false],
    ["cancel after a server failure", "cancel", httpError(500), "Could not resolve the flagged booking. Please try again.", false],
  ])(
    "SCRUM587_AC4_a_failed_booking_decision_shows_the_error_with_the_right_retry (%s)",
    async (_, action, err, message, offersRetry) => {
      vi.mocked(apiClient.post).mockReset();
      vi.mocked(apiClient.post).mockRejectedValue(err);
      const pending = action === "approve" || action === "reject";
      const user = renderIn(pending ? <PendingBookingRequests asPage /> : <FlaggedBookings asPage />);
      const name = pending ? "Event 1" : "Board Retreat";
      await screen.findByText(name);
      await user.click(toggleFor(name));
      const region = screen.getByRole("region", { name: pending ? "Event 1 at Hall 1" : "Board Retreat at Hall B" });

      if (action === "approve") {
        await user.click(within(region).getByRole("button", { name: "Approve" }));
      } else {
        const [label, button] = {
          reject: ["Reason for rejecting (required)", "Reject"],
          reinstate: ["Reason for reinstating (required)", "Reinstate"],
          cancel: ["Reason for cancelling (required)", "Cancel booking"],
        }[action];
        await user.type(within(region).getByLabelText(label), "Clash");
        await user.click(within(region).getByRole("button", { name: button }));
      }

      const alert = await within(region).findByRole("alert");
      expect(alert).toHaveTextContent(message);
      const retry = within(alert).queryByRole("button", { name: "Try again" });
      if (!offersRetry) {
        expect(retry).not.toBeInTheDocument();
        return;
      }
      expect(retry).toBeInTheDocument();
      vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { markedConflicting: [] } });
      await user.click(retry);
      expect(apiClient.post).toHaveBeenCalledTimes(2);
      expect(vi.mocked(apiClient.post).mock.lastCall[0]).toBe("/booking-requests/1/approve");
      expect(await screen.findByText(/^Approved Hall 1 for Event 1\./)).toBeInTheDocument();
    },
  );

  it("SCRUM587_AC4_booking_dates_use_the_standard_format", async () => {
    answer({
      pending: [
        {
          ...pendingItem("1", "pending", "Pending", "PENDING"),
          overlapping: [{ id: "9", eventName: "Gala", ...PERIOD, createdAt: "2026-10-07T14:05:00+08:00" }],
        },
      ],
    });
    const user = renderIn(
      <>
        <PendingBookingRequests asPage />
        <FlaggedBookings />
      </>,
    );
    await screen.findByText("Event 1");
    await screen.findByText("Board Retreat");
    await user.click(toggleFor("Event 1"));
    await user.click(toggleFor("Board Retreat"));

    const pending = screen.getByRole("region", { name: "Event 1 at Hall 1" });
    expect(ddFor(pending, "Requested")).toHaveTextContent(/^6 Oct 2026, 10:00 am$/);
    expect(within(pending).getByText("Requested 7 Oct 2026, 2:05 pm")).toBeInTheDocument();
    const flagged = screen.getByRole("region", { name: "Board Retreat at Hall B" });
    expect(ddFor(flagged, "Flagged")).toHaveTextContent(/^20 Nov 2026, 10:00 am$/);
    // Venue periods keep their own helper and its zone note.
    expect(ddFor(flagged, "Booking period")).toHaveTextContent(/\(Singapore time\)$/);
  });
});
