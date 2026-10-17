// scrum492EventVenueBookings.test.jsx
//
// SCRUM-492 (SCRUM-567): the event screen's Venue bookings section. What it
// lists, the Release form, one request at a time, and what each refusal says.
// The service is mocked; the server's own checks are proved in the backend's
// scrum492 suites.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventVenueBookings from "../../src/components/EventVenueBookings.jsx";
import { getMyBookingRequests, releaseVenueBooking } from "../../src/services/bookingRequestService";
import { formatVenuePeriod } from "../../src/services/datetimeFormat";
import { formatTimestamp } from "../../src/services/displayFormat";

vi.mock("../../src/services/bookingRequestService", () => ({
  getMyBookingRequests: vi.fn(),
  releaseVenueBooking: vi.fn(),
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_EVENT = "33333333-3333-4333-8333-333333333333";
const STARTS = "2026-11-11T05:00:00+00:00";
const ENDS = "2026-11-11T06:00:00+00:00";
const RELEASED_AT = "2026-10-18T03:00:00+00:00";

const row = (id, overrides = {}) => ({
  id,
  eventRequestId: EVENT_ID,
  venueName: `Hall ${id}`,
  status: "approved",
  statusDisplay: { status: "approved", label: "Approved" },
  startsAt: STARTS,
  endsAt: ENDS,
  releasedAt: null,
  releaseReason: null,
  ...overrides,
});
const releasedRow = (id) =>
  row(id, { status: "released", statusDisplay: { label: "Released" }, releasedAt: RELEASED_AT, releaseReason: "Moved to Hall B" });

function httpError(status, data = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

function renderSection(props = {}) {
  const user = userEvent.setup();
  const onReleased = vi.fn();
  const utils = render(<EventVenueBookings eventRequestId={EVENT_ID} onReleased={onReleased} {...props} />);
  return { user, onReleased, ...utils };
}

const card = (venue) => screen.getByRole("listitem", { name: venue });
const reasonBox = () => screen.getByLabelText("Reason for releasing this venue (required)");
const confirmButton = () => screen.getByRole("button", { name: /Confirm release|Releasing/ });

async function openRelease(user, venue) {
  await user.click(within(await screen.findByRole("listitem", { name: venue })).getByRole("button", { name: "Release this venue" }));
}

beforeEach(() => {
  vi.mocked(getMyBookingRequests).mockReset();
  vi.mocked(releaseVenueBooking).mockReset();
});


describe("SCRUM492 what the section lists", () => {
  it("SCRUM492_AC2_lists_this_events_approved_and_released_bookings_in_the_servers_order", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([
      row("A"),
      row("P", { status: "pending" }),
      row("X", { eventRequestId: OTHER_EVENT }),
      releasedRow("R"),
      row("B"),
    ]);
    renderSection();

    const items = await screen.findAllByRole("listitem");

    expect(items.map((li) => within(li).getByRole("heading").textContent)).toEqual(["Hall A", "Hall R", "Hall B"]);
    expect(within(card("Hall A")).getByText(formatVenuePeriod(STARTS, ENDS))).toBeInTheDocument();
    expect(within(card("Hall A")).getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("To use another venue, request it from Find a venue below.")).toBeInTheDocument();
  });

  it("SCRUM492_AC6_a_released_booking_shows_when_and_why_and_no_button", async () => {
    // AC2-08, AC6.
    vi.mocked(getMyBookingRequests).mockResolvedValue([releasedRow("R")]);
    renderSection();

    const released = await screen.findByRole("listitem", { name: "Hall R" });

    expect(within(released).getByText("Released")).toBeInTheDocument();
    expect(within(released).getByText(`${formatTimestamp(RELEASED_AT)}: Moved to Hall B`)).toBeInTheDocument();
    expect(within(released).queryByRole("button")).not.toBeInTheDocument();
  });

  it("SCRUM492_AC6_a_released_booking_with_no_time_or_reason_still_reads_in_words", async () => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([row("R", { status: "released", statusDisplay: undefined, venueName: "" })]);
    renderSection();

    const released = await screen.findByRole("listitem", { name: "Unknown venue" });

    expect(within(released).getByText("released")).toBeInTheDocument();
    expect(within(released).getByText("at an unknown time: No reason recorded")).toBeInTheDocument();
  });

  it.each([
    ["no_bookings", []],
    ["only_other_kinds_or_events", [row("P", { status: "pending" }), row("X", { eventRequestId: OTHER_EVENT })]],
    ["an_answer_that_is_not_a_list", { rows: [] }],
  ])("SCRUM492_AC2_with_%s_the_section_renders_nothing", async (_label, data) => {
    vi.mocked(getMyBookingRequests).mockResolvedValue(data);
    const { container } = renderSection();

    await waitFor(() => expect(getMyBookingRequests).toHaveBeenCalled());
    await Promise.resolve();

    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM492_AC2_renders_nothing_while_loading", () => {
    vi.mocked(getMyBookingRequests).mockReturnValue(new Promise(() => {}));
    const { container } = renderSection();

    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM492_AC2_a_failed_load_offers_try_again_which_reads_again", async () => {
    vi.mocked(getMyBookingRequests).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce([row("A")]);
    const { user } = renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Venue bookings could not be loaded.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("listitem", { name: "Hall A" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM492_AC2_a_reload_that_fails_says_so_and_keeps_try_again", async () => {
    vi.mocked(getMyBookingRequests).mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(500));
    const { user } = renderSection();

    await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(getMyBookingRequests).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Venue bookings could not be loaded.");
  });

  it("SCRUM492_AC2_a_load_that_lands_after_the_section_closes_changes_nothing", async () => {
    let resolveLoad;
    let rejectLoad;
    vi.mocked(getMyBookingRequests)
      .mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLoad = reject; }));
    const first = renderSection();
    first.unmount();
    const second = renderSection();
    second.unmount();

    resolveLoad([row("A")]);
    rejectLoad(httpError(500));
    await Promise.resolve();

    expect(getMyBookingRequests).toHaveBeenCalledTimes(2);
  });
});


describe("SCRUM492 the Release form", () => {
  beforeEach(() => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([row("A"), row("B")]);
  });

  it("SCRUM492_AC1_confirm_is_disabled_while_the_reason_is_blank", async () => {
    const { user } = renderSection();
    await openRelease(user, "Hall A");

    expect(confirmButton()).toBeDisabled();
    await user.type(reasonBox(), "   ");
    expect(confirmButton()).toBeDisabled();
    fireEvent.submit(confirmButton().closest("form"));
    expect(releaseVenueBooking).not.toHaveBeenCalled();
  });

  it("SCRUM492_AC1_the_counter_counts_the_trimmed_reason_out_of_1000", async () => {
    const { user } = renderSection();
    await openRelease(user, "Hall A");

    expect(screen.getByText("0 / 1,000")).toBeInTheDocument();
    await user.type(reasonBox(), "  Moved  ");
    expect(screen.getByText("5 / 1,000")).toBeInTheDocument();
    expect(reasonBox()).toHaveAttribute("maxLength", "1000");
  });

  it("SCRUM492_AC1_keep_this_venue_closes_the_form_and_sends_nothing", async () => {
    const { user } = renderSection();
    await openRelease(user, "Hall A");

    await user.click(screen.getByRole("button", { name: "Keep this venue" }));

    expect(screen.queryByLabelText("Reason for releasing this venue (required)")).not.toBeInTheDocument();
    expect(releaseVenueBooking).not.toHaveBeenCalled();
  });

  it("SCRUM492_AC2_only_the_chosen_booking_is_sent_with_the_reason_trimmed_then_the_list_refetches", async () => {
    // AC2-08: after the refetch the booking reads Released and the other
    // still offers Release.
    // The second of three, so a call that sent another row's id would show.
    vi.mocked(getMyBookingRequests)
      .mockResolvedValueOnce([row("A"), row("B"), row("C")])
      .mockResolvedValueOnce([row("A"), releasedRow("B"), row("C")]);
    vi.mocked(releaseVenueBooking).mockResolvedValue({ booking: releasedRow("B"), returnedToPending: [] });
    const { user, onReleased } = renderSection();
    await openRelease(user, "Hall B");

    await user.type(reasonBox(), "  Moved to Hall D  ");
    await user.click(confirmButton());

    expect(releaseVenueBooking).toHaveBeenCalledTimes(1);
    expect(releaseVenueBooking).toHaveBeenCalledWith("B", "Moved to Hall D");
    expect(await screen.findByRole("status")).toHaveTextContent("Hall B was released. Venue Staff have been told.");
    expect(screen.getByRole("status")).not.toHaveTextContent("no longer blocked");
    await waitFor(() => expect(within(card("Hall B")).queryByRole("button")).not.toBeInTheDocument());
    expect(within(card("Hall B")).getByText("Released")).toBeInTheDocument();
    for (const other of ["Hall A", "Hall C"]) {
      expect(within(card(other)).getByRole("button", { name: "Release this venue" })).toBeEnabled();
    }
    expect(onReleased).toHaveBeenCalledWith(expect.objectContaining({ id: "B" }));
  });

  it.each([
    [1, " 1 other event's request is no longer blocked."],
    [2, " 2 other events' requests are no longer blocked."],
  ])("SCRUM492_AC4_with_%s_returned_to_pending_the_notice_says_%s", async (count, line) => {
    vi.mocked(releaseVenueBooking).mockResolvedValue({
      booking: releasedRow("A"),
      returnedToPending: Array.from({ length: count }, (_, i) => `r${i}`),
    });
    const { user } = renderSection();
    await openRelease(user, "Hall A");
    await user.type(reasonBox(), "Moved");
    await user.click(confirmButton());

    expect(await screen.findByRole("status")).toHaveTextContent(`Hall A was released. Venue Staff have been told.${line}`);
  });

  it("SCRUM492_AC4_an_answer_with_no_list_unblocks_nothing", async () => {
    vi.mocked(releaseVenueBooking).mockResolvedValue({ booking: releasedRow("A") });
    const { user } = renderSection({ onReleased: undefined });
    await openRelease(user, "Hall A");
    await user.type(reasonBox(), "Moved");
    await user.click(confirmButton());

    expect(await screen.findByRole("status")).not.toHaveTextContent("no longer blocked");
  });

  it("SCRUM492_AC1_a_double_click_sends_once_and_every_release_waits", async () => {
    vi.mocked(releaseVenueBooking).mockReturnValue(new Promise(() => {}));
    const { user } = renderSection();
    await openRelease(user, "Hall A");
    await user.type(reasonBox(), "Moved");

    await user.dblClick(confirmButton());
    fireEvent.submit(confirmButton().closest("form"));

    expect(releaseVenueBooking).toHaveBeenCalledTimes(1);
    expect(confirmButton()).toHaveTextContent("Releasing...");
    expect(confirmButton()).toBeDisabled();
    expect(within(card("Hall B")).getByRole("button", { name: "Release this venue" })).toBeDisabled();
  });
});


describe("SCRUM492 refusals, keyed on the status and the code", () => {
  beforeEach(() => {
    vi.mocked(getMyBookingRequests).mockResolvedValue([row("A")]);
  });

  async function refuse(user, err) {
    vi.mocked(releaseVenueBooking).mockRejectedValue(err);
    await openRelease(user, "Hall A");
    await user.type(reasonBox(), "Moved");
    await user.click(confirmButton());
  }

  it.each([
    [400, "Give a reason of up to 1,000 characters."],
    [401, "Your session has expired. Please sign in again."],
    [403, "Only the coordinator assigned to this event can release its venues."],
    [404, "This booking no longer exists."],
    [500, "The venue could not be released. Please try again."],
  ])("SCRUM492_AC1_a_%s_is_shown_with_the_booking", async (status, message) => {
    const { user } = renderSection();

    await refuse(user, httpError(status, { error: "server words" }));

    expect(await within(card("Hall A")).findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("server words")).not.toBeInTheDocument();
    expect(getMyBookingRequests).toHaveBeenCalledTimes(1);
    // The form stays open with the reason, so the coordinator can try again.
    expect(reasonBox()).toHaveValue("Moved");
  });

  it.each([
    ["EVENT_NOT_APPROVED", "Venues can be released only while the event is Approved."],
    ["BOOKING_NOT_APPROVED", "This booking is no longer approved. The list has been refreshed."],
    ["BOOKING_CHANGED", "This booking changed while you were releasing it. The list has been refreshed."],
    ["SOMETHING_ELSE", "The venue could not be released. Please try again."],
  ])("SCRUM492_AC1_a_409_%s_is_said_and_the_list_refetches", async (code, message) => {
    const { user } = renderSection();

    await refuse(user, httpError(409, { code, error: "server words" }));

    await waitFor(() => expect(getMyBookingRequests).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByLabelText("Reason for releasing this venue (required)")).not.toBeInTheDocument();
  });

  it("SCRUM492_AC1_a_release_that_never_reached_the_server_is_the_generic_message", async () => {
    const { user } = renderSection();

    await refuse(user, new Error("Network Error"));

    expect(await within(card("Hall A")).findByRole("alert")).toHaveTextContent(
      "The venue could not be released. Please try again.",
    );
  });

  it("SCRUM492_AC1_opening_the_form_again_clears_the_last_refusal", async () => {
    const { user } = renderSection();
    await refuse(user, httpError(400));
    await user.click(screen.getByRole("button", { name: "Keep this venue" }));

    await openRelease(user, "Hall A");

    expect(within(card("Hall A")).queryByRole("alert")).not.toBeInTheDocument();
  });
});
