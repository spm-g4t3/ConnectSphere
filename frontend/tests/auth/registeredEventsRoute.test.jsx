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

describe("SCRUM-51 mocked API response sequences (not lifecycle RPC integration)", () => {
  const unavailable = { eventRequestId: "e1", state: "unavailable" };
  const latest = () => confirmed("e1", {
    startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
    venues: [{ bookingId: "latest", name: "Latest confirmed hall", location: "Latest location" }],
  });
  function expectArrangementsHidden() {
    expect(screen.queryByRole("heading", { name: "Confirmed arrangements" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Venues" })).not.toBeInTheDocument();
    expect(document.querySelector(".browse-event-details__facts")).toBeNull();
    expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
    expect(screen.queryByText("2026-10-25")).not.toBeInTheDocument();
  }

  it("SCRUM24_AC2_AC3_unavailable_contract_does_not_describe_cancelled_events_as_awaiting_confirmation", async () => {
    // Approved and Cancelled share this privacy-preserving response. No raw status is supplied to the UI.
    vi.mocked(getAttendeeEvent).mockResolvedValue(unavailable);
    renderAt("/registered-events/e1");
    const message = await screen.findByText("Event details are not currently confirmed.");
    expect(message).toHaveAttribute("role", "status");
    expect(message).not.toHaveTextContent(/awaiting|yet|will be confirmed/i);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expectArrangementsHidden();
  });

  it("SCRUM24_AC2_AC3_AC7_mocked_confirmed_approved_reconfirmed_responses_replace_arrangements_authoritatively", async () => {
    const approvedRead = deferred();
    const reconfirmedRead = deferred();
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(confirmed())
      .mockReturnValueOnce(approvedRead.promise).mockReturnValueOnce(reconfirmedRead.promise);
    renderAt("/registered-events/e1");
    await screen.findByText("Hall e1");

    fireEvent.focus(window);
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expectArrangementsHidden();
    // This represents the API response after Approved, not execution of a significant-change workflow.
    await act(async () => approvedRead.resolve(unavailable));
    expect(screen.getByRole("status")).toHaveTextContent("Event details are not currently confirmed.");
    expectArrangementsHidden();

    fireEvent(document, new Event("visibilitychange"));
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expectArrangementsHidden();
    await act(async () => reconfirmedRead.resolve(latest()));
    expect(screen.getByText("Latest confirmed hall")).toBeInTheDocument();
    expect(screen.getByText("Latest location")).toBeInTheDocument();
    expect(screen.getByText("2030-05-06")).toBeInTheDocument();
    expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
    expect(getAttendeeEvent).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getAttendeeEvent).mock.calls).toEqual([["e1"], ["e1"], ["e1"]]);
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Attendees can view this event information."],
    [404, "Event information is unavailable. An active registration is required."],
    [500, "Event information could not be loaded. Please try again."],
    [503, "Event information could not be loaded. Please try again."],
    [undefined, "Event information could not be loaded. Please try again."],
  ])("SCRUM24_AC2_AC3_AC7_failed_refresh_keeps_old_arrangements_hidden_and_distinguishes_failure_%s", async (status, message) => {
    renderAt("/registered-events/e1");
    await screen.findByText("Hall e1");
    const refresh = deferred();
    vi.mocked(getAttendeeEvent).mockReturnValueOnce(refresh.promise);
    fireEvent.focus(window);
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expectArrangementsHidden();
    await act(async () => refresh.reject(status === undefined ? new Error("PRIVATE_NETWORK_ERROR") : failure(status)));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/PRIVATE_|as last loaded/);
    expect(screen.queryByText("Event details are not currently confirmed.")).not.toBeInTheDocument();
    expectArrangementsHidden();

    if (status !== 404) {
      const retry = deferred();
      vi.mocked(getAttendeeEvent).mockReturnValueOnce(retry.promise);
      await userEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.getByRole("status")).toHaveTextContent("Loading...");
      expectArrangementsHidden();
      await act(async () => retry.resolve(latest()));
      expect(screen.getByText("Latest confirmed hall")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
    }
  });

  it.each(["confirmed", "unavailable", "error"])(
    "SCRUM24_AC7_mocked_overlapping_refresh_ignores_late_response_%s", async staleOutcome => {
      renderAt("/registered-events/e1");
      await screen.findByText("Hall e1");
      const oldRead = deferred();
      const newRead = deferred();
      vi.mocked(getAttendeeEvent).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
      expectArrangementsHidden();
      await act(async () => newRead.resolve(staleOutcome === "unavailable" ? latest() : unavailable));
      await act(async () => {
        if (staleOutcome === "error") oldRead.reject(failure(500));
        else oldRead.resolve(staleOutcome === "confirmed" ? confirmed() : unavailable);
      });
      if (staleOutcome === "unavailable") {
        expect(screen.getByText("Latest confirmed hall")).toBeInTheDocument();
      } else {
        expect(screen.getByRole("status")).toHaveTextContent("Event details are not currently confirmed.");
        expectArrangementsHidden();
      }
      expect(screen.queryByText("Hall e1")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
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
      expect(await screen.findByText("Event details are not currently confirmed.")).toHaveAttribute("role", "status");
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

  it("SCRUM24_AC6_every_confirmed_venue_shows_its_stored_name_and_multiline_location", async () => {
    const venues = [
      { bookingId: "hall", name: "Main Hall", location: "12 Orchard Road\nBlock A, Level 1" },
      { bookingId: "room", name: "Seminar Room 02-01", location: "Building B\nLevel 2, Room 02-01" },
      { bookingId: "venue", name: "Courtyard", location: "North entrance" },
    ];
    vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", { venues }));
    renderAt("/registered-events/e1");
    const list = await screen.findByRole("list", { name: "Venues" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    venues.forEach((venue, index) => {
      expect(within(items[index]).getByText(venue.name)).toBeInTheDocument();
      const location = items[index].querySelector("p");
      expect(location.textContent).toBe(venue.location);
      expect(location).toHaveClass("attendee-event-information__location");
    });
    expect(getAttendeeEvent).toHaveBeenCalledExactlyOnceWith("e1");
    expect(getOpenEvent).not.toHaveBeenCalled();
    expect(getOpenEvents).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "", " \t\n "])(
    "SCRUM24_AC6_missing_or_blank_venue_name_and_location_are_explicit_%j", async missing => {
      vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", {
        venues: [{ bookingId: "missing", name: missing, location: missing }],
      }));
      renderAt("/registered-events/e1");
      const list = await screen.findByRole("list", { name: "Venues" });
      expect(within(list).getByText("Venue name unavailable")).toBeInTheDocument();
      expect(within(list).getByText("Location unavailable")).toBeInTheDocument();
    },
  );

  it("SCRUM24_AC6_unsupported_room_fields_layouts_and_requirements_never_fill_missing_details", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", {
      venue_requirements: "PRIVATE_ORIGINAL_REQUIREMENTS",
      venues: [{ bookingId: "venue", name: "Venue A", location: null,
        roomName: "UNSUPPORTED_ROOM_NAME", hallName: "UNSUPPORTED_HALL_NAME",
        room_layout_code: "PRIVATE_LAYOUT_CODE", room_layouts: [{ label: "PRIVATE_LAYOUT_LABEL" }],
        address: "UNSUPPORTED_ADDRESS" }],
      bookings: [{ status: "pending", name: "PRIVATE_PENDING_VENUE" }],
    }));
    renderAt("/registered-events/e1");
    const list = await screen.findByRole("list", { name: "Venues" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Venue A")).toBeInTheDocument();
    expect(within(list).getByText("Location unavailable")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Registered event information" }))
      .not.toHaveTextContent(/PRIVATE_|UNSUPPORTED_/);
  });

  it("SCRUM24_AC6_AC8_venue_names_and_locations_render_as_safe_text", async () => {
    const name = '<img src=x onerror="window.__venuePwned=true">';
    const location = '<script>window.__venuePwned=true</script>\nHall <strong>2</strong>';
    vi.mocked(getAttendeeEvent).mockResolvedValue(confirmed("e1", {
      venues: [{ bookingId: "markup", name, location }],
    }));
    renderAt("/registered-events/e1");
    const list = await screen.findByRole("list", { name: "Venues" });
    expect(within(list).getByText(name)).toBeInTheDocument();
    expect(list.querySelector("p").textContent).toBe(location);
    expect(list.querySelector("img, script, svg")).toBeNull();
    expect(window.__venuePwned).toBeUndefined();
  });

  it("SCRUM24_AC6_AC7_mocked_refresh_replaces_changed_and_removed_venue_arrangements", async () => {
    renderAt("/registered-events/e1");
    await screen.findByText("Hall e1");
    const refresh = deferred();
    vi.mocked(getAttendeeEvent).mockReturnValueOnce(refresh.promise);
    fireEvent.focus(window);
    expect(screen.queryByRole("list", { name: "Venues" })).not.toBeInTheDocument();
    await act(async () => refresh.resolve(confirmed("e1", { venues: [
      { bookingId: "e1-a", name: "Hall A", location: "New building\nLevel 3" },
      { bookingId: "new", name: "Room C3", location: "Block C" },
    ] })));
    const list = screen.getByRole("list", { name: "Venues" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Hall A")).toBeInTheDocument();
    expect(within(list).getByText("Room C3")).toBeInTheDocument();
    expect(list.querySelector("p").textContent).toBe("New building\nLevel 3");
    expect(screen.queryByText("Seminar room")).not.toBeInTheDocument();
    expect(screen.queryByText("Building B")).not.toBeInTheDocument();
    expect(getAttendeeEvent).toHaveBeenCalledTimes(2);
  });

  it("SCRUM24_AC7_registered_list_refresh_failures_are_labelled_and_retryable", async () => {
    renderAt("/registered-events");
    await screen.findByText("Registered event");
    vi.mocked(getRegisteredEvents).mockRejectedValueOnce(failure(500));
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent(/as last loaded/);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

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
