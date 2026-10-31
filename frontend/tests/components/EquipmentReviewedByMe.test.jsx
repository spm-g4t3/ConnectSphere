// EquipmentReviewedByMe.test.jsx
//
// Named SCRUM582_AC<n>_<what_it_checks>, the ACs being SCRUM-582's.
//
// The service is mocked, so nothing touches the network. Which requests belong
// in the list, and why a review ended, is proved by the database test; this file
// is about how the screen draws and reacts to the answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import EquipmentReviewedByMe from "../../src/components/EquipmentReviewedByMe.jsx";
import { getReviewedByMe } from "../../src/services/equipmentQueueService";

vi.mock("../../src/services/equipmentQueueService", () => ({
  getReviewedByMe: vi.fn(),
}));

const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";
const REQUEST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const REQUEST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const row = (overrides = {}) => ({
  requestId: REQUEST_A,
  eventRequestId: EVENT_A,
  eventName: "Annual Dinner",
  proposedStart: "2030-01-10T10:00:00+00:00",
  proposedEnd: "2030-01-10T12:00:00+00:00",
  status: "under_review",
  statusLabel: "Under review",
  lastWorkedAt: "2030-01-05T01:00:00+00:00",
  returnedToPending: false,
  interruptedReason: null,
  interruptedAt: null,
  ...overrides,
});

const answer = (requests = [], extra = {}) => ({
  requests,
  total: requests.length,
  truncated: false,
  ...extra,
});

const renderList = () =>
  render(
    <MemoryRouter>
      <EquipmentReviewedByMe />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(getReviewedByMe).mockReset();
});

describe("what the list shows", () => {
  it("SCRUM582_AC2_shows_each_request_with_its_status_and_when_I_last_worked_on_it", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row()]));
    renderList();

    expect(await screen.findByText("Annual Dinner")).toBeInTheDocument();
    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.getByText(/Last worked on: 2030-01-05 09:00/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Reviewed by me" })).toBeInTheDocument();
  });

  it("SCRUM582_AC1_each_request_opens_its_review_screen", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row(), row({ requestId: REQUEST_B, eventRequestId: EVENT_B, eventName: "Gala" })]));
    renderList();

    expect(await screen.findByRole("link", { name: "Open Annual Dinner" })).toHaveAttribute(
      "href",
      `/equipment-review/${EVENT_A}`,
    );
    expect(screen.getByRole("link", { name: "Open Gala" })).toHaveAttribute("href", `/equipment-review/${EVENT_B}`);
  });

  it("SCRUM582_AC1_a_cancelled_request_and_its_replacement_for_one_event_are_two_rows_and_React_has_no_key_warning", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getReviewedByMe).mockResolvedValue(
      answer([
        row({ requestId: REQUEST_A2, status: "under_review", statusLabel: "Under review" }),
        row({ requestId: REQUEST_A, status: "cancelled", statusLabel: "Cancelled" }),
      ]),
    );
    renderList();

    await screen.findAllByText("Annual Dinner");
    expect(screen.getAllByText("Annual Dinner")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Open Annual Dinner" })).toHaveLength(2);
    expect(screen.getByText("Under review")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    const keyWarnings = errors.mock.calls.filter((call) => /same key|unique "key"/i.test(String(call[0])));
    expect(keyWarnings).toEqual([]);
    errors.mockRestore();
  });

  it("SCRUM582_AC1_asks_once_and_with_no_filters", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row()]));
    renderList();
    await screen.findByText("Annual Dinner");

    expect(getReviewedByMe).toHaveBeenCalledTimes(1);
    expect(getReviewedByMe).toHaveBeenCalledWith();
  });

  it("SCRUM582_AC1_an_empty_history_says_so", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([]));
    renderList();

    expect(await screen.findByText("You have not reviewed any equipment requests yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("SCRUM582_AC1_says_when_the_list_was_cut", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row()], { total: 7, truncated: true }));
    renderList();

    expect(await screen.findByRole("note")).toHaveTextContent("Showing the 1 most recent of 7.");
  });

  it("SCRUM582_AC1_a_complete_list_has_no_cut_note", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row()]));
    renderList();
    await screen.findByText("Annual Dinner");

    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("a view only", () => {
  it("SCRUM582_AC4_offers_only_links_to_the_review_screen_and_never_a_start_or_take_over", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(
      answer([row(), row({ requestId: REQUEST_B, eventRequestId: EVENT_B, eventName: "Gala", status: "pending_review", statusLabel: "Pending review" })]),
    );
    renderList();
    await screen.findByText("Annual Dinner");

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});

describe("why a review ended", () => {
  it("SCRUM582_AC3_marks_a_request_back_in_pending_review_and_shows_why_the_review_ended", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(
      answer([
        row({
          status: "pending_review",
          statusLabel: "Pending review",
          returnedToPending: true,
          interruptedReason: "The lines were changed during the review",
        }),
      ]),
    );
    renderList();

    expect(await screen.findByText("Your review ended: The lines were changed during the review.")).toBeInTheDocument();
    expect(screen.getByText("Back in Pending review since you last worked on it.")).toBeInTheDocument();
  });

  it("SCRUM582_AC2_a_reason_that_already_ends_in_a_full_stop_is_not_doubled", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(
      answer([row({ interruptedReason: "A reservation was flagged during the review. Venue closed." })]),
    );
    renderList();

    expect(
      await screen.findByText("Your review ended: A reservation was flagged during the review. Venue closed."),
    ).toBeInTheDocument();
  });

  it("SCRUM582_AC3_a_cancelled_request_shows_its_reason_and_is_not_marked", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(
      answer([
        row({
          status: "cancelled",
          statusLabel: "Cancelled",
          interruptedReason: "The request was cancelled during the review",
        }),
      ]),
    );
    renderList();

    expect(await screen.findByText("Your review ended: The request was cancelled during the review.")).toBeInTheDocument();
    expect(screen.queryByText("Back in Pending review since you last worked on it.")).not.toBeInTheDocument();
  });

  it("SCRUM582_AC3_a_request_with_no_interruption_shows_neither_line", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue(answer([row()]));
    renderList();
    await screen.findByText("Annual Dinner");

    expect(screen.queryByText(/Your review ended/)).not.toBeInTheDocument();
    expect(screen.queryByText("Back in Pending review since you last worked on it.")).not.toBeInTheDocument();
  });
});

describe("loading and failures", () => {
  it("SCRUM582_AC1_shows_a_loading_line_until_the_answer_arrives", async () => {
    let finish;
    vi.mocked(getReviewedByMe).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderList();

    expect(screen.getByRole("status")).toHaveTextContent("Loading your reviewed requests...");
    finish(answer([row()]));
    expect(await screen.findByText("Annual Dinner")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("SCRUM582_AC5_a_403_says_only_technical_support_staff_can_see_it", async () => {
    vi.mocked(getReviewedByMe).mockRejectedValue({ response: { status: 403 } });
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only technical support staff can see the requests they have reviewed.",
    );
  });

  it("SCRUM582_AC1_any_other_failure_says_so_and_Try_again_loads_the_list", async () => {
    vi.mocked(getReviewedByMe).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(answer([row()]));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your reviewed requests could not be loaded. Try again.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Annual Dinner")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
