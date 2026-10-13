import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import ClarificationHistory from "../../src/components/ClarificationHistory.jsx";
import { getEventClarificationHistory } from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventClarificationHistory: vi.fn(),
}));

describe("ClarificationHistory", () => {
  beforeEach(() => {
    vi.mocked(getEventClarificationHistory).mockReset();
  });

  it("presents each update with a clear type, author, time, and message", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([
      {
        id: "question-1",
        type: "question",
        authorName: "Coordinator",
        message: "Please confirm the expected attendance.",
        createdAt: "2026-10-10T08:00:00Z",
        replyByDate: "2026-10-12",
        requestedFields: ["expectedAttendance", "venueRequirements"],
      },
      {
        id: "reply-1",
        type: "reply",
        authorName: "Organiser",
        message: "We expect around 80 attendees.",
        createdAt: "2026-10-10T09:00:00Z",
        replyByDate: null,
        requestedFields: [],
      },
    ]);

    render(<ClarificationHistory eventRequestId="event-1" />);

    const conversation = await screen.findByLabelText("Clarification conversation");
    const entries = Array.from(conversation.children);
    expect(entries).toHaveLength(2);

    expect(within(entries[0]).getByText("Coordinator question")).toBeInTheDocument();
    expect(within(entries[0]).getByText("Coordinator")).toBeInTheDocument();
    expect(within(entries[0]).getByText("Please confirm the expected attendance.")).toBeInTheDocument();
    expect(entries[0].querySelector(".clarification-history__fields"))
      .toHaveTextContent("Fields to update: Expected attendance, Venue requirements");
    expect(within(entries[0]).getByText(/Reply by/)).toBeInTheDocument();

    expect(within(entries[1]).getByText("Organiser reply")).toBeInTheDocument();
    expect(within(entries[1]).getByText("Organiser")).toBeInTheDocument();
    expect(within(entries[1]).getByText("We expect around 80 attendees.")).toBeInTheDocument();
    expect(within(entries[1]).queryByText(/Fields to update:/)).not.toBeInTheDocument();
  });

  it("omits the active question when earlier clarification history is shown", async () => {
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
      {
        id: "reply-1",
        type: "reply",
        authorName: "Organiser",
        message: "We expect around 80 attendees.",
        createdAt: "2026-10-10T09:00:00Z",
        replyByDate: null,
        requestedFields: [],
      },
    ]);

    render(
      <ClarificationHistory
        eventRequestId="event-1"
        omitLatestQuestionMessage="Please confirm the expected attendance."
      />,
    );

    const conversation = await screen.findByLabelText("Clarification conversation");
    expect(within(conversation).queryByText("Please confirm the expected attendance.")).not.toBeInTheDocument();
    expect(within(conversation).getByText("We expect around 80 attendees.")).toBeInTheDocument();
  });

  it("shows a helpful empty state", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([]);

    render(<ClarificationHistory eventRequestId="event-1" />);

    expect(await screen.findByText("No clarification updates yet.")).toBeInTheDocument();
  });
});
