// scrum586ListScreens.test.jsx
//
// The Coordinator's list screens follow the UI standard: one h1 on a list's
// own page, shared buttons and badges, the standard loading, error, empty and
// date text, and danger kept for the step that withdraws a venue request.
// The services are mocked and the detail panel stubbed, so nothing touches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorAttentionList from "../../src/components/CoordinatorAttentionList.jsx";
import MyAssignedEvents from "../../src/components/MyAssignedEvents.jsx";
import MyBookingRequests from "../../src/components/MyBookingRequests.jsx";
import ReviewQueue from "../../src/components/ReviewQueue.jsx";
import { getMyBookingRequests, withdrawBookingRequest } from "../../src/services/bookingRequestService";
import { getEventRequestQueue, getMyAssignedEvents, getNeedsAttention } from "../../src/services/eventRequestService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/components/CoordinatorRequestDetail", () => ({
  default: ({ request }) => <h2>Detail of {request.eventName}</h2>,
}));

vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestQueue: vi.fn(),
  getMyAssignedEvents: vi.fn(),
  getNeedsAttention: vi.fn(),
}));

vi.mock("../../src/services/bookingRequestService", () => ({
  getMyBookingRequests: vi.fn(),
  withdrawBookingRequest: vi.fn(),
}));

// 01:00Z is 9:00 am in Singapore; a device-zone or device-format helper would
// print something else in a UTC runner.
const NINE_AM = "2026-01-15T01:00:00Z";
const ELEVEN_AM = "2026-01-15T03:00:00Z";
const STANDARD_TIME = "15 Jan 2026, 9:00 am";

const SUBMITTED = { status: "submitted", label: "Requested", group: "AWAITING_REVIEW", description: "x" };
const CLARIFYING = { status: "pending_clarification", label: "Action Needed", group: "ACTION_REQUIRED", description: "x" };

const QUEUE = [
  { id: "q1", eventName: "IS212 Industry Night", status: "submitted", statusDisplay: SUBMITTED },
  { id: "q2", eventName: "Freshers Welcome", status: "pending_clarification", statusDisplay: CLARIFYING },
];

const MINE = [
  {
    id: "m1",
    eventName: "IS212 Industry Night",
    status: "submitted",
    statusDisplay: SUBMITTED,
    proposedStart: NINE_AM,
    organiserName: "Aisha Rahman",
  },
];

const BOOKINGS = [
  {
    id: "b1",
    eventName: "IS212 Industry Night",
    venueName: "Hall A",
    status: "pending",
    statusDisplay: { status: "pending", label: "Pending", group: "PENDING", description: "x" },
    startsAt: NINE_AM,
    endsAt: ELEVEN_AM,
    createdAt: NINE_AM,
  },
];

const ATTENTION = [
  {
    id: "a1",
    eventName: "IS212 Industry Night",
    reason: "Ended, mark as completed",
    proposedStart: NINE_AM,
    proposedEnd: ELEVEN_AM,
    link: "/event-requests/m1",
  },
];

// Each list with its read, its title and the data a successful read returns.
const SCREENS = [
  { name: "Review queue", Component: ReviewQueue, read: getEventRequestQueue, rows: QUEUE },
  { name: "My events", Component: MyAssignedEvents, read: getMyAssignedEvents, rows: MINE },
  { name: "Venue requests", Component: MyBookingRequests, read: getMyBookingRequests, rows: BOOKINGS },
  { name: "Needs attention", Component: CoordinatorAttentionList, read: getNeedsAttention, rows: ATTENTION },
];

function renderScreen(Component, props = {}) {
  render(
    <MemoryRouter>
      <Component {...props} />
    </MemoryRouter>,
  );
  return { user: userEvent.setup() };
}

beforeEach(() => {
  vi.resetAllMocks();
  getEventRequestQueue.mockResolvedValue(QUEUE);
  getMyAssignedEvents.mockResolvedValue(MINE);
  getMyBookingRequests.mockResolvedValue(BOOKINGS);
  getNeedsAttention.mockResolvedValue(ATTENTION);
});

describe("SCRUM586_AC2 one h1 on a list's own page, h2 on the dashboard", () => {
  it.each(SCREENS.slice(0, 3))("SCRUM586_AC2_is_h1_as_a_page_and_h2_on_the_dashboard ($name)", async ({ name, Component }) => {
    renderScreen(Component, { asPage: true });
    await screen.findByText("IS212 Industry Night");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(name);
    cleanup();

    renderScreen(Component);
    await screen.findByText("IS212 Industry Night");
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
  });

  it("SCRUM586_AC2_my_events_group_headings_sit_one_level_under_the_title", async () => {
    renderScreen(MyAssignedEvents);
    expect(await screen.findByRole("heading", { level: 3, name: /^New, not yet reviewed/ })).toBeInTheDocument();
    cleanup();

    renderScreen(MyAssignedEvents, { asPage: true });
    expect(await screen.findByRole("heading", { level: 2, name: /^New, not yet reviewed/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it.each([
    { name: "Review queue", Component: ReviewQueue, open: "Review" },
    { name: "My events", Component: MyAssignedEvents, open: "Open" },
  ])("SCRUM586_AC2_keeps_its_one_h1_above_an_open_panel ($name)", async ({ name, Component, open }) => {
    const { user } = renderScreen(Component, { asPage: true });
    await user.click((await screen.findAllByRole("button", { name: open }))[0]);

    expect(screen.getByRole("heading", { level: 2, name: "Detail of IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(name);
  });

  it("SCRUM586_AC2_on_the_dashboard_an_open_panel_adds_no_h1", async () => {
    const { user } = renderScreen(ReviewQueue);
    await user.click((await screen.findAllByRole("button", { name: "Review" }))[0]);

    await screen.findByRole("heading", { name: "Detail of IS212 Industry Night" });
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});

describe("SCRUM586_AC3 the list screens use the shared Button and StatusBadge", () => {
  it.each(SCREENS)("SCRUM586_AC3_every_button_is_shared_and_no_old_class_is_left ($name)", async ({ Component }) => {
    renderScreen(Component);
    await screen.findByText("IS212 Industry Night");

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toHaveClass("ui-button");
    expect(document.querySelector(".status-badge, .review-queue__back, .review-queue__error")).toBeNull();
  });

  it("SCRUM586_AC3_review_queue_badges_take_the_tone_of_their_status_group", async () => {
    renderScreen(ReviewQueue);
    await screen.findByText("IS212 Industry Night");

    const row = (eventName) => screen.getByText(eventName).closest("li");
    expect(within(row("IS212 Industry Night")).getByText("Requested")).toHaveClass(
      "ui-status-badge",
      "ui-status-badge--warning",
    );
    expect(within(row("Freshers Welcome")).getByText("Action Needed")).toHaveClass(
      "ui-status-badge",
      "ui-status-badge--danger",
    );
  });
});

describe("SCRUM586_AC4 loading, error, empty and date text follow the standard", () => {
  it.each(SCREENS)("SCRUM586_AC4_shows_the_standard_loading_text ($name)", ({ Component, read }) => {
    read.mockReturnValue(new Promise(() => {}));
    renderScreen(Component);

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it.each(SCREENS)("SCRUM586_AC4_offers_try_again_after_a_failed_read_and_reads_again ($name)", async ({ name, Component, read, rows }) => {
    read.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(rows);
    const { user } = renderScreen(Component);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The button has gone, so focus lands on the title instead of the page body.
    await waitFor(() => expect(screen.getByRole("heading", { name: new RegExp(`^${name}`) })).toHaveFocus());
  });

  it.each([
    { name: "Review queue", message: "The review queue could not be loaded." },
    { name: "My events", message: "Your events could not be loaded." },
    { name: "Venue requests", message: "Your venue requests could not be loaded." },
    { name: "Needs attention", message: "Your Needs attention list could not be loaded." },
  ])("SCRUM586_AC4_a_failed_read_beside_try_again_says_only_what_failed ($name)", async ({ name, message }) => {
    const { Component, read } = SCREENS.find((entry) => entry.name === name);
    read.mockRejectedValue(httpError(500));
    renderScreen(Component);

    const alert = await screen.findByRole("alert");
    // Try again is the instruction, so the message does not repeat it.
    expect(within(alert).getByText(new RegExp(`^${message.replace(/\./g, "\\.")}$`))).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each(SCREENS.flatMap((entry) => [403, 404].map((status) => ({ ...entry, status }))))(
    "SCRUM586_AC4_offers_no_try_again_after_a_refused_or_missing_read ($name, $status)",
    async ({ Component, read, status }) => {
      read.mockRejectedValue(httpError(status));
      renderScreen(Component);

      const alert = await screen.findByRole("alert");
      expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("SCRUM586_AC4_the_role_refusal_keeps_its_own_words", async () => {
    getEventRequestQueue.mockRejectedValue(httpError(403));
    renderScreen(ReviewQueue);
    expect(await screen.findByRole("alert")).toHaveTextContent("Only Event Coordinators can see the review queue.");
  });

  it.each([
    { name: "Review queue", Component: ReviewQueue, read: getEventRequestQueue, nextStep: "Requests appear here when they are waiting for your decision." },
    { name: "My events", Component: MyAssignedEvents, read: getMyAssignedEvents, nextStep: "Events appear here when the Event Coordinator Lead assigns them to you." },
    { name: "Venue requests", Component: MyBookingRequests, read: getMyBookingRequests, nextStep: "Find a venue from one of your events." },
    { name: "Needs attention", Component: CoordinatorAttentionList, read: getNeedsAttention, nextStep: "Your events appear here when one needs you to act." },
  ])("SCRUM586_AC4_an_empty_list_says_what_happens_next ($name)", async ({ Component, read, nextStep }) => {
    read.mockResolvedValue([]);
    renderScreen(Component);

    const next = await screen.findByText(nextStep);
    expect(next.closest(".ui-empty-state")).not.toBeNull();
  });

  it("SCRUM586_AC4_my_events_dates_use_the_standard_format", async () => {
    renderScreen(MyAssignedEvents);
    const row = (await screen.findByText("IS212 Industry Night")).closest("li");
    expect(within(row).getByText(STANDARD_TIME)).toBeInTheDocument();
  });

  it("SCRUM586_AC4_venue_request_times_use_the_standard_format", async () => {
    renderScreen(MyBookingRequests);
    const row = (await screen.findByText("IS212 Industry Night")).closest("li");

    expect(within(row).getByText("2026-01-15 09:00 – 11:00 (Singapore time)")).toBeInTheDocument();
    expect(within(row).getByText(`Requested ${STANDARD_TIME}`)).toBeInTheDocument();
  });

  it("SCRUM586_AC4_a_failed_withdraw_is_a_notice_without_try_again", async () => {
    withdrawBookingRequest.mockRejectedValue(httpError(500));
    const { user } = renderScreen(MyBookingRequests);
    await user.click(await screen.findByRole("button", { name: /^Withdraw the request/ }));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("SCRUM586_AC5 button variants", () => {
  it.each([
    { Component: ReviewQueue, open: "Review", back: /Back to the review queue/ },
    { Component: MyAssignedEvents, open: "Open", back: /Back to my events/ },
  ])("SCRUM586_AC5_the_row_action_is_primary_and_back_is_a_link ($open)", async ({ Component, open, back }) => {
    const { user } = renderScreen(Component);
    const opener = (await screen.findAllByRole("button", { name: open }))[0];
    expect(opener).toHaveClass("ui-button--primary");
    await user.click(opener);

    expect(screen.getByRole("button", { name: back })).toHaveClass("ui-button--link");
  });

  it("SCRUM586_AC5_needs_attention_open_is_primary", async () => {
    renderScreen(CoordinatorAttentionList);
    expect(await screen.findByRole("button", { name: "Open IS212 Industry Night" })).toHaveClass("ui-button--primary");
  });

  it("SCRUM586_AC5_only_the_step_that_withdraws_is_danger_and_it_stays_inline", async () => {
    withdrawBookingRequest.mockResolvedValue({});
    const { user } = renderScreen(MyBookingRequests);

    const ask = await screen.findByRole("button", { name: /^Withdraw the request/ });
    expect(ask).toHaveClass("ui-button--secondary");
    await user.click(ask);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveClass("ui-button--secondary");
    const withdraw = screen.getByRole("button", { name: "Yes, withdraw" });
    expect(withdraw).toHaveClass("ui-button--danger");
    await user.click(withdraw);

    expect(withdrawBookingRequest).toHaveBeenCalledExactlyOnceWith("b1");
  });
});
