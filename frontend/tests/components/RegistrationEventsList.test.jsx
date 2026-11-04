import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import RegistrationEventsList from "../../src/components/RegistrationEventsList.jsx";
import { getMyEventRequests } from "../../src/services/eventRequestService";
import { deferred } from "../helpers/async.js";

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

  // The app renders in StrictMode, which mounts the page twice: the first,
  // discarded read must not overwrite the list from the second one.
  function renderListInStrictMode() {
    const discarded = deferred();
    const current = deferred();
    vi.mocked(getMyEventRequests).mockReset()
      .mockReturnValueOnce(discarded.promise)
      .mockReturnValueOnce(current.promise);
    render(
      <StrictMode>
        <MemoryRouter>
          <RegistrationEventsList />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(getMyEventRequests).toHaveBeenCalledTimes(2);
    return { discarded, current };
  }

  it("SCRUM494_AC2_a_read_from_a_discarded_mount_does_not_replace_the_list", async () => {
    const { discarded, current } = renderListInStrictMode();
    await act(async () => current.resolve([
      { id: "b", eventName: "Confirmed Gala", status: "confirmed", proposedStart: "2030-02-01T10:00:00Z" },
    ]));
    await act(async () => discarded.resolve([
      { id: "a", eventName: "Stale Fair", status: "approved", proposedStart: "2030-01-01T10:00:00Z" },
    ]));

    expect(screen.getByText("Confirmed Gala")).toBeInTheDocument();
    expect(screen.queryByText("Stale Fair")).not.toBeInTheDocument();
  });

  it("SCRUM494_AC2_a_failure_from_a_discarded_mount_shows_no_error", async () => {
    const { discarded, current } = renderListInStrictMode();
    await act(async () => current.resolve([]));
    await act(async () => discarded.reject(new Error("boom")));

    expect(screen.getByText(/None of your events can have registration set up yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
