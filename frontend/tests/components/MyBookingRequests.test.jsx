// MyBookingRequests.test.jsx
//
// SCRUM-255 (part of SCRUM-243). The coordinator's list of venue requests:
// what it shows for every status, the loading, empty and error states, and
// withdrawing a pending request with the list refreshed afterwards. The
// backend decides whose requests are listed (tests/routes/bookingRequests.test.js
// proves that); here the service is mocked and what is proved is that the
// screen shows what it is given, offers Withdraw only for Pending, and shows
// the server's state after a withdrawal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import MyBookingRequests from "../../src/components/MyBookingRequests.jsx";
import { getMyBookingRequests, withdrawBookingRequest } from "../../src/services/bookingRequestService";
import { formatRange } from "../../src/services/displayFormat.js";

vi.mock("../../src/services/bookingRequestService", () => ({
  getMyBookingRequests: vi.fn(),
  withdrawBookingRequest: vi.fn(),
}));

const START = "2026-12-01T09:00:00Z";
const END = "2026-12-01T17:00:00Z";

const DISPLAY = {
  pending: { status: "pending", label: "Pending", group: "PENDING", description: "x" },
  approved: { status: "approved", label: "Approved", group: "APPROVED", description: "x" },
  rejected: { status: "rejected", label: "Rejected", group: "REJECTED", description: "x" },
  withdrawn: { status: "withdrawn", label: "Withdrawn", group: "WITHDRAWN", description: "x" },
  cancelled: { status: "cancelled", label: "Cancelled", group: "CANCELLED", description: "x" },
  flagged_for_review: { status: "flagged_for_review", label: "Flagged for review", group: "FLAGGED", description: "x" },
};

function item(id, status, overrides = {}) {
  return {
    id,
    eventRequestId: `e-${id}`,
    eventName: `Event ${id}`,
    eventStatus: "approved",
    venueId: `v-${id}`,
    venueName: `Hall ${id}`,
    venueLocation: "Level 2",
    status,
    statusDisplay: DISPLAY[status],
    startsAt: START,
    endsAt: END,
    roomLayoutCode: null,
    setupNotes: null,
    suitabilityOverridden: false,
    flaggedAt: null,
    createdAt: "2026-10-06T10:00:00Z",
    ...overrides,
  };
}

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderList() {
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter>
      <div className="dashboard dashboard--coordinator">
        <MyBookingRequests />
      </div>
    </MemoryRouter>,
  );
  return { user, ...utils };
}

const rowFor = (eventName) => screen.getByText(eventName).closest("li");
const withdrawButton = (eventName) =>
  within(rowFor(eventName)).queryByRole("button", { name: /^Withdraw the request/ });

beforeEach(() => {
  vi.mocked(getMyBookingRequests).mockReset();
  vi.mocked(withdrawBookingRequest).mockReset();
});

describe("loading, empty and error states", () => {
  it("SCRUM255_shows_loading_until_the_list_arrives", async () => {
    const pending = deferred();
    vi.mocked(getMyBookingRequests).mockReturnValue(pending.promise);
    renderList();

    expect(screen.getByText("Loading...")).toBeInTheDocument();

    await act(async () => pending.resolve([item("1", "pending")]));
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("Event 1")).toBeInTheDocument();
  });

  it("SCRUM255_an_empty_list_is_the_good_state_and_points_to_my_events", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([]);
    renderList();

    expect(await screen.findByText(/You have not requested a venue yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open one of your events" })).toHaveAttribute("href", "/my-events");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    [401, /session has expired/],
    [403, /Only Event Coordinators/],
    [500, /could not be loaded/],
    [418, /could not be loaded/],
  ])("SCRUM255_explains_a_%i_and_shows_no_empty_message", async (status, pattern) => {
    vi.mocked(getMyBookingRequests).mockRejectedValue(httpError(status));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    expect(screen.queryByText(/You have not requested a venue yet/)).not.toBeInTheDocument();
  });

  it("SCRUM255_a_network_failure_with_no_response_still_gets_a_message", async () => {
    vi.mocked(getMyBookingRequests).mockRejectedValue(new Error("network"));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
  });

  it("SCRUM255_refetches_when_the_tab_regains_focus", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValueOnce([item("1", "pending")]);
    renderList();
    await screen.findByText("Event 1");

    vi.mocked(getMyBookingRequests).mockResolvedValueOnce([item("1", "approved")]);
    fireEvent.focus(window);

    await waitFor(() => expect(within(rowFor("Event 1")).getByText("Approved")).toBeInTheDocument());
    expect(getMyBookingRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM255_does_not_refetch_when_the_tab_is_hidden", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending")]);
    renderList();
    await screen.findByText("Event 1");

    const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    delete document.visibilityState;
    if (original) Object.defineProperty(Document.prototype, "visibilityState", original);

    expect(getMyBookingRequests).toHaveBeenCalledTimes(1);
  });
});

describe("statuses and details", () => {
  const ALL = [
    item("1", "pending"),
    item("2", "approved"),
    item("3", "rejected"),
    item("4", "withdrawn"),
    item("5", "cancelled"),
    item("6", "flagged_for_review", { flaggedAt: "2026-10-05T09:00:00Z" }),
  ];

  it.each([
    ["Event 1", "Pending", "status--booking-pending"],
    ["Event 2", "Approved", "status--booking-approved"],
    ["Event 3", "Rejected", "status--booking-rejected"],
    ["Event 4", "Withdrawn", "status--booking-withdrawn"],
    ["Event 5", "Cancelled", "status--booking-cancelled"],
    ["Event 6", "Flagged for review", "status--booking-flagged"],
  ])("SCRUM255_%s_shows_the_%s_badge_in_its_own_style", async (eventName, label, className) => {
    vi.mocked(getMyBookingRequests).mockResolvedValue(ALL);
    renderList();
    await screen.findByText(eventName);

    const badge = within(rowFor(eventName)).getByText(label, { selector: ".status-badge" });
    expect(badge).toHaveClass(className);
  });

  it("SCRUM255_lists_every_request_in_the_servers_order", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue(ALL);
    renderList();
    await screen.findByText("Event 1");

    const names = screen.getAllByRole("listitem").map((li) => li.querySelector("strong").textContent);
    expect(names).toEqual(["Event 1", "Event 2", "Event 3", "Event 4", "Event 5", "Event 6"]);
  });

  it("SCRUM255_shows_the_event_venue_and_period", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending")]);
    renderList();
    await screen.findByText("Event 1");

    const row = rowFor("Event 1");
    expect(within(row).getByText("Hall 1, Level 2")).toBeInTheDocument();
    expect(within(row).getByText(formatRange(START, END))).toBeInTheDocument();
    expect(within(row).getByText(/^Requested /)).toBeInTheDocument();
  });

  it("SCRUM255_keeps_the_review_indicator_for_a_flagged_booking", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue(ALL);
    renderList();
    await screen.findByText("Event 6");

    expect(within(rowFor("Event 6")).getByText(/Flagged for review on .*It needs to be resolved/)).toBeInTheDocument();
    expect(within(rowFor("Event 2")).queryByText(/needs to be resolved/)).not.toBeInTheDocument();
  });

  it("SCRUM255_a_flagged_booking_with_no_flag_time_still_says_so", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("6", "flagged_for_review")]);
    renderList();
    expect(await screen.findByText("Flagged for review. It needs to be resolved.")).toBeInTheDocument();
  });

  it("SCRUM255_shows_setup_notes_and_an_overridden_suitability_check", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([
      item("1", "pending", { setupNotes: "Extra tables", suitabilityOverridden: true }),
    ]);
    renderList();
    await screen.findByText("Event 1");

    expect(screen.getByText("Setup notes: Extra tables")).toBeInTheDocument();
    expect(screen.getByText("Requested although the venue did not meet every requirement.")).toBeInTheDocument();
  });

  it("SCRUM255_copes_with_a_row_missing_its_names_and_dates", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([
      item("1", "pending", {
        eventName: null,
        venueName: null,
        venueLocation: null,
        startsAt: null,
        endsAt: null,
        createdAt: null,
      }),
    ]);
    renderList();

    expect(await screen.findByText("Unnamed event")).toBeInTheDocument();
    expect(screen.getByText("Unknown venue")).toBeInTheDocument();
    expect(screen.getByText("unknown – unknown")).toBeInTheDocument();
    expect(screen.getByText("Requested at an unknown time")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw the request for this event at this venue" })).toBeInTheDocument();
  });

  it("SCRUM255_a_row_with_no_status_display_reads_status_unavailable", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "on_hold", { statusDisplay: undefined })]);
    renderList();

    const badge = await screen.findByText("Status Unavailable");
    expect(badge).toHaveClass("status--booking-unknown");
  });

  it("SCRUM255_has_no_staff_approve_or_reject_controls", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue(ALL);
    renderList();
    await screen.findByText("Event 1");

    expect(screen.queryByRole("button", { name: /approve|reject|decline/i })).not.toBeInTheDocument();
  });
});

describe("withdrawing", () => {
  it("SCRUM255_only_a_pending_request_offers_withdraw", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([
      item("1", "pending"),
      item("2", "approved"),
      item("3", "rejected"),
      item("4", "withdrawn"),
      item("5", "cancelled"),
      item("6", "flagged_for_review"),
    ]);
    renderList();
    await screen.findByText("Event 1");

    expect(screen.getAllByRole("button", { name: /^Withdraw the request/ })).toHaveLength(1);
    expect(withdrawButton("Event 1")).toBeInTheDocument();
    for (const name of ["Event 2", "Event 3", "Event 4", "Event 5", "Event 6"]) {
      expect(withdrawButton(name)).not.toBeInTheDocument();
    }
  });

  it("SCRUM255_asks_before_withdrawing_and_keep_it_backs_out", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending")]);
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    expect(screen.getByText("Withdraw this request? Venue Staff will be told.")).toBeInTheDocument();
    expect(withdrawBookingRequest).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(withdrawButton("Event 1")).toBeInTheDocument();
    expect(withdrawBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM255_withdraws_through_the_endpoint_and_refreshes_the_list", async () => {
    vi.mocked(getMyBookingRequests)
      .mockResolvedValueOnce([item("1", "pending"), item("2", "pending")])
      .mockResolvedValueOnce([item("1", "withdrawn"), item("2", "pending")]);
    vi.mocked(withdrawBookingRequest).mockResolvedValue({ id: "1", status: "withdrawn" });
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));

    expect(withdrawBookingRequest).toHaveBeenCalledWith("1");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The request for Event 1 at Hall 1 was withdrawn.",
    );
    // The list now shows what the server says: withdrawn, and no longer withdrawable.
    await waitFor(() => expect(within(rowFor("Event 1")).getByText("Withdrawn")).toBeInTheDocument());
    expect(withdrawButton("Event 1")).not.toBeInTheDocument();
    // The other pending request is untouched and still withdrawable.
    expect(within(rowFor("Event 2")).getByText("Pending")).toBeInTheDocument();
    expect(withdrawButton("Event 2")).toBeInTheDocument();
    expect(getMyBookingRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM255_names_an_unnamed_event_and_venue_in_the_confirmation", async () => {
    vi.mocked(getMyBookingRequests)
      .mockResolvedValueOnce([item("1", "pending", { eventName: null, venueName: null })])
      .mockResolvedValueOnce([item("1", "withdrawn", { eventName: null, venueName: null })]);
    vi.mocked(withdrawBookingRequest).mockResolvedValue({});
    const { user } = renderList();
    await screen.findByText("Unnamed event");

    await user.click(screen.getByRole("button", { name: /^Withdraw the request/ }));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "The request for this event at this venue was withdrawn.",
    );
  });

  it("SCRUM255_sends_one_withdrawal_at_a_time_and_disables_the_other_buttons", async () => {
    const pending = deferred();
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending"), item("2", "pending")]);
    vi.mocked(withdrawBookingRequest).mockReturnValue(pending.promise);
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    const confirm = screen.getByRole("button", { name: "Yes, withdraw" });
    await user.click(confirm);

    expect(screen.getByRole("button", { name: "Withdrawing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeDisabled();
    expect(withdrawButton("Event 2")).toBeDisabled();
    // A second click on the same button, and on the other row, send nothing.
    fireEvent.click(screen.getByRole("button", { name: "Withdrawing..." }));
    fireEvent.click(withdrawButton("Event 2"));
    expect(withdrawBookingRequest).toHaveBeenCalledTimes(1);

    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "withdrawn"), item("2", "pending")]);
    await act(async () => pending.resolve({}));
    await screen.findByRole("status");
    expect(withdrawBookingRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a request that is no longer pending", httpError(409, { code: "BOOKING_NOT_PENDING" }), /no longer pending/],
    ["a request that changed", httpError(409, { code: "BOOKING_CHANGED" }), /changed while you were working/],
    ["a request that was reassigned", httpError(403), /assigned to this event can withdraw/],
    ["a request that no longer exists", httpError(404), /no longer exists/],
  ])("SCRUM255_shows_%s_and_refreshes_the_list", async (_label, failure, pattern) => {
    vi.mocked(getMyBookingRequests)
      .mockResolvedValueOnce([item("1", "pending")])
      .mockResolvedValueOnce([item("1", "approved")]);
    vi.mocked(withdrawBookingRequest).mockRejectedValue(failure);
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    // The truth from the server replaces the stale row: approved, so no Withdraw.
    await waitFor(() => expect(within(rowFor("Event 1")).getByText("Approved")).toBeInTheDocument());
    expect(withdrawButton("Event 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["a 500", httpError(500)],
    ["a 401", httpError(401)],
    ["a network failure", new Error("network")],
  ])("SCRUM255_%s_shows_a_message_without_refreshing_and_allows_trying_again", async (_label, failure) => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending")]);
    vi.mocked(withdrawBookingRequest).mockRejectedValueOnce(failure).mockResolvedValueOnce({});
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(getMyBookingRequests).toHaveBeenCalledTimes(1);

    // Still pending on screen, so the coordinator can try again.
    await user.click(withdrawButton("Event 1"));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(withdrawBookingRequest).toHaveBeenCalledTimes(2);
  });

  it("SCRUM255_starting_another_withdrawal_clears_the_last_message", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([item("1", "pending")]);
    vi.mocked(withdrawBookingRequest).mockRejectedValue(httpError(500));
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(withdrawButton("Event 1"));
    await user.click(screen.getByRole("button", { name: "Yes, withdraw" }));
    await screen.findByRole("alert");

    await user.click(withdrawButton("Event 1"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
