import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getOpenEvent } from "../../src/services/openEventService";
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
