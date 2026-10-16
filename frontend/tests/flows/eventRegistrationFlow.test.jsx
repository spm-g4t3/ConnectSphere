import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getOpenEvent, getOpenEvents } from "../../src/services/openEventService";
import { registerForEvent } from "../../src/services/registrationService";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children, useAuth: vi.fn(),
}));
vi.mock("../../src/services/openEventService", () => ({ getOpenEvent: vi.fn(), getOpenEvents: vi.fn() }));
vi.mock("../../src/services/registrationService", () => ({ registerForEvent: vi.fn() }));

const event = (overrides = {}) => ({
  id: "e1", eventName: "Open Day", description: "Come along",
  startsAt: "2026-10-25T01:00:00Z", endsAt: "2026-10-25T03:00:00Z",
  placesLeft: 1, capacity: 1, isFull: false, isRegistered: false, canRegister: true,
  ...overrides,
});

describe("SCRUM43 registration feedback", () => {
  const successNotice = () => document.querySelector(".browse-event-details__success");

  it("SCRUM43_AC1_AC2_AC6_confirms_immediately_and_does_not_reenable_registration_after_a_stale_read", async () => {
    let finishRefresh;
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event())
      .mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", eventRequestId: "e1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
    expect(successNotice()).toHaveAttribute("role", "status");
    expect(screen.getByText("Registered")).toBeInTheDocument();
    const registeredButton = screen.getByRole("button", { name: "Already registered" });
    expect(registeredButton).toBeDisabled();
    fireEvent.click(registeredButton);
    await act(async () => { finishRefresh(event()); });
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Already registered" }));
    expect(registerForEvent).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("You are registered for Open Day.")).toHaveLength(1);
  });

  it("SCRUM43_AC1_AC2_preserves_confirmed_registration_when_refresh_fails", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockRejectedValueOnce(new Error("Read failed"));
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByText(/Could not refresh this event/);
    expect(successNotice()).toHaveTextContent("You are registered for Open Day.");
    expect(screen.getByText("Registered")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
  });

  it("SCRUM43_AC2_AC3_AC6_marks_an_existing_registration_without_a_success_notification", async () => {
    vi.mocked(registerForEvent).mockRejectedValue({ response: {
      status: 409, data: { code: "ALREADY_REGISTERED", error: "Already registered" },
    } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You are already registered for this event.");
    expect(screen.getByText("Registered")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Already registered" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(registerForEvent).toHaveBeenCalledTimes(1);
    expect(successNotice()).toBeNull();
  });

  it.each([
    ["EVENT_FULL", "This event is full."],
    ["REGISTRATION_NOT_OPEN", "Registration has not opened yet."],
    ["REGISTRATION_CLOSED", "Registration has closed for this event."],
    ["EVENT_NOT_CONFIRMED", "Registration is only available for Confirmed events."],
    ["REGISTRATION_DISABLED", "Registration is disabled for this event."],
    ["EVENT_STARTED", "Registration is closed because the event has started."],
    ["REGISTRATION_DATES_MISSING", "Registration dates have not been configured for this event."],
  ])("SCRUM43_AC4_AC5_displays_%s_accessibly_without_success", async (code, message) => {
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status: 409, data: { code } } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(successNotice()).toBeNull();
    expect(screen.queryByText("Registered")).not.toBeInTheDocument();
  });

  it("SCRUM43_AC4_preserves_the_specific_refusal_when_the_event_is_no_longer_browsable", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockRejectedValueOnce({ response: { status: 404 } });
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status: 409, data: { code: "REGISTRATION_DISABLED" } } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByText("This event is not open for registration.");
    expect(screen.getByText("Registration is disabled for this event.").closest('[role="alert"]')).toBeInTheDocument();
    expect(successNotice()).toBeNull();
  });

  it("SCRUM43_AC4_AC5_handles_network_errors_even_if_a_read_finds_an_existing_registration", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockResolvedValue(event({ isRegistered: true, canRegister: false }));
    vi.mocked(registerForEvent).mockRejectedValue({ code: "ERR_NETWORK" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server. Check your connection and try again.");
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
    expect(successNotice()).toBeNull();
  });

  it("SCRUM43_AC4_shows_one_session_error_when_the_refresh_also_refuses_access", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockRejectedValueOnce({ response: { status: 401 } });
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status: 401 } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByText("Your session has expired. Please sign in again.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(successNotice()).toBeNull();
  });

  it("SCRUM43_AC2_keeps_registered_status_on_return_to_the_browse_list_and_details", async () => {
    const registered = event({ isRegistered: true, canRegister: false });
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockResolvedValue(registered);
    vi.mocked(getOpenEvents).mockResolvedValue([registered]);
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByText("You are registered for Open Day.");
    await userEvent.click(screen.getByRole("link", { name: "Back to open events" }));
    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(getOpenEvents).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("link", { name: "Open Day" }));
    expect(await screen.findByRole("button", { name: "Already registered" })).toBeDisabled();
    expect(successNotice()).toBeNull();
    expect(registerForEvent).toHaveBeenCalledTimes(1);
  });
});
const auth = (user = { id: "a1", role: "attendee" }, loading = false) => {
  vi.mocked(useAuth).mockReturnValue({ user, loading, logoutMessage: null, clearLogoutMessage: vi.fn() });
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "true");
  window.history.replaceState({}, "", "/open-events/e1");
  auth();
  vi.mocked(getOpenEvent).mockResolvedValue(event());
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("SCRUM36 attendee registration through the real App route", () => {
  it("SCRUM36_AC1_AC2_AC7_submits_the_selected_event_and_shows_server_confirmed_success", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event())
      .mockResolvedValue(event({ isRegistered: true, canRegister: false, isFull: true, placesLeft: 0 }));
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", eventRequestId: "e1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(registerForEvent).toHaveBeenCalledExactlyOnceWith("e1");
    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
  });

  it("SCRUM36_AC6_disables_register_while_submitting_and_ignores_repeated_clicks", async () => {
    let resolve;
    vi.mocked(registerForEvent).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<App />);
    const button = await screen.findByRole("button", { name: "Register" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Registering..." })).toBeDisabled();
    expect(registerForEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You are registered for Open Day.")).not.toBeInTheDocument();
    await act(async () => { resolve({ id: "r1", status: "registered" }); });
    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
  });

  it.each([
    [401, undefined, "Your session has expired. Please sign in again."],
    [403, undefined, "Only Attendees can register for events."],
    [409, "Event is full", "Event is full"],
    [409, "Already registered", "Already registered"],
    [409, "Registration has closed for this event", "Registration has closed for this event"],
    [500, "Internal database failure", "Registration could not be completed. Please try again."],
  ])("SCRUM36_AC6_AC7_displays_submission_failure_%s_%s_without_claiming_success", async (status, message, expected) => {
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status, data: { error: message } } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(screen.queryByText("You are registered for Open Day.")).not.toBeInTheDocument();
  });

  it("SCRUM36_AC6_allows_retry_after_a_failed_attempt", async () => {
    vi.mocked(registerForEvent).mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({ id: "r1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
    expect(registerForEvent).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { response: { status: 409, data: { error: "   " } } }])(
    "SCRUM36_AC6_handles_unusable_failure_details_%j_without_claiming_success", async (failure) => {
      vi.mocked(registerForEvent).mockRejectedValue(failure);
      render(<App />);
      await userEvent.click(await screen.findByRole("button", { name: "Register" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Registration could not be completed. Please try again.");
      expect(screen.queryByText("You are registered for Open Day.")).not.toBeInTheDocument();
    },
  );

  it.each([
    [{ isFull: true, canRegister: false, placesLeft: 0 }, "Register"],
    [{ isRegistered: true, canRegister: false }, "Already registered"],
  ])("SCRUM36_AC5_respects_known_availability_%j", async (availability, label) => {
    vi.mocked(getOpenEvent).mockResolvedValue(event(availability));
    render(<App />);
    const button = await screen.findByRole("button", { name: label });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(registerForEvent).not.toHaveBeenCalled();
  });

  it("SCRUM36_AC4_redirects_an_unauthenticated_visitor_without_loading_the_event", async () => {
    auth(null);
    render(<App />);
    expect(window.location.pathname).toBe("/login");
    expect(getOpenEvent).not.toHaveBeenCalled();
    expect(registerForEvent).not.toHaveBeenCalled();
  });

  it.each(["event_organiser", "event_coordinator", "venue_staff", "technical_support_staff", "event_coordinator_lead", "safety_officer"])(
    "SCRUM36_AC4_denies_the_registration_page_to_%s", (role) => {
      auth({ id: "other", role });
      render(<App />);
      expect(window.location.pathname).toBe("/unauthorized");
      expect(getOpenEvent).not.toHaveBeenCalled();
      expect(registerForEvent).not.toHaveBeenCalled();
    });

  it("SCRUM36_AC4_waits_for_authentication_to_load", () => {
    auth(null, true);
    render(<App />);
    expect(screen.getByText("Loading ConnectSphere...")).toBeInTheDocument();
    expect(getOpenEvent).not.toHaveBeenCalled();
    expect(registerForEvent).not.toHaveBeenCalled();
  });
});

describe("SCRUM46 refreshed event availability", () => {
  it("SCRUM46_AC1_AC3_AC5_AC6_uses_the_refreshed_count_and_shows_full_on_details_and_the_list", async () => {
    let finishRefresh;
    const full = event({ placesLeft: 0, isFull: true, isRegistered: true, canRegister: false, capacity: 4 });
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event({ capacity: 4, placesLeft: 3 }))
      .mockReturnValueOnce(new Promise((resolve) => { finishRefresh = resolve; }));
    vi.mocked(getOpenEvents).mockResolvedValue([full]);
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByText("Updating availability...")).toBeInTheDocument();
    expect(screen.queryByText("3 places left")).not.toBeInTheDocument();
    expect(screen.queryByText("2 places left")).not.toBeInTheDocument();
    // Other attendees can take places too; the refresh wins over subtracting one locally.
    await act(async () => { finishRefresh(full); });
    expect(await screen.findByText("Full")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("link", { name: "Back to open events" }));
    expect(await screen.findByText("Full")).toBeInTheDocument();
    expect(getOpenEvents).toHaveBeenCalledTimes(1);
    expect(registerForEvent).toHaveBeenCalledTimes(1);
  });

  it("SCRUM46_AC4_refreshes_unlimited_events_without_inventing_a_numeric_capacity", async () => {
    const unlimited = event({ capacity: null, placesLeft: null });
    vi.mocked(getOpenEvent).mockResolvedValueOnce(unlimited)
      .mockResolvedValue({ ...unlimited, isRegistered: true, canRegister: false });
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", status: "registered" });
    render(<App />);
    expect(await screen.findByText("No limit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByRole("button", { name: "Already registered" })).toBeDisabled();
    expect(await screen.findByText("No limit")).toBeInTheDocument();
    expect(screen.queryByText("Full")).not.toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
  });

  it("SCRUM46_AC7_failed_registration_refreshes_without_decreasing_available_places", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ capacity: 3, placesLeft: 2 }));
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status: 500 } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByRole("alert");
    expect(screen.getByText("2 places left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Register" })).toBeEnabled();
    expect(screen.queryByText("Registered")).not.toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
  });

  it("SCRUM46_AC7_duplicate_registration_does_not_decrease_places_a_second_time", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event({ capacity: 2, placesLeft: 1 }))
      .mockResolvedValue(event({ capacity: 2, placesLeft: 1, isRegistered: true, canRegister: false }));
    vi.mocked(registerForEvent).mockRejectedValue({ response: { status: 409, data: { code: "ALREADY_REGISTERED" } } });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    await screen.findByRole("alert");
    expect(await screen.findByText("1 place left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already registered" })).toBeDisabled();
    expect(screen.queryByText("Full")).not.toBeInTheDocument();
  });

  it("SCRUM46_AC6_hides_invalidated_numbers_after_a_failed_refresh_and_retries_the_authoritative_read", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event({ capacity: 3, placesLeft: 2 }))
      .mockRejectedValueOnce(new Error("Refresh failed"))
      .mockResolvedValueOnce(event({ capacity: 3, placesLeft: 1, isRegistered: true, canRegister: false }));
    vi.mocked(registerForEvent).mockResolvedValue({ id: "r1", status: "registered" });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(await screen.findByText("Availability could not be refreshed.")).toBeInTheDocument();
    expect(screen.queryByText("2 places left")).not.toBeInTheDocument();
    expect(screen.getByText("You are registered for Open Day.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 place left")).toBeInTheDocument();
    expect(screen.queryByText("Availability could not be refreshed.")).not.toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(3);
    expect(registerForEvent).toHaveBeenCalledTimes(1);
  });
});
