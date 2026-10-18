// TechnicalSupportDashboard.test.jsx
//
// SCRUM-284 AC2. The dashboard shows the equipment request queue. The queue's
// own behaviour is tested in EquipmentRequestQueue.test.jsx.

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
vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => <section data-testid="notifications-stub">Notifications</section>,
}));

describe("SCRUM-284: the Technical Support dashboard", () => {
  it("SCRUM284_AC2_the_queue_is_on_the_dashboard", () => {
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);
    expect(screen.getByTestId("queue-stub")).toBeInTheDocument();
  });

  it("SCRUM284_AC2_the_open_support_tickets_stay_listed_beside_the_queue", async () => {
    vi.mocked(getOpenTickets).mockResolvedValueOnce([{ id: "t1", subject: "Projector flickers", priority: "High" }]);
    render(<TechnicalSupportDashboard user={{ id: "u1", email: "sam@example.com" }} />);

    expect(await screen.findByText(/Projector flickers/)).toHaveTextContent("Projector flickers — High priority");
    expect(screen.getByTestId("queue-stub")).toBeInTheDocument();
  });
});
