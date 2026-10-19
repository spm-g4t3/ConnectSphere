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

describe("SCRUM494 RegistrationEventsList", () => {
  it("SCRUM494_AC2_lists_only_events_registration_can_be_set_up_for_each_linking_to_its_own_page", async () => {
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

  it("SCRUM494_AC2_explains_when_no_event_is_eligible", async () => {
    vi.mocked(getMyEventRequests).mockResolvedValue([]);

    renderList();

    expect(await screen.findByText(/None of your events can have registration set up yet/)).toBeInTheDocument();
  });

  it("SCRUM494_AC2_shows_an_error_when_events_cannot_be_loaded", async () => {
    vi.mocked(getMyEventRequests).mockRejectedValue(new Error("boom"));

    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your events.");
  });
});
