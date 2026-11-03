// scrum589AttendeeKeyboard.test.jsx
//
// The Attendee screens from the keyboard alone: Tab reaches each control in
// page order, the dialogs work with Enter and Escape, and focus lands on what
// reports an outcome instead of dropping to the page body. Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import RegisteredEvents from "../../src/components/RegisteredEvents.jsx";
import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import AttendeeEventInformation from "../../src/components/AttendeeEventInformation.jsx";
import BrowseOpenEvents from "../../src/components/BrowseOpenEvents.jsx";
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
function renderDetails({ onRegister = vi.fn(), onJoinWaitlist, before = null } = {}) {
  return render(
    <MemoryRouter initialEntries={["/open-events/e1"]}>
      {before}
      <Routes>
        <Route
          path="/open-events/:eventId"
          element={<BrowseEventDetails onRegister={onRegister} onJoinWaitlist={onJoinWaitlist} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}
function renderBrowse() {
  return render(<BrowseOpenEvents />, { wrapper: MemoryRouter });
}
function renderEventInformation() {
  return render(
    <MemoryRouter initialEntries={["/registered-events/e1"]}>
      <Routes><Route path="/registered-events/:eventId" element={<AttendeeEventInformation />} /></Routes>
    </MemoryRouter>,
  );
}

// jsdom does not turn Escape into the dialog's cancel event, so it is sent directly.
function pressEscape(dialog) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

// Browsers drop focus from a button once it is disabled or removed; jsdom keeps
// it on a disabled one, so the blur stands in for that while a request runs.
function blurWhileSending(result) {
  return async () => {
    document.activeElement.blur();
    return result();
  };
}

async function tabThrough(user, count) {
  const reached = [];
  for (let step = 0; step < count; step += 1) {
    await user.tab();
    reached.push(document.activeElement);
  }
  return reached;
}

stubDialogElement();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getRegisteredEvents).mockResolvedValue([]);
  vi.mocked(getWaitlist).mockResolvedValue([]);
  vi.mocked(getOpenEvent).mockResolvedValue(openEvent());
  vi.mocked(getOpenEvents).mockResolvedValue([]);
  vi.mocked(getAttendeeEvent).mockResolvedValue(attendeeEvent());
});

describe("SCRUM589 AC7 Tab reaches every control in page order", () => {
  it("SCRUM589_AC7_tab_reaches_register_then_the_back_link_on_the_event_details", async () => {
    const user = userEvent.setup();
    renderDetails();
    await screen.findByRole("heading", { level: 1, name: "Open Day" });

    const reached = await tabThrough(user, 2);

    expect(reached).toEqual([
      screen.getByRole("button", { name: "Register" }),
      screen.getByRole("link", { name: "Back to open events" }),
    ]);
  });

  it("SCRUM589_AC7_tab_reaches_each_registered_event_then_each_leave_button", async () => {
    const user = userEvent.setup();
    vi.mocked(getRegisteredEvents).mockResolvedValue([
      { eventRequestId: "e1", eventName: "Open Day" },
      { eventRequestId: "e3", eventName: "Careers Fair" },
    ]);
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();
    await screen.findByText("Gala");

    const reached = await tabThrough(user, 3);

    expect(reached).toEqual([
      screen.getByRole("link", { name: "Open Day" }),
      screen.getByRole("link", { name: "Careers Fair" }),
      screen.getByRole("button", { name: "Leave waiting list" }),
    ]);
  });

  it("SCRUM589_AC7_tab_reaches_try_again_when_the_registered_list_fails", async () => {
    const user = userEvent.setup();
    vi.mocked(getRegisteredEvents).mockRejectedValue(httpError(500));
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();
    const alert = await screen.findByRole("alert");
    await screen.findByText("Gala");

    const reached = await tabThrough(user, 2);

    expect(reached).toEqual([
      within(alert).getByRole("button", { name: "Try again" }),
      screen.getByRole("button", { name: "Leave waiting list" }),
    ]);
  });
});

describe("SCRUM589 AC7 the dialogs work from the keyboard", () => {
  it("SCRUM589_AC7_withdrawing_with_the_keyboard_alone_moves_focus_to_the_withdrawn_notice", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockImplementation(
      blurWhileSending(() => ({ registrationId: "r1", status: "withdrawn" })),
    );
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(attendeeEvent())
      .mockRejectedValue(httpError(404, { error: "Event information not found" }));
    renderEventInformation();
    await screen.findByText("Hall A");

    await user.tab();
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Withdraw your registration?" });
    expect(within(dialog).getByRole("button", { name: "Keep my registration" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Confirm withdrawal" })).toHaveFocus();
    await user.keyboard("{Enter}");

    const notice = await screen.findByText("Your registration has been withdrawn.");
    expect(withdrawRegistration).toHaveBeenCalledExactlyOnceWith("r1");
    expect(notice.closest("[role='status']")).toHaveFocus();
  });

  it("SCRUM589_AC7_escape_closes_the_withdraw_dialog_and_returns_focus_to_withdraw", async () => {
    const user = userEvent.setup();
    renderEventInformation();
    await screen.findByText("Hall A");

    await user.tab();
    await user.keyboard("{Enter}");
    pressEscape(screen.getByRole("dialog"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(withdrawRegistration).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toHaveFocus();
  });

  it("SCRUM589_AC7_leaving_with_the_keyboard_alone_moves_focus_to_the_left_notice", async () => {
    const user = userEvent.setup();
    vi.mocked(leaveWaitlist).mockImplementation(blurWhileSending(() => ({})));
    vi.mocked(getWaitlist).mockResolvedValueOnce([waitlistPlace]).mockResolvedValue([]);
    renderRegistered();
    await screen.findByText("Gala");

    // Past the empty registered list's Browse Open Events link.
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Leave waiting list" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Leave the waiting list?" });
    expect(within(dialog).getByRole("button", { name: "Keep my place" })).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");

    const notice = await screen.findByText("You have left the waiting list for Gala.");
    expect(leaveWaitlist).toHaveBeenCalledExactlyOnceWith("w1");
    expect(notice).toHaveFocus();
  });

  it("SCRUM589_AC7_escape_closes_the_leave_dialog_and_returns_focus_to_leave", async () => {
    const user = userEvent.setup();
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();
    await screen.findByText("Gala");

    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    pressEscape(screen.getByRole("dialog"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(leaveWaitlist).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Leave waiting list" })).toHaveFocus();
  });
});

describe("SCRUM589 AC7 focus follows a failed action", () => {
  it("SCRUM589_AC7_a_failed_leave_returns_focus_to_leave_waiting_list", async () => {
    const user = userEvent.setup();
    vi.mocked(leaveWaitlist).mockImplementation(blurWhileSending(() => { throw httpError(500); }));
    vi.mocked(getWaitlist).mockResolvedValue([waitlistPlace]);
    renderRegistered();

    await user.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    await user.click(screen.getByRole("button", { name: "Confirm leaving" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You are still on it");
    expect(screen.getByRole("button", { name: "Leave waiting list" })).toHaveFocus();
  });

  it.each([
    ["a failure that may pass", httpError(500), /could not be withdrawn/],
    ["a final refusal", httpError(409, { code: "WITHDRAWAL_DEADLINE_PASSED" }), /deadline for this event has passed/],
  ])("SCRUM589_AC7_a_failed_withdrawal_moves_focus_to_its_error_notice (%s)", async (_name, error, text) => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockImplementation(blurWhileSending(() => { throw error; }));
    renderEventInformation();

    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(alert.parentElement).toHaveFocus();
  });

  it("SCRUM589_AC7_a_refusal_shown_again_after_a_reload_does_not_take_focus", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValue(httpError(409, { code: "WITHDRAWAL_DEADLINE_PASSED" }));
    renderEventInformation();
    await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    await screen.findByRole("alert");
    document.activeElement.blur();

    // Returning to the tab reloads the event, which remounts the refusal.
    fireEvent.focus(window);
    await screen.findByText("Hall A");

    expect(screen.getByRole("alert")).toHaveTextContent(/deadline for this event has passed/);
    expect(document.body).toHaveFocus();
  });
});

describe("SCRUM589 AC7 focus follows a registration or waiting-list attempt", () => {
  it.each([
    ["registered", () => Promise.resolve({}), "You are registered for Open Day."],
    ["refused", () => Promise.reject(httpError(409, { code: "REGISTRATION_CLOSED" })), "Registration has closed for this event."],
  ])("SCRUM589_AC7_registering_moves_focus_to_the_outcome (%s)", async (_name, reply, text) => {
    const user = userEvent.setup();
    const onRegister = vi.fn(blurWhileSending(reply));
    renderDetails({ onRegister });

    await user.click(await screen.findByRole("button", { name: "Register" }));

    const outcome = await screen.findByText(text);
    expect(outcome.closest("[tabindex='-1']")).toHaveFocus();
  });

  it.each([
    ["joined", () => Promise.resolve({ status: "waitlisted", waitlistPosition: 3 }), "You are on the waiting list for Open Day at position 3."],
    ["refused", () => Promise.reject(httpError(409, { code: "WAITLIST_DISABLED" })), "This event is full and does not have a waiting list."],
  ])("SCRUM589_AC7_joining_the_waiting_list_moves_focus_to_the_outcome (%s)", async (_name, reply, text) => {
    const user = userEvent.setup();
    vi.mocked(getOpenEvent).mockResolvedValue(openEvent({ isFull: true, placesLeft: 0, canJoinWaitlist: true }));
    const onJoinWaitlist = vi.fn(blurWhileSending(reply));
    renderDetails({ onJoinWaitlist });

    await user.click(await screen.findByRole("button", { name: "Join waiting list" }));

    const outcome = await screen.findByText(text);
    expect(outcome.closest("[tabindex='-1']")).toHaveFocus();
  });

  it("SCRUM589_AC7_a_join_that_finishes_after_moving_to_another_event_leaves_focus_alone", async () => {
    const user = userEvent.setup();
    const reload = deferred();
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(openEvent({ isFull: true, placesLeft: 0, canJoinWaitlist: true }))
      .mockReturnValueOnce(reload.promise)
      .mockRejectedValueOnce(httpError(404));
    renderDetails({
      onJoinWaitlist: vi.fn().mockResolvedValue({ status: "waitlisted", waitlistPosition: 1 }),
      before: <Link to="/open-events/e2">Go to another event</Link>,
    });

    await user.click(await screen.findByRole("button", { name: "Join waiting list" }));
    await user.click(screen.getByRole("link", { name: "Go to another event" }));
    await screen.findByText("This event is not open for registration.");
    await act(async () => reload.resolve(openEvent({ waitlistPosition: 1 })));

    // The not-open notice belongs to the event now shown, not to this attempt.
    expect(screen.getByRole("link", { name: "Go to another event" })).toHaveFocus();
  });
});

// Each screen with a page-level Try again: what fails first, how to show it,
// and the heading that should take focus once the retry has finished.
const retryScreens = [
  ["the registered list", () => getRegisteredEvents, renderRegistered, 2, "Registered"],
  ["the waiting lists", () => getWaitlist, renderRegistered, 2, "Waiting lists"],
  ["the open events list", () => getOpenEvents, renderBrowse, 2, "Events open for registration"],
  ["the event details", () => getOpenEvent, () => renderDetails(), 2, "Event details"],
  ["the event information", () => getAttendeeEvent, renderEventInformation, 1, "Open Day"],
];

describe("SCRUM589 AC7 focus after a page-level Try again", () => {
  it.each(retryScreens)(
    "SCRUM589_AC7_try_again_after_a_load_error_moves_focus_to_the_heading (%s)",
    async (_name, service, renderScreen, level, heading) => {
      const user = userEvent.setup();
      vi.mocked(service()).mockRejectedValueOnce(httpError(500));
      renderScreen();

      await user.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }));

      expect(await screen.findByRole("heading", { level, name: heading })).toHaveFocus();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each(retryScreens)(
    "SCRUM589_AC7_a_first_load_leaves_focus_on_the_page (%s)",
    async (_name, _service, renderScreen, level, heading) => {
      renderScreen();

      const target = await screen.findByRole("heading", { level, name: heading });
      await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());

      expect(target).not.toHaveFocus();
      expect(document.body).toHaveFocus();
    },
  );

  it("SCRUM589_AC7_try_again_on_the_refresh_notice_moves_focus_to_the_heading", async () => {
    const user = userEvent.setup();
    vi.mocked(getRegisteredEvents).mockResolvedValueOnce([{ eventRequestId: "e1", eventName: "Open Day" }])
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue([{ eventRequestId: "e1", eventName: "Open Day" }]);
    renderRegistered();
    await screen.findByRole("link", { name: "Open Day" });

    // Returning to the tab refreshes in the background; this one fails.
    fireEvent.focus(window);
    const notice = await screen.findByText(/Could not refresh the list/);
    await user.click(within(notice.parentElement).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByText(/Could not refresh the list/)).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 2, name: "Registered" })).toHaveFocus();
  });
});
