// VenueDetail.test.jsx
//
// SCRUM-125 regression. shortId and formatTimestamp moved from VenueDetail.jsx
// into services/displayFormat.js; a booking row must render exactly as it did
// before. The venue service is mocked, so nothing touches the network.
// Timezone-safe: the expected range is computed with toLocaleString from
// fixtures that carry offsets.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueDetail from "../../src/components/VenueDetail.jsx";
import {
  getVenueBookings,
  getVenueDetails,
  getVenueHistory,
} from "../../src/services/venueService";

// SCRUM-493: VenueDetail also fetches getVenueDetails for its safety section.
// The default (set in beforeEach) is a venue with neither fact recorded, so
// the older tests run against the realistic state, not the section's error.
vi.mock("../../src/services/venueService", () => ({
  getVenueBookings: vi.fn(),
  getVenueDetails: vi.fn(),
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
  vi.mocked(getVenueDetails).mockReset();
  vi.mocked(getVenueDetails).mockResolvedValue({
    ...VENUE,
    emergencyAccess: null,
    knownRestrictions: null,
  });
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

describe("SCRUM493 the Safety information section", () => {
  /** The <dd> holding a fact's value, found from its <dt> label. */
  function valueOf(label) {
    const section = screen.getByRole("heading", { name: "Safety information" }).closest("section");
    const dt = within(section).getByText(label, { selector: "dt" });
    return dt.parentElement.querySelector("dd");
  }

  function detailsWith(fields) {
    return { ...VENUE, ...fields };
  }

  beforeEach(() => {
    vi.mocked(getVenueBookings).mockResolvedValue([]);
  });

  // SCRUM-493 sub-task 3: the facts now render through the shared
  // VenueSafetyFacts component, so the muted class is that component's
  // venue-safety-facts__not-recorded (was venue-detail__not-recorded).
  it("SCRUM493_AC1_shows_both_values_with_line_breaks_kept", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(
      detailsWith({
        emergencyAccess: "Exit A via the east stairwell\nAssembly point: car park B",
        knownRestrictions: "No open flames\nNo rigging from the ceiling",
      }),
    );

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Emergency access", { selector: "dt" });
    expect(getVenueDetails).toHaveBeenCalledWith(VENUE.id);
    expect(valueOf("Emergency access").textContent).toBe(
      "Exit A via the east stairwell\nAssembly point: car park B",
    );
    expect(valueOf("Known restrictions").textContent).toBe(
      "No open flames\nNo rigging from the ceiling",
    );
    expect(valueOf("Emergency access")).not.toHaveClass("venue-safety-facts__not-recorded");
    expect(valueOf("Known restrictions")).not.toHaveClass("venue-safety-facts__not-recorded");
  });

  it.each([
    ["null", { emergencyAccess: null, knownRestrictions: null }],
    ["missing", {}],
    ["blank", { emergencyAccess: "", knownRestrictions: "   \n  " }],
    ["invisible-only", { emergencyAccess: "\u200B\uFEFF", knownRestrictions: " \u3164 " }],
  ])("SCRUM493_AC2_shows_not_recorded_muted_when_%s", async (_case, fields) => {
    vi.mocked(getVenueDetails).mockResolvedValue(detailsWith(fields));

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Emergency access", { selector: "dt" });
    for (const label of ["Emergency access", "Known restrictions"]) {
      expect(valueOf(label)).toHaveTextContent("Not recorded");
      expect(valueOf(label)).toHaveClass("venue-safety-facts__not-recorded");
    }
  });

  // Review fix: the section is labelled by its h3, and VenueSafetyFacts
  // inside it (no venueName) is a plain div, so the page has exactly one
  // region of that name.
  it("SCRUM493_AC3_the_page_has_exactly_one_region_named_safety_information", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(
      detailsWith({ emergencyAccess: "Exit A", knownRestrictions: "No confetti" }),
    );

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Emergency access", { selector: "dt" });
    const regions = screen.getAllByRole("region", { name: "Safety information" });
    expect(regions).toHaveLength(1);
    const heading = screen.getByRole("heading", { name: "Safety information" });
    expect(regions[0]).toHaveAttribute("aria-labelledby", heading.id);
    expect(regions[0]).toContainElement(heading);
    expect(within(regions[0]).queryAllByRole("region")).toHaveLength(0);
  });

  it("SCRUM493_AC2_entered_text_reading_not_recorded_is_not_muted", async () => {
    vi.mocked(getVenueDetails).mockResolvedValue(
      detailsWith({ emergencyAccess: "Not recorded", knownRestrictions: null }),
    );

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Emergency access", { selector: "dt" });
    expect(valueOf("Emergency access")).toHaveTextContent("Not recorded");
    expect(valueOf("Emergency access")).not.toHaveClass("venue-safety-facts__not-recorded");
    expect(valueOf("Known restrictions")).toHaveClass("venue-safety-facts__not-recorded");
  });

  it("SCRUM493_AC1_shows_loading_then_the_values", async () => {
    let finish;
    vi.mocked(getVenueDetails).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );

    render(<VenueDetail venue={VENUE} />);

    const section = screen.getByRole("heading", { name: "Safety information" }).closest("section");
    expect(within(section).getByText("Loading...")).toBeInTheDocument();
    expect(within(section).queryByText("Emergency access")).not.toBeInTheDocument();

    finish(detailsWith({ emergencyAccess: "Exit A", knownRestrictions: null }));

    expect(await within(section).findByText("Exit A")).toBeInTheDocument();
    expect(within(section).queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM493_AC1_an_error_shows_its_message_and_try_again_refetches", async () => {
    const user = userEvent.setup();
    vi.mocked(getVenueDetails)
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce(detailsWith({ emergencyAccess: "Exit A", knownRestrictions: null }));

    render(<VenueDetail venue={VENUE} />);

    const message = await screen.findByText(
      "That venue no longer exists. Go back and refresh the catalogue.",
    );
    expect(message).toHaveAttribute("role", "alert");
    expect(message).toHaveClass("venue-detail__error");

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Exit A")).toBeInTheDocument();
    expect(getVenueDetails).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("That venue no longer exists. Go back and refresh the catalogue."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("SCRUM493_AC1_a_failure_here_does_not_blank_the_bookings", async () => {
    vi.mocked(getVenueDetails).mockRejectedValue({ response: { status: 500 } });
    vi.mocked(getVenueBookings).mockResolvedValue([BOOKING]);

    render(<VenueDetail venue={VENUE} />);

    expect(
      await screen.findByText("The safety information could not be loaded. Please try again."),
    ).toBeInTheDocument();
    expect(await screen.findByText("e1b2c3d4")).toBeInTheDocument();
  });

  it("SCRUM493_AC5_a_retired_venue_still_shows_its_values", async () => {
    const retired = { ...VENUE, retiredAt: "2026-09-30T10:00:00+08:00" };
    vi.mocked(getVenueDetails).mockResolvedValue({
      ...retired,
      emergencyAccess: "Exit A",
      knownRestrictions: "No confetti",
    });

    render(<VenueDetail venue={retired} />);

    await screen.findByText("Emergency access", { selector: "dt" });
    expect(valueOf("Emergency access")).toHaveTextContent("Exit A");
    expect(valueOf("Known restrictions")).toHaveTextContent("No confetti");
  });
});

describe("SCRUM493 safety facts in the change history", () => {
  const EDITOR = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const CHANGED_AT = "2026-10-07T08:15:00+08:00";

  function historyEntry(oldValues, newValues) {
    return { id: "h493", changedAt: CHANGED_AT, changedBy: EDITOR, oldValues, newValues };
  }

  /** The value span next to a history field label. */
  function historyValueFor(label) {
    const labelSpan = screen.getByText(label, { selector: "li > span" });
    return labelSpan.closest("li").querySelector(".venue-history__value");
  }

  beforeEach(() => {
    vi.mocked(getVenueBookings).mockResolvedValue([]);
  });

  it("SCRUM493_AC4_labels_both_fields_and_shows_not_recorded_to_text", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry(
        { emergency_access: null, known_restrictions: null },
        { emergency_access: "Exit A via the east stairwell", known_restrictions: "No confetti" },
      ),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Exit A via the east stairwell", { exact: false });
    expect(screen.queryByText("emergency_access")).not.toBeInTheDocument();
    expect(screen.queryByText("known_restrictions")).not.toBeInTheDocument();
    expect(historyValueFor("Emergency access")).toHaveTextContent(
      "Not recorded → Exit A via the east stairwell",
    );
    expect(historyValueFor("Known restrictions")).toHaveTextContent("Not recorded → No confetti");
    expect(historyValueFor("Emergency access")).not.toHaveTextContent("not set");
  });

  it("SCRUM493_AC4_shows_text_to_not_recorded_when_cleared", async () => {
    vi.mocked(getVenueHistory).mockResolvedValue([
      historyEntry(
        { emergency_access: "Exit A", known_restrictions: "No confetti" },
        { emergency_access: null, known_restrictions: null },
      ),
    ]);

    render(<VenueDetail venue={VENUE} />);

    await screen.findByText("Exit A", { exact: false });
    expect(historyValueFor("Emergency access")).toHaveTextContent("Exit A → Not recorded");
    expect(historyValueFor("Known restrictions")).toHaveTextContent("No confetti → Not recorded");
  });
});
