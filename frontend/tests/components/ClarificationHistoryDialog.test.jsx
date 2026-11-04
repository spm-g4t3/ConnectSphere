import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import ClarificationHistoryDialog from "../../src/components/ClarificationHistoryDialog.jsx";
import { getEventClarificationHistory } from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventClarificationHistory: vi.fn(),
}));

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

describe("ClarificationHistoryDialog", () => {
  beforeEach(() => {
    vi.mocked(getEventClarificationHistory).mockReset();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function () {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function () {
        this.removeAttribute("open");
      }),
    });
  });

  afterEach(() => {
    if (originalShowModal) {
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
    } else {
      delete HTMLDialogElement.prototype.showModal;
    }
    if (originalClose) {
      Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
    } else {
      delete HTMLDialogElement.prototype.close;
    }
  });

  it("opens history in a separate dialog and closes it on request", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([
      {
        id: "question-1",
        type: "question",
        authorName: "Coordinator",
        message: "Please confirm the expected attendance.",
        createdAt: "2026-10-10T08:00:00Z",
        replyByDate: null,
        requestedFields: [],
      },
    ]);

    render(
      <ClarificationHistoryDialog
        eventRequestId="event-1"
        eventName="Community showcase"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "View clarification history" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Clarification history",
    });
    expect(within(dialog).getByText("Community showcase")).toBeInTheDocument();
    expect(within(dialog).getByText("Please confirm the expected attendance.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close clarification history" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  const QUESTION = {
    id: "question-1",
    type: "question",
    authorName: "Coordinator",
    message: "Please confirm the expected attendance.",
    createdAt: "2026-10-10T08:00:00Z",
    replyByDate: null,
    requestedFields: [],
  };

  async function openHistory(props = {}) {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([QUESTION]);
    render(<ClarificationHistoryDialog eventRequestId="event-1" eventName="Community showcase" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /View (clarification history|previous messages)/ }));
    const dialog = await screen.findByRole("dialog", { name: "Clarification history" });
    await within(dialog).findByText(/Please confirm the expected attendance\.|No earlier messages\./);
    return dialog;
  }

  it("SCRUM162_AC9_escape_closes_the_history_dialog", async () => {
    const dialog = await openHistory();

    // Escape on a modal dialog fires a cancelable "cancel" event.
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);

    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View clarification history" })).toBeInTheDocument();
  });

  it("SCRUM162_AC9_clicking_the_backdrop_closes_the_dialog_but_clicking_inside_does_not", async () => {
    const dialog = await openHistory();

    fireEvent.click(within(dialog).getByText("Please confirm the expected attendance."));
    expect(screen.getByRole("dialog", { name: "Clarification history" })).toBeInTheDocument();

    // A click on the backdrop lands on the <dialog> element itself.
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("SCRUM162_AC9_for_an_open_question_the_dialog_shows_only_the_earlier_messages", async () => {
    const dialog = await openHistory({ isOpenQuestion: true, latestQuestion: QUESTION.message });

    // The open question is already on the page above the button, so it is not repeated.
    expect(within(dialog).getByText("No earlier messages.")).toBeInTheDocument();
    expect(within(dialog).queryByText(QUESTION.message)).not.toBeInTheDocument();

    // Close before the jsdom dialog stubs are removed after the test.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close clarification history" }));
    expect(screen.getByRole("button", { name: "View previous messages" })).toBeInTheDocument();
  });
});
