// VenueHoldsPanel.test.jsx
//
// SCRUM-491. The panel where Venue Staff place a tentative hold on a venue for
// an Approved event (AC1, AC2), see what is in the way when one is refused
// (AC4), and see the venue's active holds and their expiry (AC2, AC7).
//
// The three hold calls in venueService are mocked, so nothing touches the
// network. Timezone-safe: fixtures are instants relative to the real clock
// with day-sized margins, expected strings come from formatRange /
// formatTimestamp / formatOccupiedPeriod, sent timestamps are checked by
// offset shape and getTime(), and datetime-local inputs are set with
// fireEvent.change. No fake timers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueHoldsPanel from "../../src/components/VenueHoldsPanel.jsx";
import { getHoldCandidates, listVenueHolds, placeVenueHold } from "../../src/services/venueService";
import { formatRange, formatTimestamp } from "../../src/services/displayFormat";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/venueService", () => ({
  listVenueHolds: vi.fn(),
  placeVenueHold: vi.fn(),
  getHoldCandidates: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An instant relative to the real clock, minute-aligned, as ISO. */
function fromNow(ms) {
  return new Date(Math.floor((Date.now() + ms) / MINUTE) * MINUTE).toISOString();
}

const STAFF_ID = "d1000000-0000-4000-8000-000000000001";
const OTHER_STAFF_ID = "d2000000-0000-4000-8000-000000000002";
const UUID_PROSE = "hold 3f2504e0-4f89-41d3-9a0c-0305e82c3301 conflicts";

const VENUE = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Hall A",
  location: "Level 2",
  retiredAt: null,
};

const LAUNCH = {
  id: "e1000000-0000-4000-8000-000000000001",
  eventName: "Product Launch",
  proposedStart: fromNow(10 * DAY),
  proposedEnd: fromNow(10 * DAY + 3 * HOUR),
  expectedAttendance: 120,
  assignedCoordinatorId: "c1",
  assignedCoordinatorName: "Casey Coordinator",
};
const NAMELESS = { ...LAUNCH, id: "e2000000-0000-4000-8000-000000000002", eventName: null };

function hold(n, overrides = {}) {
  return {
    id: `h${n}000000-0000-4000-8000-00000000000${n}`,
    eventRequestId: LAUNCH.id,
    venueId: VENUE.id,
    placedBy: OTHER_STAFF_ID,
    placedAt: fromNow(-DAY),
    expiresAt: fromNow(n * DAY),
    status: "active",
    expiredAt: null,
    eventName: "Product Launch",
    eventStartsAt: LAUNCH.proposedStart,
    eventEndsAt: LAUNCH.proposedEnd,
    placedByName: "Sam Staff",
    ...overrides,
  };
}

function httpError(status, data = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: UUID_PROSE, ...data } },
  });
}

beforeEach(() => {
  vi.mocked(listVenueHolds).mockReset().mockResolvedValue([]);
  vi.mocked(getHoldCandidates).mockReset().mockResolvedValue([LAUNCH, NAMELESS]);
  vi.mocked(placeVenueHold).mockReset();
});

async function renderPanel(props = {}) {
  const user = userEvent.setup();
  render(<VenueHoldsPanel venue={VENUE} currentUserId={STAFF_ID} {...props} />);
  await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
  return { user };
}

async function openForm(user) {
  await user.click(screen.getByRole("button", { name: "+ Place a hold" }));
  await screen.findByRole("option", { name: /Product Launch/ });
}

async function fillAndSubmit(user, { eventId = LAUNCH.id, expiresAt = fromNow(3 * DAY) } = {}) {
  await user.selectOptions(screen.getByLabelText("Approved event"), eventId);
  fireEvent.change(screen.getByLabelText("Hold expires"), {
    target: { value: toDatetimeLocalValue(expiresAt) },
  });
  await user.click(screen.getByRole("button", { name: "Place hold" }));
}

describe("SCRUM491 VenueHoldsPanel active holds", () => {
  it("SCRUM491_AC2_lists_each_hold_with_its_event_period_expiry_and_placer", async () => {
    const h = hold(2);
    vi.mocked(listVenueHolds).mockResolvedValue([h]);
    await renderPanel();

    expect(listVenueHolds).toHaveBeenCalledWith(VENUE.id);
    expect(screen.getByRole("heading", { name: "Tentative holds for Hall A — Level 2" })).toBeInTheDocument();
    const row = screen.getByText("Product Launch").closest("li");
    expect(within(row).getByText(formatRange(h.eventStartsAt, h.eventEndsAt))).toBeInTheDocument();
    expect(within(row).getByText("Tentatively held")).toBeInTheDocument();
    expect(row).toHaveTextContent(`Expires ${formatTimestamp(h.expiresAt)}`);
    expect(row).toHaveTextContent(`Placed ${formatTimestamp(h.placedAt)} by Sam Staff`);
  });

  it("SCRUM491_AC2_the_signed_in_users_own_hold_says_by_you", async () => {
    vi.mocked(listVenueHolds).mockResolvedValue([hold(1, { placedBy: STAFF_ID, placedByName: "Me" })]);
    await renderPanel();

    expect(screen.getByText("by you")).toBeInTheDocument();
    expect(screen.queryByText(/by Me/)).not.toBeInTheDocument();
  });

  it("SCRUM491_AC2_a_placer_with_no_name_shows_a_short_id", async () => {
    vi.mocked(listVenueHolds).mockResolvedValue([
      hold(1, { placedByName: null, eventName: null, eventStartsAt: null, eventEndsAt: null }),
    ]);
    await renderPanel();

    expect(screen.getByText(OTHER_STAFF_ID.slice(0, 8))).toBeInTheDocument();
    expect(screen.getByText("Unnamed event")).toBeInTheDocument();
    expect(screen.getByText("no date – no date")).toBeInTheDocument();
  });

  it("SCRUM491_AC7_a_hold_past_its_expiry_is_not_shown_as_held", async () => {
    vi.mocked(listVenueHolds).mockResolvedValue([hold(1, { expiresAt: fromNow(-HOUR) })]);
    await renderPanel();

    expect(screen.queryByText("Tentatively held")).not.toBeInTheDocument();
    expect(screen.getByText("This venue has no active holds.")).toBeInTheDocument();
  });

  it("SCRUM491_says_when_the_venue_has_no_active_holds", async () => {
    await renderPanel();
    expect(screen.getByText("This venue has no active holds.")).toBeInTheDocument();
  });

  it("SCRUM491_shows_Loading_while_the_first_fetch_is_in_flight", async () => {
    const pending = deferred();
    vi.mocked(listVenueHolds).mockReturnValue(pending.promise);
    render(<VenueHoldsPanel venue={VENUE} />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("This venue has no active holds.")).not.toBeInTheDocument();
    pending.resolve([]);
    expect(await screen.findByText("This venue has no active holds.")).toBeInTheDocument();
  });

  it("SCRUM491_AC1_a_403_on_the_list_says_only_Venue_Staff_can_place_holds", async () => {
    vi.mocked(listVenueHolds).mockRejectedValue(httpError(403));
    await renderPanel();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only Venue Staff can place a tentative hold on a venue.",
    );
    expect(screen.queryByText("This venue has no active holds.")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(UUID_PROSE);
  });
});

describe("SCRUM491_AC2 VenueHoldsPanel placing a hold", () => {
  it("SCRUM491_AC2_opening_the_form_loads_the_approved_events", async () => {
    const { user } = await renderPanel();
    await openForm(user);

    expect(getHoldCandidates).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "+ Place a hold" })).not.toBeInTheDocument();
  });

  it("SCRUM491_AC2_a_failed_event_load_is_shown_under_the_picker", async () => {
    vi.mocked(getHoldCandidates).mockRejectedValue(httpError(500));
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "+ Place a hold" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the Approved events. Please try again.",
    );
  });

  it("SCRUM491_AC2_places_the_hold_for_the_event_and_expiry_then_refreshes_the_list", async () => {
    const expiresAt = fromNow(3 * DAY);
    const placed = hold(3, { expiresAt, placedBy: STAFF_ID });
    vi.mocked(placeVenueHold).mockResolvedValue({ hold: placed });
    const { user } = await renderPanel();
    await openForm(user);

    vi.mocked(listVenueHolds).mockResolvedValue([placed]);
    await fillAndSubmit(user, { expiresAt });

    expect(placeVenueHold).toHaveBeenCalledTimes(1);
    const [venueId, payload] = vi.mocked(placeVenueHold).mock.calls[0];
    expect(venueId).toBe(VENUE.id);
    expect(payload.eventRequestId).toBe(LAUNCH.id);
    expect(payload.expiresAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(payload.expiresAt).getTime()).toBe(new Date(expiresAt).getTime());

    expect(await screen.findByRole("status")).toHaveTextContent(
      `Hold placed. Hall A is tentatively held for Product Launch until ${formatTimestamp(expiresAt)}.`,
    );
    expect(screen.queryByLabelText("Approved event")).not.toBeInTheDocument();
    await waitFor(() => expect(listVenueHolds).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("by you")).toBeInTheDocument();
  });

  it("SCRUM491_AC2_the_notice_names_an_unnamed_event_plainly", async () => {
    vi.mocked(placeVenueHold).mockResolvedValue({ hold: hold(3, { eventRequestId: NAMELESS.id }) });
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user, { eventId: NAMELESS.id });

    expect(await screen.findByRole("status")).toHaveTextContent("tentatively held for the event until");
  });

  it("SCRUM491_AC2_disables_the_form_while_the_request_is_in_flight", async () => {
    const pending = deferred();
    vi.mocked(placeVenueHold).mockReturnValue(pending.promise);
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(screen.getByRole("button", { name: "Placing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    pending.resolve({ hold: hold(3) });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("Cancel closes the form without a request", async () => {
    const { user } = await renderPanel();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Approved event")).not.toBeInTheDocument();
    expect(placeVenueHold).not.toHaveBeenCalled();
  });

  it("SCRUM491_AC2_a_400s_details_sit_beside_their_fields", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(
      httpError(400, { details: [{ field: "expiresAt", message: "must be in the future" }] }),
    );
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByText("must be in the future")).toBeInTheDocument();
    expect(screen.getByLabelText("Hold expires")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM491_a_400_without_details_shows_the_generic_message", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(httpError(400, { details: [] }));
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some details were not accepted. Please check the form.",
    );
  });
});

describe("SCRUM491 VenueHoldsPanel refusals", () => {
  it("SCRUM491_AC1_a_403_says_only_Venue_Staff_can_place_a_hold", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(
      httpError(403, { error: "This action is restricted to Venue Staff" }),
    );
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only Venue Staff can place a tentative hold on a venue.",
    );
  });

  it("SCRUM491_AC3_HOLD_EXISTS_says_one_active_hold_per_venue_and_refreshes_the_list", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(
      httpError(409, { code: "HOLD_EXISTS", conflicts: [{ kind: "hold", holdId: "h1" }] }),
    );
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event already holds this venue. An event can have only one active hold at each venue.",
    );
    await waitFor(() => expect(listVenueHolds).toHaveBeenCalledTimes(2));
    expect(getHoldCandidates).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: /in the way/ })).not.toBeInTheDocument();
  });

  it.each([
    [httpError(409, { code: "EVENT_NOT_APPROVED" }), /no longer Approved/],
    [httpError(404), /That venue or event no longer exists/],
  ])("SCRUM491_AC2_a_stale_event_refreshes_the_picker (%#)", async (err, pattern) => {
    vi.mocked(placeVenueHold).mockRejectedValue(err);
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    await waitFor(() => expect(getHoldCandidates).toHaveBeenCalledTimes(2));
    expect(listVenueHolds).toHaveBeenCalledTimes(1);
  });

  it("SCRUM491_AC2_EVENT_DATES_MISSING_says_there_is_no_period_to_hold", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(httpError(409, { code: "EVENT_DATES_MISSING" }));
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("no period to hold");
  });

  it("SCRUM491_AC4_VENUE_RETIRED_closes_the_form_and_disables_Place_a_hold", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(httpError(409, { code: "VENUE_RETIRED" }));
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This venue has been retired, so it can no longer be held.",
    );
    expect(screen.queryByLabelText("Approved event")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "+ Place a hold" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A retired venue cannot be held.");
  });

  it("SCRUM491_AC4_a_retired_venue_cannot_be_held", async () => {
    await renderPanel({ venue: { ...VENUE, retiredAt: "2026-09-01T10:00:00+08:00" } });

    expect(screen.getByRole("button", { name: "+ Place a hold" })).toBeDisabled();
  });

  it("SCRUM491_a_500_shows_the_default_message_and_never_the_server_prose", async () => {
    vi.mocked(placeVenueHold).mockRejectedValue(httpError(500));
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not place the hold. Please try again.",
    );
    expect(document.body).not.toHaveTextContent(UUID_PROSE);
    expect(getHoldCandidates).toHaveBeenCalledTimes(1);
    expect(listVenueHolds).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM491_AC4 VenueHoldsPanel what is in the way", () => {
  const BOOKING = {
    kind: "booking",
    bookingId: "bk-1",
    eventRequestId: "e9",
    eventName: "Orientation",
    startsAt: fromNow(10 * DAY - 2 * HOUR),
    endsAt: fromNow(10 * DAY - HOUR),
    occupiedStartsAt: fromNow(10 * DAY - 2 * HOUR - 30 * MINUTE),
    occupiedEndsAt: fromNow(10 * DAY - 15 * MINUTE),
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };
  const BLOCK = {
    kind: "block",
    blockId: "bl-1",
    startsAt: fromNow(10 * DAY + HOUR),
    endsAt: fromNow(10 * DAY + 5 * HOUR),
    reason: "maintenance",
  };
  const OTHER_HOLD = {
    kind: "hold",
    holdId: "h-other",
    eventRequestId: "e8",
    eventName: "Career Fair",
    startsAt: fromNow(10 * DAY + 2 * HOUR),
    endsAt: fromNow(10 * DAY + 4 * HOUR),
    occupiedStartsAt: fromNow(10 * DAY + 90 * MINUTE),
    occupiedEndsAt: fromNow(10 * DAY + 5 * HOUR),
    setupMinutes: 30,
    turnaroundMinutes: 60,
  };

  async function refuseWith(conflicts) {
    vi.mocked(placeVenueHold).mockRejectedValue(
      httpError(409, { code: "HOLD_PERIOD_CONFLICT", conflicts }),
    );
    const { user } = await renderPanel();
    await openForm(user);
    await fillAndSubmit(user);
    return { user };
  }

  it("SCRUM491_AC4_lists_each_booking_block_and_hold_with_the_conflicting_period", async () => {
    await refuseWith([BOOKING, BLOCK, OTHER_HOLD]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This venue is not free for the whole of the event.",
    );
    expect(
      screen.getByRole("heading", { name: "3 things are in the way of this event's period" }),
    ).toBeInTheDocument();
    const rows = within(document.querySelector(".venue-holds__conflict-list")).getAllByRole("listitem");

    expect(within(rows[0]).getByText("Booked")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Orientation")).toBeInTheDocument();
    expect(within(rows[0]).getByText(formatOccupiedPeriod(BOOKING))).toBeInTheDocument();

    expect(within(rows[1]).getByText("Blocked")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Maintenance")).toBeInTheDocument();
    expect(within(rows[1]).getByText(formatRange(BLOCK.startsAt, BLOCK.endsAt))).toBeInTheDocument();

    expect(within(rows[2]).getByText("Tentatively held")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Career Fair")).toBeInTheDocument();
    expect(within(rows[2]).getByText(formatOccupiedPeriod(OTHER_HOLD))).toBeInTheDocument();
  });

  it("SCRUM491_AC4_one_conflict_reads_in_the_singular_and_missing_names_read_plainly", async () => {
    await refuseWith([{ ...OTHER_HOLD, holdId: undefined, eventName: null }]);

    expect(
      await screen.findByRole("heading", { name: "1 thing is in the way of this event's period" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Unnamed event")).toBeInTheDocument();
  });

  it("SCRUM491_AC4_a_block_without_a_reason_shows_only_its_period", async () => {
    await refuseWith([{ ...BLOCK, reason: null }]);

    await screen.findByRole("heading", { name: /in the way/ });
    const item = document.querySelector(".venue-holds__conflict-list li");
    expect(item.querySelectorAll("span")).toHaveLength(1);
    expect(item).toHaveTextContent(`Blocked${formatRange(BLOCK.startsAt, BLOCK.endsAt)}`);
  });

  it("SCRUM491_AC4_changing_a_field_clears_the_list", async () => {
    const { user } = await refuseWith([BOOKING]);
    await screen.findByRole("heading", { name: /in the way/ });

    fireEvent.change(screen.getByLabelText("Hold expires"), {
      target: { value: toDatetimeLocalValue(fromNow(4 * DAY)) },
    });
    expect(screen.queryByRole("heading", { name: /in the way/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
