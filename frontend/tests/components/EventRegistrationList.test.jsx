import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EventRegistrationList from "../../src/components/EventRegistrationList.jsx";
import { getEventRegistrations } from "../../src/services/eventRegistrationService";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRegistrationService", () => ({ getEventRegistrations: vi.fn() }));

const entries = [
  { id: "1", attendeeName: "Ada", attendeeEmail: "ada@example.com", registeredAt: "2030-01-01T09:00:00Z", status: "registered", statusLabel: "Registered" },
  { id: "2", attendeeName: null, attendeeEmail: "ben@example.com", registeredAt: "2030-01-01T10:00:00Z", status: "withdrawn", statusLabel: "Withdrawn" },
  { id: "3", attendeeName: "Cy", attendeeEmail: null, registeredAt: "2030-01-01T11:00:00Z", status: "cancelled", statusLabel: "Event cancelled" },
];
const listing = (overrides = {}) => ({
  event: { id: "e1", eventName: "Gala", status: "confirmed", capacity: 50 },
  counts: { registered: 1, capacity: 50 },
  hideWithdrawn: false,
  entries,
  ...overrides,
});

function renderList(role = "event_organiser") {
  vi.mocked(useAuth).mockReturnValue({ user: { id: "u1", role } });
  return render(
    <MemoryRouter>
      <EventRegistrationList eventId="e1" />
    </MemoryRouter>,
  );
}

describe("SCRUM478 EventRegistrationList", () => {
  beforeEach(() => {
    vi.mocked(getEventRegistrations).mockReset();
  });

  it("SCRUM478_AC2_shows_each_entry_with_name_email_time_and_status_in_the_given_order", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue(listing());
    renderList();

    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["Ada", "Name not set", "Cy"]);
    expect(within(rows[0]).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Email not set")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Withdrawn")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Event cancelled")).toBeInTheDocument();
    expect(within(rows[0]).getAllByRole("cell")[2].textContent).not.toBe("");
  });

  it("SCRUM478_AC3_shows_registered_against_capacity_or_alone", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValueOnce(listing());
    const { unmount } = renderList();
    expect(await screen.findByLabelText("Registered count")).toHaveTextContent("1 / 50");
    unmount();

    vi.mocked(getEventRegistrations).mockResolvedValueOnce(listing({ counts: { registered: 4, capacity: null } }));
    renderList();
    expect(await screen.findByLabelText("Registered count")).toHaveTextContent(/^4$/);
    expect(screen.queryByText(/waitlist/i)).not.toBeInTheDocument();
  });

  it("SCRUM478_AC4_asks_the_server_to_hide_withdrawn_when_toggled", async () => {
    vi.mocked(getEventRegistrations)
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing({ hideWithdrawn: true, entries: [entries[0], entries[2]] }));
    renderList();

    await userEvent.click(await screen.findByRole("checkbox", { name: "Hide withdrawn" }));

    expect(getEventRegistrations).toHaveBeenLastCalledWith("e1", { hideWithdrawn: true });
    expect(await screen.findByText("Cy")).toBeInTheDocument();
    expect(screen.queryByText("Withdrawn")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Registered count")).toHaveTextContent("1 / 50");
  });

  it("SCRUM478_AC5_offers_no_actions_on_the_list", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue(listing());
    renderList();
    await screen.findByText("Ada");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/export|download|print|csv/i)).not.toBeInTheDocument();
  });

  it("SCRUM478_AC6_shows_the_server_message_when_the_list_is_refused_or_unavailable", async () => {
    vi.mocked(getEventRegistrations).mockRejectedValue({
      response: { data: { error: "Registrations can only be viewed once the event is Confirmed." } },
    });
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Registrations can only be viewed once the event is Confirmed.");
  });

  it("SCRUM478_AC6_falls_back_to_a_generic_message", async () => {
    vi.mocked(getEventRegistrations).mockRejectedValue(new Error("network"));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the registrations.");
  });

  it("SCRUM478_AC1_links_each_role_back_to_its_own_page_and_shows_an_empty_list", async () => {
    vi.mocked(getEventRegistrations).mockResolvedValue(listing({ entries: [] }));
    const { unmount } = renderList("event_coordinator");
    expect(await screen.findByText("No registrations to show.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Back to event" })).toHaveAttribute("href", "/event-requests/e1");
    unmount();

    renderList("event_organiser");
    expect(await screen.findByRole("link", { name: "← Back to My Events" })).toHaveAttribute("href", "/events");
  });
});
