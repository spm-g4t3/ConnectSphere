// scrum589AttendeeStates.test.jsx
//
// The UI standard's shared states on the Attendee screens: Loading..., the
// error notice and its Try again, empty states with a next step, the standard
// date format, and ConfirmDialog for withdrawing and leaving a waiting list.
// Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import RegisteredEvents from "../../src/components/RegisteredEvents.jsx";
import BrowseOpenEvents from "../../src/components/BrowseOpenEvents.jsx";
import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import AttendeeEventInformation from "../../src/components/AttendeeEventInformation.jsx";
import {
  getAttendeeEvent,
  getRegisteredEvents,
  getWaitlist,
  leaveWaitlist,
  withdrawRegistration,
} from "../../src/services/attendeeEventService";
import { getOpenEvent, getOpenEvents } from "../../src/services/openEventService";
import { deferred, httpError } from "../helpers/async.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/services/attendeeEventService", () => ({
  getAttendeeEvent: vi.fn(),
  getRegisteredEvents: vi.fn(),
  getWaitlist: vi.fn(),
  leaveWaitlist: vi.fn(),
  withdrawRegistration: vi.fn(),
}));
vi.mock("../../src/services/openEventService", () => ({ getOpenEvent: vi.fn(), getOpenEvents: vi.fn() }));


const openEvent = (overrides = {}) => ({
  id: "e1", eventName: "Open Day", description: "Come along.",
  startsAt: "2026-10-25T01:00:00.000Z", endsAt: "2026-10-25T03:30:00.000Z",
  capacity: 50, placesLeft: 12, isFull: false, isRegistered: false, canRegister: true,
  canJoinWaitlist: false, waitlistPosition: null, ...overrides,
});
const attendeeEvent = (overrides = {}) => ({
  eventRequestId: "e1", registrationId: "r1", state: "confirmed", eventName: "Open Day",
  startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
  venues: [{ bookingId: "b1", name: "Hall A", location: "Building A" }],
  ...overrides,
});
const waitlistPlace = { registrationId: "w1", eventRequestId: "e2", eventName: "Gala", waitlistPosition: 2 };

function renderRegistered() {
  return render(<RegisteredEvents />, { wrapper: MemoryRouter });
}
function renderBrowse() {
  return render(<BrowseOpenEvents />, { wrapper: MemoryRouter });
}
function renderDetails() {
  return render(
    <MemoryRouter initialEntries={["/open-events/e1"]}>
      <Routes>
        <Route path="/open-events/:eventId" element={<BrowseEventDetails onRegister={vi.fn()} />} />
      </Routes>
    </MemoryRouter>,
  );
}
function renderEventInformation() {
  return render(
    <MemoryRouter initialEntries={["/registered-events/e1"]}>
      <Routes><Route path="/registered-events/:eventId" element={<AttendeeEventInformation />} /></Routes>
    </MemoryRouter>,
  );
}

// Each read the attendee screens make, with what a successful answer shows.
const READS = [
  ["registered events", getRegisteredEvents, renderRegistered,
    [{ eventRequestId: "e1", eventName: "Registered event" }], () => screen.findByRole("link", { name: "Registered event" })],
  ["waiting lists", getWaitlist, renderRegistered, [waitlistPlace], () => screen.findByText("Gala")],
  ["open events", getOpenEvents, renderBrowse, [openEvent()], () => screen.findByRole("link", { name: "Open Day" })],
  ["event details", getOpenEvent, renderDetails, openEvent(), () => screen.findByRole("heading", { name: "Open Day", level: 1 })],
  ["registered event information", getAttendeeEvent, renderEventInformation, attendeeEvent(), () => screen.findByText("Hall A")],
];

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRegisteredEvents).mockResolvedValue([]);
  vi.mocked(getWaitlist).mockResolvedValue([]);
  vi.mocked(getOpenEvents).mockResolvedValue([]);
  vi.mocked(getOpenEvent).mockResolvedValue(openEvent());
  vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent());
});

describe("SCRUM589 AC4 loading", () => {
  it("SCRUM589_AC4_registered_events_and_waiting_lists_each_show_exactly_loading", () => {
    vi.mocked(getRegisteredEvents).mockReturnValue(deferred().promise);
    vi.mocked(getWaitlist).mockReturnValue(deferred().promise);
    renderRegistered();

    expect(screen.getAllByRole("status").map(status => status.textContent)).toEqual(["Loading...", "Loading..."]);
  });

  it.each([
    ["open events", getOpenEvents, renderBrowse],
    ["event details", getOpenEvent, renderDetails],
    ["registered event information", getAttendeeEvent, renderEventInformation],
  ])("SCRUM589_AC4_%s_shows_exactly_loading", (_, read, renderScreen) => {
    vi.mocked(read).mockReturnValue(deferred().promise);
    renderScreen();

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });
});

describe("SCRUM589 AC4 errors", () => {
  it.each(READS)("SCRUM589_AC4_a_failed_%s_read_shows_the_error_notice_and_try_again_reads_again", async (_, read, renderScreen, answer, findLoaded) => {
    const user = userEvent.setup();
    vi.mocked(read).mockRejectedValueOnce(httpError(500)).mockResolvedValue(answer);
    renderScreen();

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveClass("ui-error-notice");
    await user.click(within(notice).getByRole("button", { name: "Try again" }));

    expect(await findLoaded()).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(READS.slice(0, 4))("SCRUM589_AC4_a_failed_refresh_of_%s_is_a_warning_with_try_again", async (_, read, renderScreen, answer, findLoaded) => {
    const user = userEvent.setup();
    vi.mocked(read).mockResolvedValue(answer);
    renderScreen();
    await findLoaded();

    vi.mocked(read).mockRejectedValueOnce(httpError(500));
    fireEvent.focus(window);

    const warning = (await screen.findByText(/as last loaded/)).closest("[role='status']");
    expect(warning).toHaveClass("browse-open-events__notice");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const retry = within(warning).getByRole("button", { name: "Try again" });
    expect(retry).toHaveClass("ui-button--secondary");
    await user.click(retry);
    await waitFor(() => expect(screen.queryByText(/as last loaded/)).not.toBeInTheDocument());
  });
});

describe("SCRUM589 AC4 empty states", () => {
  function expectEmptyState(message, nextStep) {
    const box = screen.getByText(message).closest(".ui-empty-state");
    expect(box).not.toBeNull();
    expect(within(box).getByText(nextStep)).toBeInTheDocument();
    return box;
  }

  it("SCRUM589_AC4_no_registrations_says_what_to_do_and_links_to_browse_open_events", async () => {
    renderRegistered();

    await screen.findByText("You have no active event registrations.");
    const box = expectEmptyState("You have no active event registrations.",
      "Browse Open Events to find an event to register for.");
    expect(within(box).getByRole("link", { name: "Browse Open Events" })).toHaveAttribute("href", "/open-events");
  });

  it("SCRUM589_AC4_no_waiting_lists_says_how_to_join_one", async () => {
    renderRegistered();

    await screen.findByText("You are not on any waiting lists.");
    const box = expectEmptyState("You are not on any waiting lists.",
      "When an event is full, you can join its waiting list from the event's page.");
    expect(within(box).queryByRole("link")).not.toBeInTheDocument();
  });

  it("SCRUM589_AC4_no_open_events_says_to_check_back_later", async () => {
    renderBrowse();

    await screen.findByText("No events are currently open for registration.");
    expectEmptyState("No events are currently open for registration.", "Check back later for new events.");
  });

  it("SCRUM589_AC4_a_confirmed_event_with_no_venues_says_what_to_expect", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent({ venues: [] }));
    renderEventInformation();

    await screen.findByText("No confirmed venue information is available.");
    expectEmptyState("No confirmed venue information is available.",
      "Check back later; this page shows the venue once it is confirmed.");
  });
});

describe("SCRUM589 AC4 dates", () => {
  const whenFact = () => screen.getByText("When", { selector: "dt" }).nextElementSibling;

  it.each([
    ["event details", renderDetails, getOpenEvent, openEvent({ startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z" })],
    ["registered event information", renderEventInformation, getAttendeeEvent, attendeeEvent()],
  ])("SCRUM589_AC4_%s_shows_the_standard_date_and_time_with_one_singapore_note", async (_, renderScreen, read, answer) => {
    vi.mocked(read).mockResolvedValue(answer);
    renderScreen();

    await screen.findByText("When", { selector: "dt" });
    expect(whenFact()).toHaveTextContent(/^6 May 2030, 9:00 am – 11:00 am \(Singapore time\)$/);
    expect(document.body.textContent.match(/\(Singapore time\)/g)).toHaveLength(1);
  });

  it("SCRUM589_AC4_an_open_event_row_shows_the_standard_range_and_one_singapore_note", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([openEvent()]);
    renderBrowse();

    const row = (await screen.findByRole("link", { name: "Open Day" })).closest("li");
    expect(within(row).getByText("25 Oct 2026, 9:00 am – 11:30 am")).toBeInTheDocument();
    expect(row.textContent.match(/\(Singapore time\)/g)).toHaveLength(1);
    expect(row).not.toHaveTextContent(/2026-10-25|Starts|Ends/);
  });

  // 23:30 to 00:30 in Singapore: an end without its date would read as the same evening.
  const pastMidnight = { startsAt: "2026-10-25T15:30:00Z", endsAt: "2026-10-25T16:30:00Z" };

  it("SCRUM589_AC4_an_event_past_midnight_shows_both_dates_in_the_row_and_the_details", async () => {
    vi.mocked(getOpenEvents).mockResolvedValue([openEvent(pastMidnight)]);
    vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent(pastMidnight));
    const list = renderBrowse();

    const row = (await screen.findByRole("link", { name: "Open Day" })).closest("li");
    expect(row).toHaveTextContent("25 Oct 2026, 11:30 pm – 26 Oct 2026, 12:30 am");
    list.unmount();

    renderEventInformation();
    await screen.findByText("When", { selector: "dt" });
    expect(whenFact()).toHaveTextContent("25 Oct 2026, 11:30 pm – 26 Oct 2026, 12:30 am (Singapore time)");
  });
});

describe("SCRUM589 AC3 confirmations use ConfirmDialog", () => {
  it("SCRUM589_AC3_withdraw_registration_asks_in_a_confirm_dialog", async () => {
    const user = userEvent.setup();
    renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));

    const dialog = screen.getByRole("dialog", { name: "Withdraw your registration?" });
    expect(dialog).toHaveTextContent("Your place will be released to other attendees.");
    expect(within(dialog).getByRole("button", { name: "Confirm withdrawal" })).toHaveClass("ui-button--danger");
    expect(within(dialog).getByRole("button", { name: "Keep my registration" })).toHaveClass("ui-button--secondary");
    // Focus starts on keeping, so a stray Enter never withdraws.
    expect(within(dialog).getByRole("button", { name: "Keep my registration" })).toHaveFocus();
  });

  it("SCRUM589_AC3_leave_waiting_list_asks_in_a_confirm_dialog", async () => {
    const user = userEvent.setup();
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();

    await user.click(await screen.findByRole("button", { name: "Leave waiting list" }));

    const dialog = screen.getByRole("dialog", { name: "Leave the waiting list?" });
    expect(dialog).toHaveTextContent("You will lose your place in the queue.");
    expect(within(dialog).getByRole("button", { name: "Confirm leaving" })).toHaveClass("ui-button--danger");
    expect(within(dialog).getByRole("button", { name: "Keep my place" })).toHaveClass("ui-button--secondary");
  });
});

describe("SCRUM589 AC9 the dialogs do what the inline confirms did", () => {
  it("SCRUM589_AC9_keeping_the_registration_closes_the_dialog_and_sends_nothing", async () => {
    const user = userEvent.setup();
    renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    await user.click(screen.getByRole("button", { name: "Keep my registration" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(withdrawRegistration).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toBeInTheDocument();
  });

  it("SCRUM589_AC9_confirming_withdrawal_sends_once_however_often_clicked", async () => {
    const user = userEvent.setup();
    const reply = deferred();
    vi.mocked(withdrawRegistration).mockReturnValue(reply.promise);
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(attendeeEvent())
      .mockRejectedValue(httpError(404, { error: "Event information not found" }));
    renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    const confirm = screen.getByRole("button", { name: "Confirm withdrawal" });
    await user.click(confirm);
    await user.click(confirm);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdrawing..." })).toBeDisabled();

    await act(async () => reply.resolve({ registrationId: "r1", status: "withdrawn" }));
    expect(await screen.findByText("Your registration has been withdrawn.")).toBeInTheDocument();
    expect(withdrawRegistration).toHaveBeenCalledExactlyOnceWith("r1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("SCRUM589_AC9_keeping_the_place_closes_the_dialog_and_sends_nothing", async () => {
    const user = userEvent.setup();
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();

    await user.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    await user.click(screen.getByRole("button", { name: "Keep my place" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(leaveWaitlist).not.toHaveBeenCalled();
    expect(screen.getByText("Gala")).toBeInTheDocument();
  });

  it("SCRUM589_AC9_confirming_leaving_sends_once_and_closes_the_dialog", async () => {
    const user = userEvent.setup();
    const reply = deferred();
    vi.mocked(leaveWaitlist).mockReturnValue(reply.promise);
    vi.mocked(getWaitlist).mockResolvedValueOnce([waitlistPlace]).mockResolvedValue([]);
    renderRegistered();

    await user.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    const confirm = screen.getByRole("button", { name: "Confirm leaving" });
    await user.click(confirm);
    await user.click(confirm);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Leaving..." })).toBeDisabled();

    await act(async () => reply.resolve({}));
    expect(await screen.findByText("You have left the waiting list for Gala.")).toBeInTheDocument();
    expect(leaveWaitlist).toHaveBeenCalledExactlyOnceWith("w1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("SCRUM589_AC9_a_failed_leave_closes_the_dialog_and_keeps_the_place_with_its_action", async () => {
    const user = userEvent.setup();
    vi.mocked(leaveWaitlist).mockRejectedValue(httpError(500));
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();

    await user.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    await user.click(screen.getByRole("button", { name: "Confirm leaving" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You are still on it");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave waiting list" })).toBeEnabled();
  });
});
