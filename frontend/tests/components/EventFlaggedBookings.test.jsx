// EventFlaggedBookings.test.jsx
//
// SCRUM-266. The coordinator's own flagged bookings on the event screen: why
// each was flagged, the replacement already requested, and the cancel and
// replace actions. The service is mocked: the backend decides what is
// flagged and whether a cancellation is allowed. What is proved here is that
// the section shows what it is given, sends what it is asked to, and words
// every failure itself, never with the server's prose.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventFlaggedBookings from "../../src/components/EventFlaggedBookings.jsx";
import { cancelFlaggedBooking, getEventFlaggedBookings } from "../../src/services/flaggedBookingService";
import { formatVenuePeriod } from "../../src/services/datetimeFormat.js";
import { formatTimestamp } from "../../src/services/displayFormat.js";

vi.mock("../../src/services/flaggedBookingService", () => ({
  getEventFlaggedBookings: vi.fn(),
  cancelFlaggedBooking: vi.fn(),
}));

const STARTS = "2026-12-01T09:00:00+08:00";
const ENDS = "2026-12-01T17:00:00+08:00";
const FLAGGED_AT = "2026-11-20T10:30:00+08:00";
const PROSE = "database prose 3f2a9c1e";

const BLOCK = {
  id: "k1",
  reason: "maintenance",
  notes: "Ceiling repair",
  startsAt: "2026-12-01T08:00:00+08:00",
  endsAt: "2026-12-01T18:00:00+08:00",
  removedAt: null,
};

function item(id, overrides = {}) {
  return {
    id,
    eventRequestId: "e1",
    venueId: `v${id}`,
    venueName: `Hall ${id}`,
    venueLocation: "Level 2",
    startsAt: STARTS,
    endsAt: ENDS,
    flaggedAt: FLAGGED_AT,
    reviewReason: null,
    block: BLOCK,
    eventName: "Tech Talk",
    eventStatus: "confirmed",
    replacementRequests: [],
    ...overrides,
  };
}

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
const conflict = (code) => httpError(409, { error: PROSE, code });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSection(props = {}) {
  const handlers = { onReplace: vi.fn(), onCancelled: vi.fn(), onLoaded: vi.fn() };
  const user = userEvent.setup();
  const utils = render(<EventFlaggedBookings eventRequestId="e1" replacingId={null} {...handlers} {...props} />);
  return { user, ...handlers, ...utils };
}

const bookingCard = (name) => screen.getByRole("listitem", { name });
const CANCEL_LABEL = "Reason for cancelling (required)";

beforeEach(() => {
  vi.mocked(getEventFlaggedBookings).mockReset();
  vi.mocked(cancelFlaggedBooking).mockReset();
});

describe("when the section shows (AC1)", () => {
  it("SCRUM266_AC1_loads_this_events_flagged_bookings_and_reports_them_to_the_parent", async () => {
    const rows = [item("1")];
    vi.mocked(getEventFlaggedBookings).mockResolvedValue(rows);
    const { onLoaded } = renderSection();

    expect(await screen.findByRole("heading", { name: "Flagged bookings" })).toBeInTheDocument();
    expect(getEventFlaggedBookings).toHaveBeenCalledWith("e1");
    expect(onLoaded).toHaveBeenCalledWith(rows);
  });

  it.each([
    ["none are flagged", []],
    ["the answer is not a list", { unexpected: true }],
  ])("SCRUM266_AC1_renders_nothing_when_%s", async (_label, data) => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue(data);
    const { container, onLoaded } = renderSection();

    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledWith([]));
    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM266_AC1_renders_nothing_while_loading", () => {
    vi.mocked(getEventFlaggedBookings).mockReturnValue(deferred().promise);
    const { container } = renderSection();

    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only the coordinator assigned to this event can see its flagged bookings."],
    [404, "This event no longer exists."],
    [500, "Flagged bookings could not be loaded."],
  ])("SCRUM266_AC1_a_%i_on_load_is_worded_by_status_without_server_prose", async (status, message) => {
    vi.mocked(getEventFlaggedBookings).mockRejectedValue(httpError(status, { error: PROSE }));
    renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(PROSE);
  });

  it("SCRUM266_AC1_try_again_reloads_and_shows_the_bookings", async () => {
    vi.mocked(getEventFlaggedBookings).mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce([item("1")]);
    const { user } = renderSection();

    await user.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Hall 1, Level 2")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getEventFlaggedBookings).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["arrives", (pending) => pending.resolve([item("1")])],
    ["fails", (pending) => pending.reject(httpError(500))],
  ])("SCRUM266_AC1_a_first_load_that_%s_after_unmount_is_ignored", async (_label, settle) => {
    const pending = deferred();
    vi.mocked(getEventFlaggedBookings).mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount, onLoaded } = renderSection();
    unmount();

    await act(async () => settle(pending));

    expect(onLoaded).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("what each flagged booking shows (AC1)", () => {
  it("SCRUM266_AC1_shows_the_venue_period_flag_time_and_that_alternatives_are_required", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1")]);
    renderSection();

    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });
    expect(within(card).getByText(formatVenuePeriod(STARTS, ENDS))).toBeInTheDocument();
    expect(within(card).getByText(formatTimestamp(FLAGGED_AT, "at an unknown time"))).toBeInTheDocument();
    expect(within(card).getByText("Alternative arrangements are required.")).toBeInTheDocument();
  });

  it.each([
    ["a venue block", {}, ["Venue unavailable: Maintenance"], ["Notes: Ceiling repair"]],
    ["a review reason", { block: null, reviewReason: "safety_review" }, ["Safety review"], []],
    ["both", { reviewReason: "safety_review" }, ["Venue unavailable: Maintenance", "Safety review"], []],
  ])("SCRUM266_AC1_shows_every_reason_for_%s", async (_label, overrides, reasons, details) => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1", overrides)]);
    renderSection();

    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });
    for (const text of [...reasons, ...details]) expect(within(card).getByText(text)).toBeInTheDocument();
  });

  it("SCRUM266_AC1_a_booking_without_venue_details_reads_as_unknown_rather_than_blank", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1", { venueName: null, venueLocation: null })]);
    renderSection();

    expect(await screen.findByRole("listitem", { name: "Unknown venue" })).toBeInTheDocument();
  });

  it("SCRUM266_W7_each_flagged_booking_of_a_several_venue_event_has_its_own_actions", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    renderSection();

    for (const name of ["Hall 1, Level 2", "Hall 2, Level 2"]) {
      const card = await screen.findByRole("listitem", { name });
      expect(within(card).getByRole("button", { name: "Find a replacement venue" })).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Cancel this booking" })).toBeInTheDocument();
    }
  });

  it("SCRUM266_W7_lists_each_replacement_requested_and_says_the_booking_stays_flagged", async () => {
    const replacements = [
      { id: "r1", venueId: "v7", venueName: "Room B", status: "pending", startsAt: STARTS, endsAt: ENDS, createdAt: FLAGGED_AT },
      { id: "r2", venueId: "v8", venueName: null, status: "conflicting", startsAt: STARTS, endsAt: ENDS, createdAt: FLAGGED_AT },
    ];
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1", { replacementRequests: replacements })]);
    renderSection();

    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });
    const period = formatVenuePeriod(STARTS, ENDS);
    expect(within(card).getByText(`Replacement requested: Room B, ${period} (Pending)`)).toBeInTheDocument();
    expect(within(card).getByText(`Replacement requested: Unknown venue, ${period} (Conflicting)`)).toBeInTheDocument();
    expect(within(card).getByText("This booking stays flagged until Venue Staff approve a replacement.")).toBeInTheDocument();
  });

  it.each([
    ["empty", []],
    ["missing", undefined],
  ])("SCRUM266_W7_no_replacement_note_when_the_list_is_%s", async (_label, replacementRequests) => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1", { replacementRequests })]);
    renderSection();

    await screen.findByRole("listitem", { name: "Hall 1, Level 2" });
    expect(screen.queryByText(/Replacement requested/)).not.toBeInTheDocument();
    expect(screen.queryByText(/stays flagged/)).not.toBeInTheDocument();
  });
});

describe("find a replacement venue (W7)", () => {
  it("SCRUM266_W7_tells_the_parent_which_booking_is_being_replaced", async () => {
    const target = item("2");
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1"), target]);
    const { user, onReplace } = renderSection();

    const card = await screen.findByRole("listitem", { name: "Hall 2, Level 2" });
    await user.click(within(card).getByRole("button", { name: "Find a replacement venue" }));

    expect(onReplace).toHaveBeenCalledWith(target);
  });

  it("SCRUM266_W7_marks_the_booking_being_replaced_and_only_that_one", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    renderSection({ replacingId: "2" });

    const replace = async (name) =>
      within(await screen.findByRole("listitem", { name })).getByRole("button", { name: "Find a replacement venue" });
    expect(await replace("Hall 2, Level 2")).toHaveAttribute("aria-pressed", "true");
    expect(await replace("Hall 1, Level 2")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("cancel this booking (AC3)", () => {
  it("SCRUM266_AC3_a_blank_reason_is_refused_and_nothing_is_sent", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1")]);
    const { user } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "   ");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    expect(within(card).getByText("Enter a reason for cancelling this booking.")).toBeInTheDocument();
    expect(cancelFlaggedBooking).not.toHaveBeenCalled();
  });

  it("SCRUM266_AC3_sends_the_trimmed_reason_then_reports_refetches_and_tells_the_parent", async () => {
    const target = item("1");
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([target, item("2")]).mockResolvedValueOnce([item("2")]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1", status: "cancelled" });
    const { user, onCancelled } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "  Venue closed for repairs  ");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    expect(cancelFlaggedBooking).toHaveBeenCalledWith("1", "Venue closed for repairs");
    expect(await screen.findByRole("status")).toHaveTextContent("Cancelled the booking of Hall 1.");
    expect(onCancelled).toHaveBeenCalledWith(target);
    expect(getEventFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("listitem", { name: "Hall 1, Level 2" })).not.toBeInTheDocument();
    expect(bookingCard("Hall 2, Level 2")).toBeInTheDocument();
  });

  it("SCRUM266_AC3_a_refetch_that_fails_after_cancelling_offers_try_again_rather_than_an_empty_list", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([item("1")]).mockRejectedValueOnce(httpError(500, { error: PROSE }));
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "Not needed");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Flagged bookings could not be loaded.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cancelled the booking of Hall 1.");
  });

  it("SCRUM266_AC3_cancelling_the_last_one_keeps_the_notice_on_screen", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([item("1", { venueName: null })]).mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Unknown venue, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "Not needed");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Cancelled the booking of the venue.");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC3_while_cancelling_every_action_is_disabled_and_a_second_submit_is_not_sent", async () => {
    const call = deferred();
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    vi.mocked(cancelFlaggedBooking).mockReturnValue(call.promise);
    const { user } = renderSection();
    const first = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });
    const second = bookingCard("Hall 2, Level 2");
    await user.type(within(first).getByLabelText(CANCEL_LABEL), "Not needed");
    await user.type(within(second).getByLabelText(CANCEL_LABEL), "Also not needed");

    await user.click(within(first).getByRole("button", { name: "Cancel this booking" }));

    expect(within(first).getByRole("button", { name: "Cancelling..." })).toBeDisabled();
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
    // A form can be submitted without its disabled button; the ref stops it.
    fireEvent.submit(within(second).getByRole("button", { name: "Cancel this booking" }).closest("form"));
    expect(cancelFlaggedBooking).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve({ id: "1" }));
  });

  it.each([
    ["BOOKING_NOT_FLAGGED", /no longer flagged for review/],
    ["BOOKING_CHANGED", /changed while you were resolving it/],
  ])("SCRUM266_AC3_a_409_%s_is_worded_from_its_code_and_the_list_refetched", async (code, pattern) => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValueOnce([item("1")]).mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockRejectedValue(conflict(code));
    const { user, onCancelled } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "Not needed");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert).not.toHaveTextContent(PROSE);
    expect(getEventFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("SCRUM266_AC3_a_403_is_shown_on_the_booking_and_names_the_assigned_coordinator", async () => {
    vi.mocked(getEventFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    vi.mocked(cancelFlaggedBooking).mockRejectedValue(httpError(403, { error: PROSE }));
    const { user } = renderSection();
    const card = await screen.findByRole("listitem", { name: "Hall 1, Level 2" });

    await user.type(within(card).getByLabelText(CANCEL_LABEL), "Not needed");
    await user.click(within(card).getByRole("button", { name: "Cancel this booking" }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Only the coordinator assigned to this event can cancel its flagged bookings.",
    );
    expect(within(bookingCard("Hall 2, Level 2")).queryByRole("alert")).not.toBeInTheDocument();
    expect(getEventFlaggedBookings).toHaveBeenCalledTimes(1);
  });
});
