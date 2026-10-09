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

  it("falls back for an unrecognised role", () => {
    const { container } = renderAs("guest");

    expect(container.querySelector(".dashboard--attendee")).not.toBeInTheDocument();
    expect(screen.getByText(/No dashboard available for your role/)).toBeInTheDocument();
  });
});
