// equipmentRouteGuard.test.jsx
//
// SCRUM-485 AC5-15. The three Technical Support pages are the one
// allowedRoles gate in App.jsx with no guard test of its own:
// allowedRoles={["technical_support_staff"]} on /equipment-catalogue,
// /equipment-review/:eventId and /equipment-availability. This renders the
// REAL App, as venueCatalogueRouteGuard.test.jsx does, so it pins App.jsx's
// actual route table. Only the auth context and the three page components are
// mocked; the real ProtectedRoute and /unauthorized page run.
//
// A sample of the gate for the two new roles, not a test of every role on
// every page: the backend's technicalSupportOnly is what refuses the data, and
// requireRole's own test proves both roles are refused by it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: vi.fn(),
}));

vi.mock("../../src/components/EquipmentCatalogue", () => ({
  default: () => <p data-testid="equipment-page-stub">Equipment catalogue</p>,
}));
vi.mock("../../src/components/EquipmentReview", () => ({
  default: () => <p data-testid="equipment-page-stub">Equipment review</p>,
}));
vi.mock("../../src/components/EquipmentAvailabilityCheck", () => ({
  default: () => <p data-testid="equipment-page-stub">Equipment availability</p>,
}));

function renderAppAt(path, role) {
  vi.mocked(useAuth).mockReturnValue({
    user: role ? { id: "u1", name: "Test User", role } : null,
    loading: false,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  });
  window.history.pushState({}, "", path);
  return render(<App />);
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

const PAGES = [
  "/equipment-catalogue",
  "/equipment-review/33333333-3333-4333-8333-333333333333",
  "/equipment-availability",
];

describe("SCRUM-485 AC5: the Technical Support pages refuse the new roles", () => {
  it.each(PAGES)("SCRUM485_AC5_technical_support_staff_still_opens_%s", (path) => {
    // The control: the gate admits its own role, so a refusal below is the
    // gate refusing, not a route that is broken for everyone.
    renderAppAt(path, "technical_support_staff");

    expect(screen.getByTestId("equipment-page-stub")).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
  });

  const CASES = ["event_coordinator_lead", "safety_officer"].flatMap((role) => PAGES.map((path) => [role, path]));

  it.each(CASES)("SCRUM485_AC5_sends_%s_from_%s_to_unauthorized", (role, path) => {
    renderAppAt(path, role);

    expect(screen.queryByTestId("equipment-page-stub")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/unauthorized");
  });
});
