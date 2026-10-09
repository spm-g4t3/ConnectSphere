// Dashboard.test.jsx
//
// The role-to-dashboard map: an Attendee reaches the Attendee dashboard, and a
// role with no entry still gets the fallback rather than someone else's view.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import Dashboard from "../../src/components/Dashboard.jsx";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({
  useAuth: vi.fn(),
}));

function renderAs(role) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", email: "user@example.com", role },
  });
  return render(<Dashboard />);
}

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("Dashboard role map", () => {
  it("renders the Attendee dashboard for an attendee", () => {
    const { container } = renderAs("attendee");

    expect(container.querySelector(".dashboard--attendee")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome, user@example.com" })).toBeInTheDocument();
  });

  it("shows the Browse Open Events entry, with no invented event data", () => {
    renderAs("attendee");

    expect(screen.getByRole("heading", { name: "Browse Open Events" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("not available yet");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("falls back for an unrecognised role", () => {
    const { container } = renderAs("guest");

    expect(container.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
    expect(screen.getByText(/No dashboard available for your role/)).toBeInTheDocument();
  });
});
