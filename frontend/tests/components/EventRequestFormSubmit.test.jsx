// EventRequestFormSubmit.test.jsx
//
// SCRUM-10 AC4 and SCRUM-355 AC4: submitting sends what is on screen. The
// server validates the stored request, so the form saves before it submits.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventRequestForm from "../../src/components/EventRequestForm.jsx";
import {
  createEventRequest,
  submitEventRequest,
  updateEventRequest,
} from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  createEventRequest: vi.fn(),
  submitEventRequest: vi.fn(),
  updateEventRequest: vi.fn(),
}));

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const draft = (overrides = {}) => ({
  id: REQUEST_ID,
  status: "draft",
  eventName: "IS212 Industry Night",
  purpose: "",
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Submitting from the event request form", () => {
  it("SCRUM355_AC4_unsaved_edits_are_saved_before_the_request_is_submitted", async () => {
    const calls = [];
    vi.mocked(updateEventRequest).mockImplementation(async (id, payload) => {
      calls.push(["update", payload.purpose]);
      return draft({ purpose: payload.purpose });
    });
    vi.mocked(submitEventRequest).mockImplementation(async () => {
      calls.push(["submit"]);
      return draft({ status: "submitted" });
    });
    render(<EventRequestForm existingRequest={draft()} />);

    await userEvent.type(screen.getByPlaceholderText("Why is this event happening?"), "Networking");
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(calls).toEqual([["update", "Networking"], ["submit"]]);
    expect(updateEventRequest).toHaveBeenCalledWith(REQUEST_ID, expect.any(Object));
    expect(await screen.findByText("Request submitted")).toBeInTheDocument();
    expect(createEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM355_AC3_a_field_emptied_on_screen_is_sent_as_null_so_it_is_cleared", async () => {
    vi.mocked(updateEventRequest).mockResolvedValue(draft());
    vi.mocked(submitEventRequest).mockResolvedValue(draft({ status: "submitted" }));
    render(<EventRequestForm existingRequest={draft({ venueRequirements: "A tiered hall", expectedAttendance: 80 })} />);

    await userEvent.clear(screen.getByLabelText("Venue requirements"));
    await userEvent.clear(screen.getByLabelText("Expected attendance"));
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(updateEventRequest).toHaveBeenCalledWith(REQUEST_ID, expect.objectContaining({
      venueRequirements: null,
      expectedAttendance: null,
      proposedStart: null,
    }));
  });

  it("SCRUM10_AC4_every_missing_field_is_listed_when_submission_is_refused", async () => {
    vi.mocked(updateEventRequest).mockResolvedValue(draft());
    vi.mocked(submitEventRequest).mockRejectedValue({
      response: { status: 400, data: { details: [{ field: "purpose", message: "is required" }] } },
    });
    render(<EventRequestForm existingRequest={draft()} />);

    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("purpose: is required");
  });

  it("SCRUM10_AC3_a_cleared_event_name_is_refused_before_anything_is_sent", async () => {
    render(<EventRequestForm existingRequest={draft()} />);

    await userEvent.clear(screen.getByDisplayValue("IS212 Industry Night"));
    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    expect(screen.getByText("Event name is required, even for a draft.")).toBeInTheDocument();
    expect(updateEventRequest).not.toHaveBeenCalled();
    expect(submitEventRequest).not.toHaveBeenCalled();
  });
});

describe("Saving a draft from the event request form", () => {
  it("SCRUM10_AC2_every_field_entered_is_sent_when_a_new_draft_is_saved", async () => {
    vi.mocked(createEventRequest).mockResolvedValue(draft());
    const onSaved = vi.fn();
    render(<EventRequestForm onSaved={onSaved} />);

    await userEvent.type(screen.getByLabelText("Event name"), "Alumni Talk");
    await userEvent.type(screen.getByLabelText("Purpose"), "Meet alumni");
    await userEvent.type(screen.getByLabelText("Description"), "Panel and drinks");
    fireEvent.change(screen.getByLabelText("Proposed start"), { target: { value: "2026-12-02T18:00" } });
    fireEvent.change(screen.getByLabelText("Proposed end"), { target: { value: "2026-12-02T21:00" } });
    await userEvent.type(screen.getByLabelText("Expected attendance"), "120");
    await userEvent.type(screen.getByLabelText("Venue requirements"), "Hall");
    await userEvent.type(screen.getByLabelText("Accessibility requirements"), "Step-free access");
    await userEvent.type(screen.getByLabelText("Equipment requirements"), "Two microphones");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(createEventRequest).toHaveBeenCalledWith({
      eventName: "Alumni Talk",
      purpose: "Meet alumni",
      description: "Panel and drinks",
      proposedStart: expect.stringMatching(/^2026-12-02T18:00:00[+-]\d\d:\d\d$/),
      proposedEnd: expect.stringMatching(/^2026-12-02T21:00:00[+-]\d\d:\d\d$/),
      expectedAttendance: 120,
      venueRequirements: "Hall",
      accessibilityRequirements: "Step-free access",
      equipmentRequirements: "Two microphones",
    });
    expect(await screen.findByText("Draft saved. You can submit it when you're ready.")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(draft());
    expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled();
  });

  it("SCRUM10_AC3_a_draft_without_an_event_name_is_refused_before_anything_is_sent", async () => {
    render(<EventRequestForm />);

    await userEvent.type(screen.getByLabelText("Purpose"), "Meet alumni");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(screen.getByText("Event name is required, even for a draft.")).toBeInTheDocument();
    expect(createEventRequest).not.toHaveBeenCalled();
  });
});

describe("Refusals and read-only requests", () => {
  it.each([
    ["the server's reason", { response: { status: 409, data: { error: "Only a draft can be submitted." } } }, "Only a draft can be submitted."],
    ["a general message when the server gives none", new Error("Network Error"), "Could not submit your request."],
  ])("SCRUM10_AC6_a_refused_submission_without_field_details_shows_%s", async (_label, error, shown) => {
    vi.mocked(updateEventRequest).mockResolvedValue(draft());
    vi.mocked(submitEventRequest).mockRejectedValue(error);
    render(<EventRequestForm existingRequest={draft()} />);

    await userEvent.click(screen.getByRole("button", { name: "Submit request" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(shown);
    expect(alert.querySelector("li").textContent).toBe(shown);
    expect(screen.queryByText("Request submitted")).not.toBeInTheDocument();
  });

  it("SCRUM10_AC6_a_submitted_request_opens_read_only_and_points_to_request_a_change", () => {
    render(<EventRequestForm existingRequest={draft({ status: "submitted" })} />);

    expect(screen.getByText(/This request has already been submitted/)).toHaveTextContent('use "Request a change"');
    expect(screen.getByLabelText("Event name")).toBeDisabled();
    expect(screen.getByLabelText("Equipment requirements")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit request" })).not.toBeInTheDocument();
  });

  it("SCRUM10_AC3_a_new_request_cannot_be_submitted_before_its_draft_is_saved", () => {
    render(<EventRequestForm />);

    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
    expect(screen.getByText("Save the draft first to enable submission.")).toBeInTheDocument();
  });
});
