// VenueHoldForm.test.jsx
//
// SCRUM-491 (AC2). The presentational hold form: an Approved event from the
// list it is given, and an expiry in the future. It calls no service, so
// nothing is mocked; every callback is a spy.
//
// Timezone-safe: the expiry is set through toDatetimeLocalValue from an
// instant relative to the real clock, and the sent value is checked by its
// offset shape and getTime(). No fake timers.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import VenueHoldForm from "../../src/components/VenueHoldForm.jsx";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat";
import { formatDateTimeRange } from "../../src/services/displayFormat";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;

function minuteFromNow(ms) {
  return new Date(Math.floor((Date.now() + ms) / MINUTE) * MINUTE).toISOString();
}

const LAUNCH = {
  id: "e1000000-0000-4000-8000-000000000001",
  eventName: "Product Launch",
  proposedStart: "2026-11-02T09:00:00+08:00",
  proposedEnd: "2026-11-02T12:00:00+08:00",
  expectedAttendance: 120,
  assignedCoordinatorId: "c1",
  assignedCoordinatorName: "Casey Coordinator",
};
const NAMELESS = {
  id: "e2000000-0000-4000-8000-000000000002",
  eventName: null,
  proposedStart: null,
  proposedEnd: null,
  expectedAttendance: null,
  assignedCoordinatorId: null,
  assignedCoordinatorName: null,
};

function renderForm(props = {}) {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  const onChanged = vi.fn();
  const utils = render(
    <VenueHoldForm candidates={[LAUNCH, NAMELESS]} onSubmit={onSubmit} onChanged={onChanged} {...props} />,
  );
  return { user, onSubmit, onChanged, ...utils };
}

const eventSelect = () => screen.getByLabelText("Approved event");
const expiryInput = () => screen.getByLabelText("Hold expires");
const submitButton = () => screen.getByRole("button", { name: "Place hold" });

function setExpiry(iso) {
  fireEvent.change(expiryInput(), { target: { value: toDatetimeLocalValue(iso) } });
}

describe("SCRUM491_AC2 VenueHoldForm event picker", () => {
  it("SCRUM491_AC2_lists_each_approved_event_with_its_period_attendance_and_coordinator", () => {
    renderForm();
    const options = within(eventSelect()).getAllByRole("option");

    expect(options[0]).toHaveTextContent("Choose an event");
    expect(options[0]).toBeDisabled();
    expect(options[1]).toHaveTextContent(
      `Product Launch · ${formatDateTimeRange(LAUNCH.proposedStart, LAUNCH.proposedEnd)} · 120 attending · Coordinator: Casey Coordinator`,
    );
  });

  it("SCRUM491_AC2_an_event_missing_its_details_reads_plainly", () => {
    renderForm();
    const option = within(eventSelect()).getAllByRole("option")[2];

    expect(option).toHaveTextContent(
      "Unnamed event · no date · Coordinator: not assigned",
    );
    expect(option).not.toHaveTextContent("attending");
  });

  it("SCRUM491_AC2_says_Loading_and_disables_the_picker_while_events_load", () => {
    renderForm({ candidates: [], loadingCandidates: true });

    expect(eventSelect()).toBeDisabled();
    expect(within(eventSelect()).getByRole("option")).toHaveTextContent("Loading events...");
    expect(screen.queryByText(/no Approved events/)).not.toBeInTheDocument();
  });

  it("SCRUM491_AC2_says_when_there_are_no_approved_events", () => {
    renderForm({ candidates: [] });

    expect(screen.getByText("There are no Approved events to hold a venue for.")).toBeInTheDocument();
  });

  it("SCRUM491_AC2_shows_a_failed_event_load_as_an_alert", () => {
    renderForm({ candidates: [], candidatesError: "Could not load the Approved events." });

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the Approved events.");
    expect(screen.queryByText(/no Approved events/)).not.toBeInTheDocument();
  });

  it("SCRUM491_AC2_says_the_hold_covers_the_events_own_period_and_device_time", () => {
    renderForm();

    expect(screen.getByText(/covers the event's own period/)).toBeInTheDocument();
    expect(screen.getByText(/Times are in your device's time zone/)).toBeInTheDocument();
  });
});

describe("SCRUM491_AC2 VenueHoldForm submit", () => {
  it("SCRUM491_AC2_sends_the_chosen_event_and_an_offset_expiry", async () => {
    const { user, onSubmit } = renderForm();
    const expires = minuteFromNow(3 * DAY);

    await user.selectOptions(eventSelect(), LAUNCH.id);
    setExpiry(expires);
    await user.click(submitButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(["eventRequestId", "expiresAt"]);
    expect(payload.eventRequestId).toBe(LAUNCH.id);
    expect(payload.expiresAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(payload.expiresAt).getTime()).toBe(new Date(expires).getTime());
  });

  it("SCRUM491_AC2_expiry_is_required_and_an_event_must_be_chosen", async () => {
    const { user, onSubmit } = renderForm();
    await user.click(submitButton());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(eventSelect()).toHaveAttribute("aria-invalid", "true");
    expect(expiryInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("is required")).toHaveLength(2);
    const describedBy = expiryInput().getAttribute("aria-describedby");
    expect(document.getElementById(describedBy)).toHaveTextContent("is required");
  });

  it("SCRUM491_AC2_a_past_expiry_is_refused_before_any_request", async () => {
    const { user, onSubmit } = renderForm();
    await user.selectOptions(eventSelect(), LAUNCH.id);
    setExpiry(minuteFromNow(-DAY));
    await user.click(submitButton());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("must be in the future")).toBeInTheDocument();
  });

  it("SCRUM491_AC2_editing_a_field_clears_its_error_and_tells_the_parent", async () => {
    const { user, onChanged } = renderForm();
    await user.click(submitButton());
    expect(screen.getAllByText("is required")).toHaveLength(2);

    await user.selectOptions(eventSelect(), LAUNCH.id);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(eventSelect()).not.toHaveAttribute("aria-invalid");
    expect(screen.getAllByText("is required")).toHaveLength(1);
  });

  it("SCRUM491_AC2_disables_everything_while_submitting_and_ignores_a_forced_submit", () => {
    const onCancel = vi.fn();
    const { onSubmit } = renderForm({ submitting: true, onCancel });

    expect(screen.getByRole("button", { name: "Placing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(eventSelect()).toBeDisabled();
    expect(expiryInput()).toBeDisabled();

    fireEvent.submit(document.querySelector("form.venue-hold-form"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Cancel calls onCancel, and there is no Cancel without one", async () => {
    const onCancel = vi.fn();
    const { user, unmount } = renderForm({ onCancel });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    unmount();
    renderForm();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("works without onSubmit or onChanged", async () => {
    const user = userEvent.setup();
    render(<VenueHoldForm candidates={[LAUNCH]} />);
    await user.selectOptions(eventSelect(), LAUNCH.id);
    setExpiry(minuteFromNow(DAY));
    await user.click(submitButton());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM491_AC2 VenueHoldForm server answers", () => {
  it("SCRUM491_AC2_a_400s_details_sit_beside_their_fields", () => {
    renderForm({
      serverErrors: [
        { field: "expiresAt", message: "must be in the future" },
        { field: "eventRequestId", message: "must be a valid event id" },
      ],
    });

    expect(expiryInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("must be in the future")).toBeInTheDocument();
    expect(screen.getByText("must be a valid event id")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM491_AC2_details_for_no_field_here_go_in_the_alert", () => {
    renderForm({
      serverErrors: [
        { field: "venueId", message: "must be a valid venue id" },
        { message: "something else" },
      ],
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("venueId: must be a valid venue id");
    expect(alert).toHaveTextContent("something else");
  });

  it("SCRUM491_AC4_formError_shows_in_the_alert", () => {
    renderForm({ formError: "This venue is not free for the whole of the event." });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This venue is not free for the whole of the event.",
    );
  });
});
