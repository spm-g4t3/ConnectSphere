import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ClarificationReplyForm from "../../src/components/ClarificationReplyForm.jsx";
import {
  getEventClarificationHistory,
  respondToEventClarification,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/eventRequestService.js", () => ({
  getEventClarificationHistory: vi.fn(),
  respondToEventClarification: vi.fn(),
}));

const REQUEST = {
  id: "22222222-2222-4222-8222-222222222222",
  clarificationNote: "Please confirm the expected attendance.",
  clarificationReplyByDate: "2026-10-10",
};

beforeEach(() => {
  vi.mocked(getEventClarificationHistory).mockReset();
  vi.mocked(getEventClarificationHistory).mockResolvedValue([
    { type: "question", requestedFields: [] },
  ]);
  vi.mocked(respondToEventClarification).mockReset();
  vi.mocked(respondToEventClarification).mockResolvedValue({});
});

describe("SCRUM-162 clarification reply and scoped amendments", () => {
  it("shows the question and optional date, and submits a reply with no amendments", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ClarificationReplyForm request={REQUEST} onSaved={onSaved} />);

    expect(screen.getByText(REQUEST.clarificationNote)).toBeInTheDocument();
    expect(screen.getByText(/reply by 10 Oct 2026/i)).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(await screen.findByText("Event amendments")).toBeInTheDocument();
    expect(screen.getByText("Reply only")).toBeInTheDocument();
    expect(screen.getByText(/No event fields were selected for this clarification/i)).toBeInTheDocument();
    expect(screen.getByText("Review current event details")).toBeInTheDocument();
    expect(screen.getByText("View clarification history")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Your reply")).toBeEnabled(),
    );

    await user.type(screen.getByLabelText("Your reply"), "Attendance is 120.");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(respondToEventClarification).toHaveBeenCalledWith(REQUEST.id, "Attendance is 120.", {});
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("does not submit a blank reply", async () => {
    const user = userEvent.setup();
    render(<ClarificationReplyForm request={REQUEST} />);

    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    await user.type(screen.getByLabelText("Your reply"), "   ");
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(respondToEventClarification).not.toHaveBeenCalled();
  });

  it("lets the organiser amend only fields requested by the coordinator", async () => {
    const user = userEvent.setup();
    vi.mocked(getEventClarificationHistory).mockResolvedValue([
      { type: "question", requestedFields: ["purpose"] },
    ]);
    render(<ClarificationReplyForm request={REQUEST} />);

    const purpose = await screen.findByLabelText("Purpose");
    await user.clear(purpose);
    await user.type(purpose, "A student networking event");
    await user.type(screen.getByLabelText("Your reply"), "Updated the purpose.");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(respondToEventClarification).toHaveBeenCalledWith(
      REQUEST.id,
      "Updated the purpose.",
      { purpose: "A student networking event" },
    );
  });
});

describe("SCRUM-162 amending the requested fields", () => {
  const FULL_REQUEST = {
    ...REQUEST,
    eventName: "Freshers Night",
    description: "An evening of games.",
    proposedStart: "2026-12-01T10:00:00+08:00",
    proposedEnd: "2026-12-01T12:00:00+08:00",
    expectedAttendance: 80,
  };
  const FIELDS = ["eventName", "description", "proposedStart", "proposedEnd", "expectedAttendance"];

  beforeEach(() => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([
      { type: "question", requestedFields: FIELDS },
    ]);
  });

  it("SCRUM162_AC5_edited_dates_attendance_and_text_are_sent_in_the_wire_format", async () => {
    const user = userEvent.setup();
    render(<ClarificationReplyForm request={FULL_REQUEST} />);

    expect(await screen.findByText("5 fields editable")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Event name"));
    await user.type(screen.getByLabelText("Event name"), "Freshers Night 2");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "Games and food.");
    fireEvent.change(screen.getByLabelText("Proposed start"), { target: { value: "2026-12-02T09:00" } });
    fireEvent.change(screen.getByLabelText("Proposed end"), { target: { value: "2026-12-02T11:30" } });
    await user.clear(screen.getByLabelText("Expected attendance"));
    await user.type(screen.getByLabelText("Expected attendance"), "150");
    await user.type(screen.getByLabelText("Your reply"), "Moved it a day.");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    const [, , amendments] = vi.mocked(respondToEventClarification).mock.calls[0];
    expect(amendments).toEqual({
      eventName: "Freshers Night 2",
      description: "Games and food.",
      proposedStart: expect.stringMatching(/^2026-12-02T09:00:00[+-]\d\d:\d\d$/),
      proposedEnd: expect.stringMatching(/^2026-12-02T11:30:00[+-]\d\d:\d\d$/),
      expectedAttendance: 150,
    });
  });

  it("SCRUM162_AC5_requested_fields_left_empty_are_sent_as_null_to_clear_them", async () => {
    const user = userEvent.setup();
    render(<ClarificationReplyForm request={FULL_REQUEST} />);

    await screen.findByText("5 fields editable");
    await user.clear(screen.getByLabelText("Event name"));
    await user.clear(screen.getByLabelText("Description"));
    await user.type(screen.getByLabelText("Description"), "   ");
    fireEvent.change(screen.getByLabelText("Proposed start"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Proposed end"), { target: { value: "" } });
    await user.clear(screen.getByLabelText("Expected attendance"));
    await user.type(screen.getByLabelText("Your reply"), "Not decided yet.");
    // The empty name is `required`; submit directly so the payload is what the server judges.
    fireEvent.submit(screen.getByRole("button", { name: "Send reply" }).closest("form"));

    await waitFor(() => expect(respondToEventClarification).toHaveBeenCalledWith(
      REQUEST.id,
      "Not decided yet.",
      {
        eventName: null,
        description: null,
        proposedStart: null,
        proposedEnd: null,
        expectedAttendance: null,
      },
    ));
  });

  it("SCRUM162_AC5_the_fields_are_prefilled_and_locked_while_the_reply_is_sending", async () => {
    const user = userEvent.setup();
    vi.mocked(respondToEventClarification).mockReturnValue(new Promise(() => {}));
    render(<ClarificationReplyForm request={FULL_REQUEST} />);

    expect(await screen.findByLabelText("Event name")).toHaveValue("Freshers Night");
    expect(screen.getByLabelText("Expected attendance")).toHaveValue(80);
    await user.type(screen.getByLabelText("Your reply"), "Done.");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(screen.getByRole("button", { name: "Sending..." })).toBeDisabled();
    for (const label of ["Event name", "Description", "Proposed start", "Proposed end", "Expected attendance"]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
  });
});

describe("SCRUM-162 replying guards", () => {
  it("SCRUM162_AC4_a_blank_reply_submitted_anyway_is_refused_before_anything_is_sent", async () => {
    render(<ClarificationReplyForm request={REQUEST} />);
    await screen.findByText("Reply only");

    fireEvent.submit(screen.getByRole("button", { name: "Send reply" }).closest("form"));

    expect(await screen.findByText("Your reply cannot be blank.")).toBeInTheDocument();
    expect(respondToEventClarification).not.toHaveBeenCalled();
  });

  it.each([
    ["arrives", (pending) => pending.resolve([{ type: "question", requestedFields: ["purpose"] }])],
    ["fails", (pending) => pending.reject({ response: { status: 500 } })],
  ])("SCRUM162_AC3_a_question_that_%s_after_unmount_is_ignored_without_errors", async (_label, settle) => {
    const pending = {};
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    vi.mocked(getEventClarificationHistory).mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<ClarificationReplyForm request={REQUEST} />);
    unmount();

    await act(async () => settle(pending));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
