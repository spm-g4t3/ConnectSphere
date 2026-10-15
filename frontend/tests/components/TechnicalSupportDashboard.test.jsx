// TechnicalSupportDashboard.test.jsx
//
// SCRUM-287, for SCRUM-284. The dashboard shows the equipment request queue where
// the stub list used to be, and its welcome line no longer reads "Welcome, " with
// nothing after it. The queue's own behaviour is tested in EquipmentRequestQueue.test.jsx.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { getOpenTickets } from "../../src/services/supportService";

import TechnicalSupportDashboard from "../../src/components/TechnicalSupportDashboard.jsx";

vi.mock("../../src/services/supportService", () => ({
  getOpenTickets: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/components/EquipmentRequestQueue", () => ({
  default: () => <section data-testid="queue-stub">Equipment request queue</section>,
}));
vi.mock("../../src/components/CoordinatorNotifications", () => ({
  default: () => <section data-testid="notifications-stub">Notifications</section>,
}));

describe("SCRUM-284: the Technical Support dashboard", () => {
  it("SCRUM287_the_queue_is_on_the_dashboard", () => {
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);
    expect(screen.getByTestId("queue-stub")).toBeInTheDocument();
  });

  it("SCRUM287_the_queue_sits_directly_under_the_dashboard_so_it_gets_the_card_styling", () => {
    const { container } = render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);
    expect(screen.getByTestId("queue-stub").parentElement).toBe(container.querySelector(".dashboard"));
  });

  it("SCRUM287_the_stub_equipment_list_is_gone", () => {
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);
    expect(screen.queryByText("No pending equipment requests.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark fulfilled" })).not.toBeInTheDocument();
  });

  it("SCRUM287_the_welcome_line_uses_the_email_when_there_is_no_name", () => {
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome, sam@example.com");
  });

  it("SCRUM287_the_welcome_line_prefers_the_name", () => {
    render(<TechnicalSupportDashboard user={{ id: "u1", name: "Sam Lee", email: "sam@example.com" }} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Welcome, Sam Lee");
  });

  it("SCRUM287_open_tickets_the_service_returns_are_listed_with_their_priority", async () => {
    vi.mocked(getOpenTickets).mockResolvedValueOnce([{ id: "t1", subject: "Projector flickers", priority: "High" }]);
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);

    expect(await screen.findByText(/Projector flickers/)).toHaveTextContent("Projector flickers — High priority");
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(screen.queryByText("No open tickets.")).not.toBeInTheDocument();
  });
});
