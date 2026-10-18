import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SignificantEventChangePanel from "../../src/components/SignificantEventChangePanel.jsx";
import {
  applySignificantEventChange,
  previewSignificantEventChange,
} from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  applySignificantEventChange: vi.fn(),
  previewSignificantEventChange: vi.fn(),
}));

const BASE_EVENT = {
  id: "event-1",
  eventName: "Tech Talk",
  status: "confirmed",
  proposedStart: "2040-12-01T10:00:00+08:00",
  proposedEnd: "2040-12-01T12:00:00+08:00",
  expectedAttendance: 80,
  venueRequirements: "Lecture space",
  accessibilityRequirements: "Step-free access",
};

const VENUES = [
  { id: "booking-small", venueName: "Small Hall", capacity: 100 },
  { id: "booking-large", venueName: "Large Hall", capacity: 300 },
];
const RESERVATIONS = [{ id: "reservation-1", equipmentName: "Projector", quantity: 2 }];

// Mirrors the server rules: each booking is judged on its own capacity.
function impactFor(changes, status) {
  const timeChanged = "proposedStart" in changes || "proposedEnd" in changes;
  const requirementsChanged =
    "venueRequirements" in changes || "accessibilityRequirements" in changes;
  const venueBookings = VENUES.filter(
    (venue) =>
      timeChanged ||
      requirementsChanged ||
      (changes.expectedAttendance && changes.expectedAttendance > venue.capacity),
  ).map(({ id, venueName }) => ({ id, venueName }));
  return {
    venueBookings,
    equipmentReservations: timeChanged ? RESERVATIONS : [],
    registeredAttendeesToNotify: timeChanged ? 12 : 0,
    statusBefore: status,
    statusAfter: "approved",
    equipmentChangeRecorded: Boolean(changes.equipmentChange),
  };
}

function Harness({ initial = BASE_EVENT }) {
  const [event, setEvent] = useState(initial);
  return (
    <>
      <p data-testid="status">{event.status}</p>
      <SignificantEventChangePanel eventRequest={event} onApplied={setEvent} />
    </>
  );
}

async function fill(user, { attendance, start, reason = "Organiser asked for it" }) {
  if (attendance !== undefined) {
    fireEvent.change(screen.getByLabelText("Expected attendance"), {
      target: { value: String(attendance) },
    });
  }
  if (start) fireEvent.change(screen.getByLabelText("Event start"), { target: { value: start } });
  await user.type(screen.getByLabelText("Reason for this change"), reason);
}

// Impact tiles are labelled groups; pass wait=false once the preview is already on screen.
const stat = (label, value, wait = true) => {
  const name = `${label}: ${value}`;
  return wait ? screen.findByRole("group", { name }) : screen.getByRole("group", { name });
};

const confirmBox = () =>
  screen.getByLabelText("I have reviewed this impact and confirm applying the significant change.");

describe("SCRUM395 significant change flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewSignificantEventChange).mockImplementation(async (_id, changes) =>
      impactFor(changes, "confirmed"),
    );
    vi.mocked(applySignificantEventChange).mockImplementation(async (_id, { changes }) => ({
      ...BASE_EVENT,
      ...changes,
      status: "approved",
    }));
  });

  it("SCRUM395_AC3_AC4_confirmed_date_change_previews_flags_then_returns_to_approved", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await fill(user, { start: "2040-12-02T10:00" });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await stat("Venue bookings to flag", 2)).toBeInTheDocument();
    expect(screen.getByText(/Small Hall/)).toBeInTheDocument();
    expect(screen.getByText(/Large Hall/)).toBeInTheDocument();
    expect(stat("Equipment reservations to flag", 1, false)).toBeInTheDocument();
    expect(stat("Registered attendees to notify", 12, false)).toBeInTheDocument();
    expect(screen.getByText("This Confirmed event will return to Approved.")).toBeInTheDocument();
    expect(screen.getByText(/remain in place for manual resolution/)).toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("confirmed");

    await user.click(confirmBox());
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    expect(await screen.findByText("approved", { selector: "[data-testid=status]" })).toBeInTheDocument();
    expect(applySignificantEventChange).toHaveBeenCalledTimes(1);
  });

  it("SCRUM395_AC3_attendance_flags_only_the_venue_whose_capacity_is_exceeded", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await fill(user, { attendance: 150 });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await stat("Venue bookings to flag", 1)).toBeInTheDocument();
    expect(screen.getByText(/Small Hall/)).toBeInTheDocument();
    expect(screen.queryByText(/Large Hall/)).not.toBeInTheDocument();
    expect(stat("Equipment reservations to flag", 0, false)).toBeInTheDocument();
    expect(stat("Registered attendees to notify", 0, false)).toBeInTheDocument();
  });

  it("SCRUM395_AC3_attendance_within_every_capacity_flags_nothing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await fill(user, { attendance: 90 });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await stat("Venue bookings to flag", 0)).toBeInTheDocument();
  });

  it.each(["safety_review", "safety_approved"])(
    "SCRUM395_AC1_%s_event_is_told_it_returns_to_approved",
    async (status) => {
      const user = userEvent.setup();
      vi.mocked(previewSignificantEventChange).mockImplementation(async (_id, changes) =>
        impactFor(changes, status),
      );
      render(<Harness initial={{ ...BASE_EVENT, status }} />);
      await fill(user, { attendance: 150 });
      await user.click(screen.getByRole("button", { name: "Preview significant change" }));

      expect(await screen.findByText("This event will return to Approved.")).toBeInTheDocument();
      await user.click(confirmBox());
      await user.click(screen.getByRole("button", { name: "Confirm significant change" }));
      expect(await screen.findByText("approved", { selector: "[data-testid=status]" })).toBeInTheDocument();
    },
  );

  it("SCRUM395_AC4_failed_apply_changes_nothing_and_can_be_retried", async () => {
    const user = userEvent.setup();
    vi.mocked(applySignificantEventChange).mockRejectedValueOnce({
      response: { status: 500, data: { error: "Could not flag the reservation" } },
    });
    render(<Harness />);
    await fill(user, { start: "2040-12-02T10:00" });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await stat("Venue bookings to flag", 2);
    await user.click(confirmBox());
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not flag the reservation No changes have been made.",
    );
    expect(screen.getByTestId("status")).toHaveTextContent("confirmed");
    expect(stat("Venue bookings to flag", 2, false)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));
    expect(await screen.findByText("approved", { selector: "[data-testid=status]" })).toBeInTheDocument();
    expect(applySignificantEventChange).toHaveBeenCalledTimes(2);
  });

  it("SCRUM395_AC3_stale_preview_409_forces_a_fresh_preview_before_applying", async () => {
    const user = userEvent.setup();
    vi.mocked(applySignificantEventChange).mockRejectedValueOnce({
      response: {
        status: 409,
        data: { code: "SIGNIFICANT_CHANGE_IMPACT_CHANGED", error: "The impact changed" },
      },
    });
    render(<Harness />);
    await fill(user, { attendance: 150 });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await stat("Venue bookings to flag", 1);
    await user.click(confirmBox());
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The impact changed");
    expect(screen.queryByRole("button", { name: "Confirm significant change" })).not.toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("confirmed");

    // The coordinator must preview again, and the new impact is what gets applied.
    vi.mocked(previewSignificantEventChange).mockResolvedValueOnce({
      ...impactFor({ expectedAttendance: 150 }, "confirmed"),
      venueBookings: [],
    });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await stat("Venue bookings to flag", 0);
    await user.click(confirmBox());
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    expect(await screen.findByText("approved", { selector: "[data-testid=status]" })).toBeInTheDocument();
    expect(vi.mocked(applySignificantEventChange).mock.calls[1][1].expectedImpact.venueBookings).toEqual([]);
  });

  it("SCRUM395_AC5_equipment_change_is_recorded_with_a_reason_and_points_to_scrum_21", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText(/Record an equipment change/));
    await user.type(screen.getByLabelText("Reason for this change"), "Projector swapped");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await screen.findByText(/make those changes through SCRUM-21/)).toBeInTheDocument();
    expect(previewSignificantEventChange).toHaveBeenCalledWith("event-1", { equipmentChange: true });

    await user.click(confirmBox());
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));
    expect(applySignificantEventChange).toHaveBeenCalledWith("event-1", {
      changes: { equipmentChange: true },
      reason: "Projector swapped",
      expectedImpact: expect.objectContaining({ equipmentChangeRecorded: true }),
    });
    expect(await screen.findByText("approved", { selector: "[data-testid=status]" })).toBeInTheDocument();
  });

  it("SCRUM395_AC3_editing_a_field_after_preview_discards_the_confirmation", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await fill(user, { attendance: 150 });
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    await stat("Venue bookings to flag", 1);
    await user.click(confirmBox());

    fireEvent.change(screen.getByLabelText("Expected attendance"), { target: { value: "160" } });

    expect(screen.queryByRole("button", { name: "Confirm significant change" })).not.toBeInTheDocument();
    expect(applySignificantEventChange).not.toHaveBeenCalled();
  });
});
