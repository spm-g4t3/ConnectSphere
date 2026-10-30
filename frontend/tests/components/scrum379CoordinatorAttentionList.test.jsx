// scrum379CoordinatorAttentionList.test.jsx
//
// SCRUM-384 (SCRUM-379 AC7): the coordinator's Needs attention list. Each item shows its reason,
// is a link to the event, and times are in Singapore time. The service is mocked, so nothing
// touches the network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";

import CoordinatorAttentionList from "../../src/components/CoordinatorAttentionList.jsx";
import { getNeedsAttention } from "../../src/services/eventRequestService";
import { SESSION_EXPIRED } from "../../src/services/apiErrors";
import { setVisibility } from "../helpers/visibility.js";

vi.mock("../../src/services/eventRequestService", () => ({
  getNeedsAttention: vi.fn(),
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ID = "33333333-3333-4333-8333-333333333333";

const item = (overrides = {}) => ({
  id: `${EVENT_ID}:MARK_COMPLETED:0`,
  code: "MARK_COMPLETED",
  reason: "Mark as completed",
  eventRequestId: EVENT_ID,
  eventName: "IS212 Industry Night",
  status: "confirmed",
  // 09:00 to 11:00 in Singapore.
  proposedStart: "2030-06-15T01:00:00Z",
  proposedEnd: "2030-06-15T03:00:00Z",
  organiserName: "Olivia Organiser",
  link: `/event-requests/${EVENT_ID}`,
  ...overrides,
});

const refusal = (status) => Object.assign(new Error("request failed"), { response: { status } });

function renderList(props = {}) {
  return render(
    <MemoryRouter>
      <CoordinatorAttentionList {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getNeedsAttention).mockReset();
  vi.mocked(getNeedsAttention).mockResolvedValue([]);
});

afterEach(() => {
  delete document.visibilityState;
});

describe("SCRUM379 Needs attention: what it shows", () => {
  it("SCRUM379_AC7_has_a_Needs_attention_heading_and_reads_the_list_once_on_load", async () => {
    renderList();

    expect(screen.getByRole("heading", { level: 2, name: /^Needs attention/ })).toBeInTheDocument();
    await waitFor(() => expect(getNeedsAttention).toHaveBeenCalledTimes(1));
  });

  it("SCRUM379_AC7_shows_loading_until_the_list_arrives", async () => {
    let finish;
    vi.mocked(getNeedsAttention).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderList();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    finish([]);
    await screen.findByText("Nothing needs your attention right now.");
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC7_an_empty_list_is_the_good_state_not_an_error", async () => {
    renderList();

    expect(await screen.findByText("Nothing needs your attention right now.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC7_each_item_shows_its_event_reason_organiser_and_singapore_time", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item()]);
    renderList();

    const row = (await screen.findByRole("link", { name: "IS212 Industry Night" })).closest("li");
    expect(within(row).getByText("Mark as completed")).toBeInTheDocument();
    expect(within(row).getByText("Organiser: Olivia Organiser")).toBeInTheDocument();
    expect(within(row).getByText("2030-06-15 09:00 – 11:00 (Singapore time)")).toBeInTheDocument();
  });

  it("SCRUM379_AC7_each_item_has_an_Open_button_named_for_its_event_like_the_rows_of_My_events", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item(), item({
      id: `${SECOND_ID}:NOT_CONFIRMED:0`, eventRequestId: SECOND_ID, link: `/event-requests/${SECOND_ID}`, eventName: "Other", reason: "Not confirmed; cancel",
    })]);
    renderList();

    const buttons = await screen.findAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Open", "Open"]);
    expect(screen.getByRole("button", { name: "Open IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Other" })).toBeInTheDocument();
  });

  it("SCRUM379_AC7_the_Open_button_goes_to_the_events_own_link", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item({
      id: `${SECOND_ID}:NOT_CONFIRMED:0`, eventRequestId: SECOND_ID, link: `/event-requests/${SECOND_ID}`, eventName: "Other", reason: "Not confirmed; cancel",
    })]);
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<CoordinatorAttentionList />} />
          <Route path="/event-requests/:id" element={<p>Event page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Open Other" }));

    expect(await screen.findByText("Event page")).toBeInTheDocument();
  });

  it("SCRUM379_AC7_the_event_name_links_to_the_event_by_the_servers_link", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item()]);
    renderList();

    expect(await screen.findByRole("link", { name: "IS212 Industry Night" })).toHaveAttribute("href", `/event-requests/${EVENT_ID}`);
  });

  it("SCRUM379_AC7_the_heading_carries_the_number_of_items", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item(), item({ id: `${SECOND_ID}:NOT_CONFIRMED:0`, eventRequestId: SECOND_ID, link: `/event-requests/${SECOND_ID}`, eventName: "Other", reason: "Not confirmed; cancel" })]);
    renderList();

    expect(await screen.findByRole("heading", { level: 2, name: /^Needs attention\s*\(2\)$/ })).toBeInTheDocument();
  });

  it("SCRUM379_AC7_the_heading_has_no_count_when_there_is_nothing", async () => {
    renderList();
    await screen.findByText("Nothing needs your attention right now.");

    expect(screen.getByRole("heading", { level: 2, name: "Needs attention" })).toBeInTheDocument();
  });

  it("SCRUM379_AC7_items_keep_the_order_the_server_gave", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([
      item({ eventName: "First" }),
      item({ id: `${SECOND_ID}:CLARIFICATION_OVERDUE:0`, eventRequestId: SECOND_ID, link: `/event-requests/${SECOND_ID}`, eventName: "Second", reason: "Clarification overdue: reply was due 2030-06-01" }),
      item({ id: `${EVENT_ID}:VENUE_NOT_READY:1`, eventName: "Third", reason: "No valid venue booking" }),
    ]);
    renderList();

    await screen.findByText("First");
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["First", "Second", "Third"]);
  });

  it("SCRUM379_AC7_an_event_with_two_reasons_has_two_rows_each_with_its_own_reason", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([
      item({ id: `${EVENT_ID}:VENUE_NOT_READY:0`, code: "VENUE_NOT_READY", reason: "No valid venue booking" }),
      item({ id: `${EVENT_ID}:EQUIPMENT_NOT_READY:1`, code: "EQUIPMENT_NOT_READY", reason: "Equipment request: Pending review" }),
    ]);
    renderList();

    await screen.findByText("No valid venue booking");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Equipment request: Pending review")).toBeInTheDocument();
  });

  it("SCRUM379_AC7_the_servers_wording_of_every_reason_is_shown_as_given", async () => {
    const reasons = [
      "Mark as completed",
      "Not confirmed; cancel",
      "Clarification overdue: reply was due 2030-06-01",
      "No valid venue booking",
      "Equipment request: Pending review",
      "Equipment flagged: Projector lost",
    ];
    vi.mocked(getNeedsAttention).mockResolvedValue(reasons.map((reason, i) => item({ id: `${EVENT_ID}:X:${i}`, reason })));
    renderList();

    for (const reason of reasons) expect(await screen.findByText(reason)).toBeInTheDocument();
  });

  it("SCRUM379_AC7_an_item_without_an_organiser_name_shows_no_organiser_line", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item({ organiserName: null })]);
    renderList();

    await screen.findByRole("link", { name: "IS212 Industry Night" });
    expect(screen.queryByText(/Organiser:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it("SCRUM379_AC7_an_item_with_no_times_says_so_instead_of_a_blank", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item({ proposedStart: null, proposedEnd: null, reason: "Not confirmed; cancel" })]);
    renderList();

    expect(await screen.findByText("Date not set")).toBeInTheDocument();
  });

  it("SCRUM379_AC7_a_time_late_in_the_evening_utc_is_the_next_morning_in_singapore", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue([item({ proposedStart: "2030-06-15T16:00:00Z", proposedEnd: "2030-06-15T18:00:00Z" })]);
    renderList();

    expect(await screen.findByText("2030-06-16 00:00 – 02:00 (Singapore time)")).toBeInTheDocument();
  });

  it("SCRUM379_AC7_a_non_array_answer_reads_as_an_empty_list", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValue({ unexpected: true });
    renderList();

    expect(await screen.findByText("Nothing needs your attention right now.")).toBeInTheDocument();
  });
});

describe("SCRUM379 Needs attention: failures", () => {
  it("SCRUM379_AC7_a_401_shows_the_session_message", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValue(refusal(401));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(SESSION_EXPIRED);
  });

  it("SCRUM379_AC7_a_403_says_only_coordinators_have_the_list", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValue(refusal(403));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Only Event Coordinators have a Needs attention list.");
  });

  it("SCRUM379_AC7_a_server_error_asks_to_try_again_and_does_not_claim_the_list_is_empty", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValue(refusal(500));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your Needs attention list could not be loaded. Please try again.");
    expect(screen.queryByText("Nothing needs your attention right now.")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC7_a_network_failure_is_the_same_message", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValue(new Error("Network Error"));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  });

  it("SCRUM379_AC7_a_successful_read_after_a_failure_clears_the_error", async () => {
    vi.mocked(getNeedsAttention).mockRejectedValueOnce(refusal(500));
    const { rerender } = renderList({ refreshKey: 0 });
    await screen.findByRole("alert");
    vi.mocked(getNeedsAttention).mockResolvedValue([item()]);

    rerender(<MemoryRouter><CoordinatorAttentionList refreshKey={1} /></MemoryRouter>);

    expect(await screen.findByRole("link", { name: "IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM379 Needs attention: reading again", () => {
  it("SCRUM379_AC7_a_new_refreshKey_reads_the_list_again_and_shows_the_new_answer", async () => {
    vi.mocked(getNeedsAttention).mockResolvedValueOnce([item()]);
    const { rerender } = renderList({ refreshKey: 0 });
    await screen.findByRole("link", { name: "IS212 Industry Night" });
    vi.mocked(getNeedsAttention).mockResolvedValue([]);

    rerender(<MemoryRouter><CoordinatorAttentionList refreshKey={1} /></MemoryRouter>);

    await screen.findByText("Nothing needs your attention right now.");
    expect(getNeedsAttention).toHaveBeenCalledTimes(2);
  });

  it("SCRUM379_AC7_the_same_refreshKey_does_not_read_again", async () => {
    const { rerender } = renderList({ refreshKey: 3 });
    await screen.findByText("Nothing needs your attention right now.");

    rerender(<MemoryRouter><CoordinatorAttentionList refreshKey={3} /></MemoryRouter>);

    expect(getNeedsAttention).toHaveBeenCalledTimes(1);
  });

  it("SCRUM379_AC7_coming_back_to_a_visible_tab_reads_the_list_again", async () => {
    renderList();
    await screen.findByText("Nothing needs your attention right now.");
    vi.mocked(getNeedsAttention).mockResolvedValue([item()]);

    setVisibility("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(await screen.findByRole("link", { name: "IS212 Industry Night" })).toBeInTheDocument();
    expect(getNeedsAttention).toHaveBeenCalledTimes(2);
  });

  it("SCRUM379_AC7_a_hidden_tab_does_not_read_the_list", async () => {
    renderList();
    await screen.findByText("Nothing needs your attention right now.");

    setVisibility("hidden");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(getNeedsAttention).toHaveBeenCalledTimes(1);
  });
});
