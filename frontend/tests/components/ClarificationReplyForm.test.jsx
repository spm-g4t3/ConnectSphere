import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText(/reply by 2026-10-10/i)).toBeInTheDocument();
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
