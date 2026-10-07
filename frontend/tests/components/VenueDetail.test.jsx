// VenueDetail.test.jsx
//
// SCRUM-125 regression. shortId and formatTimestamp moved from VenueDetail.jsx
// into services/displayFormat.js; a booking row must render exactly as it did
// before. The venue service is mocked, so nothing touches the network.
// Timezone-safe: the expected range is computed with toLocaleString from
// fixtures that carry offsets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import VenueDetail from "../../src/components/VenueDetail.jsx";
import { getVenueBookings, getVenueHistory } from "../../src/services/venueService";

vi.mock("../../src/services/venueService", () => ({
  getVenueBookings: vi.fn(),
  getVenueHistory: vi.fn(),
}));

const VENUE = { id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", name: "Hall A", location: "Level 2" };

const BOOKING = {
  id: "b0000000-0000-4000-8000-000000000001",
  eventRequestId: "e1b2c3d4-5678-4000-8000-000000000001",
  startsAt: "2026-10-01T09:00:00+08:00",
  endsAt: "2026-10-01T17:30:00+08:00",
};

beforeEach(() => {
  vi.mocked(getVenueBookings).mockReset();
  vi.mocked(getVenueHistory).mockReset();
  vi.mocked(getVenueHistory).mockResolvedValue([]);
});

describe("SCRUM17 VenueDetail after the display helpers moved", () => {
  it("renders a booking row with its short event id, full-id title and formatted range", async () => {
    vi.mocked(getVenueBookings).mockResolvedValue([BOOKING]);

    render(<VenueDetail venue={VENUE} />);

    const code = await screen.findByText("e1b2c3d4");
    expect(code.tagName).toBe("CODE");
    expect(code).toHaveAttribute("title", BOOKING.eventRequestId);

    const row = code.closest("li");
    const expectedRange =
      `${new Date(BOOKING.startsAt).toLocaleString()} – ` +
      `${new Date(BOOKING.endsAt).toLocaleString()}`;
    expect(within(row).getByText(expectedRange).tagName).toBe("SPAN");

    expect(getVenueBookings).toHaveBeenCalledWith(VENUE.id);
  });

  it("SCRUM257_labels_a_booking_request_with_its_status_so_it_does_not_read_as_a_hold", async () => {
    vi.mocked(getVenueBookings).mockResolvedValue([
      { ...BOOKING, statusDisplay: { status: "pending", label: "Pending", group: "PENDING" } },
      { ...BOOKING, id: "b0000000-0000-4000-8000-000000000002", eventRequestId: "f1b2c3d4-5678-4000-8000-000000000002", statusDisplay: { status: "withdrawn", label: "Withdrawn", group: "WITHDRAWN" } },
    ]);

    render(<VenueDetail venue={VENUE} />);

    const pending = (await screen.findByText("e1b2c3d4")).closest("li");
    expect(within(pending).getByText("Pending")).toBeInTheDocument();
    expect(within(screen.getByText("f1b2c3d4").closest("li")).getByText("Withdrawn")).toBeInTheDocument();
  });

  it("renders unknown and no event for a booking missing its times and event", async () => {
    vi.mocked(getVenueBookings).mockResolvedValue([
      { id: BOOKING.id, eventRequestId: null, startsAt: null, endsAt: null },
    ]);

    render(<VenueDetail venue={VENUE} />);

    const code = await screen.findByText("no event");
    expect(code).not.toHaveAttribute("title");
    expect(within(code.closest("li")).getByText("unknown – unknown")).toBeInTheDocument();
  });

  it("renders a history entry's editor as a short id with the full id in its title", async () => {
    vi.mocked(getVenueBookings).mockResolvedValue([]);
    const editor = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const changedAt = "2026-09-20T08:15:00+08:00";
    vi.mocked(getVenueHistory).mockResolvedValue([
      { id: "h1", changedAt, changedBy: editor, oldValues: {}, newValues: { name: "Hall A" } },
    ]);

    render(<VenueDetail venue={VENUE} />);

    const code = await screen.findByText("9b1deb4d");
    expect(code).toHaveAttribute("title", editor);
    expect(screen.getByText(new Date(changedAt).toLocaleString())).toBeInTheDocument();
  });
});

describe("SCRUM186 turnaround in the change history", () => {
  const EDITOR = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const CHANGED_AT = "2026-09-20T08:15:00+08:00";

  function historyEntry(oldValues, newValues) {
    return { id: "h186", changedAt: CHANGED_AT, changedBy: EDITOR, oldValues, newValues };
  }

  /** The value span next to a field label. */
  function valueFor(label) {
    const labelSpan = screen.getByText(label);
    return labelSpan.closest("li").querySelector(".venue-history__value");
  }

  beforeEach(() => {
    vi.mocked(getVenueBookings).mockResolvedValue([]);
  });

  it("SCRUM186_shows_a_turnaround_change_as_durations", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({ turnaround_minutes: 30 }, { turnaround_minutes: 60 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    expect(await screen.findByText("Turnaround between events")).toBeInTheDocument();
    expect(valueFor("Turnaround between events")).toHaveTextContent("30 minutes → 1 hour");
  });

  it("SCRUM186_shows_null_to_zero_as_not_set_to_none", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({ turnaround_minutes: null }, { turnaround_minutes: 0 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Turnaround between events");
    expect(valueFor("Turnaround between events")).toHaveTextContent("not set → None");
  });

  it("SCRUM186_an_odd_turnaround_value_renders_as_is_alongside_other_fields", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry(
        { turnaround_minutes: "abc", name: "Hall A" },
        { turnaround_minutes: 15, name: "Hall B" },
      ),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Turnaround between events");
    expect(valueFor("Turnaround between events")).toHaveTextContent("abc → 15 minutes");
    expect(valueFor("Name")).toHaveTextContent("Hall A → Hall B");
  });

  it("SCRUM186_a_creation_entry_with_turnaround_shows_only_venue_created", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({}, { name: "Hall A", location: "Level 2", turnaround_minutes: 30 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    expect(await screen.findByText("Venue created")).toBeInTheDocument();
    expect(screen.queryByText("Turnaround between events")).not.toBeInTheDocument();
    expect(screen.queryByText(/30 minutes/)).not.toBeInTheDocument();
  });
});

describe("SCRUM182 the bookings panel names the role gate", () => {
  it("SCRUM178_AC6_a_403_from_getVenueBookings_shows_who_can_see_bookings", async () => {
    vi.mocked(getVenueBookings).mockRejectedValue({ response: { status: 403 } });

    render(<VenueDetail venue={VENUE} />);

    const message = await screen.findByText(
      "Only Venue Staff and Event Coordinators can see a venue's bookings.",
    );
    expect(message).toHaveAttribute("role", "alert");
    expect(message).toHaveClass("venue-detail__error");
    expect(
      screen.queryByText("Could not load this venue's bookings. Please try again."),
    ).not.toBeInTheDocument();
  });
});

describe("SCRUM20_SCRUM137 setup time in the change history", () => {
  const EDITOR = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const CHANGED_AT = "2026-10-05T08:15:00+08:00";

  function historyEntry(oldValues, newValues) {
    return { id: "h137", changedAt: CHANGED_AT, changedBy: EDITOR, oldValues, newValues };
  }

  /** The value span next to a field label. */
  function valueFor(label) {
    const labelSpan = screen.getByText(label);
    return labelSpan.closest("li").querySelector(".venue-history__value");
  }

  beforeEach(() => {
    vi.mocked(getVenueBookings).mockResolvedValue([]);
  });

  it("SCRUM20_SCRUM137_shows_a_setup_change_from_none_as_durations", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({ setup_minutes: 0 }, { setup_minutes: 30 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    expect(await screen.findByText("Setup before events")).toBeInTheDocument();
    expect(valueFor("Setup before events")).toHaveTextContent("None → 30 minutes");
  });

  it("SCRUM20_SCRUM137_shows_hours_and_back_to_none", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({ setup_minutes: 90 }, { setup_minutes: 0 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Setup before events");
    expect(valueFor("Setup before events")).toHaveTextContent("1 hour 30 minutes → None");
  });

  it("SCRUM20_SCRUM137_the_raw_column_name_is_never_shown", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({ setup_minutes: 0 }, { setup_minutes: 60 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Setup before events");
    expect(screen.queryByText("setup_minutes")).not.toBeInTheDocument();
    expect(valueFor("Setup before events")).not.toHaveTextContent("0 → 60");
  });

  it("SCRUM20_SCRUM137_setup_and_turnaround_in_one_entry_get_their_own_rows", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry(
        { setup_minutes: 0, turnaround_minutes: 30 },
        { setup_minutes: 15, turnaround_minutes: 60 },
      ),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Setup before events");
    expect(valueFor("Setup before events")).toHaveTextContent("None → 15 minutes");
    expect(valueFor("Turnaround between events")).toHaveTextContent("30 minutes → 1 hour");
  });

  it("SCRUM20_SCRUM137_a_creation_entry_with_setup_shows_only_venue_created", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry({}, { name: "Hall A", location: "Level 2", setup_minutes: 30 }),
    ]);

    render(<VenueDetail venue={VENUE} />);

    expect(await screen.findByText("Venue created")).toBeInTheDocument();
    expect(screen.queryByText("Setup before events")).not.toBeInTheDocument();
  });
});
