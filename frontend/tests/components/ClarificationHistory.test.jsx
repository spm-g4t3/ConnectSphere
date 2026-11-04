import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

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

const PAST_DAY = "2020-01-10";
const FUTURE_DAY = "2099-01-10";

function question(overrides = {}) {
  return {
    id: "question-1",
    type: "question",
    authorName: "Coordinator",
    message: "Please confirm the expected attendance.",
    createdAt: "2026-10-10T08:00:00Z",
    replyByDate: null,
    requestedFields: [],
    ...overrides,
  };
}

describe("SCRUM-162 clarification history details", () => {
  beforeEach(() => {
    vi.mocked(getEventClarificationHistory).mockReset();
  });

  it("SCRUM162_AC9_when_the_only_entry_is_the_open_question_shown_above_it_says_there_is_nothing_earlier", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([question()]);

    render(
      <ClarificationHistory
        eventRequestId="event-1"
        omitLatestQuestionMessage="Please confirm the expected attendance."
      />,
    );

    expect(await screen.findByText("No earlier messages.")).toBeInTheDocument();
    expect(screen.queryByText("Please confirm the expected attendance.")).not.toBeInTheDocument();
  });

  it("SCRUM162_AC11_an_open_question_past_its_reply_by_date_is_marked_overdue", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([question({ replyByDate: PAST_DAY })]);

    render(<ClarificationHistory eventRequestId="event-1" isOpen />);

    const conversation = await screen.findByLabelText("Clarification conversation");
    expect(within(conversation).getByText("Overdue")).toBeInTheDocument();
  });

  it.each([
    ["the clarification is no longer open", { isOpen: false }, [question({ replyByDate: PAST_DAY })]],
    ["the reply-by date has not passed", { isOpen: true }, [question({ replyByDate: FUTURE_DAY })]],
    ["the question has been answered", { isOpen: true }, [
      question({ replyByDate: PAST_DAY }),
      { id: "reply-1", type: "reply", authorName: "Organiser", message: "Around 80.", createdAt: "2026-10-11T08:00:00Z" },
    ]],
  ])("SCRUM162_AC11_no_overdue_mark_when_%s", async (_label, props, history) => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue(history);

    render(<ClarificationHistory eventRequestId="event-1" {...props} />);

    await screen.findByLabelText("Clarification conversation");
    expect(screen.queryByText("Overdue")).not.toBeInTheDocument();
  });

  it("SCRUM162_AC9_an_entry_of_an_unknown_type_or_field_still_shows_in_plain_words", async () => {
    vi.mocked(getEventClarificationHistory).mockResolvedValue([
      question({ requestedFields: ["layout"] }),
      { id: "other-1", type: "reopened", authorName: "Coordinator", message: "Reopened.", createdAt: "2026-10-11T08:00:00Z" },
    ]);

    render(<ClarificationHistory eventRequestId="event-1" />);

    const conversation = await screen.findByLabelText("Clarification conversation");
    expect(conversation.querySelector(".clarification-history__fields"))
      .toHaveTextContent("Fields to update: layout");
    expect(within(conversation).getByText("Clarification update")).toBeInTheDocument();
  });

  it.each([
    ["arrives", (pending) => pending.resolve([question()])],
    ["fails", (pending) => pending.reject({ response: { status: 500 } })],
  ])("SCRUM162_AC9_a_history_that_%s_after_unmount_is_ignored_without_errors", async (_label, settle) => {
    const pending = {};
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    vi.mocked(getEventClarificationHistory).mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<ClarificationHistory eventRequestId="event-1" />);
    unmount();

    await act(async () => settle(pending));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
