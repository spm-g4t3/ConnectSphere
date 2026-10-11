// BookingRequestPanel.test.jsx
//
// SCRUM-254 (part of SCRUM-243). The request flow itself: what it shows, what
// it sends, the suitability confirmation, the errors, and the one-at-a-time
// guard. bookingRequestService is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import BookingRequestPanel from "../../src/components/BookingRequestPanel.jsx";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { formatRange } from "../../src/services/displayFormat.js";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay.js";

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

const EVENT = {
  id: "e1",
  eventName: "Industry Night",
  proposedStart: "2026-12-01T09:00:00Z",
  proposedEnd: "2026-12-01T17:00:00Z",
  expectedAttendance: 150,
  venueRequirements: "Tiered seating",
  accessibilityRequirements: null,
};
const VENUE = { id: "v1", name: "Hall A", location: "Level 2", maxCapacity: 200 };
const PENDING = { id: "b1", status: "pending" };

const UNSUITABLE = {
  suitable: false,
  criteria: [
    { criterion: "Capacity", met: false, detail: "Capacity 80 < expected attendance 150" },
    { criterion: "Facilities", met: true },
  ],
};

const httpError = (status, data = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

const conflict409 = (code, conflicts = []) => httpError(409, { error: "prose", code, conflicts });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(props = {}) {
  const callbacks = { onSubmitted: vi.fn(), onEventAlreadyRequested: vi.fn(), onClose: vi.fn() };
  const user = userEvent.setup();
  const utils = render(<BookingRequestPanel event={EVENT} venue={VENUE} {...callbacks} {...props} />);
  return { user, ...callbacks, ...utils };
}

const submit = () => screen.getByRole("button", { name: /Request this venue|Requesting/ });
const confirmBox = () => screen.queryByRole("checkbox");

beforeEach(() => {
  vi.mocked(createBookingRequest).mockReset();
});

describe("what the coordinator sees", () => {
  it("SCRUM254_shows_the_event_and_venue_the_request_is_for", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Request Hall A" })).toBeInTheDocument();
    expect(screen.getByText("Industry Night")).toBeInTheDocument();
    expect(screen.getByText(formatRange(EVENT.proposedStart, EVENT.proposedEnd))).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("Tiered seating")).toBeInTheDocument();
    expect(screen.getByText("Hall A, Level 2, seats up to 200")).toBeInTheDocument();
  });

  it("SCRUM254_says_so_when_a_requirement_was_left_empty", () => {
    renderPanel();
    // accessibilityRequirements is null: an explicit statement, not a blank cell.
    expect(screen.getByText("Not specified")).toBeInTheDocument();
  });

  it("SCRUM254_copes_with_an_event_with_no_name_period_or_attendance_and_a_bare_venue", () => {
    renderPanel({
      event: { id: "e1", venueRequirements: "  " },
      venue: { id: "v1", name: "Annex" },
    });
    expect(screen.getByText("Unnamed event")).toBeInTheDocument();
    expect(screen.getByText("Not set – Not set")).toBeInTheDocument();
    expect(screen.getAllByText("Not specified")).toHaveLength(3);
    expect(screen.getByText("Annex")).toBeInTheDocument();
  });

  it("SCRUM254_offers_optional_setup_notes_and_no_warning_for_a_suitable_venue", () => {
    renderPanel({ suitability: { suitable: true, criteria: [] } });
    expect(screen.getByLabelText("Setup notes (optional)")).toBeInTheDocument();
    expect(confirmBox()).not.toBeInTheDocument();
    expect(submit()).toBeEnabled();
  });
});

describe("submitting", () => {
  it("SCRUM254_sends_only_the_event_and_venue_when_there_are_no_notes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user, onSubmitted } = renderPanel();

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1" });
    expect(await screen.findByRole("status")).toHaveTextContent("Request sent to Venue Staff for Hall A");
    expect(screen.getByRole("status")).toHaveTextContent("Pending");
    expect(onSubmitted).toHaveBeenCalledWith(PENDING);
  });

  it("SCRUM254_sends_trimmed_setup_notes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    await user.type(screen.getByLabelText("Setup notes (optional)"), "  Extra tables  ");
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      setupNotes: "Extra tables",
    });
  });

  it("SCRUM254_replaces_the_form_with_the_confirmation_and_a_close_button", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user, onClose } = renderPanel();

    await user.click(submit());
    await screen.findByRole("status");

    expect(screen.queryByLabelText("Setup notes (optional)")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("SCRUM254_has_no_close_button_when_the_parent_gives_no_handler", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ onClose: undefined, onSubmitted: undefined });

    await user.click(submit());
    await screen.findByRole("status");

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("SCRUM254_cancel_closes_without_sending", async () => {
    const { user, onClose } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM254_refuses_setup_notes_over_1000_characters_without_a_request", async () => {
    const { user } = renderPanel();

    fireEvent.change(screen.getByLabelText("Setup notes (optional)"), { target: { value: "x".repeat(1001) } });

    expect(screen.getByText("Setup notes must be 1000 characters or fewer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup notes (optional)")).toHaveAttribute("aria-invalid", "true");
    expect(submit()).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Setup notes (optional)").closest("form"));
    await user.click(submit());
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM254_counts_notes_in_code_points_like_the_server", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    fireEvent.change(screen.getByLabelText("Setup notes (optional)"), {
      target: { value: "\u{1F600}".repeat(1000) },
    });
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledTimes(1);
  });
});

describe("one request at a time", () => {
  it("SCRUM254_disables_the_button_while_saving_and_sends_once", async () => {
    const pending = deferred();
    vi.mocked(createBookingRequest).mockReturnValue(pending.promise);
    const { user } = renderPanel();

    await user.click(submit());
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveTextContent("Requesting...");
    expect(screen.getByLabelText("Setup notes (optional)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // A second submit that lands before the next render must be ignored.
    fireEvent.submit(screen.getByLabelText("Setup notes (optional)").closest("form"));
    fireEvent.submit(screen.getByLabelText("Setup notes (optional)").closest("form"));
    expect(createBookingRequest).toHaveBeenCalledTimes(1);

    pending.resolve(PENDING);
    await screen.findByRole("status");
    expect(createBookingRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM254_cannot_be_sent_again_once_it_has_succeeded", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();
    await user.click(submit());
    await screen.findByRole("status");

    expect(screen.queryByRole("button", { name: /Request this venue/ })).not.toBeInTheDocument();
    expect(createBookingRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM254_lets_the_coordinator_try_again_after_a_failure", async () => {
    vi.mocked(createBookingRequest).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(PENDING);
    const { user } = renderPanel();

    await user.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not submit the request. Please try again.");
    expect(submit()).toBeEnabled();

    await user.click(submit());
    await screen.findByRole("status");
    expect(createBookingRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a venue that fails the suitability check", () => {
  it("SCRUM254_warns_up_front_and_requires_the_box_before_the_first_send", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: UNSUITABLE });

    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent("does not meet this event's requirements");
    expect(within(warning).getByText("Capacity: Capacity 80 < expected attendance 150")).toBeInTheDocument();
    // Only what was not met.
    expect(within(warning).queryByText(/Facilities/)).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Setup notes (optional)").closest("form"));
    expect(createBookingRequest).not.toHaveBeenCalled();

    await user.click(confirmBox());
    expect(submit()).toBeEnabled();
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      confirmUnsuitable: true,
    });
    await screen.findByRole("status");
  });

  it("SCRUM254_unticking_the_box_takes_the_confirmation_back", async () => {
    const { user } = renderPanel({ suitability: UNSUITABLE });
    await user.click(confirmBox());
    await user.click(confirmBox());
    expect(submit()).toBeDisabled();
  });

  it("SCRUM254_a_failed_result_with_no_criteria_still_needs_confirmation", () => {
    renderPanel({ suitability: { suitable: false } });
    expect(screen.getByRole("alert")).toHaveTextContent("does not meet");
    expect(submit()).toBeDisabled();
  });

  it("SCRUM254_a_criterion_with_no_detail_or_name_is_still_listed", () => {
    renderPanel({ suitability: { suitable: false, criteria: [{ met: false }, { criterion: "Layout", met: false }] } });
    expect(screen.getByText("A requirement")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
  });

  it("SCRUM254_when_the_server_says_so_it_warns_and_waits_for_the_box", async () => {
    vi.mocked(createBookingRequest)
      .mockRejectedValueOnce(conflict409("SUITABILITY_CONFIRMATION_REQUIRED", UNSUITABLE.criteria.slice(0, 1)))
      .mockResolvedValueOnce(PENDING);
    const { user } = renderPanel();

    await user.click(submit());

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("does not meet this event's requirements");
    expect(within(warning).getByText("Capacity: Capacity 80 < expected attendance 150")).toBeInTheDocument();
    // The first send did not claim a confirmation.
    expect(createBookingRequest).toHaveBeenNthCalledWith(1, { eventRequestId: "e1", venueId: "v1" });
    expect(submit()).toBeDisabled();

    await user.click(confirmBox());
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenNthCalledWith(2, {
      eventRequestId: "e1",
      venueId: "v1",
      confirmUnsuitable: true,
    });
    await screen.findByRole("status");
  });

  it("SCRUM254_a_second_confirmation_is_asked_for_again_if_the_server_asks_again", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("SUITABILITY_CONFIRMATION_REQUIRED", []));
    const { user } = renderPanel();

    await user.click(submit());
    await user.click(await screen.findByRole("checkbox"));
    await user.click(submit());

    await waitFor(() => expect(confirmBox()).not.toBeChecked());
    expect(submit()).toBeDisabled();
  });

  it("SCRUM254_a_suitable_result_never_sends_a_confirmation", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: { suitable: true, criteria: [] } });
    await user.click(submit());
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1" });
  });
});

describe("errors the coordinator can act on", () => {
  it("SCRUM254_shows_what_is_in_the_way_for_a_period_conflict", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      conflict409("BOOKING_PERIOD_CONFLICT", [
        { kind: "block", blockId: "bl1", startsAt: "2026-12-01T08:00:00Z", endsAt: "2026-12-01T10:00:00Z", reason: "maintenance" },
        {
          kind: "booking",
          bookingId: "bk1",
          eventRequestId: "11111111-2222-3333-4444-555555555555",
          eventName: "Careers Fair",
          startsAt: "2026-12-01T15:00:00Z",
          endsAt: "2026-12-01T18:00:00Z",
        },
        { kind: "booking", bookingId: "bk2", startsAt: "2026-12-01T15:00:00Z", endsAt: "2026-12-01T18:00:00Z" },
      ]),
    );
    const { user } = renderPanel();

    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent("not available for the whole of the event");
    const list = screen.getByRole("list", { name: "What is in the way" });
    expect(within(list).getByText("Blocked")).toBeInTheDocument();
    expect(within(list).getByText(formatRange("2026-12-01T08:00:00Z", "2026-12-01T10:00:00Z"))).toBeInTheDocument();
    expect(within(list).getByText("Careers Fair")).toBeInTheDocument();
    expect(within(list).getByText("11111111")).toBeInTheDocument();
    expect(within(list).getByText("Unnamed event")).toBeInTheDocument();
  });

  it("SCRUM254_lists_conflicts_even_when_the_server_gives_them_no_ids", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      conflict409("BOOKING_PERIOD_CONFLICT", [
        { kind: "block", startsAt: "2026-12-01T08:00:00Z", endsAt: "2026-12-01T10:00:00Z" },
        { kind: "booking", startsAt: "2026-12-01T15:00:00Z", endsAt: "2026-12-01T18:00:00Z" },
      ]),
    );
    const { user } = renderPanel();

    await user.click(submit());

    const list = await screen.findByRole("list", { name: "What is in the way" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it.each([
    ["VENUE_RETIRED", /retired/],
    ["EVENT_NOT_BOOKABLE", /approved or confirmed/],
    ["EVENT_DATES_MISSING", /no proposed start and end/],
  ])("SCRUM254_explains_%s", async (code, pattern) => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409(code));
    const { user, onEventAlreadyRequested } = renderPanel();

    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    expect(onEventAlreadyRequested).not.toHaveBeenCalled();
  });

  it.each([
    ["BOOKING_REQUEST_EXISTS", /pending or approved venue request/],
    ["BOOKING_FLAGGED_FOR_REVIEW", /flagged for review/],
  ])("SCRUM254_%s_tells_the_parent_the_event_already_has_a_request", async (code, pattern) => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409(code, [{ kind: "booking_request", bookingId: "b9" }]));
    const { user, onEventAlreadyRequested } = renderPanel();

    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    expect(onEventAlreadyRequested).toHaveBeenCalledTimes(1);
  });

  it("SCRUM254_works_when_the_parent_gives_no_callbacks", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("BOOKING_REQUEST_EXISTS"));
    const { user } = renderPanel({ onEventAlreadyRequested: undefined });
    await user.click(submit());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it.each([
    [403, /assigned to this event/],
    [404, /no longer exists/],
    [401, /sign in again/],
    [503, /suitability checking is not available/],
  ])("SCRUM254_explains_a_%i", async (status, pattern) => {
    vi.mocked(createBookingRequest).mockRejectedValue(httpError(status));
    const { user } = renderPanel();

    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
  });

  it("SCRUM254_shows_a_400s_note_message_beside_the_notes_field", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      httpError(400, {
        details: [
          { field: "setupNotes", message: "must be 1000 characters or fewer" },
          { field: "venueId", message: "must be a valid venue id" },
        ],
      }),
    );
    const { user } = renderPanel();

    await user.click(submit());

    expect(await screen.findByText("must be 1000 characters or fewer")).toBeInTheDocument();
    expect(screen.queryByText("must be a valid venue id")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Setup notes (optional)")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("check the form");

    // Editing the notes retires the server's message.
    fireEvent.change(screen.getByLabelText("Setup notes (optional)"), { target: { value: "Shorter" } });
    expect(screen.queryByText("must be 1000 characters or fewer")).not.toBeInTheDocument();
  });
});

describe("SCRUM484_AC7 setup and turnaround in what is in the way", () => {
  // The venue needs 30 minutes of setup and 45 of turnaround. Orientation
  // ends at 08:30Z, so its turnaround holds the venue to 09:15Z, past the
  // 09:00Z start of this event.
  const ORIENTATION = {
    kind: "booking",
    bookingId: "bk-orientation",
    eventRequestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    eventName: "Orientation",
    startsAt: "2026-12-01T07:00:00Z",
    endsAt: "2026-12-01T08:30:00Z",
    occupiedStartsAt: "2026-12-01T06:30:00Z",
    occupiedEndsAt: "2026-12-01T09:15:00Z",
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  // A block ending at 08:45Z: clear of the 09:00Z start, but not of this
  // event's own 30 minutes of setup. A block is never padded, so its
  // occupied fields equal its own period.
  const BLOCK = {
    kind: "block",
    blockId: "bl-maint",
    startsAt: "2026-12-01T07:00:00Z",
    endsAt: "2026-12-01T08:45:00Z",
    reason: "maintenance",
    occupiedStartsAt: "2026-12-01T07:00:00Z",
    occupiedEndsAt: "2026-12-01T08:45:00Z",
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  async function showConflicts(conflicts) {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("BOOKING_PERIOD_CONFLICT", conflicts));
    const { user } = renderPanel();
    await user.click(submit());
    return screen.findByRole("list", { name: "What is in the way" });
  }

  it("SCRUM484_AC7_booking_request_conflict_shows_parts", async () => {
    const list = await showConflicts([ORIENTATION]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("Orientation")).toBeInTheDocument();
    expect(
      within(row).getByText(
        `Setup ${formatRange(ORIENTATION.occupiedStartsAt, ORIENTATION.startsAt)} · ` +
          `Event ${formatRange(ORIENTATION.startsAt, ORIENTATION.endsAt)} · ` +
          `Turnaround ${formatRange(ORIENTATION.endsAt, ORIENTATION.occupiedEndsAt)}`,
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("aaaaaaaa")).toBeInTheDocument();
  });

  it("SCRUM484_AC7_booking_request_block_conflict_is_raw", async () => {
    const list = await showConflicts([BLOCK]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    expect(within(row).getByText(formatRange(BLOCK.startsAt, BLOCK.endsAt))).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/Setup \d|Event |Turnaround \d/);
    expect(
      within(row).getByText(
        "Includes the 30 minutes of setup and 45 minutes of turnaround this venue needs around your event.",
      ),
    ).toHaveClass("booking-request__conflict-note");
  });

  it("SCRUM484_AC7_booking_request_block_note_names_only_the_minutes_above_zero", async () => {
    const list = await showConflicts([{ ...BLOCK, turnaroundMinutes: 0 }]);
    expect(
      within(list).getByText("Includes the 30 minutes of setup this venue needs before your event."),
    ).toBeInTheDocument();
    expect(list).not.toHaveTextContent(/turnaround/i);
  });

  it("SCRUM484_AC7_booking_request_block_has_no_note_at_zero_minutes", async () => {
    const list = await showConflicts([{ ...BLOCK, setupMinutes: 0, turnaroundMinutes: 0 }]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText(formatRange(BLOCK.startsAt, BLOCK.endsAt))).toBeInTheDocument();
    expect(row.querySelector(".booking-request__conflict-note")).toBeNull();
    expect(row).not.toHaveTextContent(/Includes|setup|turnaround/i);
  });

  it("SCRUM484_AC7_booking_request_zero_minutes_show_event_only", async () => {
    const zero = {
      ...ORIENTATION,
      occupiedStartsAt: ORIENTATION.startsAt,
      occupiedEndsAt: ORIENTATION.endsAt,
      setupMinutes: 0,
      turnaroundMinutes: 0,
    };
    const list = await showConflicts([zero]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText(formatRange(zero.startsAt, zero.endsAt))).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/Setup|Turnaround/);
  });

  it("SCRUM484_AC7_booking_request_booking_row_names_the_requests_own_padding", async () => {
    // The worked example: a 30/45 venue. A booking from 11:00 to 12:00 holds
    // the venue until 12:45 with its turnaround; this event starts at 13:14,
    // so its own 30 minutes of setup begin at 12:44 and reach back into it.
    const lunch = {
      kind: "booking",
      bookingId: "bk-lunch",
      eventRequestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      eventName: "Lunch Talk",
      startsAt: "2026-12-01T11:00:00+08:00",
      endsAt: "2026-12-01T12:00:00+08:00",
      occupiedStartsAt: "2026-12-01T10:30:00+08:00",
      occupiedEndsAt: "2026-12-01T12:45:00+08:00",
      setupMinutes: 30,
      turnaroundMinutes: 45,
    };
    const event = {
      ...EVENT,
      proposedStart: "2026-12-01T13:14:00+08:00",
      proposedEnd: "2026-12-01T15:00:00+08:00",
    };
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("BOOKING_PERIOD_CONFLICT", [lunch]));
    const { user } = renderPanel({ event });
    await user.click(submit());
    const list = await screen.findByRole("list", { name: "What is in the way" });

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("Lunch Talk")).toBeInTheDocument();
    expect(within(row).getByText(formatOccupiedPeriod(lunch))).toBeInTheDocument();
    expect(formatOccupiedPeriod(lunch)).toBe(
      `Setup ${formatRange(lunch.occupiedStartsAt, lunch.startsAt)} · ` +
        `Event ${formatRange(lunch.startsAt, lunch.endsAt)} · ` +
        `Turnaround ${formatRange(lunch.endsAt, lunch.occupiedEndsAt)}`,
    );
    expect(
      within(row).getByText(
        "Your event's own 30 minutes of setup and 45 minutes of turnaround count as well.",
      ),
    ).toHaveClass("booking-request__conflict-note");
    // Not the block note's wording, which would read as the booking's own minutes.
    expect(row).not.toHaveTextContent(/Includes the/);
    expect(within(row).getByText("bbbbbbbb")).toBeInTheDocument();
  });

  it("SCRUM484_AC7_booking_request_booking_row_names_only_the_minutes_above_zero", async () => {
    const list = await showConflicts([{ ...ORIENTATION, setupMinutes: 0 }]);
    expect(
      within(list).getByText("Your event's own 45 minutes of turnaround counts as well."),
    ).toBeInTheDocument();
  });

  it("SCRUM484_AC7_booking_request_booking_row_has_no_note_at_zero_minutes", async () => {
    const zero = {
      ...ORIENTATION,
      occupiedStartsAt: ORIENTATION.startsAt,
      occupiedEndsAt: ORIENTATION.endsAt,
      setupMinutes: 0,
      turnaroundMinutes: 0,
    };
    const list = await showConflicts([zero]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText(formatRange(zero.startsAt, zero.endsAt))).toBeInTheDocument();
    expect(row.querySelector(".booking-request__conflict-note")).toBeNull();
    expect(row).not.toHaveTextContent(/Your event's own|counts? as well/);
  });

  it("SCRUM484_AC7_booking_request_lists_a_padded_booking_and_a_block_together", async () => {
    const list = await showConflicts([BLOCK, ORIENTATION]);
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Blocked");
    expect(rows[1]).toHaveTextContent("Orientation");
    expect(rows[1]).toHaveTextContent(`Turnaround ${formatRange(ORIENTATION.endsAt, ORIENTATION.occupiedEndsAt)}`);
  });
});

describe("SCRUM491_AC5 another event's tentative hold in what is in the way", () => {
  // Another event's hold, 10:00-12:00Z, padded 30/45 like a booking.
  const HOLD = {
    kind: "hold",
    holdId: "h-launch",
    eventRequestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    eventName: "Product Launch",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    occupiedStartsAt: "2026-12-01T09:30:00Z",
    occupiedEndsAt: "2026-12-01T12:45:00Z",
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  async function showConflicts(conflicts) {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("BOOKING_PERIOD_CONFLICT", conflicts));
    const { user } = renderPanel();
    await user.click(submit());
    return screen.findByRole("list", { name: "What is in the way" });
  }

  it("SCRUM491_AC5_a_hold_conflict_reads_Tentatively_held_with_its_event_and_occupied_period", async () => {
    const list = await showConflicts([HOLD]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("Tentatively held")).toBeInTheDocument();
    expect(within(row).getByText("Product Launch")).toBeInTheDocument();
    expect(
      within(row).getByText(
        `Setup ${formatRange(HOLD.occupiedStartsAt, HOLD.startsAt)} · ` +
          `Event ${formatRange(HOLD.startsAt, HOLD.endsAt)} · ` +
          `Turnaround ${formatRange(HOLD.endsAt, HOLD.occupiedEndsAt)}`,
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("bbbbbbbb")).toBeInTheDocument();
  });

  it("SCRUM491_AC5_a_booking_conflict_is_not_labelled_as_a_hold", async () => {
    const list = await showConflicts([{ ...HOLD, kind: "booking", bookingId: "bk-1", holdId: undefined }]);

    expect(within(list).queryByText("Tentatively held")).not.toBeInTheDocument();
  });

  it("SCRUM491_AC5_a_hold_without_an_id_still_renders", async () => {
    const list = await showConflicts([{ ...HOLD, holdId: undefined, eventName: "" }]);

    expect(within(list).getByText("Tentatively held")).toBeInTheDocument();
    expect(within(list).getByText("Unnamed event")).toBeInTheDocument();
  });
});


describe("SCRUM-191 the coordinator's requirement codes travel with the request", () => {
  it("SCRUM191_sends_the_layout_accessibility_and_facilities_when_given", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({
      requirements: { layout: "theatre", accessibility: ["hearing_loop"], facilities: ["projector", "wifi"] },
    });

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      roomLayoutCode: "theatre",
      accessibility: ["hearing_loop"],
      facilities: ["projector", "wifi"],
    });
  });

  it.each([
    ["blank", { layout: "", accessibility: [], facilities: [] }],
    ["null", { layout: null, accessibility: null, facilities: null }],
    ["absent", undefined],
  ])("SCRUM191_leaves_them_out_when_%s", async (_label, requirements) => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ requirements });

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1" });
  });

  it("SCRUM191_sends_only_the_lists_that_have_codes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ requirements: { layout: "", accessibility: [], facilities: ["wifi"] } });

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      facilities: ["wifi"],
    });
  });

  it("SCRUM191_codes_and_the_unsuitable_confirmation_go_together", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: UNSUITABLE, requirements: { layout: "theatre" } });

    await user.click(confirmBox());
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      roomLayoutCode: "theatre",
      confirmUnsuitable: true,
    });
  });
});
