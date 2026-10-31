// NotificationInbox.test.jsx
//
// SCRUM-128 (part of SCRUM-17, AC3): "... each affected booking is flagged
// for review and its Event Coordinator is notified." This is the card where
// the Coordinator reads that notification and marks it read.
//
// The notification service is mocked, so nothing touches the network.
// Timezone-safe: every expected time is built as Singapore time with sgTime (or the
// module's own describeNotification) from fixtures that carry +08:00 offsets.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

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
import { deferred, httpError } from "../helpers/async.js";
import { setVisibility } from "../helpers/visibility.js";
import { PAYLOAD, SETUP_PAYLOAD } from "../fixtures/notifications.js";
import { sgTime } from "../helpers/singaporeTime.js";

vi.mock("../../src/services/notificationService", () => ({
  getUnreadCount: vi.fn(),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

// The inbox reads the signed-in user to link its rows, and the SCRUM-172 cases
// below also render under UnreadCountProvider, which reads it too.
vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

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

const ATTENDEE = { id: "u1", name: "Test User", role: "attendee" };

/** The <li> whose headline names this event. */
function rowFor(eventName) {
  return screen.getByText(`${eventName} at Hall A needs review`).closest("li");
}

/**
 * The inbox at /dashboard under the real provider, as App.jsx mounts it.
 * `nav` adds the nav bar beside it; `routes` adds pages a link can land on.
 */
function renderInbox({ user = ATTENDEE, entries = ["/dashboard"], nav = false, routes = null } = {}) {
  vi.mocked(useAuth).mockReturnValue({ user, logout: vi.fn() });
  return render(
    <MemoryRouter initialEntries={entries}>
      <UnreadCountProvider>
        {nav && <Navigation />}
        <Routes>
          <Route path="/dashboard" element={<NotificationInbox />} />
          {routes}
        </Routes>
      </UnreadCountProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(listNotifications).mockReset();
  vi.mocked(markNotificationRead).mockReset();
  vi.mocked(getUnreadCount).mockReset();
  vi.mocked(useAuth).mockReset();
  // No user, no links: the rows render as they did before AC7.
  vi.mocked(useAuth).mockReturnValue({ user: null });
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
    ["a 401", httpError(401), "Your session has expired. Please sign in again."],
    ["a 500", httpError(500), "Notifications could not be loaded. Please try again."],
    ["a 403", httpError(403), "Notifications could not be loaded. Please try again."],
    ["a 503", httpError(503), "Notifications could not be loaded. Please try again."],
    ["a network error with no response", new Error("Network Error"), "Notifications could not be loaded. Please try again."],
  ])("%s shows its message as an alert", async (_label, error, message) => {
    vi.mocked(listNotifications).mockRejectedValue(error);

    render(<NotificationInbox />, { wrapper: MemoryRouter });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.queryByText("You have no notifications.")).not.toBeInTheDocument();
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
      screen.getByText(`Received ${sgTime(UNREAD.createdAt)}`),
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
      payload: SETUP_PAYLOAD,
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

  // Only a 404 refetches; it has its own test below.
  it.each([
    ["a_500", httpError(500), "This notification could not be marked as read. Please try again."],
    ["a_401", httpError(401), "Your session has expired. Please sign in again."],
    ["a_network_error", new Error("Network Error"), "This notification could not be marked as read. Please try again."],
  ])("SCRUM17_AC3_%s_shows_its_row_message_re_enables_the_button_and_does_not_refetch", async (_label, error, message) => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(markNotificationRead).mockRejectedValue(error);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await user.click(await screen.findByRole("button", { name: "Mark as read" }));

    const row = rowFor("Tech Talk");
    expect(await within(row).findByRole("alert")).toHaveTextContent(message);
    expect(within(row).getByRole("button", { name: "Mark as read" })).toBeEnabled();
    expect(within(row).getByText("New")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
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


// Visibility, hidden tabs and unmounting are useRefetchOnReturn's own tests;
// this proves the inbox is wired to it.
describe("SCRUM17_AC3 refetching when the Coordinator returns", () => {
  it("refetches on window focus", async () => {
    vi.mocked(listNotifications).mockResolvedValueOnce([]).mockResolvedValueOnce([UNREAD]);

    render(<NotificationInbox />, { wrapper: MemoryRouter });
    await screen.findByText("You have no notifications.");

    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByText("Tech Talk at Hall A needs review")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-172 AC4: the shared, exact unread count
// ---------------------------------------------------------------------------

describe("SCRUM172_AC4 the heading's count", () => {
  it("SCRUM172_AC4_heading_uses_the_exact_server_count", async () => {
    // The list is capped at 50, so counting it would say 50; the server says 73.
    const fifty = Array.from({ length: 50 }, (_, i) =>
      notification({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    vi.mocked(listNotifications).mockResolvedValue(fifty);
    vi.mocked(getUnreadCount).mockResolvedValue(73);

    renderInbox();

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications \(73 unread\)$/),
    );
  });

  it("SCRUM172_AC4_heading_shows_no_count_when_the_server_says_zero", async () => {
    // A stale unread row in the list must not outvote the server's 0.
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(getUnreadCount).mockResolvedValue(0);

    renderInbox();
    await screen.findByText("Tech Talk at Hall A needs review");

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications$/),
    );
  });

  it("SCRUM172_AC4_heading_falls_back_to_the_list_when_the_count_is_unknown", async () => {
    // The count read failed, so the provider holds null: the list's own count stands in.
    vi.mocked(listNotifications).mockResolvedValue([UNREAD, UNREAD_2, READ]);
    vi.mocked(getUnreadCount).mockRejectedValue(httpError(500));

    renderInbox();
    await screen.findAllByRole("listitem");

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^Notifications \(2 unread\)$/);
  });

  it("SCRUM172_AC4_a_successful_list_read_refreshes_the_count", async () => {
    vi.mocked(listNotifications).mockResolvedValue([UNREAD]);
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    renderInbox();
    await screen.findByText("Tech Talk at Hall A needs review");

    // Once on the provider's mount, once after the list arrived.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(2));
  });

  it("SCRUM172_AC4_a_failed_list_read_does_not_refresh_the_count", async () => {
    vi.mocked(listNotifications).mockRejectedValue(httpError(500));
    vi.mocked(getUnreadCount).mockResolvedValue(1);

    renderInbox();
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

    renderInbox({ nav: true });

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

    renderInbox();
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

    renderInbox({ nav: true });
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

describe("SCRUM172_AC7 selecting a notification opens its event", () => {
  const EVENT = "22222222-2222-4222-8222-222222222222";
  const COORDINATOR = { id: "c1", name: "Priya Nair", role: "event_coordinator" };
  const LINKED = { ...UNREAD, eventRequestId: EVENT };
  const LINKED_READ = { ...READ, eventRequestId: EVENT };

  function ReviewProbe() {
    const { id } = useParams();
    return <p>Review page for {id}</p>;
  }

  // The coordinator's link lands here.
  const REVIEW_PAGE = <Route path="/event-requests/:id" element={<ReviewProbe />} />;

  beforeEach(() => {
    vi.mocked(getUnreadCount).mockResolvedValue(1);
  });

  // Other roles' links (the organiser's /events, none for Venue Staff) are
  // proved by notificationLink.test.js and the inbox flow test.
  it("SCRUM172_AC7_linked_headline_is_a_link_to_the_event", async () => {
    vi.mocked(listNotifications).mockResolvedValue([LINKED]);
    renderInbox({ user: COORDINATOR, routes: REVIEW_PAGE });

    const link = await screen.findByRole("link", { name: "Tech Talk at Hall A needs review" });
    expect(link).toHaveAttribute("href", `/event-requests/${EVENT}`);
  });

  it("SCRUM172_AC7_clicking_an_unread_link_marks_it_read_then_refreshes_and_navigates", async () => {
    const user = userEvent.setup();
    const mark = deferred();
    vi.mocked(markNotificationRead).mockReturnValue(mark.promise);
    vi.mocked(listNotifications).mockResolvedValue([LINKED]);
    renderInbox({ user: COORDINATOR, routes: REVIEW_PAGE });
    // Provider mount plus the list's own refresh.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByRole("link", { name: "Tech Talk at Hall A needs review" }));

    // Navigation does not wait on the mark.
    expect(await screen.findByText(`Review page for ${EVENT}`)).toBeInTheDocument();
    expect(markNotificationRead).toHaveBeenCalledWith(LINKED.id);
    expect(getUnreadCount).toHaveBeenCalledTimes(2);

    await act(async () => mark.resolve({ ...LINKED, readAt: MARKED_AT }));
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(3));
  });

  it("SCRUM172_AC7_clicking_a_read_link_does_not_mark_it_again", async () => {
    const user = userEvent.setup();
    vi.mocked(listNotifications).mockResolvedValue([LINKED_READ]);
    renderInbox({ user: COORDINATOR, routes: REVIEW_PAGE });

    await user.click(await screen.findByRole("link", { name: "Orientation at Hall A needs review" }));

    expect(await screen.findByText(`Review page for ${EVENT}`)).toBeInTheDocument();
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("SCRUM172_AC7_a_failed_mark_still_navigates_without_an_error", async () => {
    const user = userEvent.setup();
    vi.mocked(markNotificationRead).mockRejectedValue(httpError(500));
    vi.mocked(listNotifications).mockResolvedValue([LINKED]);
    renderInbox({ user: COORDINATOR, routes: REVIEW_PAGE });
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalledTimes(2));

    await user.click(await screen.findByRole("link", { name: "Tech Talk at Hall A needs review" }));

    expect(await screen.findByText(`Review page for ${EVENT}`)).toBeInTheDocument();
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // A failed mark changed nothing, so the count is not re-read.
    expect(getUnreadCount).toHaveBeenCalledTimes(2);
  });
});
