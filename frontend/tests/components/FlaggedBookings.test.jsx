// FlaggedBookings.test.jsx
//
// SCRUM-266. Venue Staff's list of bookings flagged for review and the
// reinstate (AC2) and cancel (AC3) actions taken from it. The service is
// mocked: the backend decides what is flagged, in what order, and whether a
// resolution is allowed (backend tests prove that). What is proved here is
// that the screen shows what it is given, sends what it is asked to, and tells
// Venue Staff what happened, including every refusal.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import FlaggedBookings from "../../src/components/FlaggedBookings.jsx";
import FlaggedBookingCard from "../../src/components/FlaggedBookingCard.jsx";
import {
  cancelFlaggedBooking,
  getFlaggedBookings,
  reinstateFlaggedBooking,
} from "../../src/services/flaggedBookingService";
import { formatVenuePeriod } from "../../src/services/datetimeFormat.js";
import { formatTimestamp } from "../../src/services/displayFormat.js";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/flaggedBookingService", () => ({
  getFlaggedBookings: vi.fn(),
  reinstateFlaggedBooking: vi.fn(),
  cancelFlaggedBooking: vi.fn(),
}));

const STARTS = "2026-12-01T09:00:00+08:00";
const ENDS = "2026-12-01T17:00:00+08:00";
const EVENT_STARTS = "2026-12-02T09:00:00+08:00";
const EVENT_ENDS = "2026-12-02T17:00:00+08:00";
const BLOCK_STARTS = "2026-12-01T08:00:00+08:00";
const BLOCK_ENDS = "2026-12-01T18:00:00+08:00";
const FLAGGED_AT = "2026-11-20T10:30:00+08:00";

function item(id, overrides = {}) {
  return {
    id,
    eventRequestId: `e-${id}`,
    venueId: "v1",
    startsAt: STARTS,
    endsAt: ENDS,
    occupiedStartsAt: STARTS,
    occupiedEndsAt: ENDS,
    flaggedAt: FLAGGED_AT,
    flaggedBy: "staff-1",
    reviewReason: null,
    eventName: `Event ${id}`,
    eventStatus: "approved",
    eventStartsAt: EVENT_STARTS,
    eventEndsAt: EVENT_ENDS,
    assignedCoordinatorId: "c1",
    venueName: `Hall ${id}`,
    venueLocation: "Level 2",
    block: {
      id: `k-${id}`,
      reason: "maintenance",
      notes: null,
      startsAt: BLOCK_STARTS,
      endsAt: BLOCK_ENDS,
      removedAt: null,
    },
    reinstatable: true,
    ...overrides,
  };
}

const SAFETY = { reviewReason: "safety_review", reinstatable: false };

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
const conflict = (code, extra = {}) => httpError(409, { error: "database prose 3f2a9c1e", code, ...extra });

function renderList() {
  const user = userEvent.setup();
  const utils = render(
    <div className="dashboard dashboard--venue-staff">
      <FlaggedBookings />
    </div>,
  );
  return { user, ...utils };
}

const toggleFor = (eventName) =>
  screen.getAllByRole("button").find((b) => b.hasAttribute("aria-expanded") && b.textContent.includes(eventName));
const regionFor = (eventName, venueName) => screen.getByRole("region", { name: `${eventName} at ${venueName}` });
const queryRegion = (eventName, venueName) => screen.queryByRole("region", { name: `${eventName} at ${venueName}` });

async function openCard(user, id) {
  await user.click(toggleFor(`Event ${id}`));
  return regionFor(`Event ${id}`, `Hall ${id}`);
}

const REINSTATE_LABEL = "Reason for reinstating (required)";
const CANCEL_LABEL = "Reason for cancelling (required)";

beforeEach(() => {
  vi.mocked(getFlaggedBookings).mockReset();
  vi.mocked(reinstateFlaggedBooking).mockReset();
  vi.mocked(cancelFlaggedBooking).mockReset();
});

describe("loading, empty and error states (AC1)", () => {
  it("SCRUM266_AC1_shows_loading_until_the_list_arrives", async () => {
    const pending = deferred();
    vi.mocked(getFlaggedBookings).mockReturnValue(pending.promise);
    renderList();

    expect(screen.getByRole("heading", { name: "Flagged bookings" }).closest("section")).not.toBeNull();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await act(async () => pending.resolve([item("1")]));
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("Event 1")).toBeInTheDocument();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(1);
  });

  it("SCRUM266_AC1_an_empty_list_says_nothing_is_flagged", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([]);
    renderList();

    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each([
    [403, "Only Venue Staff can see flagged bookings."],
    [500, "Flagged bookings could not be loaded. Please try again."],
  ])("SCRUM266_AC1_a_%i_on_load_is_explained_and_not_shown_as_empty", async (status, message) => {
    vi.mocked(getFlaggedBookings).mockRejectedValue(httpError(status, { error: "database prose" }));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("No bookings are flagged for review.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC1_a_network_failure_on_load_gets_the_default_message", async () => {
    vi.mocked(getFlaggedBookings).mockRejectedValue(new Error("Network Error"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Flagged bookings could not be loaded. Please try again.");
  });

  it("SCRUM266_AC1_a_list_that_is_not_an_array_is_shown_as_empty", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue({ unexpected: true });
    renderList();

    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
  });

  it.each([
    ["arrives", (pending) => pending.resolve([item("1")])],
    ["fails", (pending) => pending.reject(httpError(500))],
  ])("SCRUM266_AC1_a_first_load_that_%s_after_unmount_is_ignored_without_errors", async (_label, settle) => {
    const pending = deferred();
    vi.mocked(getFlaggedBookings).mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderList();
    unmount();

    await act(async () => settle(pending));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("the list (AC1)", () => {
  it("SCRUM266_AC1_lists_bookings_in_the_servers_order_without_re_sorting", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([
      item("3", { flaggedAt: "2026-11-01T10:00:00+08:00" }),
      item("1", { flaggedAt: "2026-11-30T10:00:00+08:00" }),
      item("2", { flaggedAt: null }),
    ]);
    renderList();
    await screen.findByText("Event 3");

    const names = screen.getAllByRole("listitem").map((li) => li.querySelector("strong").textContent);
    expect(names).toEqual(["Event 3", "Event 1", "Event 2"]);
  });

  it("SCRUM266_AC1_a_collapsed_row_shows_event_venue_period_and_every_reason", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", SAFETY)]);
    renderList();
    await screen.findByText("Event 1");

    const toggle = toggleFor("Event 1");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(toggle).getByText("Hall 1")).toBeInTheDocument();
    expect(within(toggle).getByText(formatVenuePeriod(STARTS, ENDS))).toBeInTheDocument();
    expect(within(toggle).getByText("Venue unavailable: Maintenance; Safety review")).toBeInTheDocument();
    expect(queryRegion("Event 1", "Hall 1")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC1_expanding_shows_the_event_venue_periods_reasons_and_flag_time", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([
      item("1", {
        eventStatus: "safety_review",
        block: { id: "k1", reason: "safety", notes: "Fire alarm testing", startsAt: BLOCK_STARTS, endsAt: BLOCK_ENDS, removedAt: "2026-11-25T10:00:00+08:00" },
        reviewReason: "safety_review",
        reinstatable: false,
      }),
    ]);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    const term = (label) => within(region).getByText(label, { selector: "dt" }).nextElementSibling;
    expect(term("Event status")).toHaveTextContent("Safety review");
    expect(term("Venue")).toHaveTextContent("Hall 1, Level 2");
    expect(term("Booking period")).toHaveTextContent(formatVenuePeriod(STARTS, ENDS));
    expect(term("Event's current period")).toHaveTextContent(formatVenuePeriod(EVENT_STARTS, EVENT_ENDS));
    expect(term("Flagged")).toHaveTextContent(formatTimestamp(FLAGGED_AT));

    expect(within(region).getByRole("heading", { name: "Why it was flagged" })).toBeInTheDocument();
    const reasons = within(region).getByRole("heading", { name: "Why it was flagged" }).nextElementSibling;
    const entries = within(reasons).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("Venue unavailable: Safety (block since removed)");
    expect(entries[0]).toHaveTextContent(`Blocked ${formatVenuePeriod(BLOCK_STARTS, BLOCK_ENDS)}`);
    expect(entries[0]).toHaveTextContent("Notes: Fire alarm testing");
    expect(entries[1]).toHaveTextContent("Safety review");
  });

  it("SCRUM266_AC1_missing_details_read_as_fallbacks_rather_than_blank", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([
      item("1", {
        eventName: null,
        venueName: "",
        venueLocation: null,
        eventStatus: null,
        startsAt: null,
        eventStartsAt: null,
        eventEndsAt: null,
        flaggedAt: null,
        block: null,
        reviewReason: "something_new",
      }),
    ]);
    const { user } = renderList();
    await screen.findByText("Unnamed event");

    await user.click(toggleFor("Unnamed event"));
    const region = regionFor("Unnamed event", "Unknown venue");
    const term = (label) => within(region).getByText(label, { selector: "dt" }).nextElementSibling;
    expect(term("Event status")).toHaveTextContent(/^Unknown$/);
    expect(term("Venue")).toHaveTextContent(/^Unknown venue$/);
    expect(term("Booking period")).toHaveTextContent(/^Not set$/);
    expect(term("Event's current period")).toHaveTextContent(/^Not set$/);
    expect(term("Flagged")).toHaveTextContent(/^at an unknown time$/);
    expect(within(region).getByText("Reason not recorded")).toBeInTheDocument();
  });

  it("SCRUM266_AC1_one_card_is_open_at_a_time_and_a_second_click_closes_it", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    const { user } = renderList();
    await screen.findByText("Event 1");

    await user.click(toggleFor("Event 1"));
    expect(toggleFor("Event 1")).toHaveAttribute("aria-expanded", "true");
    expect(toggleFor("Event 1")).toHaveAttribute("aria-controls", regionFor("Event 1", "Hall 1").id);

    await user.click(toggleFor("Event 2"));
    expect(queryRegion("Event 1", "Hall 1")).not.toBeInTheDocument();
    expect(toggleFor("Event 1")).toHaveAttribute("aria-expanded", "false");
    expect(regionFor("Event 2", "Hall 2")).toBeInTheDocument();

    await user.click(toggleFor("Event 2"));
    expect(queryRegion("Event 2", "Hall 2")).not.toBeInTheDocument();
    expect(toggleFor("Event 2")).toHaveAttribute("aria-expanded", "false");
  });

  it("SCRUM266_AC2_a_reinstatable_booking_offers_both_forms", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    expect(within(region).getByLabelText(REINSTATE_LABEL)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Reinstate" })).toBeEnabled();
    expect(within(region).getByLabelText(CANCEL_LABEL)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Cancel booking" })).toBeEnabled();
    expect(within(region).queryByText(/a safety flag can't be reinstated/)).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_a_safety_flag_hides_reinstate_and_says_to_cancel", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", SAFETY)]);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    expect(within(region).queryByLabelText(REINSTATE_LABEL)).not.toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Reinstate" })).not.toBeInTheDocument();
    expect(within(region).getByText("Resolve by cancelling; a safety flag can't be reinstated.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Cancel booking" })).toBeEnabled();
  });
});

describe("the reason (AC2, AC3)", () => {
  it.each([
    ["Reinstate", REINSTATE_LABEL, "Enter a reason for reinstating this booking.", reinstateFlaggedBooking],
    ["Cancel booking", CANCEL_LABEL, "Enter a reason for cancelling this booking.", cancelFlaggedBooking],
  ])("SCRUM266_AC2_%s_with_a_blank_reason_is_refused_and_nothing_is_sent", async (button, label, message, send) => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");
    const field = within(region).getByLabelText(label);

    expect(field).not.toHaveAttribute("aria-invalid");
    await user.click(within(region).getByRole("button", { name: button }));
    expect(within(region).getByText(message)).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(message);

    await user.type(field, "   \n  ");
    await user.click(within(region).getByRole("button", { name: button }));
    expect(within(region).getByText(message)).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["Reinstate", REINSTATE_LABEL, reinstateFlaggedBooking],
    ["Cancel booking", CANCEL_LABEL, cancelFlaggedBooking],
  ])("SCRUM266_AC2_%s_refuses_a_reason_over_1000_characters", async (button, label, send) => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");
    const field = within(region).getByLabelText(label);
    expect(field).toHaveAttribute("maxLength", "1000");

    // maxLength stops typing, not a pasted or scripted value.
    fireEvent.change(field, { target: { value: "x".repeat(1001) } });
    await user.click(within(region).getByRole("button", { name: button }));

    expect(within(region).getByText("The reason must be 1000 characters or fewer.")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(send).not.toHaveBeenCalled();
  });

  it("SCRUM266_AC2_a_reason_of_exactly_1000_characters_after_trimming_is_sent", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(reinstateFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    fireEvent.change(within(region).getByLabelText(REINSTATE_LABEL), { target: { value: `  ${"x".repeat(1000)}  ` } });
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(reinstateFlaggedBooking).toHaveBeenCalledWith("1", "x".repeat(1000));
  });

  it("SCRUM266_AC2_a_corrected_reason_clears_the_field_error_and_is_sent_trimmed", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(reinstateFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");
    const field = within(region).getByLabelText(REINSTATE_LABEL);

    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.type(field, "  Block lifted early  ");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(reinstateFlaggedBooking).toHaveBeenCalledTimes(1);
    expect(reinstateFlaggedBooking).toHaveBeenCalledWith("1", "Block lifted early");
    expect(cancelFlaggedBooking).not.toHaveBeenCalled();
  });

  it("SCRUM266_AC3_cancel_sends_the_trimmed_reason", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", SAFETY)]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "\n Safety concern upheld \n");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    expect(cancelFlaggedBooking).toHaveBeenCalledTimes(1);
    expect(cancelFlaggedBooking).toHaveBeenCalledWith("1", "Safety concern upheld");
    expect(reinstateFlaggedBooking).not.toHaveBeenCalled();
  });
});

describe("resolving (AC2, AC3)", () => {
  it.each([
    ["Reinstate", REINSTATE_LABEL, "Reinstating...", reinstateFlaggedBooking],
    ["Cancel booking", CANCEL_LABEL, "Cancelling...", cancelFlaggedBooking],
  ])("SCRUM266_AC2_while_%s_is_in_flight_every_button_is_disabled_and_it_is_sent_once", async (button, label, busyLabel, send) => {
    const call = deferred();
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    vi.mocked(send).mockReturnValue(call.promise);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(label), "Because");
    await user.click(within(region).getByRole("button", { name: button }));

    const busy = within(region).getByRole("button", { name: busyLabel });
    expect(busy).toBeDisabled();
    for (const b of within(region).getAllByRole("button")) expect(b).toBeDisabled();
    // Only the resolving form shows the busy label.
    expect(within(region).getAllByRole("button", { name: /\.\.\.$/ })).toHaveLength(1);
    expect(toggleFor("Event 1")).toBeDisabled();
    expect(toggleFor("Event 2")).toBeDisabled();
    await user.click(busy);
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve({ id: "1" }));
  });

  it("SCRUM266_AC2_a_second_resolution_submitted_while_one_is_in_flight_is_not_sent", async () => {
    const call = deferred();
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(reinstateFlaggedBooking).mockReturnValue(call.promise);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");
    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Block lifted");
    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Not needed");

    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    // A form can be submitted without its (disabled) button, so the ref is
    // what keeps a second resolution from going out.
    fireEvent.submit(within(region).getByRole("button", { name: "Cancel booking" }).closest("form"));
    fireEvent.submit(within(region).getByRole("button", { name: "Reinstating..." }).closest("form"));

    expect(cancelFlaggedBooking).not.toHaveBeenCalled();
    expect(reinstateFlaggedBooking).toHaveBeenCalledTimes(1);
    await act(async () => call.resolve({ id: "1" }));
  });

  it("SCRUM266_AC2_a_reinstatement_reports_success_collapses_the_card_and_refetches", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1"), item("2")]).mockResolvedValueOnce([item("2")]);
    vi.mocked(reinstateFlaggedBooking).mockResolvedValue({ id: "1", status: "approved" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Block lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Reinstated the booking of Hall 1 for Event 1; it is approved again.",
    );
    expect(reinstateFlaggedBooking).toHaveBeenCalledWith("1", "Block lifted");
    expect(getFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Event 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(toggleFor("Event 2")).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC3_a_cancellation_reports_success_collapses_the_card_and_refetches", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1", SAFETY)]).mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1", status: "cancelled" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Safety concern upheld");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Cancelled the booking of Hall 1 for Event 1.");
    expect(cancelFlaggedBooking).toHaveBeenCalledWith("1", "Safety concern upheld");
    expect(getFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
  });

  it("SCRUM266_AC3_the_success_notice_for_an_unnamed_booking_says_so_plainly", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", { eventName: null, venueName: null })]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Unnamed event");
    await user.click(toggleFor("Unnamed event"));
    const region = regionFor("Unnamed event", "Unknown venue");

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Duplicate");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Cancelled the booking of the venue for the event.");
  });

  it("SCRUM266_AC2_the_reinstate_notice_for_an_unnamed_booking_says_so_plainly", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", { eventName: "", venueName: undefined })]);
    vi.mocked(reinstateFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Unnamed event");
    await user.click(toggleFor("Unnamed event"));
    const region = regionFor("Unnamed event", "Unknown venue");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Reinstated the booking of the venue for the event; it is approved again.",
    );
  });

  it("SCRUM266_AC2_a_refetch_that_fails_after_a_resolution_keeps_the_notice_and_says_the_list_could_not_load", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1")]).mockRejectedValueOnce(httpError(500));
    vi.mocked(reinstateFlaggedBooking).mockResolvedValue({ id: "1" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Flagged bookings could not be loaded. Please try again.");
    expect(screen.getByRole("status")).toHaveTextContent(/Reinstated the booking of Hall 1 for Event 1/);
    expect(screen.queryByText("No bookings are flagged for review.")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_a_later_successful_refetch_clears_an_earlier_list_error", async () => {
    vi.mocked(getFlaggedBookings)
      .mockResolvedValueOnce([item("1"), item("2")])
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce([]);
    vi.mocked(cancelFlaggedBooking).mockResolvedValue({ id: "x" });
    const { user } = renderList();
    await screen.findByText("Event 1");

    let region = await openCard(user, "1");
    await user.type(within(region).getByLabelText(CANCEL_LABEL), "One");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);

    region = await openCard(user, "2");
    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Two");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    expect(await screen.findByText("No bookings are flagged for review.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cancelled the booking of Hall 2 for Event 2.");
  });
});

describe("refusals (AC2, AC3)", () => {
  it.each([
    ["BOOKING_NOT_FLAGGED", conflict("BOOKING_NOT_FLAGGED"), /no longer flagged for review/],
    ["BOOKING_CHANGED", conflict("BOOKING_CHANGED"), /changed while you were resolving it/],
    ["a 404", httpError(404, { error: "database prose 3f2a9c1e" }), /no longer exists/],
  ])("SCRUM266_AC2_a_stale_refusal_%s_is_shown_above_the_list_and_the_list_refetched", async (_label, err, pattern) => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1"), item("2")]).mockResolvedValueOnce([item("2")]);
    vi.mocked(reinstateFlaggedBooking).mockRejectedValue(err);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert).not.toHaveTextContent(/database prose/);
    // Above the list, not inside a card.
    expect(alert.closest("li")).toBeNull();
    expect(alert.compareDocumentPosition(screen.getByRole("list")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Event 1")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC3_a_stale_cancel_refusal_is_also_shown_above_the_list_and_refetched", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1")]).mockResolvedValueOnce([item("1")]);
    vi.mocked(cancelFlaggedBooking).mockRejectedValue(conflict("BOOKING_CHANGED"));
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Duplicate");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/changed while you were resolving it/);
    expect(alert.closest("li")).toBeNull();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(queryRegion("Event 1", "Hall 1")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_a_period_conflict_is_shown_in_the_card_with_every_clash_listed", async () => {
    const CLASH_STARTS = "2026-12-01T10:00:00+08:00";
    const CLASH_ENDS = "2026-12-01T12:00:00+08:00";
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    vi.mocked(reinstateFlaggedBooking).mockRejectedValue(
      conflict("BOOKING_PERIOD_CONFLICT", {
        conflicts: [
          { kind: "block", reason: "renovation", occupiedStartsAt: CLASH_STARTS, occupiedEndsAt: CLASH_ENDS },
          { kind: "booking", eventName: "Gala Dinner", occupiedStartsAt: CLASH_STARTS, occupiedEndsAt: CLASH_ENDS },
          { kind: "hold", eventName: null, occupiedStartsAt: null, occupiedEndsAt: null },
          { kind: "unknown_kind", eventName: "Hidden" },
        ],
      }),
    );
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(await within(region).findByRole("alert")).toHaveTextContent(
      /no longer free.*In the way: a venue block \(Renovation\), the booking for Gala Dinner, a tentative hold for another event\./,
    );
    const clashes = within(region).getByRole("heading", { name: "What is in the way" }).nextElementSibling;
    const entries = within(clashes).getAllByRole("listitem");
    expect(entries.map((li) => li.querySelector("strong").textContent)).toEqual([
      "A venue block (Renovation)",
      "The booking for Gala Dinner",
      "A tentative hold for another event",
    ]);
    expect(entries[0]).toHaveTextContent(`Occupies ${formatVenuePeriod(CLASH_STARTS, CLASH_ENDS)}`);
    expect(entries[2]).toHaveTextContent("Occupies Not set");
    expect(region).not.toHaveTextContent("Hidden");

    // Not stale: the card stays open, nothing is refetched, and it can still be cancelled.
    expect(regionFor("Event 1", "Hall 1")).toBeInTheDocument();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(1);
    expect(within(region).getByRole("button", { name: "Reinstate" })).toBeEnabled();
    expect(within(region).getByRole("button", { name: "Cancel booking" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_a_retry_after_the_clash_is_cleared_reinstates_and_drops_the_booking_and_conflict", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValueOnce([item("1"), item("2")]).mockResolvedValueOnce([item("2")]);
    vi.mocked(reinstateFlaggedBooking)
      .mockRejectedValueOnce(
        conflict("BOOKING_PERIOD_CONFLICT", { conflicts: [{ kind: "block", reason: "renovation" }] }),
      )
      .mockResolvedValueOnce({ id: "1", status: "approved" });
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent(/In the way: a venue block \(Renovation\)/);
    expect(within(region).getByRole("heading", { name: "What is in the way" })).toBeInTheDocument();

    // The block has since been shortened elsewhere, so the same request now succeeds.
    const reason = within(region).getByLabelText(REINSTATE_LABEL);
    await user.clear(reason);
    await user.type(reason, "Block shortened");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Reinstated the booking of Hall 1 for Event 1; it is approved again.",
    );
    expect(reinstateFlaggedBooking).toHaveBeenNthCalledWith(2, "1", "Block shortened");
    expect(getFlaggedBookings).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Event 1")).not.toBeInTheDocument();
    expect(screen.getByText("Event 2")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer free/)).not.toBeInTheDocument();
  });

  it.each([
    ["SAFETY_FLAG_NOT_REINSTATABLE", conflict("SAFETY_FLAG_NOT_REINSTATABLE"), /flagged by the safety review/],
    ["EVENT_NOT_BOOKABLE", conflict("EVENT_NOT_BOOKABLE"), /no longer approved, in the safety check, or confirmed/],
    ["BOOKING_PERIOD_STALE", conflict("BOOKING_PERIOD_STALE"), /dates have changed/],
    ["VENUE_RETIRED", conflict("VENUE_RETIRED"), /retired/],
    ["a 500", httpError(500, { error: "database prose 3f2a9c1e" }), /Could not resolve the flagged booking/],
  ])("SCRUM266_AC2_a_%s_refusal_is_explained_in_the_card_with_no_clash_list", async (_label, err, pattern) => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(reinstateFlaggedBooking).mockRejectedValue(err);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));

    const alert = await within(region).findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert).not.toHaveTextContent(/database prose/);
    expect(within(region).queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();
    expect(getFlaggedBookings).toHaveBeenCalledTimes(1);
  });

  it("SCRUM266_AC3_a_cancel_refusal_that_is_not_stale_is_shown_in_the_card", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(cancelFlaggedBooking).mockRejectedValue(httpError(403));
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Duplicate");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));

    expect(await within(region).findByRole("alert")).toHaveTextContent("Only Venue Staff can resolve flagged bookings.");
    expect(within(region).getByRole("button", { name: "Cancel booking" })).toBeEnabled();
  });

  it("SCRUM266_AC2_a_card_refusal_is_shown_only_in_its_own_card_and_cleared_by_toggling", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1"), item("2")]);
    vi.mocked(reinstateFlaggedBooking).mockRejectedValue(
      conflict("BOOKING_PERIOD_CONFLICT", { conflicts: [{ kind: "booking", eventName: "Gala Dinner" }] }),
    );
    const { user } = renderList();
    await screen.findByText("Event 1");
    let region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    expect(await within(region).findByRole("alert")).toBeInTheDocument();

    region = await openCard(user, "2");
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(region).queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();

    region = await openCard(user, "1");
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(region).queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_a_new_attempt_clears_the_previous_refusal_and_notice", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1")]);
    vi.mocked(reinstateFlaggedBooking).mockRejectedValueOnce(conflict("VENUE_RETIRED"));
    const call = deferred();
    vi.mocked(cancelFlaggedBooking).mockReturnValue(call.promise);
    const { user } = renderList();
    await screen.findByText("Event 1");
    const region = await openCard(user, "1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), "Lifted");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent(/retired/);

    await user.type(within(region).getByLabelText(CANCEL_LABEL), "Venue retired");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => call.resolve({ id: "1" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Cancelled the booking of Hall 1 for Event 1.");
  });
});

describe("replacement requests (W7)", () => {
  const REPLACEMENTS = [
    { id: "r1", venueId: "v7", venueName: "Room B", status: "pending", startsAt: EVENT_STARTS, endsAt: EVENT_ENDS, createdAt: FLAGGED_AT },
    { id: "r2", venueId: "v8", venueName: null, status: "conflicting", startsAt: EVENT_STARTS, endsAt: EVENT_ENDS, createdAt: FLAGGED_AT },
  ];
  const KEEPS_OPEN =
    "Reinstating keeps the replacement request open; approve or reject it separately under Pending booking requests.";

  it("SCRUM266_W7_venue_staff_see_each_replacement_requested_and_that_reinstating_keeps_it_open", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", { replacementRequests: REPLACEMENTS })]);
    const { user } = renderList();
    await screen.findByText("Event 1");

    const region = await openCard(user, "1");
    const period = formatVenuePeriod(EVENT_STARTS, EVENT_ENDS);
    expect(within(region).getByText(`Replacement requested: Room B, ${period} (Pending)`)).toBeInTheDocument();
    expect(within(region).getByText(`Replacement requested: Unknown venue, ${period} (Conflicting)`)).toBeInTheDocument();
    expect(within(region).getByText(KEEPS_OPEN)).toBeInTheDocument();
  });

  it("SCRUM266_W7_a_safety_flag_lists_the_replacement_but_has_no_reinstate_note", async () => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", { ...SAFETY, replacementRequests: REPLACEMENTS })]);
    const { user } = renderList();
    await screen.findByText("Event 1");

    const region = await openCard(user, "1");
    expect(within(region).getAllByText(/^Replacement requested: /)).toHaveLength(2);
    expect(within(region).queryByText(KEEPS_OPEN)).not.toBeInTheDocument();
  });

  it.each([
    ["empty", []],
    ["missing", undefined],
  ])("SCRUM266_W7_no_replacement_shown_when_the_list_is_%s", async (_label, replacementRequests) => {
    vi.mocked(getFlaggedBookings).mockResolvedValue([item("1", { replacementRequests })]);
    const { user } = renderList();
    await screen.findByText("Event 1");

    const region = await openCard(user, "1");
    expect(within(region).queryByText(/Replacement requested/)).not.toBeInTheDocument();
    expect(within(region).queryByText(KEEPS_OPEN)).not.toBeInTheDocument();
  });
});

describe("FlaggedBookingCard on its own", () => {
  function renderCard(props = {}) {
    return render(
      <ul>
        <FlaggedBookingCard
          item={item("1")}
          expanded
          onToggle={vi.fn()}
          busy={false}
          resolving={null}
          error={null}
          onReinstate={vi.fn()}
          onCancel={vi.fn()}
          {...props}
        />
      </ul>,
    );
  }

  it("SCRUM266_AC1_a_card_rendered_without_a_conflicts_prop_lists_no_clashes", () => {
    renderCard();

    const region = regionFor("Event 1", "Hall 1");
    expect(within(region).queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM266_AC1_a_card_given_conflicts_that_are_not_a_list_lists_no_clashes", () => {
    renderCard({ conflicts: { kind: "booking" }, error: "Something went wrong" });

    const region = regionFor("Event 1", "Hall 1");
    expect(within(region).getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(within(region).queryByRole("heading", { name: "What is in the way" })).not.toBeInTheDocument();
  });

  it("SCRUM266_AC2_the_card_hands_the_item_and_trimmed_reason_to_its_callbacks", async () => {
    const user = userEvent.setup();
    const onReinstate = vi.fn();
    const onCancel = vi.fn();
    const onToggle = vi.fn();
    const booking = item("1");
    renderCard({ item: booking, onReinstate, onCancel, onToggle });
    const region = regionFor("Event 1", "Hall 1");

    await user.type(within(region).getByLabelText(REINSTATE_LABEL), " A ");
    await user.click(within(region).getByRole("button", { name: "Reinstate" }));
    await user.type(within(region).getByLabelText(CANCEL_LABEL), " B ");
    await user.click(within(region).getByRole("button", { name: "Cancel booking" }));
    await user.click(toggleFor("Event 1"));

    expect(onReinstate).toHaveBeenCalledWith(booking, "A");
    expect(onCancel).toHaveBeenCalledWith(booking, "B");
    expect(onToggle).toHaveBeenCalledWith("1");
  });
});
