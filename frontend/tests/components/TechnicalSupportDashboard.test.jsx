// TechnicalSupportDashboard.test.jsx
//
// SCRUM-284 AC2. The dashboard shows the equipment request queue. The queue's
// own behaviour is tested in EquipmentRequestQueue.test.jsx.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import TechnicalSupportDashboard from "../../src/components/TechnicalSupportDashboard.jsx";

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
});
