// EquipmentRequestQueue.test.jsx
//
// SCRUM-287, for SCRUM-284 (Technical Support Dashboard and Request Queue).
// Named SCRUM287_ACn_<what_it_checks>, the ACs being SCRUM-284's.
//
// The service is mocked, so nothing touches the network. What the server puts in
// each list, and in what order, is proved by the backend and database tests; this
// file is about what the screen asks for and how it draws and reacts to the answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import EquipmentRequestQueue from "../../src/components/EquipmentRequestQueue.jsx";
import { formatEventPeriod } from "../../src/services/eventPeriodFormat";
import { getEquipmentQueue } from "../../src/services/equipmentQueueService";

vi.mock("../../src/services/equipmentQueueService", async (importOriginal) => ({
  ...(await importOriginal()),
  getEquipmentQueue: vi.fn(),
}));

const EVENT_A = "11111111-1111-4111-8111-111111111111";
const EVENT_B = "22222222-2222-4222-8222-222222222222";
const EVENT_C = "33333333-3333-4333-8333-333333333333";

function row(overrides = {}) {
  return {
    eventRequestId: EVENT_A,
    eventName: "Annual Dinner",
    proposedStart: "2030-01-10T10:00:00+00:00",
    proposedEnd: "2030-01-10T12:00:00+00:00",
    venue: { id: "v1", name: "Hall A" },
    coordinator: { id: "c1", name: "Rae Tan" },
    lineCount: 3,
    status: "pending_review",
    statusLabel: "Pending review",
    reviewer: null,
    flaggedCount: 0,
    flagReasons: [],
    ...overrides,
  };
}

const answer = (needsAction = [], requests = needsAction) => ({ needsAction, requests });

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route path="/dashboard" element={<EquipmentRequestQueue />} />
        <Route path="/equipment-review/:eventId" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const section = (name) => screen.getByRole("region", { name });
const needsActionSection = () => section(/^Needs action/);
const allSection = () => section("Equipment requests");

beforeEach(() => {
  vi.resetAllMocks();
});


describe("loading and failing", () => {
  it("SCRUM287_says_it_is_loading_until_the_answer_arrives", async () => {
    let finish;
    vi.mocked(getEquipmentQueue).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderQueue();
    expect(screen.getByRole("status")).toHaveTextContent("Loading equipment requests");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    finish(answer());
    expect(await screen.findByRole("region", { name: /Needs action/ })).toBeInTheDocument();
    expect(screen.queryByText(/Loading equipment requests/)).not.toBeInTheDocument();
  });

  it.each([
    [400, /filter was not accepted/],
    [403, /Only technical support staff/],
    [500, /could not be loaded/],
    [undefined, /could not be loaded/],
  ])("SCRUM287_a_%s_failure_is_said_in_a_sentence", async (status, message) => {
    vi.mocked(getEquipmentQueue).mockRejectedValue(status ? { response: { status } } : new Error("network"));
    renderQueue();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("SCRUM287_a_server_message_is_never_shown_for_a_500", async () => {
    vi.mocked(getEquipmentQueue).mockRejectedValue({ response: { status: 500, data: { error: "relation x exploded" } } });
    renderQueue();
    expect(await screen.findByRole("alert")).not.toHaveTextContent("exploded");
  });

  it("SCRUM287_Try_again_reads_the_queue_again_and_clears_the_error", async () => {
    vi.mocked(getEquipmentQueue).mockRejectedValueOnce({ response: { status: 500 } }).mockResolvedValue(answer([row()]));
    renderQueue();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect((await screen.findAllByText("Annual Dinner", { selector: "strong" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});


describe("AC3: what a row shows", () => {
  it("SCRUM287_AC3_a_row_shows_the_event_dates_venue_coordinator_lines_and_status", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row()]));
    renderQueue();

    const item = within(await screen.findByRole("region", { name: "Equipment requests" })).getByRole("listitem");
    expect(within(item).getByText("Annual Dinner")).toBeInTheDocument();
    expect(within(item).getByText("Pending review")).toBeInTheDocument();
    expect(item).toHaveTextContent(/Jan/);
    expect(item).toHaveTextContent(/2030/);
    // Either clock style, whatever the reader's locale writes: "6:00 PM", "6:00 pm" or "18:00".
    expect(item).toHaveTextContent(/\d{1,2}:\d{2}(\s?[ap]m)? to \d{1,2}:\d{2}(\s?[ap]m)?/i);
    expect(item).toHaveTextContent("Venue: Hall A");
    expect(item).toHaveTextContent("Coordinator: Rae Tan");
    expect(item).toHaveTextContent("3 items");
  });

  it("SCRUM287_AC3_one_item_is_singular", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ lineCount: 1 })]));
    renderQueue();
    expect(await screen.findByText(/1 item$/)).toBeInTheDocument();
  });

  it("SCRUM287_AC3_a_missing_venue_and_coordinator_are_said_in_words", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ venue: null, coordinator: null })]));
    renderQueue();
    const item = within(await screen.findByRole("region", { name: "Equipment requests" })).getByRole("listitem");
    expect(item).toHaveTextContent("No venue booked");
    expect(item).toHaveTextContent("No coordinator assigned");
  });

  it("SCRUM287_AC3_a_coordinator_with_no_name_does_not_render_the_word_null", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ coordinator: { id: "c1", name: null } })]));
    renderQueue();
    const item = within(await screen.findByRole("region", { name: "Equipment requests" })).getByRole("listitem");
    expect(item).toHaveTextContent("Coordinator: Name not set");
    expect(item).not.toHaveTextContent("null");
  });

  it("SCRUM287_AC3_the_reviewer_is_shown_when_the_request_is_under_review", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([], [row({ status: "under_review", statusLabel: "Under review", reviewer: { id: "r1", name: "Sam Lee" } })]),
    );
    renderQueue();
    expect(await screen.findByText("Reviewing: Sam Lee")).toBeInTheDocument();
  });

  it("SCRUM287_AC3_a_venue_with_no_name_does_not_render_the_word_null", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ venue: { id: "v1", name: null } })]));
    renderQueue();
    const item = within(await screen.findByRole("region", { name: "Equipment requests" })).getByRole("listitem");
    expect(item).toHaveTextContent("Venue: Unnamed venue");
    expect(item).not.toHaveTextContent("null");
  });

  it("SCRUM287_AC3_a_reviewer_with_no_name_does_not_render_the_word_null", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([], [row({ status: "under_review", statusLabel: "Under review", reviewer: { id: "r1", name: null } })]),
    );
    renderQueue();
    expect(await screen.findByText("Reviewing: Name not set")).toBeInTheDocument();
  });

  it("SCRUM287_AC3_no_reviewer_line_for_a_request_that_is_not_under_review", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ reviewer: { id: "r1", name: "Sam Lee" } })]));
    renderQueue();
    await screen.findByText("Annual Dinner", { selector: "strong" });
    expect(screen.queryByText(/Reviewing:/)).not.toBeInTheDocument();
  });

  it("SCRUM287_AC6_nothing_the_server_did_not_list_is_drawn", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([], [{ ...row(), organiserEmail: "secret@example.com", notes: "private notes" }]),
    );
    renderQueue();
    await screen.findByText("Annual Dinner", { selector: "strong" });
    expect(document.body).not.toHaveTextContent(/secret@example.com|private notes/);
  });

  it("SCRUM287_AC3_every_status_is_written_not_just_coloured", async () => {
    const rows = [
      row({ eventRequestId: "a", eventName: "One", status: "pending_review", statusLabel: "Pending review" }),
      row({ eventRequestId: "b", eventName: "Two", status: "under_review", statusLabel: "Under review" }),
      row({ eventRequestId: "c", eventName: "Three", status: "arranged", statusLabel: "Arranged" }),
      row({ eventRequestId: "d", eventName: "Four", status: "cannot_be_fully_arranged", statusLabel: "Cannot be fully arranged" }),
      row({ eventRequestId: "e", eventName: "Five", status: "cancelled", statusLabel: "Cancelled" }),
    ];
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], rows));
    renderQueue();
    const list = within(await screen.findByRole("region", { name: "Equipment requests" }));
    for (const label of ["Pending review", "Under review", "Arranged", "Cannot be fully arranged", "Cancelled"]) {
      // Not "getByText": the filter's options are the same words, so look inside the rows.
      expect(list.getAllByRole("listitem").some((item) => item.textContent.includes(label))).toBe(true);
    }
  });
});


describe("AC4: the Needs action section", () => {
  it("SCRUM287_AC4_the_heading_carries_the_count", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([row({ eventRequestId: "a" }), row({ eventRequestId: "b", eventName: "Two" })], [row()]),
    );
    renderQueue();
    expect(await screen.findByRole("heading", { level: 2, name: "Needs action (2)" })).toBeInTheDocument();
  });

  it("SCRUM287_AC4_an_empty_section_says_nothing_needs_action_and_counts_zero", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([], [row({ status: "arranged", statusLabel: "Arranged" })]));
    renderQueue();
    expect(await screen.findByRole("heading", { name: "Needs action (0)" })).toBeInTheDocument();
    expect(within(needsActionSection()).getByText("Nothing needs your action.")).toBeInTheDocument();
  });

  it("SCRUM287_AC4_a_flagged_request_shows_why_it_was_flagged", async () => {
    const flagged = row({
      eventName: "Flagged Gala",
      flaggedCount: 2,
      flagReasons: ["Event dates changed", "Quantity changed"],
    });
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([flagged], [flagged]));
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    expect(within(needsActionSection()).getByText("2 reservations flagged: Event dates changed; Quantity changed")).toBeInTheDocument();
  });

  it("SCRUM287_AC4_one_flag_is_singular", async () => {
    const flagged = row({ flaggedCount: 1, flagReasons: ["Event dates changed"] });
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([flagged], [flagged]));
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    expect(within(needsActionSection()).getByText("1 reservation flagged: Event dates changed")).toBeInTheDocument();
  });

  it("SCRUM287_AC4_rows_stay_in_the_order_the_server_gave", async () => {
    const rows = [
      row({ eventRequestId: "a", eventName: "Early" }),
      row({ eventRequestId: "b", eventName: "Middle" }),
      row({ eventRequestId: "c", eventName: "Late" }),
    ];
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer(rows, rows));
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    const order = within(needsActionSection()).getAllByRole("listitem").map((li) => li.querySelector("strong").textContent);
    expect(order).toEqual(["Early", "Middle", "Late"]);
  });

  it("SCRUM287_AC4_a_flagged_row_in_the_main_list_shows_the_count_without_the_long_reasons", async () => {
    const flagged = row({ flaggedCount: 1, flagReasons: ["Event dates changed"] });
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([flagged], [flagged]));
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    expect(within(allSection()).getByText("1 reservation flagged")).toBeInTheDocument();
  });
});


describe("AC2: the filters", () => {
  it("SCRUM287_AC2_the_first_read_asks_for_every_status_without_past_events", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    expect(getEquipmentQueue).toHaveBeenCalledTimes(1);
    expect(getEquipmentQueue).toHaveBeenCalledWith({ status: "", includePast: false });
  });

  it("SCRUM287_AC2_the_status_filter_offers_all_and_the_five_statuses", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    const select = await screen.findByLabelText("Status");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All statuses",
      "Pending review",
      "Under review",
      "Arranged",
      "Cannot be fully arranged",
      "Cancelled",
    ]);
  });

  it("SCRUM287_AC2_choosing_a_status_reads_the_queue_again_with_it", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    await waitFor(() => expect(getEquipmentQueue).toHaveBeenLastCalledWith({ status: "arranged", includePast: false }));
  });

  it("SCRUM287_AC2_ticking_include_past_events_reads_again_with_it", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await userEvent.click(await screen.findByLabelText("Include past events"));
    await waitFor(() => expect(getEquipmentQueue).toHaveBeenLastCalledWith({ status: "", includePast: true }));
  });

  it("SCRUM287_AC2_the_two_filters_combine_and_can_be_cleared", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "cancelled");
    await userEvent.click(screen.getByLabelText("Include past events"));
    await waitFor(() => expect(getEquipmentQueue).toHaveBeenLastCalledWith({ status: "cancelled", includePast: true }));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "");
    await waitFor(() => expect(getEquipmentQueue).toHaveBeenLastCalledWith({ status: "", includePast: true }));
  });

  it("SCRUM287_AC2_the_filters_survive_a_reload_of_the_lists_they_do_not_disappear", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    await waitFor(() => expect(getEquipmentQueue).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Status")).toHaveValue("arranged");
  });

  it("SCRUM287_AC2_an_empty_filtered_list_says_nothing_matches", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    expect(await within(allSection()).findByText("No equipment requests match these filters.")).toBeInTheDocument();
  });

  it("SCRUM287_AC2_an_empty_unfiltered_list_says_there_are_none_upcoming", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer());
    renderQueue();
    expect(await within(await screen.findByRole("region", { name: "Equipment requests" })).findByText("No equipment requests for upcoming events.")).toBeInTheDocument();
  });

  it("SCRUM287_AC2_a_slow_answer_to_an_old_filter_does_not_overwrite_a_newer_one", async () => {
    let finishSlow;
    vi.mocked(getEquipmentQueue)
      .mockResolvedValueOnce(answer())
      .mockReturnValueOnce(new Promise((resolve) => (finishSlow = resolve)))
      .mockResolvedValueOnce(answer([], [row({ eventName: "Newer answer" })]));
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "cancelled");
    expect(await screen.findByText("Newer answer", { selector: "strong" })).toBeInTheDocument();

    finishSlow(answer([], [row({ eventName: "Stale answer" })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale answer")).not.toBeInTheDocument();
    expect(screen.getByText("Newer answer", { selector: "strong" })).toBeInTheDocument();
  });

  it("SCRUM287_AC2_a_slow_failure_of_an_old_filter_does_not_show_an_error_over_a_newer_answer", async () => {
    let failSlow;
    vi.mocked(getEquipmentQueue)
      .mockResolvedValueOnce(answer())
      .mockReturnValueOnce(new Promise((_resolve, reject) => (failSlow = reject)))
      .mockResolvedValueOnce(answer([], [row({ eventName: "Newer answer" })]));
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "cancelled");
    expect(await screen.findByText("Newer answer", { selector: "strong" })).toBeInTheDocument();

    failSlow({ response: { status: 500 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Newer answer", { selector: "strong" })).toBeInTheDocument();
  });

  it("SCRUM287_AC2_a_failed_filter_keeps_the_filter_so_it_can_be_corrected", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValueOnce(answer()).mockRejectedValueOnce({ response: { status: 500 } });
    renderQueue();
    await userEvent.selectOptions(await screen.findByLabelText("Status"), "arranged");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
    expect(screen.getByLabelText("Status")).toHaveValue("arranged");
  });
});


describe("AC5: selecting a request opens its review screen", () => {
  it("SCRUM287_AC5_Open_on_a_row_goes_to_that_events_review_screen", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([], [row({ eventRequestId: EVENT_A, eventName: "First" }), row({ eventRequestId: EVENT_B, eventName: "Second" })]),
    );
    renderQueue();
    await userEvent.click(await screen.findByRole("link", { name: "Open Second" }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/equipment-review/${EVENT_B}`);
  });

  it("SCRUM287_AC5_each_link_names_its_own_event", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      answer([], [row({ eventRequestId: EVENT_A, eventName: "First" }), row({ eventRequestId: EVENT_C, eventName: "Third" })]),
    );
    renderQueue();
    expect(await screen.findByRole("link", { name: "Open First" })).toHaveAttribute("href", `/equipment-review/${EVENT_A}`);
    expect(screen.getByRole("link", { name: "Open Third" })).toHaveAttribute("href", `/equipment-review/${EVENT_C}`);
  });

  it("SCRUM287_AC5_a_needs_action_row_opens_the_same_review_screen", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(answer([row({ eventRequestId: EVENT_B, eventName: "Urgent" })], []));
    renderQueue();
    await screen.findByRole("heading", { name: /Needs action/ });
    await userEvent.click(within(needsActionSection()).getByRole("link", { name: "Open Urgent" }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/equipment-review/${EVENT_B}`);
  });
});


describe("formatEventPeriod", () => {
  it("SCRUM287_AC3_a_one_day_event_shows_the_date_once_with_both_times", () => {
    const text = formatEventPeriod("2030-01-10T10:00:00Z", "2030-01-10T12:00:00Z");
    expect(text.match(/2030/g)).toHaveLength(1);
    expect(text).toContain(" to ");
  });

  it("SCRUM287_AC3_times_are_Singapore_time_whatever_the_device_zone", () => {
    // 16:30 to 18:00 UTC on the 10th is 00:30 to 02:00 on the 11th in Singapore.
    const text = formatEventPeriod("2030-01-10T16:30:00Z", "2030-01-10T18:00:00Z");
    expect(text).toMatch(/Fri, 11 Jan 2030/);
    expect(text).toMatch(/12:30\s?am to 2:00\s?am/i);
  });

  it("SCRUM287_AC3_a_multi_day_event_shows_both_dates", () => {
    const text = formatEventPeriod("2030-01-10T10:00:00Z", "2030-01-12T12:00:00Z");
    expect(text.match(/2030/g)).toHaveLength(2);
  });

  it.each([
    [null, null],
    [undefined, undefined],
    ["2030-01-10T10:00:00Z", null],
    [null, "2030-01-10T12:00:00Z"],
    ["not a date", "2030-01-10T12:00:00Z"],
  ])("SCRUM287_AC3_%s to %s is shown as Date not set", (start, end) => {
    expect(formatEventPeriod(start, end)).toBe("Date not set");
  });

  it("SCRUM287_AC3_uses_no_dash_characters_between_times", () => {
    expect(formatEventPeriod("2030-01-10T10:00:00Z", "2030-01-10T12:00:00Z")).not.toMatch(/[–—]/);
  });
});
