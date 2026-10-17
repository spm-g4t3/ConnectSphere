import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import RegistrationEventsList from "../../src/components/RegistrationEventsList.jsx";
import { getMyEventRequests } from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  getMyEventRequests: vi.fn(),
}));

function renderList() {
  return render(
    <MemoryRouter>
      <RegistrationEventsList />
    </MemoryRouter>,
  );
}

describe("RegistrationEventsList", () => {
  it("lists only events registration can be set up for, each linking to its own page", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([
      { id: "a", eventName: "Approved Fair", status: "approved", proposedStart: "2030-01-01T10:00:00Z" },
      { id: "b", eventName: "Confirmed Gala", status: "confirmed", proposedStart: "2030-02-01T10:00:00Z" },
      { id: "c", eventName: "Draft Idea", status: "draft", proposedStart: null },
      { id: "d", eventName: "Submitted Talk", status: "submitted", proposedStart: null },
    ]);

    renderList();

    const links = await screen.findAllByRole("link", { name: "Configure registration" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/events/a/registration",
      "/events/b/registration",
    ]);
    expect(screen.queryByText("Draft Idea")).not.toBeInTheDocument();
    expect(screen.queryByText("Submitted Talk")).not.toBeInTheDocument();
  });

  it("explains when no event is eligible", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([]);

    renderList();

    expect(await screen.findByText(/None of your events can have registration set up yet/)).toBeInTheDocument();
  });

  it("shows an error when events cannot be loaded", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValue(new Error("boom"));

    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your events.");
  });
});
