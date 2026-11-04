import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import NotAvailablePage from "../../src/components/NotAvailablePage.jsx";

describe("NotAvailablePage", () => {
  it("SCRUM584_AC5_names_the_lead_as_who_checks_a_role_since_there_is_no_admin", () => {
    render(<NotAvailablePage />);

    expect(screen.getByRole("heading", { level: 1, name: "Not available to your role" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your account does not have access to that page. If you think it should, ask your Event Coordinator Lead to check your role.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/administrator/i)).not.toBeInTheDocument();
  });
});
