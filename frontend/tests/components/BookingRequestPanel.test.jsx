// BookingRequestPanel.test.jsx
//
// SCRUM-254 (part of SCRUM-243). The request flow itself: what it shows, what
// it sends, the suitability confirmation, the errors, and the one-at-a-time
// guard. bookingRequestService is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import BookingRequestPanel from "../../src/components/BookingRequestPanel.jsx";
import { createBookingRequest } from "../../src/services/bookingRequestService";
import { checkVenueSuitability } from "../../src/services/venueSuitabilityService";
import { formatVenuePeriod, formatVenueRange } from "../../src/services/datetimeFormat.js";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay.js";
import { deferred } from "../helpers/async.js";

// SCRUM-188 (F5): the panel reads periods on the venue's Singapore clock.
const venueOccupied = (entry) => `${formatOccupiedPeriod(entry, formatVenueRange)} (Singapore time)`;

vi.mock("../../src/services/bookingRequestService", () => ({
  createBookingRequest: vi.fn(),
}));

// SCRUM-525: the panel checks the venue again when the attendance changes.
vi.mock("../../src/services/venueSuitabilityService", () => ({
  checkVenueSuitability: vi.fn(),
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

function renderPanel(props = {}) {
  const callbacks = { onSubmitted: vi.fn(), onVenueAlreadyRequested: vi.fn(), onClose: vi.fn() };
  const user = userEvent.setup();
  const utils = render(<BookingRequestPanel event={EVENT} venue={VENUE} {...callbacks} {...props} />);
  return { user, ...callbacks, ...utils };
}

const submit = () => screen.getByRole("button", { name: /Request this venue|Requesting/ });
const confirmBox = () => screen.queryByRole("checkbox");

beforeEach(() => {
  vi.mocked(createBookingRequest).mockReset();
  vi.mocked(checkVenueSuitability).mockReset();
});

describe("what the coordinator sees", () => {
  it("SCRUM254_shows_the_event_and_venue_the_request_is_for", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Request Hall A" })).toBeInTheDocument();
    expect(screen.getByText("Industry Night")).toBeInTheDocument();
    expect(screen.getByText(formatVenuePeriod(EVENT.proposedStart, EVENT.proposedEnd))).toBeInTheDocument();
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
    expect(screen.getByText("Not set")).toBeInTheDocument();
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

    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 150 });
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
      expectedAttendance: 150,
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
    expect(warning).toHaveTextContent("does not meet this request's requirements");
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
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
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
    expect(warning).toHaveTextContent("does not meet this request's requirements");
    expect(within(warning).getByText("Capacity: Capacity 80 < expected attendance 150")).toBeInTheDocument();
    // The first send did not claim a confirmation.
    expect(createBookingRequest).toHaveBeenNthCalledWith(1, { eventRequestId: "e1", venueId: "v1", expectedAttendance: 150 });
    expect(submit()).toBeDisabled();

    await user.click(confirmBox());
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenNthCalledWith(2, {
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
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
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 150 });
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
    expect(within(list).getByText(formatVenuePeriod("2026-12-01T08:00:00Z", "2026-12-01T10:00:00Z"))).toBeInTheDocument();
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
    const { user, onVenueAlreadyRequested } = renderPanel();

    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    expect(onVenueAlreadyRequested).not.toHaveBeenCalled();
  });

  // SCRUM-525 (AC1): the refusal is about this venue, and the parent is told
  // which refusal it was, so it can lock this venue only and name its status.
  it.each([
    ["BOOKING_REQUEST_EXISTS", /pending or approved request for this venue/],
    ["BOOKING_FLAGGED_FOR_REVIEW", /booking for this venue is flagged for review/],
  ])("SCRUM525_AC1_%s_is_explained_per_venue", async (code, pattern) => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409(code, [{ kind: "booking_request", bookingId: "b9" }]));
    const { user, onVenueAlreadyRequested } = renderPanel();

    await user.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert).not.toHaveTextContent(/only one is allowed/);
    expect(onVenueAlreadyRequested).toHaveBeenCalledTimes(1);
    expect(onVenueAlreadyRequested).toHaveBeenCalledWith(code);
  });

  // SCRUM-266: a request made to replace a flagged booking names it; any
  // other request must not, or approving it would close a booking by mistake.
  it("SCRUM266_W7_sends_replacesBookingId_only_when_replacing", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ replacesBookingId: "f1" });

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      replacesBookingId: "f1",
    });
  });

  it.each([
    ["REPLACED_BOOKING_NOT_FLAGGED", /no longer flagged for review/],
    ["REPLACED_BOOKING_NOT_ON_EVENT", /does not belong to this event/],
  ])("SCRUM266_W7_%s_is_explained_and_reported_to_the_parent", async (code, pattern) => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409(code));
    const onReplacementRefused = vi.fn();
    const { user, onVenueAlreadyRequested } = renderPanel({ replacesBookingId: "f1", onReplacementRefused });

    await user.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(pattern);
    expect(alert).not.toHaveTextContent("prose");
    expect(onReplacementRefused).toHaveBeenCalledWith(code);
    expect(onVenueAlreadyRequested).not.toHaveBeenCalled();
  });

  it("SCRUM254_works_when_the_parent_gives_no_callbacks", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(conflict409("BOOKING_REQUEST_EXISTS"));
    const { user } = renderPanel({ onVenueAlreadyRequested: undefined });
    await user.click(submit());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it.each([
    [403, /assigned to this event/],
    [404, /no longer exists/],
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
        `Setup ${formatVenueRange(ORIENTATION.occupiedStartsAt, ORIENTATION.startsAt)} · ` +
          `Event ${formatVenueRange(ORIENTATION.startsAt, ORIENTATION.endsAt)} · ` +
          `Turnaround ${formatVenueRange(ORIENTATION.endsAt, ORIENTATION.occupiedEndsAt)} (Singapore time)`,
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText("aaaaaaaa")).toBeInTheDocument();
  });

  it("SCRUM484_AC7_booking_request_block_conflict_is_raw", async () => {
    const list = await showConflicts([BLOCK]);

    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    expect(within(row).getByText(formatVenuePeriod(BLOCK.startsAt, BLOCK.endsAt))).toBeInTheDocument();
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
    expect(within(row).getByText(formatVenuePeriod(BLOCK.startsAt, BLOCK.endsAt))).toBeInTheDocument();
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
    expect(within(row).getByText(formatVenuePeriod(zero.startsAt, zero.endsAt))).toBeInTheDocument();
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
    expect(within(row).getByText(venueOccupied(lunch))).toBeInTheDocument();
    expect(venueOccupied(lunch)).toBe(
      `Setup ${formatVenueRange(lunch.occupiedStartsAt, lunch.startsAt)} · ` +
        `Event ${formatVenueRange(lunch.startsAt, lunch.endsAt)} · ` +
        `Turnaround ${formatVenueRange(lunch.endsAt, lunch.occupiedEndsAt)} (Singapore time)`,
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
    expect(within(row).getByText(formatVenuePeriod(zero.startsAt, zero.endsAt))).toBeInTheDocument();
    expect(row.querySelector(".booking-request__conflict-note")).toBeNull();
    expect(row).not.toHaveTextContent(/Your event's own|counts? as well/);
  });

  it("SCRUM484_AC7_booking_request_lists_a_padded_booking_and_a_block_together", async () => {
    const list = await showConflicts([BLOCK, ORIENTATION]);
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Blocked");
    expect(rows[1]).toHaveTextContent("Orientation");
    expect(rows[1]).toHaveTextContent(`Turnaround ${formatVenueRange(ORIENTATION.endsAt, ORIENTATION.occupiedEndsAt)}`);
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
        `Setup ${formatVenueRange(HOLD.occupiedStartsAt, HOLD.startsAt)} · ` +
          `Event ${formatVenueRange(HOLD.startsAt, HOLD.endsAt)} · ` +
          `Turnaround ${formatVenueRange(HOLD.endsAt, HOLD.occupiedEndsAt)} (Singapore time)`,
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
      expectedAttendance: 150,
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

    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 150 });
  });

  it("SCRUM191_sends_only_the_lists_that_have_codes", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ requirements: { layout: "", accessibility: [], facilities: ["wifi"] } });

    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      facilities: ["wifi"],
    });
  });

  // SCRUM-525 (AC2): the layout belongs to the request, so the form shows the
  // one it will send, and says so when it sends none.
  it.each([
    ["a layout", { layout: "theatre" }, "Theatre (from your search)", { roomLayoutCode: "theatre" }],
    ["no layout", { layout: "" }, "None requested", {}],
  ])("SCRUM525_AC2_the_request_form_shows_the_layout_it_will_send (%s)", async (_label, requirements, shown, sent) => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ requirements });

    const term = screen.getByText("Room layout", { selector: "dt" });
    expect(term.nextElementSibling.textContent).toBe(shown);
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      ...sent,
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
      expectedAttendance: 150,
      roomLayoutCode: "theatre",
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });
  });
});

// SCRUM-188 review fix F2 (AC7): the override names what it accepts.
describe("SCRUM-188 AC7 the confirmation names the criteria it accepts", () => {
  const TWO_UNMET = {
    suitable: false,
    criteria: [
      { criterion: "Capacity", met: false, detail: "Capacity 80 < expected attendance 150" },
      { criterion: "Layout", met: false, detail: "Layout banquet not offered", layout: "banquet", offers: ["theatre"] },
      { criterion: "Facilities", met: true },
    ],
  };

  it("SCRUM188_AC7_sends_acknowledged_criteria_from_the_checked_result", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: TWO_UNMET });

    await user.click(confirmBox());
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity", "Layout"],
    });
  });

  it("SCRUM188_AC7_sends_acknowledged_criteria_from_the_servers_list", async () => {
    vi.mocked(createBookingRequest)
      .mockRejectedValueOnce(conflict409("SUITABILITY_CONFIRMATION_REQUIRED", TWO_UNMET.criteria.slice(0, 2)))
      .mockResolvedValueOnce(PENDING);
    const { user } = renderPanel();

    await user.click(submit());
    await screen.findByRole("alert");
    await user.click(confirmBox());
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenNthCalledWith(2, {
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity", "Layout"],
    });
  });

  it("SCRUM188_AC7_a_different_unmet_list_from_the_server_replaces_the_warning_and_needs_a_new_confirmation", async () => {
    vi.mocked(createBookingRequest)
      .mockRejectedValueOnce(conflict409("SUITABILITY_CONFIRMATION_REQUIRED", TWO_UNMET.criteria.slice(0, 2)))
      .mockResolvedValueOnce(PENDING);
    const { user } = renderPanel({ suitability: UNSUITABLE });

    await user.click(confirmBox());
    await user.click(submit());
    expect(createBookingRequest).toHaveBeenNthCalledWith(1, {
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });

    // The server now finds Layout unmet too: the new list shows, unticked.
    const warning = await screen.findByRole("alert");
    await waitFor(() => expect(within(warning).getByText(/^Layout: /)).toBeInTheDocument());
    expect(confirmBox()).not.toBeChecked();
    expect(submit()).toBeDisabled();

    await user.click(confirmBox());
    await user.click(submit());
    expect(createBookingRequest).toHaveBeenNthCalledWith(2, {
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity", "Layout"],
    });
  });

  it("SCRUM188_AC2_the_warning_reads_structured_codes_as_labels", () => {
    renderPanel({ suitability: TWO_UNMET });
    expect(screen.getByText("Layout: Layout Banquet not offered (offers: Theatre)")).toBeInTheDocument();
  });
});

// SCRUM-188 review fix F3 (AC4/AC7): Availability is never overridable.
describe("SCRUM-188 AC7 an unavailable venue cannot be requested", () => {
  const UNAVAILABLE = {
    suitable: false,
    criteria: [
      { criterion: "Capacity", met: false, detail: "Capacity 80 < expected attendance 150" },
      { criterion: "Availability", met: false, detail: "Needs 13:45–16:45 on Wed 11 Nov. Booked for Gala Night" },
    ],
  };
  const UNAVAILABLE_TEXT = /This venue is not available for this event's period, so it can't be requested\./;

  it("SCRUM188_AC7_unmet_availability_offers_no_confirmation_and_keeps_send_disabled", () => {
    renderPanel({ suitability: UNAVAILABLE });

    const warning = screen.getByRole("alert");
    expect(within(warning).getByText(/^Availability: Needs 13:45–16:45/)).toBeInTheDocument();
    expect(within(warning).getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(confirmBox()).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();
    fireEvent.submit(screen.getByLabelText("Setup notes (optional)").closest("form"));
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM188_AC7_a_server_list_naming_availability_cannot_be_confirmed_either", async () => {
    vi.mocked(createBookingRequest).mockRejectedValueOnce(
      conflict409("SUITABILITY_CONFIRMATION_REQUIRED", UNAVAILABLE.criteria),
    );
    const { user } = renderPanel();

    await user.click(submit());

    expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    expect(confirmBox()).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(createBookingRequest).toHaveBeenCalledTimes(1);
  });
});

// SCRUM-188 review fix F5 (AC2/AC7): venue periods read on Singapore's clock.
describe("SCRUM-188 periods in Singapore time", () => {
  it("SCRUM188_AC2_when_reads_in_singapore_time", () => {
    renderPanel();
    // 09:00Z-17:00Z is 17:00 on 1 Dec to 01:00 on 2 Dec in Singapore.
    expect(screen.getByText("2026-12-01 17:00 – 2026-12-02 01:00 (Singapore time)")).toBeInTheDocument();
  });

  it("SCRUM188_AC7_a_block_and_a_padded_booking_in_the_way_read_in_singapore_time", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      conflict409("BOOKING_PERIOD_CONFLICT", [
        { kind: "block", blockId: "k1", startsAt: "2026-12-01T07:00:00Z", endsAt: "2026-12-01T08:45:00Z" },
        {
          kind: "booking",
          bookingId: "b2",
          eventName: "Orientation",
          startsAt: "2026-12-01T07:00:00Z",
          endsAt: "2026-12-01T08:30:00Z",
          occupiedStartsAt: "2026-12-01T06:30:00Z",
          occupiedEndsAt: "2026-12-01T09:15:00Z",
          setupMinutes: 30,
          turnaroundMinutes: 45,
        },
      ]),
    );
    const { user } = renderPanel();
    await user.click(submit());

    const rows = within(await screen.findByRole("list", { name: "What is in the way" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("2026-12-01 15:00 – 16:45 (Singapore time)")).toBeInTheDocument();
    expect(
      within(rows[1]).getByText(
        "Setup 2026-12-01 14:30 – 15:00 · Event 2026-12-01 15:00 – 16:30 · Turnaround 2026-12-01 16:30 – 17:15 (Singapore time)",
      ),
    ).toBeInTheDocument();
  });
});

// SCRUM-525 (AC2): the request carries its own expected attendance, prefilled
// from the event and editable.
describe("SCRUM-525 expected attendance for this venue", () => {
  const attendanceField = () => screen.getByLabelText("Expected attendance for this venue");
  const SUITABLE = { suitable: true, criteria: [], checked: { expectedAttendance: 80 } };

  /** Replace the field's text and leave it, which commits it (blur). */
  async function setAttendance(user, text) {
    await user.clear(attendanceField());
    if (text) await user.type(attendanceField(), text);
    await user.tab();
  }

  it("SCRUM525_AC2_attendance_is_prefilled_from_the_event_and_sent", async () => {
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    expect(attendanceField()).toHaveValue(150);
    expect(attendanceField()).toHaveAccessibleDescription(/^Prefilled with the event's expected attendance\./);
    // Leaving the field unchanged is not a new number, so nothing is checked.
    await user.click(attendanceField());
    await user.tab();
    await user.click(submit());

    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 150 });
    expect(checkVenueSuitability).not.toHaveBeenCalled();
  });

  it("SCRUM525_AC2_an_edited_attendance_is_the_one_sent", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(SUITABLE);
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ requirements: { layout: "theatre" } });

    await setAttendance(user, "80");
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", { layout: "theatre" }, { attendance: 80 });
    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      roomLayoutCode: "theatre",
      expectedAttendance: 80,
    });
  });

  it.each([
    ["0", "Expected attendance must be at least 1."],
    ["", "Enter the expected attendance for this venue."],
    ["1.5", "Expected attendance must be a whole number."],
  ])("SCRUM525_AC2_attendance_%j_blocks_submit", async (text, message) => {
    const { user } = renderPanel();

    await setAttendance(user, text);

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(attendanceField()).toHaveAttribute("aria-invalid", "true");
    expect(submit()).toBeDisabled();
    fireEvent.submit(attendanceField().closest("form"));
    expect(checkVenueSuitability).not.toHaveBeenCalled();
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM525_AC2_attendance_1_is_accepted", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue({ ...SUITABLE, checked: { expectedAttendance: 1 } });
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    await setAttendance(user, "1");
    expect(attendanceField()).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: 1 });
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 1 });
  });

  // The column is a Postgres integer and the server refuses anything above
  // its maximum, so the form refuses it first, beside the field.
  it("SCRUM525_AC2_attendance_above_the_database_limit_is_refused", async () => {
    const { user } = renderPanel();

    await setAttendance(user, "2147483648");

    expect(screen.getByText("Expected attendance must be at most 2,147,483,647.")).toBeInTheDocument();
    expect(attendanceField()).toHaveAttribute("aria-invalid", "true");
    expect(submit()).toBeDisabled();
    fireEvent.submit(attendanceField().closest("form"));
    expect(checkVenueSuitability).not.toHaveBeenCalled();
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM525_AC2_attendance_at_the_database_limit_is_accepted", async () => {
    const max = 2147483647;
    vi.mocked(checkVenueSuitability).mockResolvedValue({ ...SUITABLE, checked: { expectedAttendance: max } });
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    await setAttendance(user, String(max));
    expect(attendanceField()).not.toHaveAttribute("aria-invalid");
    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());

    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: max });
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: max });
  });

  it("SCRUM525_AC2_an_event_without_attendance_starts_blank_and_asks_for_one", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue({ ...SUITABLE, checked: { expectedAttendance: 60 } });
    const { user } = renderPanel({ event: { ...EVENT, expectedAttendance: null } });

    // Shown at once: nothing could be sent without a number. The hint does
    // not claim a prefill there was none of.
    expect(attendanceField()).toHaveValue(null);
    expect(attendanceField()).toHaveAccessibleDescription(/The event has no expected attendance, so enter one/);
    expect(attendanceField()).not.toHaveAccessibleDescription(/Prefilled/);
    expect(screen.getByText("Enter the expected attendance for this venue.")).toBeInTheDocument();
    expect(submit()).toBeDisabled();

    await setAttendance(user, "60");
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: 60 });
  });

  it("SCRUM525_AC2_enter_in_the_field_checks_the_number_and_sends_nothing", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(SUITABLE);
    const { user } = renderPanel();

    await user.clear(attendanceField());
    await user.type(attendanceField(), "80{Enter}");

    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: 80 });
    expect(createBookingRequest).not.toHaveBeenCalled();
  });

  it("SCRUM525_AC2_a_400_on_expectedAttendance_shows_beside_the_attendance_field", async () => {
    vi.mocked(createBookingRequest).mockRejectedValue(
      httpError(400, {
        details: [
          { field: "expectedAttendance", message: "must be a whole number of 1 or more" },
          { field: "setupNotes", message: "must be 1000 characters or fewer" },
        ],
      }),
    );
    const { user } = renderPanel();

    await user.click(submit());

    expect(await screen.findByText("must be a whole number of 1 or more")).toBeInTheDocument();
    expect(attendanceField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("expected attendance for this venue was not accepted");

    // Editing the attendance retires only its own message.
    fireEvent.change(attendanceField(), { target: { value: "151" } });
    expect(screen.queryByText("must be a whole number of 1 or more")).not.toBeInTheDocument();
    expect(screen.getByText("must be 1000 characters or fewer")).toBeInTheDocument();
  });
});

// SCRUM-525 (AC3): the verdict and the confirmation are for the number that
// will be sent, so a changed attendance checks the venue again.
describe("SCRUM-525 editing attendance rechecks the venue", () => {
  const attendanceField = () => screen.getByLabelText("Expected attendance for this venue");
  const CAPACITY_UNMET = {
    suitable: false,
    criteria: [
      { criterion: "Capacity", met: false, detail: "Capacity 100 < expected attendance 150" },
      { criterion: "Facilities", met: true },
    ],
    checked: { expectedAttendance: 150 },
  };
  const suitableFor = (n) => ({
    suitable: true,
    criteria: [{ criterion: "Capacity", met: true, detail: `Capacity 100 >= expected attendance ${n}` }],
    checked: { expectedAttendance: n },
  });
  const warningText = /does not meet this request's requirements/;

  async function setAttendance(user, text) {
    await user.clear(attendanceField());
    await user.type(attendanceField(), text);
    await user.tab();
  }

  it("SCRUM525_AC3_editing_attendance_rechecks_the_venue", async () => {
    const for80 = deferred();
    vi.mocked(checkVenueSuitability).mockImplementation((_e, _v, _req, opts) =>
      opts.attendance === 80 ? for80.promise : Promise.resolve(CAPACITY_UNMET),
    );
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: CAPACITY_UNMET });

    await user.click(confirmBox());
    await setAttendance(user, "80");

    // While checking: no verdict, no box, no send.
    expect(screen.getByRole("status")).toHaveTextContent("Checking Hall A for 80 people…");
    expect(confirmBox()).not.toBeInTheDocument();
    expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    expect(submit()).toBeDisabled();

    for80.resolve(suitableFor(80));
    await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // Back to 150: the warning returns and the earlier tick does not carry over.
    await setAttendance(user, "150");
    expect(await screen.findByText(warningText)).toBeInTheDocument();
    expect(confirmBox()).not.toBeChecked();
    expect(submit()).toBeDisabled();

    await user.click(confirmBox());
    await user.click(submit());

    expect(checkVenueSuitability).toHaveBeenLastCalledWith("e1", "v1", {}, { attendance: 150 });
    expect(createBookingRequest).toHaveBeenCalledWith({
      eventRequestId: "e1",
      venueId: "v1",
      expectedAttendance: 150,
      confirmUnsuitable: true,
      acknowledgedCriteria: ["Capacity"],
    });
  });

  it("SCRUM525_AC3_an_older_check_answering_late_does_not_replace_the_newer_verdict", async () => {
    const for80 = deferred();
    const for120 = deferred();
    vi.mocked(checkVenueSuitability).mockImplementation((_e, _v, _req, opts) =>
      opts.attendance === 80 ? for80.promise : for120.promise,
    );
    const { user } = renderPanel({ suitability: CAPACITY_UNMET });

    await setAttendance(user, "80");
    await setAttendance(user, "120");

    // 120's answer lands first, then 80's stale one.
    for120.resolve(suitableFor(120));
    await waitFor(() => expect(submit()).toBeEnabled());
    await act(async () => {
      for80.resolve({ ...CAPACITY_UNMET, checked: { expectedAttendance: 80 } });
      await for80.promise;
    });

    expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    expect(submit()).toBeEnabled();
  });

  it("SCRUM525_AC3_an_older_check_failing_late_does_not_replace_the_newer_verdict", async () => {
    const for80 = deferred();
    const for120 = deferred();
    vi.mocked(checkVenueSuitability).mockImplementation((_e, _v, _req, opts) =>
      opts.attendance === 80 ? for80.promise : for120.promise,
    );
    const { user } = renderPanel();

    await setAttendance(user, "80");
    await setAttendance(user, "120");

    // 120's verdict (unsuitable, so it is visible) lands first, then 80's stale failure.
    for120.resolve({ ...CAPACITY_UNMET, checked: { expectedAttendance: 120 } });
    expect(await screen.findByText(warningText)).toBeInTheDocument();
    await act(async () => {
      for80.reject(httpError(500));
      await for80.promise.catch(() => {});
    });

    expect(screen.getByText(warningText)).toBeInTheDocument();
    expect(screen.queryByText(/It will be checked again when you send the request\./)).not.toBeInTheDocument();
  });

  it("SCRUM525_AC3_sending_with_an_unchecked_number_checks_it_first", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(suitableFor(80));
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    await user.clear(attendanceField());
    await user.type(attendanceField(), "80");
    await user.click(submit());

    // The first click only checks the new number.
    expect(checkVenueSuitability).toHaveBeenCalledTimes(1);
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: 80 });
    expect(createBookingRequest).not.toHaveBeenCalled();

    await waitFor(() => expect(submit()).toBeEnabled());
    await user.click(submit());
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 80 });
    expect(checkVenueSuitability).toHaveBeenCalledTimes(1);
  });

  // No blur here: the form is submitted straight from the field (as Enter in
  // another field or a script would), so only the send path's own check can
  // stop it. Without that check the request would go out for a number whose
  // verdict was never shown.
  it("SCRUM525_AC3_sending_with_an_unchecked_number_checks_it_first (submitted without leaving the field)", async () => {
    vi.mocked(checkVenueSuitability).mockResolvedValue(suitableFor(80));
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel();

    await user.clear(attendanceField());
    await user.type(attendanceField(), "80");
    expect(checkVenueSuitability).not.toHaveBeenCalled();
    fireEvent.submit(attendanceField().closest("form"));

    expect(createBookingRequest).not.toHaveBeenCalled();
    expect(checkVenueSuitability).toHaveBeenCalledTimes(1);
    expect(checkVenueSuitability).toHaveBeenCalledWith("e1", "v1", {}, { attendance: 80 });
    await waitFor(() => expect(submit()).toBeEnabled());
  });

  it("SCRUM525_AC3_a_failed_recheck_says_so_and_leaves_sending_to_the_server", async () => {
    vi.mocked(checkVenueSuitability).mockRejectedValue(httpError(500));
    vi.mocked(createBookingRequest).mockResolvedValue(PENDING);
    const { user } = renderPanel({ suitability: CAPACITY_UNMET });

    await setAttendance(user, "80");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /It will be checked again when you send the request\.$/,
    );
    // The verdict for 150 no longer applies, so it is not shown.
    expect(screen.queryByText(warningText)).not.toBeInTheDocument();
    expect(submit()).toBeEnabled();

    await user.click(submit());
    expect(createBookingRequest).toHaveBeenCalledWith({ eventRequestId: "e1", venueId: "v1", expectedAttendance: 80 });
  });

  // After a failed check, the server judges the number on send. When it asks
  // for a confirmation, its list is the verdict, and the failed check's
  // "checked again when you send" must not stand beside it as if pending.
  it("SCRUM525_AC3_a_send_after_a_failed_recheck_clears_the_stale_alert", async () => {
    vi.mocked(checkVenueSuitability).mockRejectedValue(httpError(500));
    vi.mocked(createBookingRequest).mockRejectedValue(
      conflict409("SUITABILITY_CONFIRMATION_REQUIRED", [
        { criterion: "Capacity", met: false, detail: "Capacity 60 < expected attendance 80" },
      ]),
    );
    const { user } = renderPanel();

    await setAttendance(user, "80");
    expect(await screen.findByText(/It will be checked again when you send the request\./)).toBeInTheDocument();

    await user.click(submit());

    const warning = await screen.findByText(warningText);
    expect(within(warning.closest("[role=alert]")).getByText("Capacity: Capacity 60 < expected attendance 80")).toBeInTheDocument();
    expect(screen.queryByText(/It will be checked again when you send the request\./)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(confirmBox()).not.toBeChecked();
  });
});
