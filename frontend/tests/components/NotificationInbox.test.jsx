// NotificationInbox.test.jsx
//
// SCRUM-128 (part of SCRUM-17, AC3): "... each affected booking is flagged
// for review and its Event Coordinator is notified." This is the card where
// the Coordinator reads that notification and marks it read.
//
// The notification service is mocked, so nothing touches the network.
// Timezone-safe: every expected time is built with toLocaleString (or the
// module's own describeNotification) from fixtures that carry +08:00 offsets.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import NotificationInbox from "../../src/components/NotificationInbox.jsx";
import Navigation from "../../src/components/Navigation.jsx";
import { UnreadCountProvider } from "../../src/notifications/UnreadCountContext.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getUnreadCount,
  listNotifications,
  markNotificationRead,
} from "../../src/services/notificationService";
import { describeNotification } from "../../src/services/notificationDisplay";

vi.mock("../../src/services/notificationService", () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

// Only the SCRUM-172 cases below render under UnreadCountProvider, which reads
// the signed-in user; the inbox itself never calls useAuth.
vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

const PAYLOAD = {
  venueName: "Hall A",
  eventName: "Tech Talk",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
  reason: "maintenance",
  blockStartsAt: "2026-10-01T09:00:00+08:00",
  blockEndsAt: "2026-10-01T17:00:00+08:00",
};

function notification(overrides = {}) {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    type: "booking_flagged",
    bookingId: "a1b2c3d4-0000-4000-8000-000000000001",
    blockId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    payload: PAYLOAD,
    readAt: null,
    createdAt: "2026-09-26T11:00:00+08:00",
    ...overrides,
  };
}

const UNREAD = notification();
const UNREAD_2 = notification({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae8",
  payload: { ...PAYLOAD, eventName: "Career Fair" },
  createdAt: "2026-09-25T11:00:00+08:00",
});
const READ = notification({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae9",
  payload: { ...PAYLOAD, eventName: "Orientation" },
  readAt: "2026-09-24T12:00:00+08:00",
  createdAt: "2026-09-24T11:00:00+08:00",
});

const MARKED_AT = "2026-09-28T14:30:00+08:00";

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}

/** A promise the test settles by hand, to hold a request in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The <li> whose headline names this event. */
function rowFor(eventName) {
  return screen.getByText(`${eventName} at Hall A needs review`).closest("li");
}

function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.mocked(listNotifications).mockReset();
  vi.mocked(markNotificationRead).mockReset();
  vi.mocked(getUnreadCount).mockReset();
  vi.mocked(useAuth).mockReset();
  setVisibility("visible");
});

afterEach(() => {
  // Restore jsdom's own getter.
  delete document.visibilityState;
});


describe("SCRUM17_AC3 loading and empty states", () => {
  it("shows Loading... while the list is in flight", async () => {
    const pending = deferred();
    vi.mocked(listNotifications).mockReturnValue(pending.promise);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("You have no notifications.")).not.toBeInTheDocument();

    await act(async () => pending.resolve([]));
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_empty_inbox_says_so", async () => {
    vi.mocked(listNotifications).mockResolvedValue([]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications$/);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });
});


describe("SCRUM17_AC3 list errors", () => {
  it.each([
    [401, "Your session has expired. Please sign in again."],
    [500, "Notifications could not be loaded. Please try again."],
    [403, "Notifications could not be loaded. Please try again."],
    [503, "Notifications could not be loaded. Please try again."],
  ])("a %s shows its message as an alert", async (status, message) => {
    vi.mocked(listNotifications).mockRejectedValue(httpError(status));

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.queryByText("You have no notifications.")).not.toBeInTheDocument();
  });

  it("a network error with no response shows the generic message", async () => {
    vi.mocked(listNotifications).mockRejectedValue(new Error("Network Error"));

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Notifications could not be loaded. Please try again.",
    );
  });

  it("a later successful refetch clears the error", async () => {
    vi.mocked(listNotifications)
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByRole("alert");

    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByText("Tech Talk at Hall A needs review")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});


describe("SCRUM17_AC3 rows", () => {
  it("SCRUM17_AC3_unread_row_has_New_and_Mark_as_read", async () => {
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const row = (await screen.findByText("Tech Talk at Hall A needs review")).closest("li");
    expect(within(row).getByText("New")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeEnabled();
    expect(row).toHaveClass("notification-inbox__item--unread");
  });

  it("SCRUM17_AC3_read_row_has_neither", async () => {
    vi.mocked(listNotifications).mockResolvedValue([READ]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const row = (await screen.findByText("Orientation at Hall A needs review")).closest("li");
    expect(within(row).queryByText("New")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(row).toHaveClass("notification-inbox__item--read");
  });

  it("renders the headline and detail from describeNotification", async () => {
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const { headline, detail } = describeNotification(UNREAD);
    expect(await screen.findByText(headline)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("SCRUM17_AC3_createdAt_is_rendered_in_the_readers_locale", async () => {
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    await screen.findByText("Tech Talk at Hall A needs review");
    expect(
      screen.getByText(`Received ${new Date(UNREAD.createdAt).toLocaleString()}`),
    ).toBeInTheDocument();
  });

  it("a missing createdAt reads as unknown", async () => {
    vi.mocked(listNotifications).mockResolvedValue([notification({ createdAt: null })]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    expect(await screen.findByText("Received unknown")).toBeInTheDocument();
  });

  it("an unknown type still renders, with its button", async () => {
    vi.mocked(listNotifications).mockResolvedValue([notification({ type: "something_new" })]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const row = (await screen.findByText("New notification")).closest("li");
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeInTheDocument();
  });

  it("SCRUM484_AC8_coordinator_sees_the_setup_change_notification", async () => {
    // SCRUM-484 (AC8). The payload 034 writes; no blockId, since no block
    // caused it.
    const setupChange = notification({
      id: "7c9e6679-7425-40de-944b-e07fc1f90af0",
      type: "booking_flagged_setup_change",
      blockId: null,
      payload: {
        venueName: "Harbour Room",
        eventName: "Orientation",
        startsAt: "2026-11-02T10:00:00+08:00",
        endsAt: "2026-11-02T12:00:00+08:00",
        occupiedStartsAt: "2026-11-02T09:30:00+08:00",
        occupiedEndsAt: "2026-11-02T12:15:00+08:00",
        setupMinutes: 30,
        turnaroundMinutes: 15,
        reason: "The venue's setup or turnaround time changed.",
      },
    });
    vi.mocked(listNotifications).mockResolvedValue([setupChange, UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const { headline, detail } = describeNotification(setupChange);
    expect(headline).toBe("Orientation at Harbour Room needs review");
    const row = (await screen.findByText(headline)).closest("li");
    expect(within(row).getByText(detail)).toBeInTheDocument();
    expect(detail).toMatch(/^Setup or turnaround time changed\. It now occupies /);
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeInTheDocument();
    expect(screen.queryByText("New notification")).not.toBeInTheDocument();
    // The block notification beside it is unaffected.
    expect(screen.getByText("Tech Talk at Hall A needs review")).toBeInTheDocument();
  });

  it("SCRUM17_AC3_keeps_the_backend_order", async () => {
    // Deliberately not sorted by createdAt: the card must not re-sort.
    vi.mocked(listNotifications).mockResolvedValue([READ, UNREAD, UNREAD_2]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    await screen.findByText("Tech Talk at Hall A needs review");
    const headlines = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".notification-inbox__headline strong").textContent);
    expect(headlines).toEqual([
      "Orientation at Hall A needs review",
      "Tech Talk at Hall A needs review",
      "Career Fair at Hall A needs review",
    ]);
  });
});


describe("SCRUM17_AC3 the unread count", () => {
  it.each([
    [[UNREAD, UNREAD_2, READ], "Notifications (2 unread)"],
    [[UNREAD, READ], "Notifications (1 unread)"],
    [[READ], "Notifications"],
  ])("heading reads correctly (%#)", async (list, heading) => {
    vi.mocked(listNotifications).mockResolvedValue(list);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    await screen.findAllByRole("listitem");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(new RegExp(`^${heading.replace(/[()]/g, "\\$&")}$`));
  });

  it("shows no count before the list has loaded", () => {
    vi.mocked(listNotifications).mockReturnValue(new Promise(() => {}));

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications$/);
  });
});


describe("SCRUM17_AC3 marking a notification read", () => {
  it("shows Marking... disabled while the request is in flight", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockReturnValue(pending.promise);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    const button = screen.getByRole("button", { name: "Marking..." });
    expect(button).toBeDisabled();
    expect(markNotificationRead).toHaveBeenCalledWith(UNREAD.id);
    // Not optimistic: still unread until the server answers.
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("(1 unread)");

    await act(async () => pending.resolve({ ...UNREAD, readAt: MARKED_AT }));
  });

  it("SCRUM17_AC3_success_replaces_the_row_without_a_refetch", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2]);
    vi.mocked(markNotificationRead).mockResolvedValue({ ...UNREAD, readAt: MARKED_AT });

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("Tech Talk at Hall A needs review");
    await user.click(within(rowFor("Tech Talk")).getByRole("button", { name: "Mark as read" }));

    await waitFor(() =>
      expect(within(rowFor("Tech Talk")).queryByRole("button")).not.toBeInTheDocument(),
    );
    expect(within(rowFor("Tech Talk")).queryByText("New")).not.toBeInTheDocument();
    expect(rowFor("Tech Talk")).toHaveClass("notification-inbox__item--read");
    // The other row is untouched.
    expect(within(rowFor("Career Fair")).getByRole("button", { name: "Mark as read" })).toBeEnabled();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("(1 unread)");
    expect(listNotifications).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("marking the last unread one removes the count", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockResolvedValue({ ...UNREAD, readAt: MARKED_AT });

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications$/),
    );
  });

  it("marking one row does not disable another", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2]);
    vi.mocked(markNotificationRead).mockReturnValue(new Promise(() => {}));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("Tech Talk at Hall A needs review");
    await user.click(within(rowFor("Tech Talk")).getByRole("button", { name: "Mark as read" }));

    expect(within(rowFor("Tech Talk")).getByRole("button", { name: "Marking..." })).toBeDisabled();
    expect(within(rowFor("Career Fair")).getByRole("button", { name: "Mark as read" })).toBeEnabled();
  });

  it("SCRUM17_AC3_a_500_shows_an_inline_error_and_re_enables_the_button", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(500));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    const row = rowFor("Tech Talk");
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "This notification could not be marked as read. Please try again.",
    );
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeEnabled();
    expect(within(row).getByText("New")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("a 401 says the session expired and does not refetch", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(401));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your session has expired. Please sign in again.",
    );
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("a network error with no response shows the generic row message", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(new Error("Network Error"));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This notification could not be marked as read. Please try again.",
    );
  });

  it("a retry clears the previous row error, and success keeps it cleared", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead)
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ ...UNREAD, readAt: MARKED_AT });

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Mark as read" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("an error on one row does not appear on another", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(500));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("Tech Talk at Hall A needs review");
    await user.click(within(rowFor("Tech Talk")).getByRole("button", { name: "Mark as read" }));

    await within(rowFor("Tech Talk")).findByRole("alert");
    expect(within(rowFor("Career Fair")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC3_a_404_shows_its_message_and_refetches", async () => {
    const user = userEvent.setup();
    // The refetch still returns the row, so its message stays visible.
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(404));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This notification is no longer available.",
    );
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
  });

  it("a 404 refetch that no longer lists the row removes it", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce([UNREAD, UNREAD_2])
      .mockResolvedValueOnce([UNREAD_2]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(404));

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("Tech Talk at Hall A needs review");
    await user.click(within(rowFor("Tech Talk")).getByRole("button", { name: "Mark as read" }));

    await waitFor(() =>
      expect(screen.queryByText("Tech Talk at Hall A needs review")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Career Fair at Hall A needs review")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("(1 unread)");
  });
});


describe("SCRUM17_AC3 refetching when the Coordinator returns", () => {
  it("refetches on window focus", async () => {
    vi.mocked(listNotifications).mockResolvedValueOnce([]).mockResolvedValueOnce([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("You have no notifications.");

    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByText("Tech Talk at Hall A needs review")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });

  it("refetches when the tab becomes visible", async () => {
    vi.mocked(listNotifications).mockResolvedValue([]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("You have no notifications.");

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
  });

  it("does not refetch while the tab is hidden", async () => {
    vi.mocked(listNotifications).mockResolvedValue([]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("You have no notifications.");

    setVisibility("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("SCRUM17_AC3_removes_its_listeners_on_unmount", async () => {
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeDocument = vi.spyOn(document, "removeEventListener");
    vi.mocked(listNotifications).mockResolvedValue([]);

    const { unmount } = render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("You have no notifications.");
    unmount();

    expect(removeWindow).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(listNotifications).toHaveBeenCalledTimes(1);

    removeWindow.mockRestore();
    removeDocument.mockRestore();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-172 AC4: the shared, exact unread count
// ---------------------------------------------------------------------------

const ATTENDEE = { id: "u1", name: "Test User", role: "attendee" };

/** The inbox (and optionally the nav) under the real provider, as App.jsx mounts them. */
function renderWithCount(ui, { initialEntries = ["/dashboard"] } = {}) {
  vi.mocked(useAuth).mockReturnValue({ user: ATTENDEE, logout: vi.fn() });
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <UnreadCountProvider>{ui}</UnreadCountProvider>
    </MemoryRouter>,
  );
}

describe("SCRUM172_AC4 the heading's count", () => {
  it("SCRUM172_AC4_heading_uses_the_exact_server_count", async () => {
    // The list is capped at 50, so counting it would say 50; the server says 73.
    const fifty = Array.from({ length: 50 }, (_, i) =>
      notification({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    vi.mocked(listNotifications).mockResolvedValue(fifty);
    vi.mocked(getUnreadCount).mockResolvedValue(73);

    renderWithCount(<NotificationInbox />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications \(73 unread\)$/),
    );
  });

  it("SCRUM172_AC4_heading_shows_no_count_when_the_server_says_zero", async () => {
    // A stale unread row in the list must not outvote the server's 0.
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(getUnreadCount).mockResolvedValue(0);

    renderWithCount(<NotificationInbox />);
    await screen.findByText("Tech Talk at Hall A needs review");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications$/),
    );
  });

  it("SCRUM172_AC4_heading_falls_back_to_the_list_when_the_count_is_unknown", async () => {
    // The count read failed, so the provider holds null: the list's own count stands in.
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2, READ]);
    vi.mocked(getUnreadCount).mockRejectedValue(httpError(500));

    renderWithCount(<NotificationInbox />);
    await screen.findAllByRole("listitem");

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications \(2 unread\)$/);
  });

  it("SCRUM172_AC4_a_successful_list_read_refreshes_the_count", async () => {
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    renderWithCount(<NotificationInbox />);
    await screen.findByText("Tech Talk at Hall A needs review");

    // Once on the provider's mount, once after the list arrived.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(2));
  });

  it("SCRUM172_AC4_a_failed_list_read_does_not_refresh_the_count", async () => {
    vi.mocked(listNotifications).mockRejectedValue(httpError(500));
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    renderWithCount(<NotificationInbox />);
    await screen.findByRole("alert");

    expect(getUnreadCount).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM172_AC5 marking read updates the shared count", () => {
  it("SCRUM172_AC4_marking_read_refreshes_the_shared_count", async () => {
    // The nav badge and the heading read one number, so both drop together.
    const user = userEvent.setup();
    let serverCount = 2;
    vi.mocked(getUnreadCount).mockImplementation(async () => serverCount);
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2]);
    vi.mocked(markNotificationRead).mockImplementation(async (id) => {
      serverCount -= 1;
      return { ...(id === UNREAD.id ? UNREAD : UNREAD_2), readAt: MARKED_AT };
    });

    renderWithCount(
      <>
        <Navigation />
        <NotificationInbox />
      </>,
    );

    expect(await screen.findByRole("link", { name: "Notifications, 2 unread" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("(2 unread)");

    await user.click(within(rowFor("Tech Talk")).getByRole("button", { name: "Mark as read" }));

    expect(await screen.findByRole("link", { name: "Notifications, 1 unread" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications \(1 unread\)$/);
  });

  it("SCRUM172_AC5_a_failed_mark_leaves_the_shared_count_alone", async () => {
    const user = userEvent.setup();
    vi.mocked(getUnreadCount).mockResolvedValue(1);
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(500));

    renderWithCount(<NotificationInbox />);
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));
    await screen.findByRole("alert");

    expect(getUnreadCount).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("(1 unread)");
  });
});

describe("SCRUM172_AC4 the nav link lands on the inbox", () => {
  let scrollIntoView;
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.mocked(listNotifications).mockResolvedValue([]);
  });

  afterEach(() => {
    if (original === undefined) delete Element.prototype.scrollIntoView;
    else Element.prototype.scrollIntoView = original;
  });

  it("SCRUM172_AC4_scrolls_to_the_inbox_on_the_notifications_hash", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard#notifications"]}>
        <NotificationInbox />
      </MemoryRouter>,
    );
    await screen.findByText("You have no notifications.");

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const section = scrollIntoView.mock.contexts[0];
    expect(section).toHaveAttribute("id", "notifications");
  });

  it("SCRUM172_AC4_does_not_scroll_without_the_hash", async () => {
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <NotificationInbox />
      </MemoryRouter>,
    );
    await screen.findByText("You have no notifications.");

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("SCRUM172_AC4_clicking_the_nav_link_on_the_dashboard_scrolls_to_the_inbox", async () => {
    const user = userEvent.setup();
    vi.mocked(getUnreadCount).mockResolvedValue(0);

    renderWithCount(
      <>
        <Navigation />
        <NotificationInbox />
      </>,
    );
    await screen.findByText("You have no notifications.");
    expect(scrollIntoView).not.toHaveBeenCalled();

    await user.click(screen.getByRole("link", { name: "Notifications" }));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it("SCRUM172_AC4_renders_where_scrollIntoView_does_not_exist", async () => {
    delete Element.prototype.scrollIntoView;

    render(
      <MemoryRouter initialEntries={["/dashboard#notifications"]}>
        <NotificationInbox />
      </MemoryRouter>,
    );

    expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
  });
});
