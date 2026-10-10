// attendeeRouteGuard.test.jsx
//
// SCRUM453_AC3 (SCRUM-457): direct access to an attendee-specific view is
// refused to every other role, by the same ProtectedRoute the app's other
// role-limited routes use, so hiding a link is not the only defence.
//
// SCRUM-495 (Browse Open Events) has no route yet, so the view here is a probe
// route wrapped exactly as that route must be: allowedRoles={["attendee"]}.
// When SCRUM-495 lands, add a test that renders the real App at its path.
//
// Roles are spelled as the token carries them, as in the other guard tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import ProtectedRoute from "../../src/auth/ProtectedRoute";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

const OTHER_ROLES = ["event_organiser", "event_coordinator", "venue_staff", "technical_support_staff", "event_coordinator_lead", "safety_officer"];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAttendeeViewAs(user, loading = false) {
  vi.mocked(useAuth).mockReturnValue({ user, loading });
  return render(
    <MemoryRouter initialEntries={["/attendee-only"]}>
      <Routes>
        <Route
          path="/attendee-only"
          element={
            <ProtectedRoute allowedRoles={["attendee"]}>
              <p data-testid="attendee-view">Attendee view</p>
            </ProtectedRoute>
          }
        />
        <Route path="/unauthorized" element={<><p>Not available to your role</p><Where /></>} />
        <Route path="/login" element={<><p>Log in</p><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM453_AC3 attendee-specific views are limited to the Attendee role", () => {
  it.each(["attendee", "Attendee", " ATTENDEE "])(
    "SCRUM453_AC3_lets_an_attendee_spelled_%j_in",
    (role) => {
      renderAttendeeViewAs({ id: "u1", role });

      expect(screen.getByTestId("attendee-view")).toBeInTheDocument();
    },
  );

  it.each(OTHER_ROLES)("SCRUM453_AC3_refuses_%s_and_sends_them_to_unauthorized", (role) => {
    renderAttendeeViewAs({ id: "u1", role });

    expect(screen.queryByTestId("attendee-view")).not.toBeInTheDocument();
    expect(screen.getByText("Not available to your role")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/unauthorized");
  });

  it.each([
    ["an unknown role", "guest"],
    ["a blank role", ""],
    ["a missing role", undefined],
  ])("SCRUM453_AC3_refuses_a_user_with_%s", (_label, role) => {
    renderAttendeeViewAs({ id: "u1", role });

    expect(screen.queryByTestId("attendee-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/unauthorized");
  });

  it("SCRUM453_AC3_sends_a_signed_out_visitor_to_login_rather_than_unauthorized", () => {
    renderAttendeeViewAs(null);

    expect(screen.queryByTestId("attendee-view")).not.toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/login");
  });

  it("SCRUM453_AC3_shows_nothing_of_the_view_while_the_session_is_still_loading", () => {
    renderAttendeeViewAs(null, true);

    expect(screen.queryByTestId("attendee-view")).not.toBeInTheDocument();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });
});
