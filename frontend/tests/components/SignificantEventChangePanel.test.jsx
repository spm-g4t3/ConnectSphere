import { beforeEach, describe, expect, it, vi } from "vitest";
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

const EVENT = {
  id: "event-1",
  eventName: "Tech Talk",
  status: "confirmed",
  proposedStart: "2040-12-01T10:00:00+08:00",
  proposedEnd: "2040-12-01T12:00:00+08:00",
  expectedAttendance: 80,
  venueRequirements: "Lecture space",
  accessibilityRequirements: "Step-free access",
};

const IMPACT = {
  venueBookings: [{
    id: "booking-1",
    venueName: "Small Hall",
    startsAt: "2040-12-01T10:00:00+08:00",
    endsAt: "2040-12-01T12:00:00+08:00",
    occupiedStartsAt: "2040-12-01T09:45:00+08:00",
    occupiedEndsAt: "2040-12-01T12:30:00+08:00",
  }],
  equipmentReservations: [{
    id: "reservation-1",
    equipmentName: "Projector",
    quantity: 2,
  }],
  registeredAttendeesToNotify: 0,
  statusBefore: "confirmed",
  statusAfter: "approved",
  equipmentChangeRecorded: false,
};

describe("SignificantEventChangePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewSignificantEventChange).mockResolvedValue(IMPACT);
    vi.mocked(applySignificantEventChange).mockResolvedValue({
      ...EVENT,
      status: "approved",
    });
  });

  it("SCRUM395_AC3_AC4_previews_impacts_and_applies_only_after_explicit_confirmation", async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
    render(<SignificantEventChangePanel eventRequest={EVENT} onApplied={onApplied} />);

    fireEvent.change(screen.getByLabelText("Expected attendance"), {
      target: { value: "120" },
    });
    await user.type(screen.getByLabelText("Reason for this change"), "More attendees expected");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await screen.findByRole("group", { name: "Venue bookings to flag: 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Equipment reservations to flag: 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Registered attendees to notify: 0" })).toBeInTheDocument();
    expect(screen.getByText("This Confirmed event will return to Approved.")).toBeInTheDocument();
    expect(previewSignificantEventChange).toHaveBeenCalledWith("event-1", {
      expectedAttendance: 120,
    });
    expect(applySignificantEventChange).not.toHaveBeenCalled();

    const applyButton = screen.getByRole("button", { name: "Confirm significant change" });
    expect(applyButton).toBeDisabled();
    await user.click(screen.getByLabelText(
      "I have reviewed this impact and confirm applying the significant change.",
    ));
    await user.click(applyButton);

    expect(applySignificantEventChange).toHaveBeenCalledWith("event-1", {
      changes: { expectedAttendance: 120 },
      reason: "More attendees expected",
      expectedImpact: IMPACT,
    });
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });

  it("SCRUM395_AC2_requires_a_reason_before_requesting_the_preview", async () => {
    render(<SignificantEventChangePanel eventRequest={EVENT} />);
    fireEvent.change(screen.getByLabelText("Expected attendance"), {
      target: { value: "90" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Preview significant change" }).closest("form"));

    expect(screen.getByRole("alert")).toHaveTextContent("A reason is required.");
    expect(previewSignificantEventChange).not.toHaveBeenCalled();
  });

  it("SCRUM395_AC5_requires_a_fresh_confirmation_when_the_impact_changed_since_preview", async () => {
    const user = userEvent.setup();
    render(<SignificantEventChangePanel eventRequest={EVENT} />);
    fireEvent.change(screen.getByLabelText("Expected attendance"), {
      target: { value: "90" },
    });
    await user.type(screen.getByLabelText("Reason for this change"), "More attendees expected");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));
    expect(await screen.findByRole("group", { name: "Registered attendees to notify: 0" })).toBeInTheDocument();

    vi.mocked(applySignificantEventChange).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: "SIGNIFICANT_CHANGE_IMPACT_CHANGED",
          error: "The impact changed; refresh the preview before confirming",
        },
      },
    });
    await user.click(screen.getByLabelText(
      "I have reviewed this impact and confirm applying the significant change.",
    ));
    await user.click(screen.getByRole("button", { name: "Confirm significant change" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The impact changed");
    expect(screen.queryByText("What this change will affect")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview significant change" })).toBeInTheDocument();
  });

  it("SCRUM395_AC3_lists_pending_venue_requests_still_for_the_old_time", async () => {
    const user = userEvent.setup();
    vi.mocked(previewSignificantEventChange).mockResolvedValueOnce({
      ...IMPACT,
      pendingBookingRequests: [{
        id: "request-1",
        venueName: "Lecture Theatre",
        startsAt: "2040-12-01T10:00:00+08:00",
        endsAt: "2040-12-01T12:00:00+08:00",
      }],
    });
    render(<SignificantEventChangePanel eventRequest={EVENT} />);
    fireEvent.change(screen.getByLabelText("Event start"), {
      target: { value: "2040-12-02T10:00" },
    });
    await user.type(screen.getByLabelText("Reason for this change"), "Speaker moved");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    const list = await screen.findByRole("heading", { name: "Pending venue requests still for the old time" });
    expect(list.closest("section")).toHaveTextContent("Lecture Theatre");
    expect(screen.getByText("Venue Staff will be told. Withdraw or re-request them if needed.")).toBeInTheDocument();
  });

  it("SCRUM395_AC3_omits_the_pending_requests_list_when_there_are_none", async () => {
    const user = userEvent.setup();
    render(<SignificantEventChangePanel eventRequest={EVENT} />);
    fireEvent.change(screen.getByLabelText("Expected attendance"), {
      target: { value: "90" },
    });
    await user.type(screen.getByLabelText("Reason for this change"), "More attendees expected");
    await user.click(screen.getByRole("button", { name: "Preview significant change" }));

    expect(await screen.findByText("What this change will affect")).toBeInTheDocument();
    expect(screen.queryByText("Pending venue requests still for the old time")).not.toBeInTheDocument();
    expect(screen.queryByText(/Venue Staff will be told/)).not.toBeInTheDocument();
  });
});
