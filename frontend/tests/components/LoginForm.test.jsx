// LoginForm.test.jsx
//
// SCRUM-485 (SCRUM-512), AC3-03: logging in as either new role goes to
// /dashboard, as it does for every role, and lands on that role's own page.
//
// Narrow on purpose. LoginForm had no tests before this file, and this is not
// the test of it: its validation, error messages and disabled button belong to
// the login story (SCRUM-96, SCRUM-104), not to SCRUM-485. What this proves is
// the one step AC3 depends on: a successful login sends the new roles where
// every role goes, and the Dashboard router (Dashboard.test.jsx) takes it from
// there.
//
// It renders the REAL App at /login, as tests/auth/venueSearchRouteGuard does,
// so the route table, ProtectedRoute and Dashboard all run. Only the auth
// context is replaced, by a stand-in with state: no user until login() is
// called, then the user login() returned. That is the change the real
// AuthProvider makes, and it is what lets ProtectedRoute admit /dashboard
// after the redirect.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

/** An auth context with no user, whose login() signs in as `role`. */
function signInAs(role, email) {
  let user = null;
  const login = vi.fn(async () => {
    user = { id: "u1", email, role };
    return { success: true, user };
  });
  vi.mocked(useAuth).mockImplementation(() => ({
    user,
    loading: false,
    login,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  }));
  return login;
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM485_AC3 login sends each new role to its own dashboard", () => {
  it.each([
    ["event_coordinator_lead", "lead@connectsphere.com", "Event Coordinator Lead"],
    ["safety_officer", "safety@connectsphere.com", "Safety Officer"],
  ])("SCRUM485_AC3_logging_in_as_%s_goes_to_the_dashboard", async (role, email, heading) => {
    // AC3-03. The emails are the two accounts made for these roles on
    // 10 October; here they are only strings, no real login happens.
    const login = signInAs(role, email);
    window.history.pushState({}, "", "/login");
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("Email"), email);
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(login).toHaveBeenCalledWith(email, "password123");
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
    expect(screen.queryByText(/No dashboard available/)).not.toBeInTheDocument();
  });
});
