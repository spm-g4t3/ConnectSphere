// VenueBlocksPanel.test.jsx
//
// SCRUM-127 (part of SCRUM-17). The panel where Venue Staff create a block
// (AC1), see the approved bookings it would overlap and explicitly override
// (AC3), and shorten, extend or remove a block (AC4).
//
// The four block calls in venueService are mocked, so nothing touches the
// network. Timezone-safe: fixtures are instants relative to the real clock
// with day-sized margins, expected ranges come from formatRange, sent
// timestamps are checked by offset shape and getTime(), and datetime-local
// inputs are set with fireEvent.change. No fake timers.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueBlocksPanel from "../../src/components/VenueBlocksPanel.jsx";
import {
  createVenueBlock,
  listVenueBlocks,
  removeVenueBlock,
  updateVenueBlock,
} from "../../src/services/venueService";
import { formatRange } from "../../src/services/displayFormat";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat";
import { getVenueBlockHistory } from "../../src/services/venueService";
import { formatTimestamp } from "../../src/services/displayFormat";

vi.mock("../../src/services/venueService", () => ({
  listVenueBlocks: vi.fn(),
  createVenueBlock: vi.fn(),
  updateVenueBlock: vi.fn(),
  removeVenueBlock: vi.fn(),
  getVenueBlockHistory: vi.fn(),
}));

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An instant relative to the real clock, minute-aligned, as ISO. */
function fromNow(ms) {
  const t = Math.floor((Date.now() + ms) / 60_000) * 60_000;
  return new Date(t).toISOString();
}

const VENUE = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Hall A",
  location: "Level 2",
  retiredAt: null,
};

const UPCOMING = {
  id: "b1000000-0000-4000-8000-000000000001",
  venueId: VENUE.id,
  startsAt: fromNow(5 * DAY),
  endsAt: fromNow(6 * DAY),
  reason: "maintenance",
  notes: "Aircon servicing",
};
const IN_EFFECT = {
  id: "b2000000-0000-4000-8000-000000000002",
  venueId: VENUE.id,
  startsAt: fromNow(-2 * DAY),
  endsAt: fromNow(2 * DAY),
  reason: "internal_activity",
  notes: null,
};
const ENDED = {
  id: "b3000000-0000-4000-8000-000000000003",
  venueId: VENUE.id,
  startsAt: fromNow(-10 * DAY),
  endsAt: fromNow(-9 * DAY),
  reason: "safety",
  notes: "Fire drill",
};
const BLOCKS = [IN_EFFECT, UPCOMING, ENDED];

// Booking times are offset from every block's range so formatRange strings
// never collide with a row's.
function booking(n, name, startMs) {
  return {
    bookingId: `a1b2c3d4-0000-4000-8000-00000000000${n}`,
    eventRequestId: `e${n}b2c3d4-0000-4000-8000-00000000000${n}`,
    eventName: name,
    startsAt: fromNow(startMs),
    endsAt: fromNow(startMs + 2 * HOUR),
  };
}
const BOOKING_A = booking(1, "Tech Talk", 20 * DAY + 1 * HOUR);
const BOOKING_B = booking(2, "Career Fair", 20 * DAY + 5 * HOUR);
const BOOKING_C = booking(3, "Hackathon", 20 * DAY + 9 * HOUR);

const UUID_PROSE = `block ${UPCOMING.id} overlaps block ${IN_EFFECT.id} at venue ${VENUE.id}`;

function httpError(status, data = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: UUID_PROSE, ...data } },
  });
}

function bookingConflict(conflicts) {
  return httpError(409, { code: "BLOCK_BOOKING_CONFLICT", conflicts });
}

/** A promise the test settles by hand, to hold a request in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MSG = {
  saved: "Block saved.",
  removed: "Block removed.",
  noneFlagged: "No bookings were flagged.",
  changedSince: "The overlapping bookings changed since you confirmed. Review the updated list.",
  overlapsBlock:
    "This period overlaps another block on this venue. Choose a different period, or change that block instead.",
  retired: "This venue has been retired, so it can no longer be blocked.",
  removedAlready: "This block has already been removed. The list has been refreshed.",
  ended:
    "This block has already ended, so it can no longer be changed. The list has been refreshed.",
  blockGone: "That block no longer exists. The list has been refreshed.",
  unknown409: "This block changed while you were working on it. The list has been refreshed.",
  removeFailed: "Could not remove this block. Please try again.",
  confirmRemove: "Remove this block? Bookings it flagged stay flagged for review.",
  endedNote: "Ended blocks are kept as a record and can't be changed.",
  retiredTitle: "A retired venue cannot be blocked.",
};

let confirmSpy;

beforeEach(() => {
  vi.mocked(listVenueBlocks).mockReset();
  vi.mocked(createVenueBlock).mockReset();
  vi.mocked(updateVenueBlock).mockReset();
  vi.mocked(removeVenueBlock).mockReset();
  vi.mocked(listVenueBlocks).mockResolvedValue(BLOCKS);
  confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);
});

afterEach(() => {
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

// ---- helpers ---------------------------------------------------------------

async function renderPanel(venue = VENUE) {
  const user = userEvent.setup();
  const utils = render(<VenueBlocksPanel venue={venue} />);
  await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
  return { user, ...utils };
}

/** The <li> for a block, found by its formatted range. */
function rowFor(block) {
  return screen.getByText(formatRange(block.startsAt, block.endsAt)).closest("li");
}

function startInput() {
  return screen.getByLabelText("Start");
}
function endInput() {
  return screen.getByLabelText("End");
}
function reasonSelect() {
  return screen.getByLabelText("Reason");
}
function notesInput() {
  return screen.getByRole("textbox");
}

function setDate(input, iso) {
  fireEvent.change(input, { target: { value: toDatetimeLocalValue(iso) } });
}

/** The error list under a control, via its aria-describedby. */
function errorsFor(control) {
  const id = control.getAttribute("aria-describedby");
  if (!id) return [];
  const list = document.getElementById(id);
  return within(list).getAllByRole("listitem").map((li) => li.textContent);
}

const NEW_START = fromNow(20 * DAY);
const NEW_END = fromNow(21 * DAY);

async function openCreateAndFill(user, { start = NEW_START, end = NEW_END, reason = "renovation", notes } = {}) {
  await user.click(screen.getByRole("button", { name: "+ Add a block" }));
  setDate(startInput(), start);
  setDate(endInput(), end);
  await user.selectOptions(reasonSelect(), reason);
  if (notes) await user.type(notesInput(), notes);
}

async function submitCreate(user) {
  await user.click(screen.getByRole("button", { name: "Block venue" }));
}

/** Create a block that answers with a booking conflict; returns the first payload. */
async function reachConflict(user, conflicts = [BOOKING_A, BOOKING_B]) {
  vi.mocked(createVenueBlock).mockRejectedValueOnce(bookingConflict(conflicts));
  await openCreateAndFill(user);
  await submitCreate(user);
  await screen.findByText(new RegExp(`This period overlaps ${conflicts.length} approved booking`));
  return vi.mocked(createVenueBlock).mock.calls.at(-1)[1];
}

async function confirmOverride(user, count) {
  const noun = count === 1 ? "booking" : "bookings";
  await user.click(screen.getByRole("button", { name: `Override and flag ${count} ${noun}` }));
  await user.click(screen.getByRole("button", { name: "Yes, override" }));
}

function noticeEl() {
  return document.querySelector(".venue-blocks__notice");
}

function panelAlert() {
  // The panel-level alert is the direct child of .venue-blocks.
  return document.querySelector(".venue-blocks > p.venue-blocks__error[role='alert']");
}

function expectNoUuidInText() {
  expect(document.body.textContent).not.toMatch(UUID_PATTERN);
  expect(document.body.textContent).not.toContain("overlaps block");
}

// ---- list ------------------------------------------------------------------

describe("VenueBlocksPanel list", () => {
  it("SCRUM17_AC1_renders_each_block_with_reason_range_notes_and_phase", async () => {
    await renderPanel();

    expect(listVenueBlocks).toHaveBeenCalledWith(VENUE.id);
    expect(
      screen.getByRole("heading", { level: 2, name: "Blocks for Hall A — Level 2" }),
    ).toBeInTheDocument();

    const upcoming = rowFor(UPCOMING);
    expect(within(upcoming).getByText("Maintenance")).toBeInTheDocument();
    expect(within(upcoming).getByText("Aircon servicing")).toBeInTheDocument();
    expect(within(upcoming).getByText("Upcoming")).toHaveClass("status--block-upcoming");

    const inEffect = rowFor(IN_EFFECT);
    expect(within(inEffect).getByText("Internal activity")).toBeInTheDocument();
    expect(within(inEffect).getByText("In effect")).toHaveClass("status--block-in_effect");
    expect(inEffect.querySelector(".venue-blocks__notes")).toBeNull();

    const ended = rowFor(ENDED);
    expect(within(ended).getByText("Safety")).toBeInTheDocument();
    expect(within(ended).getByText("Ended")).toHaveClass("status--block-ended");
    expect(ended).toHaveClass("venue-blocks__item--ended");

    // Server order is kept.
    const rows = document.querySelectorAll(".venue-blocks__list > li");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(inEffect);
    expect(rows[1]).toBe(upcoming);
    expect(rows[2]).toBe(ended);
  });

  it("SCRUM17_AC4_ended_rows_have_no_actions_and_say_they_are_a_record", async () => {
    await renderPanel();

    const ended = rowFor(ENDED);
    expect(within(ended).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(ended).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(ended).getByRole("button", { name: "History" })).toBeEnabled();
    expect(within(ended).getByText(MSG.endedNote)).toBeInTheDocument();

    for (const block of [UPCOMING, IN_EFFECT]) {
      const row = rowFor(block);
      expect(within(row).getByRole("button", { name: "Edit" })).toBeEnabled();
      expect(within(row).getByRole("button", { name: "Remove" })).toBeEnabled();
      expect(within(row).queryByText(MSG.endedNote)).not.toBeInTheDocument();
    }
  });

  it("shows the raw code for a reason this build does not know", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([{ ...UPCOMING, reason: "flood" }]);
    await renderPanel();
    expect(within(rowFor(UPCOMING)).getByText("flood")).toBeInTheDocument();
  });

  it("says when the venue has no blocks", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([]);
    await renderPanel();
    expect(screen.getByText("This venue has no blocks.")).toBeInTheDocument();
    expect(document.querySelector(".venue-blocks__list")).toBeNull();
  });

  it("shows Loading... while the first fetch is in flight, and not the empty state", async () => {
    const pending = deferred();
    vi.mocked(listVenueBlocks).mockReturnValue(pending.promise);
    render(<VenueBlocksPanel venue={VENUE} />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("This venue has no blocks.")).not.toBeInTheDocument();

    await act(async () => pending.resolve(BLOCKS));
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(rowFor(UPCOMING)).toBeInTheDocument();
  });

  it("does not show Loading... above an existing list during a refetch", async () => {
    const { user } = await renderPanel();
    const refetch = deferred();
    vi.mocked(listVenueBlocks).mockReturnValueOnce(refetch.promise);
    vi.mocked(createVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });

    await openCreateAndFill(user);
    await submitCreate(user);

    await waitFor(() => expect(listVenueBlocks).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(rowFor(UPCOMING)).toBeInTheDocument();

    await act(async () => refetch.resolve(BLOCKS));
  });

  for (const [status, message] of [
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Venue Staff can manage venue blocks."],
    [500, "Could not load this venue's blocks. Please try again."],
  ]) {
    it(`SCRUM17_shows_the_list_error_for_a_${status}`, async () => {
      vi.mocked(listVenueBlocks).mockRejectedValue(httpError(status));
      await renderPanel();

      const section = document.querySelector(".venue-blocks__current");
      expect(within(section).getByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByText("This venue has no blocks.")).not.toBeInTheDocument();
      expectNoUuidInText();
    });
  }
});

// ---- create (AC1) ----------------------------------------------------------

describe("VenueBlocksPanel create (AC1)", () => {
  it("SCRUM17_AC1_creates_a_block_with_offset_timestamps_and_no_override_keys", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });

    await openCreateAndFill(user, { notes: "Repainting" });
    expect(screen.getByRole("heading", { level: 2, name: "Block this venue" })).toBeInTheDocument();
    await submitCreate(user);

    expect(createVenueBlock).toHaveBeenCalledTimes(1);
    const [venueId, payload] = vi.mocked(createVenueBlock).mock.calls[0];
    expect(venueId).toBe(VENUE.id);
    expect(Object.keys(payload).sort()).toEqual(["endsAt", "notes", "reason", "startsAt"]);
    expect(payload).not.toHaveProperty("confirmOverride");
    expect(payload).not.toHaveProperty("acknowledgedBookingIds");
    expect(payload.startsAt).toMatch(OFFSET_SUFFIX);
    expect(payload.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(payload.startsAt).getTime()).toBe(new Date(NEW_START).getTime());
    expect(new Date(payload.endsAt).getTime()).toBe(new Date(NEW_END).getTime());
    expect(payload.reason).toBe("renovation");
    expect(payload.notes).toBe("Repainting");

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
    expect(noticeEl()).toHaveAttribute("role", "status");
    // A plain save that flagged nothing says nothing about flagging.
    expect(noticeEl()).not.toHaveTextContent(MSG.noneFlagged);
    expect(noticeEl()).not.toHaveTextContent(/flagged/);

    // The form closed and the list was refetched.
    expect(screen.queryByRole("heading", { name: "Block this venue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add a block" })).toBeEnabled();
    expect(listVenueBlocks).toHaveBeenCalledTimes(2);
  });

  it("Cancel closes the form without a request", async () => {
    const { user } = await renderPanel();
    await openCreateAndFill(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("heading", { name: "Block this venue" })).not.toBeInTheDocument();
    expect(createVenueBlock).not.toHaveBeenCalled();
  });

  it("SCRUM17_AC1_a_400_shows_its_details_under_the_matching_fields", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValue(
      httpError(400, {
        details: [
          { field: "endsAt", message: "must be later than the start" },
          { field: "notes", message: "is required when the reason is other" },
        ],
      }),
    );

    await openCreateAndFill(user);
    await submitCreate(user);

    await waitFor(() => expect(errorsFor(endInput())).toEqual(["must be later than the start"]));
    expect(errorsFor(notesInput())).toEqual(["is required when the reason is other"]);
    expect(endInput()).toHaveAttribute("aria-invalid", "true");
    // The form stays open with no refetch.
    expect(screen.getByRole("heading", { name: "Block this venue" })).toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
    expectNoUuidInText();
  });

  it("SCRUM17_AC1_an_unknown_409_on_create_shows_in_the_form_alert_and_refetches", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValue(httpError(409, { code: "SOMETHING_NEW" }));

    await openCreateAndFill(user);
    await submitCreate(user);

    const form = document.querySelector("form.venue-block-form");
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent(MSG.unknown409));
    expect(screen.getByRole("heading", { name: "Block this venue" })).toBeInTheDocument();
    await waitFor(() => expect(listVenueBlocks).toHaveBeenCalledTimes(2));
    // The user's values are kept.
    expect(reasonSelect()).toHaveValue("renovation");
    expectNoUuidInText();
  });

  it("a 500 on create shows the default message in the form and does not refetch", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValue(httpError(500));

    await openCreateAndFill(user);
    await submitCreate(user);

    const form = document.querySelector("form.venue-block-form");
    await waitFor(() =>
      expect(within(form).getByRole("alert")).toHaveTextContent(
        "Could not save the block. Please try again.",
      ),
    );
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
    expectNoUuidInText();
  });

  it("SCRUM17_AC1_disables_the_form_while_the_create_is_in_flight", async () => {
    const { user } = await renderPanel();
    const pending = deferred();
    vi.mocked(createVenueBlock).mockReturnValue(pending.promise);

    await openCreateAndFill(user);
    await submitCreate(user);

    const saving = screen.getByRole("button", { name: "Saving..." });
    expect(saving).toBeDisabled();
    expect(startInput()).toBeDisabled();
    expect(endInput()).toBeDisabled();
    expect(reasonSelect()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // A second submit while in flight sends nothing.
    fireEvent.submit(document.querySelector("form.venue-block-form"));
    expect(createVenueBlock).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve({ block: UPCOMING, flaggedBookings: [] }));
    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
  });
});

// ---- conflicts and override (AC3) ------------------------------------------

describe("VenueBlocksPanel conflicts and override (AC3)", () => {
  it("SCRUM17_AC3_lists_the_conflicting_bookings_and_does_not_save_silently", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    expect(screen.getByText("Tech Talk")).toBeInTheDocument();
    expect(screen.getByText("Career Fair")).toBeInTheDocument();
    expect(
      screen.getByText(formatRange(BOOKING_A.startsAt, BOOKING_A.endsAt)),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a different period" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Override and flag 2 bookings" })).toBeEnabled();
    expect(noticeEl()).toBeNull();
    expect(createVenueBlock).toHaveBeenCalledTimes(1);
    // The form stays open with the values the conflicts were computed for.
    expect(reasonSelect()).toHaveValue("renovation");
    expectNoUuidInText();
  });

  it("SCRUM17_AC3_override_resends_the_first_payload_with_confirmOverride_and_the_acknowledged_ids", async () => {
    const { user } = await renderPanel();
    const first = await reachConflict(user);
    vi.mocked(createVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [BOOKING_A, BOOKING_B],
    });

    // Two steps: the first click only asks.
    await user.click(screen.getByRole("button", { name: "Override and flag 2 bookings" }));
    expect(createVenueBlock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Flag these bookings for review and notify Event Coordinators?"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, override" }));

    expect(createVenueBlock).toHaveBeenCalledTimes(2);
    const [venueId, second] = vi.mocked(createVenueBlock).mock.calls[1];
    expect(venueId).toBe(VENUE.id);
    expect(second).toEqual({
      ...first,
      confirmOverride: true,
      acknowledgedBookingIds: [BOOKING_A.bookingId, BOOKING_B.bookingId],
    });
    expect(first).not.toHaveProperty("confirmOverride");

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
  });

  it("SCRUM17_AC3_the_flagged_notice_names_each_booking_and_says_coordinators_were_notified", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);
    vi.mocked(createVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [BOOKING_A, BOOKING_B],
    });
    await confirmOverride(user, 2);

    await waitFor(() => expect(noticeEl()).not.toBeNull());
    const notice = noticeEl();
    expect(notice).toHaveTextContent(MSG.saved);
    expect(notice).toHaveTextContent(
      "2 bookings were flagged for review and Event Coordinators were notified:",
    );
    expect(notice).not.toHaveTextContent(MSG.noneFlagged);

    const items = within(notice).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Tech Talk")).toBeInTheDocument();
    expect(
      within(items[0]).getByText(formatRange(BOOKING_A.startsAt, BOOKING_A.endsAt)),
    ).toBeInTheDocument();
    expect(within(items[1]).getByText("Career Fair")).toBeInTheDocument();
    expect(
      within(items[1]).getByText(formatRange(BOOKING_B.startsAt, BOOKING_B.endsAt)),
    ).toBeInTheDocument();

    // The full event request id is only in the title, never in the text.
    const code = items[0].querySelector("code");
    expect(code).toHaveAttribute("title", BOOKING_A.eventRequestId);
    expect(code.textContent).toBe(BOOKING_A.eventRequestId.slice(0, 8));
    expectNoUuidInText();

    // The form closed, the conflict list went with it, and the list refetched.
    expect(screen.queryByRole("heading", { name: "Block this venue" })).not.toBeInTheDocument();
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(2);
  });

  it("SCRUM17_AC3_says_1_booking_was_flagged_in_the_singular", async () => {
    const { user } = await renderPanel();
    await reachConflict(user, [BOOKING_A]);
    vi.mocked(createVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [BOOKING_A],
    });
    await confirmOverride(user, 1);

    await waitFor(() =>
      expect(noticeEl()).toHaveTextContent(
        "1 booking was flagged for review and Event Coordinators were notified:",
      ),
    );
  });

  it("SCRUM17_AC3_an_override_that_flags_nothing_says_No_bookings_were_flagged", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);
    vi.mocked(createVenueBlock).mockResolvedValueOnce({ block: UPCOMING, flaggedBookings: [] });
    await confirmOverride(user, 2);

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
    expect(noticeEl()).toHaveTextContent(MSG.noneFlagged);
    expect(within(noticeEl()).queryByRole("list")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_a_re_409_with_a_different_set_shows_the_new_list_and_the_changed_alert", async () => {
    const { user } = await renderPanel();
    const first = await reachConflict(user);
    vi.mocked(createVenueBlock).mockRejectedValueOnce(bookingConflict([BOOKING_C]));
    await confirmOverride(user, 2);

    await screen.findByText("This period overlaps 1 approved booking");
    expect(screen.getByText("Hackathon")).toBeInTheDocument();
    expect(screen.queryByText("Tech Talk")).not.toBeInTheDocument();
    expect(screen.getByText(MSG.changedSince)).toBeInTheDocument();
    expect(screen.getByText(MSG.changedSince)).toHaveAttribute("role", "alert");
    // The confirm closed itself: nobody confirms bookings they have not seen.
    expect(screen.queryByRole("button", { name: "Yes, override" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Override and flag 1 booking" })).toBeEnabled();
    expect(noticeEl()).toBeNull();

    // A second override carries the ORIGINAL payload and only the new ids.
    vi.mocked(createVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [BOOKING_C],
    });
    await confirmOverride(user, 1);
    expect(createVenueBlock).toHaveBeenCalledTimes(3);
    expect(vi.mocked(createVenueBlock).mock.calls[2][1]).toEqual({
      ...first,
      confirmOverride: true,
      acknowledgedBookingIds: [BOOKING_C.bookingId],
    });
    await waitFor(() =>
      expect(noticeEl()).toHaveTextContent(
        "1 booking was flagged for review and Event Coordinators were notified:",
      ),
    );
    expect(screen.queryByText(MSG.changedSince)).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_Choose_a_different_period_clears_the_list_and_the_next_submit_is_plain", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    await user.click(screen.getByRole("button", { name: "Choose a different period" }));
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Override and flag/ })).not.toBeInTheDocument();
    // The form stays open.
    expect(screen.getByRole("heading", { name: "Block this venue" })).toBeInTheDocument();

    vi.mocked(createVenueBlock).mockResolvedValueOnce({ block: UPCOMING, flaggedBookings: [] });
    setDate(endInput(), fromNow(22 * DAY));
    await submitCreate(user);
    const payload = vi.mocked(createVenueBlock).mock.calls[1][1];
    expect(payload).not.toHaveProperty("confirmOverride");
    expect(payload).not.toHaveProperty("acknowledgedBookingIds");
  });

  it("SCRUM17_AC3_changing_a_date_clears_the_list_and_the_next_submit_has_no_override_keys", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    const newEnd = fromNow(25 * DAY);
    setDate(endInput(), newEnd);
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();

    vi.mocked(createVenueBlock).mockResolvedValueOnce({ block: UPCOMING, flaggedBookings: [] });
    await submitCreate(user);

    expect(createVenueBlock).toHaveBeenCalledTimes(2);
    const payload = vi.mocked(createVenueBlock).mock.calls[1][1];
    expect(Object.keys(payload).sort()).toEqual(["endsAt", "reason", "startsAt"]);
    expect(new Date(payload.endsAt).getTime()).toBe(new Date(newEnd).getTime());
  });

  it("SCRUM17_AC3_changing_the_start_also_clears_the_list", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);
    setDate(startInput(), fromNow(19 * DAY));
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_changing_the_reason_clears_the_list", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    await user.selectOptions(reasonSelect(), "safety");
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();

    vi.mocked(createVenueBlock).mockResolvedValueOnce({ block: UPCOMING, flaggedBookings: [] });
    await submitCreate(user);
    const payload = vi.mocked(createVenueBlock).mock.calls[1][1];
    expect(payload.reason).toBe("safety");
    expect(payload).not.toHaveProperty("confirmOverride");
  });

  it("SCRUM17_AC3_changing_the_notes_clears_the_list", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    await user.type(notesInput(), "x");
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_disables_both_ways_out_while_the_override_is_in_flight", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);
    const pending = deferred();
    vi.mocked(createVenueBlock).mockReturnValueOnce(pending.promise);
    await confirmOverride(user, 2);

    expect(screen.getByRole("button", { name: "Flagging..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose a different period" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();

    // A second click while in flight sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Flagging..." }));
    expect(createVenueBlock).toHaveBeenCalledTimes(2);

    await act(async () => pending.resolve({ block: UPCOMING, flaggedBookings: [BOOKING_A] }));
    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
  });

  it("SCRUM17_AC3_cancelling_the_form_drops_the_conflicts_so_a_new_form_starts_clean", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Add a block" }));
    expect(screen.queryByText(/This period overlaps/)).not.toBeInTheDocument();
    expect(startInput()).toHaveValue("");
  });
});

// ---- block-on-block and retired --------------------------------------------

describe("VenueBlocksPanel other 409s", () => {
  it("SCRUM17_AC1_BLOCK_OVERLAPS_BLOCK_shows_a_form_alert_and_marks_the_clashing_row", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValue(
      httpError(409, { code: "BLOCK_OVERLAPS_BLOCK", conflicts: [{ blockId: UPCOMING.id }] }),
    );

    await openCreateAndFill(user);
    await submitCreate(user);

    const form = document.querySelector("form.venue-block-form");
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent(MSG.overlapsBlock));

    const clash = rowFor(UPCOMING);
    expect(clash).toHaveClass("venue-blocks__item--clash");
    expect(within(clash).getByText("Overlaps the period you chose")).toBeInTheDocument();
    expect(rowFor(IN_EFFECT)).not.toHaveClass("venue-blocks__item--clash");
    expect(within(rowFor(IN_EFFECT)).queryByText("Overlaps the period you chose")).not.toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
    expectNoUuidInText();

    // Choosing new dates and resubmitting clears the mark.
    vi.mocked(createVenueBlock).mockReset();
    vi.mocked(createVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });
    setDate(endInput(), fromNow(22 * DAY));
    await submitCreate(user);
    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
    expect(rowFor(UPCOMING)).not.toHaveClass("venue-blocks__item--clash");
  });

  it("SCRUM17_AC3_BLOCK_OVERLAPS_BLOCK_after_an_override_also_clears_the_booking_conflict_list", async () => {
    const { user } = await renderPanel();
    await reachConflict(user);
    vi.mocked(createVenueBlock).mockRejectedValueOnce(
      httpError(409, { code: "BLOCK_OVERLAPS_BLOCK", conflicts: [{ blockId: IN_EFFECT.id }] }),
    );
    await confirmOverride(user, 2);

    const form = document.querySelector("form.venue-block-form");
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent(MSG.overlapsBlock));
    expect(screen.queryByText(/This period overlaps \d approved/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Override and flag/ })).not.toBeInTheDocument();
    expect(rowFor(IN_EFFECT)).toHaveClass("venue-blocks__item--clash");
  });

  it("SCRUM17_AC1_VENUE_RETIRED_shows_a_panel_alert_closes_the_form_and_disables_adding", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValue(httpError(409, { code: "VENUE_RETIRED" }));

    await openCreateAndFill(user);
    await submitCreate(user);

    await waitFor(() => expect(panelAlert()).toHaveTextContent(MSG.retired));
    expect(screen.queryByRole("heading", { name: "Block this venue" })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "+ Add a block" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", MSG.retiredTitle);

    // Edit is disabled too; Remove stays available.
    const row = rowFor(UPCOMING);
    expect(within(row).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Edit" })).toHaveAttribute("title", MSG.retiredTitle);
    expect(within(row).getByRole("button", { name: "Remove" })).toBeEnabled();
    expectNoUuidInText();
  });

  it("SCRUM17_AC1_a_venue_that_arrives_retired_starts_with_adding_and_editing_disabled", async () => {
    await renderPanel({ ...VENUE, retiredAt: fromNow(-DAY) });

    expect(screen.getByRole("button", { name: "+ Add a block" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Add a block" })).toHaveAttribute(
      "title",
      MSG.retiredTitle,
    );
    const row = rowFor(UPCOMING);
    expect(within(row).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("an active venue's add button has no title", async () => {
    await renderPanel();
    expect(screen.getByRole("button", { name: "+ Add a block" })).not.toHaveAttribute("title");
  });
});

// ---- edit (AC4) ------------------------------------------------------------

describe("VenueBlocksPanel edit (AC4)", () => {
  async function openEdit(user, block = UPCOMING) {
    await user.click(within(rowFor(block)).getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { level: 2, name: "Change this block" });
  }

  it("SCRUM17_AC4_Edit_prefills_the_form_from_the_block", async () => {
    const { user } = await renderPanel();
    await openEdit(user);

    expect(startInput()).toHaveValue(toDatetimeLocalValue(UPCOMING.startsAt));
    expect(endInput()).toHaveValue(toDatetimeLocalValue(UPCOMING.endsAt));
    expect(reasonSelect()).toHaveValue("maintenance");
    expect(notesInput()).toHaveValue("Aircon servicing");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("SCRUM17_AC4_extending_the_end_sends_only_endsAt_to_updateVenueBlock", async () => {
    const { user } = await renderPanel();
    vi.mocked(updateVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });
    await openEdit(user);

    const newEnd = fromNow(8 * DAY);
    setDate(endInput(), newEnd);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenueBlock).toHaveBeenCalledTimes(1);
    const [venueId, blockId, changes] = vi.mocked(updateVenueBlock).mock.calls[0];
    expect(venueId).toBe(VENUE.id);
    expect(blockId).toBe(UPCOMING.id);
    expect(Object.keys(changes)).toEqual(["endsAt"]);
    expect(changes.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(changes.endsAt).getTime()).toBe(new Date(newEnd).getTime());
    expect(createVenueBlock).not.toHaveBeenCalled();

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
    expect(screen.queryByRole("heading", { name: "Change this block" })).not.toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(2);
  });

  it("SCRUM17_AC4_shortening_an_in_effect_block_sends_only_endsAt", async () => {
    const { user } = await renderPanel();
    vi.mocked(updateVenueBlock).mockResolvedValue({ block: IN_EFFECT, flaggedBookings: [] });
    await openEdit(user, IN_EFFECT);

    const newEnd = fromNow(DAY);
    setDate(endInput(), newEnd);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const [, blockId, changes] = vi.mocked(updateVenueBlock).mock.calls[0];
    expect(blockId).toBe(IN_EFFECT.id);
    expect(Object.keys(changes)).toEqual(["endsAt"]);
    expect(new Date(changes.endsAt).getTime()).toBe(new Date(newEnd).getTime());
  });

  it("SCRUM17_AC4_clearing_the_notes_sends_notes_null", async () => {
    const { user } = await renderPanel();
    vi.mocked(updateVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });
    await openEdit(user);

    await user.clear(notesInput());
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(updateVenueBlock).toHaveBeenCalledWith(VENUE.id, UPCOMING.id, { notes: null });
  });

  it("SCRUM17_AC3_an_edit_conflict_overrides_with_the_changes_plus_the_override_fields", async () => {
    const { user } = await renderPanel();
    await openEdit(user);
    vi.mocked(updateVenueBlock).mockRejectedValueOnce(bookingConflict([BOOKING_A]));

    const newEnd = fromNow(21 * DAY);
    setDate(endInput(), newEnd);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("This period overlaps 1 approved booking");

    const first = vi.mocked(updateVenueBlock).mock.calls[0][2];
    expect(Object.keys(first)).toEqual(["endsAt"]);

    vi.mocked(updateVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [BOOKING_A],
    });
    await confirmOverride(user, 1);

    expect(updateVenueBlock).toHaveBeenCalledTimes(2);
    const [venueId, blockId, second] = vi.mocked(updateVenueBlock).mock.calls[1];
    expect(venueId).toBe(VENUE.id);
    expect(blockId).toBe(UPCOMING.id);
    expect(second).toEqual({
      endsAt: first.endsAt,
      confirmOverride: true,
      acknowledgedBookingIds: [BOOKING_A.bookingId],
    });
    expect(createVenueBlock).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(noticeEl()).toHaveTextContent(
        "1 booking was flagged for review and Event Coordinators were notified:",
      ),
    );
  });

  for (const [label, err, message] of [
    ["BLOCK_ENDED", () => httpError(409, { code: "BLOCK_ENDED" }), MSG.ended],
    ["BLOCK_REMOVED", () => httpError(409, { code: "BLOCK_REMOVED" }), MSG.removedAlready],
    ["404", () => httpError(404), MSG.blockGone],
    ["an unknown 409", () => httpError(409, { code: "NEW_CODE" }), MSG.unknown409],
  ]) {
    it(`SCRUM17_AC4_${label.replace(/\s+/g, "_")}_on_edit_shows_the_message_closes_the_form_and_refetches`, async () => {
      const { user } = await renderPanel();
      await openEdit(user);
      vi.mocked(updateVenueBlock).mockRejectedValue(err());
      vi.mocked(listVenueBlocks).mockResolvedValue([IN_EFFECT, ENDED]);

      setDate(endInput(), fromNow(8 * DAY));
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(panelAlert()).toHaveTextContent(message));
      expect(screen.queryByRole("heading", { name: "Change this block" })).not.toBeInTheDocument();
      expect(listVenueBlocks).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(
          screen.queryByText(formatRange(UPCOMING.startsAt, UPCOMING.endsAt)),
        ).not.toBeInTheDocument(),
      );
      expectNoUuidInText();
    });
  }

  it("SCRUM17_AC4_row_actions_are_disabled_while_a_form_is_open", async () => {
    const { user } = await renderPanel();
    await openEdit(user);

    for (const block of [UPCOMING, IN_EFFECT]) {
      const row = rowFor(block);
      expect(within(row).getByRole("button", { name: "Edit" })).toBeDisabled();
      expect(within(row).getByRole("button", { name: "Remove" })).toBeDisabled();
    }
    expect(screen.queryByRole("button", { name: "+ Add a block" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(within(rowFor(UPCOMING)).getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("row actions are disabled while the create form is open", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "+ Add a block" }));

    const row = rowFor(IN_EFFECT);
    expect(within(row).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Remove" })).toBeDisabled();
  });
});

// ---- remove (AC4) ----------------------------------------------------------

describe("VenueBlocksPanel remove (AC4)", () => {
  async function askToRemove(user, block = UPCOMING) {
    await user.click(within(rowFor(block)).getByRole("button", { name: "Remove" }));
  }

  it("SCRUM17_AC4_Remove_asks_first_and_says_flagged_bookings_stay_flagged", async () => {
    const { user } = await renderPanel();
    await askToRemove(user);

    const row = rowFor(UPCOMING);
    expect(within(row).getByText(MSG.confirmRemove)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Yes, remove" })).toBeEnabled();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(row).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(removeVenueBlock).not.toHaveBeenCalled();
    // Only this row asks.
    expect(within(rowFor(IN_EFFECT)).queryByText(MSG.confirmRemove)).not.toBeInTheDocument();
  });

  it("SCRUM17_AC4_Cancel_backs_out_without_a_request", async () => {
    const { user } = await renderPanel();
    await askToRemove(user);
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText(MSG.confirmRemove)).not.toBeInTheDocument();
    expect(within(rowFor(UPCOMING)).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(removeVenueBlock).not.toHaveBeenCalled();
  });

  it("SCRUM17_AC4_Yes_remove_calls_removeVenueBlock_shows_Removing_then_refetches", async () => {
    const { user } = await renderPanel();
    const pending = deferred();
    vi.mocked(removeVenueBlock).mockReturnValue(pending.promise);

    await askToRemove(user);
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Yes, remove" }));

    expect(removeVenueBlock).toHaveBeenCalledTimes(1);
    expect(removeVenueBlock).toHaveBeenCalledWith(VENUE.id, UPCOMING.id);

    const row = rowFor(UPCOMING);
    expect(within(row).getByRole("button", { name: "Removing..." })).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Other rows' actions are disabled while a removal is in flight.
    expect(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Remove" })).toBeDisabled();

    // A second click while in flight sends nothing.
    fireEvent.click(within(row).getByRole("button", { name: "Removing..." }));
    expect(removeVenueBlock).toHaveBeenCalledTimes(1);

    vi.mocked(listVenueBlocks).mockResolvedValue([IN_EFFECT, ENDED]);
    await act(async () => pending.resolve(undefined));

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.removed));
    expect(noticeEl()).not.toHaveTextContent(MSG.noneFlagged);
    expect(listVenueBlocks).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(
        screen.queryByText(formatRange(UPCOMING.startsAt, UPCOMING.endsAt)),
      ).not.toBeInTheDocument(),
    );
    expect(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  for (const [label, err, message] of [
    ["BLOCK_REMOVED", () => httpError(409, { code: "BLOCK_REMOVED" }), MSG.removedAlready],
    ["BLOCK_ENDED", () => httpError(409, { code: "BLOCK_ENDED" }), MSG.ended],
    ["404", () => httpError(404), MSG.blockGone],
    ["an unknown 409", () => httpError(409, { code: "NEW_CODE" }), MSG.unknown409],
  ]) {
    it(`SCRUM17_AC4_a_stale_remove_${label.replace(/\s+/g, "_")}_shows_in_the_panel_alert_and_refetches`, async () => {
      const { user } = await renderPanel();
      vi.mocked(removeVenueBlock).mockRejectedValue(err());

      await askToRemove(user);
      await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Yes, remove" }));

      await waitFor(() => expect(panelAlert()).toHaveTextContent(message));
      expect(within(rowFor(UPCOMING)).queryByRole("alert")).not.toBeInTheDocument();
      expect(listVenueBlocks).toHaveBeenCalledTimes(2);
      expect(noticeEl()).toBeNull();
      expectNoUuidInText();
    });
  }

  it("SCRUM17_AC4_a_500_on_remove_shows_on_the_row_and_does_not_refetch", async () => {
    const { user } = await renderPanel();
    vi.mocked(removeVenueBlock).mockRejectedValue(httpError(500));

    await askToRemove(user);
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Yes, remove" }));

    const row = rowFor(UPCOMING);
    await waitFor(() => expect(within(row).getByRole("alert")).toHaveTextContent(MSG.removeFailed));
    expect(panelAlert()).toBeNull();
    expect(within(rowFor(IN_EFFECT)).queryByRole("alert")).not.toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
    // Back to the plain buttons, ready to retry.
    expect(within(row).getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(within(row).queryByText(MSG.confirmRemove)).not.toBeInTheDocument();
    expectNoUuidInText();
  });

  it("a 403 on remove is not stale, so it shows on the row", async () => {
    const { user } = await renderPanel();
    vi.mocked(removeVenueBlock).mockRejectedValue(httpError(403));

    await askToRemove(user, IN_EFFECT);
    await user.click(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Yes, remove" }));

    await waitFor(() =>
      expect(within(rowFor(IN_EFFECT)).getByRole("alert")).toHaveTextContent(
        "Only Venue Staff can manage venue blocks.",
      ),
    );
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
  });

  it("opening a form clears a row's remove error", async () => {
    const { user } = await renderPanel();
    vi.mocked(removeVenueBlock).mockRejectedValue(httpError(500));
    await askToRemove(user);
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(within(rowFor(UPCOMING)).getByRole("alert")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "+ Add a block" }));
    expect(within(rowFor(UPCOMING)).queryByRole("alert")).not.toBeInTheDocument();
  });
});

// ---- safety ----------------------------------------------------------------

describe("VenueBlocksPanel safety", () => {
  it("SCRUM17_server_prose_with_uuids_never_reaches_the_text_across_every_error_path", async () => {
    const { user } = await renderPanel();

    // Booking conflict, then an override that fails with a 500.
    await reachConflict(user);
    expectNoUuidInText();
    vi.mocked(createVenueBlock).mockRejectedValueOnce(httpError(500));
    await confirmOverride(user, 2);
    const form = document.querySelector("form.venue-block-form");
    await waitFor(() => expect(within(form).getByRole("alert")).toBeInTheDocument());
    expectNoUuidInText();
    expect(document.body.textContent).not.toContain(UUID_PROSE);
  });
});

// ---- audit line and history (SCRUM-131) ------------------------------------

describe("VenueBlocksPanel audit line and history (SCRUM-131, AC4)", () => {
  const ME = "d1000000-0000-4000-8000-000000000001";
  const OTHER = "d2a3b4c5-0000-4000-8000-000000000002";
  const CREATED_AT = fromNow(-20 * DAY);
  const AMENDED_AT = fromNow(-19 * DAY);

  /** A block as the list returns it once the audit fields are read. */
  function audited(block, fields = {}) {
    return {
      ...block,
      createdAt: CREATED_AT,
      createdBy: ME,
      updatedAt: CREATED_AT,
      lastModifiedBy: ME,
      ...fields,
    };
  }

  const HISTORY_ENTRY = {
    id: "c1000000-0000-4000-8000-000000000001",
    blockId: UPCOMING.id,
    action: "amended",
    changedBy: ME,
    changedAt: AMENDED_AT,
    oldValues: { reason: "maintenance" },
    newValues: { reason: "renovation" },
  };

  beforeEach(() => {
    vi.mocked(getVenueBlockHistory).mockReset();
    vi.mocked(getVenueBlockHistory).mockResolvedValue([HISTORY_ENTRY]);
  });

  async function renderWithUser(venue = VENUE, options = { currentUserId: ME }) {
    const { currentUserId } = options;
    const user = userEvent.setup();
    const utils = render(<VenueBlocksPanel venue={venue} currentUserId={currentUserId} />);
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    return { user, ...utils };
  }

  function auditOf(block) {
    return rowFor(block).querySelector(".venue-blocks__audit");
  }

  function historyButton(block) {
    return within(rowFor(block)).getByRole("button", { name: /^(History|Hide history)$/ });
  }

  function openHistories() {
    return document.querySelectorAll(".block-history");
  }

  // ---- audit line ----

  it("SCRUM17_AC4_the_audit_line_says_who_created_the_block_and_when", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([audited(UPCOMING)]);
    await renderWithUser();

    expect(auditOf(UPCOMING)).toHaveTextContent(`Created ${formatTimestamp(CREATED_AT)} by you`, {
      normalizeWhitespace: true,
    });
    expect(auditOf(UPCOMING).textContent).toBe(
      `Created ${new Date(CREATED_AT).toLocaleString()} by you`,
    );
    // Never changed, so no amendment is named.
    expect(auditOf(UPCOMING).textContent).not.toContain("Last amended");
  });

  it("SCRUM17_AC4_Last_amended_appears_only_after_an_amendment_and_names_the_amender", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([
      audited(UPCOMING, { updatedAt: AMENDED_AT, lastModifiedBy: OTHER }),
      audited(IN_EFFECT),
    ]);
    await renderWithUser();

    const audit = auditOf(UPCOMING);
    expect(audit.textContent).toBe(
      `Created ${formatTimestamp(CREATED_AT)} by you · Last amended ${formatTimestamp(AMENDED_AT)} by d2a3b4c5`,
    );
    expect(audit.querySelector("code")).toHaveAttribute("title", OTHER);
    expect(audit.textContent).not.toContain(OTHER);

    expect(auditOf(IN_EFFECT).textContent).not.toContain("Last amended");
  });

  it("SCRUM17_AC4_a_block_created_outside_the_app_says_so", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([
      audited(UPCOMING, { createdBy: null, lastModifiedBy: null }),
    ]);
    await renderWithUser();
    expect(auditOf(UPCOMING).textContent).toBe(
      `Created ${formatTimestamp(CREATED_AT)} outside the app`,
    );
  });

  it("SCRUM17_AC4_rows_without_audit_fields_have_no_audit_line", async () => {
    await renderWithUser();
    expect(document.querySelector(".venue-blocks__audit")).toBeNull();
    // The rows still render, with their History buttons.
    for (const block of BLOCKS) {
      expect(historyButton(block)).toBeEnabled();
    }
  });

  it("SCRUM17_AC4_without_a_currentUserId_the_users_own_change_is_a_short_id_with_a_title", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([audited(UPCOMING)]);
    await renderWithUser(VENUE, {});

    const audit = auditOf(UPCOMING);
    expect(audit.textContent).toBe(`Created ${formatTimestamp(CREATED_AT)} by d1000000`);
    expect(audit.querySelector("code")).toHaveAttribute("title", ME);
    expect(audit.textContent).not.toContain("you");
  });

  it("SCRUM17_AC4_the_audit_line_shows_no_full_uuid", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([
      audited(UPCOMING, { createdBy: OTHER, updatedAt: AMENDED_AT, lastModifiedBy: OTHER }),
    ]);
    await renderWithUser();
    expect(auditOf(UPCOMING).textContent).not.toMatch(UUID_PATTERN);
  });

  // ---- history toggle ----

  it("SCRUM17_AC4_History_fetches_the_trail_under_the_row_and_Hide_history_closes_it", async () => {
    const { user } = await renderWithUser();
    expect(getVenueBlockHistory).not.toHaveBeenCalled();

    const button = historyButton(UPCOMING);
    expect(button).toHaveTextContent("History");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", `block-history-${UPCOMING.id}`);
    expect(openHistories()).toHaveLength(0);

    await user.click(button);

    expect(getVenueBlockHistory).toHaveBeenCalledTimes(1);
    expect(getVenueBlockHistory).toHaveBeenCalledWith(VENUE.id, UPCOMING.id);
    expect(historyButton(UPCOMING)).toHaveTextContent("Hide history");
    expect(historyButton(UPCOMING)).toHaveAttribute("aria-expanded", "true");

    const section = document.getElementById(`block-history-${UPCOMING.id}`);
    expect(section).not.toBeNull();
    expect(rowFor(UPCOMING).contains(section)).toBe(true);
    // The row's last child.
    expect(rowFor(UPCOMING).lastElementChild).toBe(section);
    expect(
      await within(section).findByText("Reason: Maintenance → Renovation"),
    ).toBeInTheDocument();
    // currentUserId reaches the history, so the user's own change is "you".
    expect(within(section).getByText("by you")).toBeInTheDocument();

    await user.click(historyButton(UPCOMING));
    expect(document.getElementById(`block-history-${UPCOMING.id}`)).toBeNull();
    expect(historyButton(UPCOMING)).toHaveTextContent("History");
    expect(historyButton(UPCOMING)).toHaveAttribute("aria-expanded", "false");
  });

  it("SCRUM17_AC4_only_one_history_is_open_at_a_time", async () => {
    const { user } = await renderWithUser();

    await user.click(historyButton(UPCOMING));
    await user.click(historyButton(IN_EFFECT));

    expect(openHistories()).toHaveLength(1);
    expect(document.getElementById(`block-history-${IN_EFFECT.id}`)).not.toBeNull();
    expect(document.getElementById(`block-history-${UPCOMING.id}`)).toBeNull();
    expect(historyButton(UPCOMING)).toHaveAttribute("aria-expanded", "false");
    expect(historyButton(IN_EFFECT)).toHaveAttribute("aria-expanded", "true");
    expect(getVenueBlockHistory).toHaveBeenLastCalledWith(VENUE.id, IN_EFFECT.id);
  });

  it("SCRUM17_AC4_an_ended_row_has_History_and_it_opens", async () => {
    const { user } = await renderWithUser();
    await user.click(historyButton(ENDED));
    expect(getVenueBlockHistory).toHaveBeenCalledWith(VENUE.id, ENDED.id);
    expect(document.getElementById(`block-history-${ENDED.id}`)).not.toBeNull();
  });

  it("SCRUM17_AC4_a_history_error_stays_inside_the_history_and_shows_no_uuid", async () => {
    vi.mocked(getVenueBlockHistory).mockRejectedValue(httpError(403));
    const { user } = await renderWithUser();
    await user.click(historyButton(UPCOMING));

    const section = document.getElementById(`block-history-${UPCOMING.id}`);
    await waitFor(() =>
      expect(within(section).getByRole("alert")).toHaveTextContent(
        "Only Venue Staff can see a block's history.",
      ),
    );
    expect(panelAlert()).toBeNull();
    expectNoUuidInText();
  });

  // ---- never disabled ----

  it("SCRUM17_AC4_History_stays_enabled_while_a_form_is_open", async () => {
    const { user } = await renderWithUser();
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Edit" }));
    await screen.findByRole("heading", { level: 2, name: "Change this block" });

    for (const block of BLOCKS) expect(historyButton(block)).toBeEnabled();

    await user.click(historyButton(IN_EFFECT));
    expect(document.getElementById(`block-history-${IN_EFFECT.id}`)).not.toBeNull();
    // The form is untouched.
    expect(screen.getByRole("heading", { level: 2, name: "Change this block" })).toBeInTheDocument();
  });

  it("SCRUM17_AC4_History_stays_enabled_while_the_create_form_is_open", async () => {
    const { user } = await renderWithUser();
    await user.click(screen.getByRole("button", { name: "+ Add a block" }));
    for (const block of BLOCKS) expect(historyButton(block)).toBeEnabled();
  });

  it("SCRUM17_AC4_History_stays_enabled_during_a_remove_confirm_and_while_it_is_in_flight", async () => {
    const { user } = await renderWithUser();
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Remove" }));
    expect(within(rowFor(UPCOMING)).getByText(MSG.confirmRemove)).toBeInTheDocument();
    expect(historyButton(UPCOMING)).toBeEnabled();

    const pending = deferred();
    vi.mocked(removeVenueBlock).mockReturnValue(pending.promise);
    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Yes, remove" }));
    expect(within(rowFor(UPCOMING)).getByRole("button", { name: "Removing..." })).toBeDisabled();

    for (const block of BLOCKS) expect(historyButton(block)).toBeEnabled();
    await user.click(historyButton(UPCOMING));
    expect(document.getElementById(`block-history-${UPCOMING.id}`)).not.toBeNull();

    vi.mocked(listVenueBlocks).mockResolvedValue([IN_EFFECT, ENDED]);
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.removed));
  });

  it("SCRUM17_AC4_History_stays_enabled_on_a_retired_venue", async () => {
    const { user } = await renderWithUser({ ...VENUE, retiredAt: fromNow(-DAY) });
    expect(within(rowFor(UPCOMING)).getByRole("button", { name: "Edit" })).toBeDisabled();
    for (const block of BLOCKS) {
      expect(historyButton(block)).toBeEnabled();
      expect(historyButton(block)).not.toHaveAttribute("title");
    }
    await user.click(historyButton(UPCOMING));
    expect(getVenueBlockHistory).toHaveBeenCalledWith(VENUE.id, UPCOMING.id);
  });

  // ---- refetch after a save ----

  it("SCRUM17_AC4_an_open_history_refetches_after_a_save_changes_updatedAt", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([audited(UPCOMING), audited(IN_EFFECT)]);
    const { user } = await renderWithUser();

    await user.click(historyButton(UPCOMING));
    await waitFor(() => expect(getVenueBlockHistory).toHaveBeenCalledTimes(1));

    const amendedEntry = {
      ...HISTORY_ENTRY,
      id: "c2000000-0000-4000-8000-000000000002",
      oldValues: { notes: "Aircon servicing" },
      newValues: { notes: null },
    };
    vi.mocked(getVenueBlockHistory).mockResolvedValue([amendedEntry, HISTORY_ENTRY]);
    vi.mocked(updateVenueBlock).mockResolvedValue({ block: UPCOMING, flaggedBookings: [] });
    vi.mocked(listVenueBlocks).mockResolvedValue([
      audited(UPCOMING, { notes: null, updatedAt: fromNow(0), lastModifiedBy: ME }),
      audited(IN_EFFECT),
    ]);

    await user.click(within(rowFor(UPCOMING)).getByRole("button", { name: "Edit" }));
    await user.clear(notesInput());
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.saved));
    await waitFor(() => expect(getVenueBlockHistory).toHaveBeenCalledTimes(2));
    expect(getVenueBlockHistory).toHaveBeenLastCalledWith(VENUE.id, UPCOMING.id);

    const section = document.getElementById(`block-history-${UPCOMING.id}`);
    expect(
      await within(section).findByText("Notes: Aircon servicing → (none)"),
    ).toBeInTheDocument();
    expect(auditOf(UPCOMING).textContent).toContain("Last amended");
  });

  it("SCRUM17_AC4_an_open_history_does_not_refetch_when_its_updatedAt_is_unchanged", async () => {
    vi.mocked(listVenueBlocks).mockResolvedValue([audited(UPCOMING), audited(IN_EFFECT)]);
    const { user } = await renderWithUser();

    await user.click(historyButton(UPCOMING));
    await waitFor(() => expect(getVenueBlockHistory).toHaveBeenCalledTimes(1));

    // Another row is removed; this row comes back unchanged.
    vi.mocked(removeVenueBlock).mockResolvedValue(undefined);
    vi.mocked(listVenueBlocks).mockResolvedValue([audited(UPCOMING)]);
    await user.click(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Remove" }));
    await user.click(within(rowFor(IN_EFFECT)).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(noticeEl()).toHaveTextContent(MSG.removed));
    await waitFor(() => expect(listVenueBlocks).toHaveBeenCalledTimes(2));

    expect(getVenueBlockHistory).toHaveBeenCalledTimes(1);
    expect(document.getElementById(`block-history-${UPCOMING.id}`)).not.toBeNull();
  });
});

// ---- coverage gaps (SCRUM-132) ------------------------------------------------
//
// Defensive paths for answers the backend does not normally send. The three
// double-click guards (`if (submitting) return`, `if (!pendingPayload)
// return`, `if (removingId) return`) are deliberately not here: their
// buttons are disabled, and React never dispatches a click to a disabled
// button, so they cannot be reached from the UI.

describe("VenueBlocksPanel coverage gaps (SCRUM-132)", () => {
  it("SCRUM17_AC1_a_create_that_answers_with_no_body_still_reports_Block_saved_and_flags_nothing", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockResolvedValueOnce(undefined);

    await openCreateAndFill(user);
    await submitCreate(user);

    await waitFor(() => expect(noticeEl()).not.toBeNull());
    expect(within(noticeEl()).getByText(MSG.saved)).toBeInTheDocument();
    expect(noticeEl().textContent).not.toContain("flagged for review");
    expect(noticeEl().querySelector(".venue-blocks__flagged")).toBeNull();
    // Not an override, so the "nothing was flagged" line is not said either.
    expect(within(noticeEl()).queryByText(MSG.noneFlagged)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Block venue" })).not.toBeInTheDocument();
    expect(listVenueBlocks).toHaveBeenCalledTimes(2);
  });

  it("SCRUM17_AC3_a_booking_conflict_409_without_a_conflicts_array_lists_nothing_and_keeps_the_form_open", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValueOnce(
      httpError(409, { code: "BLOCK_BOOKING_CONFLICT", conflicts: "not a list" }),
    );

    await openCreateAndFill(user);
    await submitCreate(user);

    await waitFor(() => expect(createVenueBlock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Block venue" })).toBeEnabled(),
    );
    expect(document.querySelector(".block-conflicts")).toBeNull();
    expect(screen.queryByRole("button", { name: /Override and flag/ })).not.toBeInTheDocument();
    expect(noticeEl()).toBeNull();
    expect(listVenueBlocks).toHaveBeenCalledTimes(1);
    expectNoUuidInText();
  });

  it("SCRUM17_AC1_BLOCK_OVERLAPS_BLOCK_without_a_conflicts_array_shows_the_message_and_marks_no_row", async () => {
    const { user } = await renderPanel();
    vi.mocked(createVenueBlock).mockRejectedValueOnce(
      httpError(409, { code: "BLOCK_OVERLAPS_BLOCK" }),
    );

    await openCreateAndFill(user);
    await submitCreate(user);

    const form = document.querySelector("form.venue-block-form");
    await waitFor(() => expect(within(form).getByRole("alert")).toHaveTextContent(MSG.overlapsBlock));
    expect(document.querySelectorAll(".venue-blocks__item--clash")).toHaveLength(0);
    expect(screen.queryByText("Overlaps the period you chose")).not.toBeInTheDocument();
    expectNoUuidInText();
  });

  it("SCRUM17_AC3_a_flagged_booking_missing_its_id_name_and_event_reads_Unnamed_event_and_no_event", async () => {
    const { user } = await renderPanel();
    await reachConflict(user, [BOOKING_A]);
    const bare = { startsAt: BOOKING_A.startsAt, endsAt: BOOKING_A.endsAt };
    vi.mocked(createVenueBlock).mockResolvedValueOnce({
      block: UPCOMING,
      flaggedBookings: [bare, { ...bare, eventName: "", eventRequestId: null }],
    });

    await confirmOverride(user, 1);

    await waitFor(() => expect(noticeEl()).not.toBeNull());
    const notice = noticeEl();
    expect(within(notice).getByText(MSG.saved)).toBeInTheDocument();
    expect(
      within(notice).getByText(
        "2 bookings were flagged for review and Event Coordinators were notified:",
      ),
    ).toBeInTheDocument();
    const items = within(notice).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(within(item).getByText("Unnamed event")).toBeInTheDocument();
      expect(within(item).getByText(formatRange(bare.startsAt, bare.endsAt))).toBeInTheDocument();
      const code = within(item).getByText("no event");
      expect(code.tagName).toBe("CODE");
      expect(code).not.toHaveAttribute("title");
    }
  });
});
