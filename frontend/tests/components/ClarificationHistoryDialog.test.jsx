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
});
