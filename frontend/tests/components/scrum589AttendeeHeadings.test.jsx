// scrum589AttendeeHeadings.test.jsx
//
// The UI standard on the Attendee screens: one h1 per page with sections at h2,
// the shared Button and StatusBadge in place of each screen's own markup, and
// no classes borrowed from other roles' screens. Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AttendeeDashboard from "../../src/components/AttendeeDashboard.jsx";
import RegisteredEvents from "../../src/components/RegisteredEvents.jsx";
import BrowseOpenEvents from "../../src/components/BrowseOpenEvents.jsx";
import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import AttendeeEventInformation from "../../src/components/AttendeeEventInformation.jsx";
import {
  getAttendeeEvent,
  getRegisteredEvents,
  getWaitlist,
  withdrawRegistration,
} from "../../src/services/attendeeEventService";
import { getOpenEvent, getOpenEvents } from "../../src/services/openEventService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/attendeeEventService", () => ({
  getAttendeeEvent: vi.fn(),
  getRegisteredEvents: vi.fn(),
  getWaitlist: vi.fn(),
  leaveWaitlist: vi.fn(),
  withdrawRegistration: vi.fn(),
}));
vi.mock("../../src/services/openEventService", () => ({ getOpenEvent: vi.fn(), getOpenEvents: vi.fn() }));
// The inbox's own headings are covered by scrum584SharedScreenHeadings.
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

const BORROWED_CLASSES = [
  "browse-open-events__badge",
  "browse-open-events__availability",
  "dashboard--attendee__browse-link",
  "pending-bookings__error",
  "event-venue-bookings__actions",
];

const openEvent = (overrides = {}) => ({
  id: "e1", eventName: "Open Day", description: "Come along.",
  startsAt: "2026-10-25T01:00:00.000Z", endsAt: "2026-10-25T03:30:00.000Z",
  capacity: 50, placesLeft: 12, isFull: false, isRegistered: false, canRegister: true,
  canJoinWaitlist: false, waitlistPosition: null, ...overrides,
});
const attendeeEvent = (overrides = {}) => ({
  eventRequestId: "e1", registrationId: "r1", state: "confirmed", eventName: "Open Day",
  startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
  venues: [{ bookingId: "b1", name: "Hall A", location: "Building A" }],
  ...overrides,
});
const waitlistPlace = { registrationId: "w1", eventRequestId: "e2", eventName: "Gala", waitlistPosition: 2 };

function renderDetails(props = {}) {
  return render(
    <MemoryRouter initialEntries={["/open-events/e1"]}>
      <Routes>
        <Route path="/open-events/:eventId" element={<BrowseEventDetails onRegister={vi.fn()} {...props} />} />
      </Routes>
    </MemoryRouter>,
  );
}
function renderEventInformation() {
  return render(
    <MemoryRouter initialEntries={["/registered-events/e1"]}>
      <Routes><Route path="/registered-events/:eventId" element={<AttendeeEventInformation />} /></Routes>
    </MemoryRouter>,
  );
}

// One h1 named as given, and every other heading an h2 with exactly these names.
function expectHeadings(h1, h2s) {
  const headings = screen.getAllByRole("heading");
  expect(headings.filter(h => h.tagName === "H1").map(h => h.textContent)).toEqual([h1]);
  expect(headings.filter(h => h.tagName !== "H1").map(h => `${h.tagName} ${h.textContent}`))
    .toEqual(h2s.map(name => `H2 ${name}`));
}
function expectBadge(text, tone) {
  expect(screen.getByText(text)).toHaveClass("ui-status-badge", `ui-status-badge--${tone}`);
}
function expectButton(name, variant) {
  expect(screen.getByRole("button", { name })).toHaveClass("ui-button", `ui-button--${variant}`);
}
function expectNoBorrowedClasses(container) {
  for (const name of BORROWED_CLASSES) expect(container.querySelector(`.${name}`)).toBeNull();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRegisteredEvents).mockResolvedValue([]);
  vi.mocked(getWaitlist).mockResolvedValue([]);
});

describe("SCRUM589 AC2 one h1 per Attendee screen, sections at h2", () => {
  it("SCRUM589_AC2_dashboard_has_one_h1_and_its_sections_at_h2", () => {
    render(<AttendeeDashboard user={{ name: "Ada" }} />, { wrapper: MemoryRouter });

    expectHeadings("Welcome, Ada", ["Registered events", "Browse Open Events"]);
  });

  it("SCRUM589_AC2_registered_events_page_labels_the_registered_list_with_a_visible_h2_beside_waiting_lists", async () => {
    vi.mocked(getRegisteredEvents).mockResolvedValue([{ eventRequestId: "e1", eventName: "Open Day" }]);
    render(<RegisteredEvents />, { wrapper: MemoryRouter });

    const registered = await screen.findByRole("region", { name: "Registered" });
    expect(within(registered).getByRole("link", { name: "Open Day" })).toBeInTheDocument();
    await screen.findByText("You are not on any waiting lists.");
    expectHeadings("Registered events", ["Registered", "Waiting lists"]);
  });

  it("SCRUM589_AC2_browse_open_events_has_one_h1_and_the_list_at_h2", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([openEvent()]);
    render(<BrowseOpenEvents />, { wrapper: MemoryRouter });

    await screen.findByText("Open Day");
    expectHeadings("Browse Open Events", ["Events open for registration"]);
  });

  it("SCRUM589_AC2_event_details_puts_about_this_event_at_h2", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(openEvent());
    renderDetails();

    await screen.findByText("Come along.");
    expectHeadings("Open Day", ["Event details", "About this event"]);
  });

  it("SCRUM589_AC2_registered_event_information_with_the_withdraw_section_has_one_h1_and_h2_sections", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent());
    renderEventInformation();

    await screen.findByRole("button", { name: "Withdraw registration" });
    expectHeadings("Open Day", ["Confirmed arrangements", "Venues"]);
  });

  it("SCRUM589_AC2_cancelled_event_information_puts_the_coordinators_message_at_h2", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent({ state: "cancelled", message: "Sorry." }));
    renderEventInformation();

    await screen.findByText("Sorry.");
    expectHeadings("Open Day", ["Message from the coordinator"]);
  });
});

describe("SCRUM589 AC3 shared status badges and buttons", () => {
  it("SCRUM589_AC6_list_marks_and_availability_are_status_badges_toned_by_meaning", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([
      openEvent({ id: "e1", isRegistered: true }),
      openEvent({ id: "e2", eventName: "Gala", placesLeft: 0, isFull: true, waitlistPosition: 2 }),
      openEvent({ id: "e3", eventName: "Talk", placesLeft: null }),
    ]);
    const { container } = render(<BrowseOpenEvents />, { wrapper: MemoryRouter });

    await screen.findByText("Open Day");
    expectBadge("Registered", "success");
    expectBadge("Waitlisted: position 2", "accent");
    expectBadge("12 places left", "info");
    expectBadge("Full", "warning");
    expectBadge("No limit", "neutral");
    expectNoBorrowedClasses(container);
  });

  it.each([
    ["an open event", {}, "Register", true],
    ["a registered event", { isRegistered: true }, "Already registered", false],
    ["a full event with no waiting list", { placesLeft: 0, isFull: true, canRegister: false }, "Register", false],
    ["a full event with a waiting list", { placesLeft: 0, isFull: true, canRegister: false, canJoinWaitlist: true }, "Join waiting list", true],
    ["a waitlisted event", { placesLeft: 0, isFull: true, canRegister: false, waitlistPosition: 2 }, "On the waiting list", false],
  ])("SCRUM589_AC3_event_details_action_for_%s_is_a_primary_button", async (_, overrides, name, enabled) => {
    vi.mocked(getOpenEvent).mockResolvedValue(openEvent(overrides));
    renderDetails({ onJoinWaitlist: vi.fn() });

    const button = await screen.findByRole("button", { name });
    expect(button).toHaveClass("ui-button", "ui-button--primary");
    if (enabled) expect(button).toBeEnabled();
    else expect(button).toBeDisabled();
  });

  it("SCRUM589_AC3_event_details_try_again_is_a_secondary_button_and_back_is_a_link", async () => {
    vi.mocked(getOpenEvent).mockRejectedValue(httpError(500));
    renderDetails();

    expect(await screen.findByRole("button", { name: "Try again" })).toHaveClass("ui-button", "ui-button--secondary");
    expect(screen.getByRole("link", { name: "Back to open events" })).toHaveClass("ui-button", "ui-button--link");
  });

  it("SCRUM589_AC3_withdrawing_uses_danger_buttons_and_keeping_is_secondary", async () => {
    const user = userEvent.setup();
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent());
    const { container } = renderEventInformation();

    expect(await screen.findByRole("button", { name: "Withdraw registration" })).toBeInTheDocument();
    expectButton("Withdraw registration", "danger");
    await user.click(screen.getByRole("button", { name: "Withdraw registration" }));
    expectButton("Confirm withdrawal", "danger");
    expectButton("Keep my registration", "secondary");
    expect(screen.getByRole("link", { name: "Back to registered events" })).toHaveClass("ui-button", "ui-button--link");
    expectNoBorrowedClasses(container);
  });

  it("SCRUM589_AC6_a_completed_withdrawal_shows_withdrawn_as_a_neutral_badge", async () => {
    const user = userEvent.setup();
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(attendeeEvent())
      .mockRejectedValue(httpError(404, { error: "Event information not found" }));
    vi.mocked(withdrawRegistration).mockResolvedValue({ registrationId: "r1", status: "withdrawn" });
    renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Your registration has been withdrawn.")).toBeInTheDocument();
    expectBadge("Withdrawn", "neutral");
  });

  it("SCRUM589_AC3_leaving_a_waiting_list_uses_danger_buttons_and_keeping_is_secondary", async () => {
    const user = userEvent.setup();
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    const { container } = render(<RegisteredEvents />, { wrapper: MemoryRouter });

    await screen.findByText("Waitlisted: position 2");
    expectBadge("Waitlisted: position 2", "accent");
    expectButton("Leave waiting list", "danger");
    await user.click(screen.getByRole("button", { name: "Leave waiting list" }));
    expectButton("Confirm leaving", "danger");
    expectButton("Keep my place", "secondary");
    expectNoBorrowedClasses(container);
  });

  it("SCRUM589_AC3_dashboard_ways_in_stay_links_styled_as_primary_buttons", () => {
    const { container } = render(<AttendeeDashboard user={{ name: "Ada" }} />, { wrapper: MemoryRouter });

    for (const name of ["View registered events", "Browse Open Events"]) {
      expect(screen.getByRole("link", { name })).toHaveClass("ui-button", "ui-button--primary");
    }
    expectNoBorrowedClasses(container);
  });
});

describe("SCRUM589 AC6 no classes borrowed from other roles' screens", () => {
  it("SCRUM589_AC3_a_final_withdrawal_refusal_uses_the_attendee_error_class", async () => {
    const user = userEvent.setup();
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent());
    vi.mocked(withdrawRegistration).mockRejectedValue(httpError(409, { code: "WITHDRAWAL_DEADLINE_PASSED" }));
    const { container } = renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    const refusal = await screen.findByText(/withdrawal deadline for this event has passed/);
    expect(refusal).toHaveClass("withdraw-registration__error");
    expectNoBorrowedClasses(container);
  });
});
