// scrum584SharedScreenHeadings.test.jsx
//
// The UI standard's heading rule on the screens every user sees: exactly one
// h1 per page, and section headings at h2. The role dashboards and their inbox
// are real; their list sections are stubbed as in
// scrum172InboxOnEveryDashboard.test.jsx, and every remaining read answers an
// empty list through apiClient.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import Dashboard from "../../src/components/Dashboard.jsx";
import LoginForm from "../../src/components/LoginForm.jsx";
import Navigation from "../../src/components/Navigation.jsx";
import NotAvailablePage from "../../src/components/NotAvailablePage.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { apiClient } from "../../src/services/apiClient";
import { ALL_ROLES } from "../helpers/authMock.js";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../src/services/apiClient", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

// The dashboards' list sections, stubbed so none of them fetches.
vi.mock("../../src/components/MyAssignedEvents", () => ({ default: () => null }));
vi.mock("../../src/components/ReviewQueue", () => ({ default: () => null }));
vi.mock("../../src/components/UnassignedQueue", () => ({ default: () => null }));
vi.mock("../../src/components/PendingBookingRequests", () => ({ default: () => null }));
vi.mock("../../src/components/FlaggedBookings", () => ({ default: () => null }));
vi.mock("../../src/components/VenueCatalogue", () => ({ default: () => null }));

function signIn(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", name: "Test User", email: "user@example.com", role },
    logout: vi.fn(),
  });
}

function expectOneH1() {
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
});

describe("SCRUM584 AC4 one h1 per shared screen, sections at h2", () => {
  it("SCRUM584_AC4_login_has_one_h1", () => {
    vi.mocked(useAuth).mockReturnValue({ login: vi.fn() });
    render(<LoginForm />, { wrapper: MemoryRouter });

    expectOneH1();
  });

  it("SCRUM584_AC4_not_available_page_has_one_h1", () => {
    render(<NotAvailablePage />);

    expectOneH1();
  });

  it.each(ALL_ROLES)("SCRUM584_AC4_%s_dashboard_has_one_h1_and_notifications_at_h2", async (role) => {
    signIn(role);
    render(<Dashboard />, { wrapper: MemoryRouter });

    // Wait for the inbox to settle, so its loaded state is what is checked.
    expect(await screen.findByText("You have no notifications.")).toBeInTheDocument();
    expectOneH1();
    expect(screen.getByRole("heading", { level: 2, name: "Notifications" })).toBeInTheDocument();
  });

  it.each(ALL_ROLES)("SCRUM584_AC4_%s_nav_adds_no_heading_to_the_page", (role) => {
    signIn(role);
    render(<Navigation />, { wrapper: MemoryRouter });

    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
  });
});
