import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/EventRegistrationSettings", () => ({
  default: ({ eventId }) => <p data-testid="registration-settings">Settings for {eventId}</p>,
}));

function renderRegistrationPage(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: role ? { id: "u1", name: "Test User", role } : null,
    loading: false,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  });
  window.history.pushState({}, "", "/events/22222222-2222-4222-8222-222222222222/registration");
  return render(<App />);
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("event registration settings route", () => {
  it("allows an Event Organiser to open a separate event settings page", () => {
    renderRegistrationPage("event_organiser");

    expect(screen.getByTestId("registration-settings"))
      .toHaveTextContent("Settings for 22222222-2222-4222-8222-222222222222");
    expect(window.location.pathname).toBe("/events/22222222-2222-4222-8222-222222222222/registration");
  });

  it.each(["event_coordinator", "attendee", "venue_staff"])(
    "refuses %s from the settings page",
    (role) => {
      renderRegistrationPage(role);

      expect(screen.queryByTestId("registration-settings")).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    },
  );

  it("sends a signed-out visitor to login", () => {
    renderRegistrationPage(null);

    expect(screen.queryByTestId("registration-settings")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
