// EventRequestFormSubmit.test.jsx
//
// SCRUM-10 AC4 and SCRUM-355 AC4: submitting sends what is on screen. The
// server validates the stored request, so the form saves before it submits.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
