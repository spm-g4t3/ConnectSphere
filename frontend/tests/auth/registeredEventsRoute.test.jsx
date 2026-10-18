import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { getRegisteredEvents, getAttendeeEvent } from "../../src/services/attendeeEventService";
import { getOpenEvents, getOpenEvent } from "../../src/services/openEventService";

const auth = vi.hoisted(() => ({ user: { id: "attendee", role: "attendee", email: "attendee@example.com" } }));
vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: auth.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../../src/notifications/UnreadCountContext", () => ({
  UnreadCountProvider: ({ children }) => children,
  useUnreadCount: () => ({ unreadCount: 0 }),
}));
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => <section id="notifications">Notifications</section> }));
vi.mock("../../src/services/attendeeEventService", () => ({ getRegisteredEvents: vi.fn(), getAttendeeEvent: vi.fn() }));
vi.mock("../../src/services/openEventService", () => ({ getOpenEvents: vi.fn(), getOpenEvent: vi.fn() }));

const confirmed = (id = "e1", overrides = {}) => ({
  eventRequestId: id, state: "confirmed",
  startsAt: "2026-10-25T15:30:00Z", endsAt: "2026-10-25T16:30:00Z",
  venues: [{ bookingId: `${id}-a`, name: `Hall ${id}`, location: "Building A" },
    { bookingId: `${id}-b`, name: "Seminar room", location: "Building B" }],
  ...overrides,
});
function renderAt(path) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}
function navigate(path) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const failure = status => ({ response: { status, data: { error: "PRIVATE_DATABASE_ERROR" } } });

beforeEach(() => {
  vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "false");
  auth.user = { id: "attendee", role: "attendee", email: "attendee@example.com" };
  vi.mocked(getRegisteredEvents).mockReset().mockResolvedValue([{ eventRequestId: "e1", eventName: "Registered event" }]);
  vi.mocked(getAttendeeEvent).mockReset().mockResolvedValue(confirmed());
  vi.mocked(getOpenEvents).mockReset();
  vi.mocked(getOpenEvent).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("SCRUM-24 reachable attendee information", () => {
  it.each(["dashboard", "navigation"])("SCRUM24_AC1_AC4_AC5_AC6_%s_reaches_protected_event_reads_without_a_flag", async entry => {
    renderAt("/dashboard");
    expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Registered events" }))
      .toHaveAttribute("href", "/registered-events");
    await userEvent.click(entry === "dashboard"
      ? screen.getByRole("link", { name: "View registered events" })
      : within(screen.getByRole("navigation")).getByRole("link", { name: "Registered events" }));
    await userEvent.click(await screen.findByRole("link", { name: "Registered event" }));
    expect(await screen.findByRole("heading", { name: "Confirmed arrangements" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/registered-events/e1");
    expect(getRegisteredEvents).toHaveBeenCalledWith();
    expect(getAttendeeEvent).toHaveBeenCalledWith("e1");
    expect(screen.getByText("2026-10-25")).toBeInTheDocument();
    expect(screen.getByText("23:30")).toBeInTheDocument();
    expect(screen.getByText("2026-10-26 00:30")).toBeInTheDocument();
    expect(screen.getByText("(Singapore time)")).toBeInTheDocument();
    expect(screen.getByText("Hall e1")).toBeInTheDocument();
    expect(screen.getByText("Building B")).toBeInTheDocument();
    expect(getOpenEvents).not.toHaveBeenCalled();
    expect(getOpenEvent).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /register|withdraw|cancel/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Back to registered events" }));
    expect(await screen.findByRole("link", { name: "Registered event" })).toBeInTheDocument();
  });

  it.each(["/registered-events", "/registered-events/e1"])(
    "SCRUM24_AC1_signed_out_access_redirects_to_login_%s", async path => {
      auth.user = null;
      renderAt(path);
      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      expect(getRegisteredEvents).not.toHaveBeenCalled();
      expect(getAttendeeEvent).not.toHaveBeenCalled();
    },
  );

  it.each(["event_organiser", "event_coordinator", "event_coordinator_lead", "venue_staff", "technical_support_staff", "safety_officer"])(
    "SCRUM24_AC1_both_real_routes_refuse_non_attendee_role_%s", async role => {
      auth.user = { ...auth.user, role };
      const first = renderAt("/registered-events");
      expect(await screen.findByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
      first.unmount();
      renderAt("/registered-events/e1");
      expect(await screen.findByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
      expect(getRegisteredEvents).not.toHaveBeenCalled();
      expect(getAttendeeEvent).not.toHaveBeenCalled();
      expect(screen.queryByRole("link", { name: "Registered events" })).not.toBeInTheDocument();
    },
  );

  it("SCRUM24_AC1_registered_events_show_loading_empty_and_unnamed_entries", async () => {
    const pending = deferred();
    vi.mocked(getRegisteredEvents).mockReturnValueOnce(pending.promise);
    renderAt("/registered-events");
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    await act(async () => pending.resolve([]));
    expect(screen.getByText("You have no active event registrations.")).toBeInTheDocument();
    vi.mocked(getRegisteredEvents).mockResolvedValue([{ eventRequestId: "e2", eventName: null }]);
    fireEvent.focus(window);
    expect(await screen.findByRole("link", { name: "Unnamed event" })).toHaveAttribute("href", "/registered-events/e2");
  });

  it.each([401, 403, 500, 503, undefined])(
    "SCRUM24_AC1_list_failures_are_accessible_safe_and_retryable_%s", async status => {
      vi.mocked(getRegisteredEvents).mockRejectedValueOnce(failure(status));
      renderAt("/registered-events");
      expect(await screen.findByRole("alert")).not.toHaveTextContent("PRIVATE_DATABASE_ERROR");
      vi.mocked(getRegisteredEvents).mockResolvedValue([{ eventRequestId: "e1", eventName: "Registered event" }]);
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "Registered event" })).toBeInTheDocument();
    },
  );

  it.each([401, 403, 500, 503, undefined])(
    "SCRUM24_AC2_detail_failures_never_show_arrangements_and_can_retry_%s", async status => {
      vi.mocked(getAttendeeEvent).mockRejectedValueOnce(failure(status));
      renderAt("/registered-events/e1");
      expect(await screen.findByRole("alert")).not.toHaveTextContent("PRIVATE_DATABASE_ERROR");
      expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Hall e1")).toBeInTheDocument();
    },
  );

  it("SCRUM24_AC1_inaccessible_event_shows_safe_refusal_without_arrangements", async () => {
    vi.mocked(getAttendeeEvent).mockRejectedValueOnce(failure(404));
    renderAt("/registered-events/e1");
    expect(await screen.findByRole("alert")).toHaveTextContent("An active registration is required");
    expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
  });

  it.each([{ eventRequestId: "e1", state: "unavailable" }, confirmed("e2")])(
    "SCRUM24_AC2_AC3_unconfirmed_or_mismatched_records_never_render_arrangements_%j", async data => {
      vi.mocked(getAttendeeEvent).mockResolvedValue(data);
      renderAt("/registered-events/e1");
      expect(await screen.findByText("Confirmed event information is not available yet.")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Confirmed arrangements" })).not.toBeInTheDocument();
    },
  );

  it("SCRUM24_AC6_missing_venue_details_are_handled_without_inventing_arrangements", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", { venues: [] }));
    renderAt("/registered-events/e1");
    expect(await screen.findByText("No confirmed venue information is available.")).toBeInTheDocument();
    vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", { venues: [{ bookingId: "missing", name: null, location: null }] }));
    fireEvent.focus(window);
    expect(await screen.findByText("Venue name unavailable")).toBeInTheDocument();
    expect(screen.getByText("Location unavailable")).toBeInTheDocument();
  });

  it.each(["/registered-events", "/registered-events/e1"])(
    "SCRUM24_AC7_refresh_failures_are_labelled_and_retryable_%s", async path => {
      renderAt(path);
      await screen.findByText(path.endsWith("e1") ? "Hall e1" : "Registered event");
      const reader = path.endsWith("e1") ? getAttendeeEvent : getRegisteredEvents;
      vi.mocked(reader).mockRejectedValueOnce(failure(500));
      fireEvent.focus(window);
      expect(await screen.findByRole("alert")).toHaveTextContent(/as last loaded/);
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    },
  );

  it("SCRUM24_AC7_event_route_changes_clear_old_data_before_the_next_reply", async () => {
    renderAt("/registered-events/e1");
    await screen.findByText("Hall e1");
    const second = deferred();
    vi.mocked(getAttendeeEvent).mockReturnValueOnce(second.promise);
    navigate("/registered-events/e2");
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
    await act(async () => second.resolve(confirmed("e2")));
    expect(screen.getByText("Hall e2")).toBeInTheDocument();
  });

  it.each(["resolve", "reject"])(
    "SCRUM24_AC7_late_previous_event_responses_cannot_replace_current_information_%s", async outcome => {
      const first = deferred();
      vi.mocked(getAttendeeEvent).mockReturnValueOnce(first.promise).mockResolvedValue(confirmed("e2"));
      renderAt("/registered-events/e1");
      expect(screen.getByRole("status")).toHaveTextContent("Loading...");
      navigate("/registered-events/e2");
      await screen.findByText("Hall e2");
      await act(async () => outcome === "resolve" ? first.resolve(confirmed()) : first.reject(failure(500)));
      expect(screen.getByText("Hall e2")).toBeInTheDocument();
      expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
