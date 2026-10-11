// BrowseEventDetails.test.jsx
//
// SCRUM-495: one open event's browse preview. The service is mocked at its own
// module, so what is under test is what the page does with each answer: the
// fields it shows (and the ones it never does), the Register states, the
// unavailable-event path back to the list, and that the organiser's
// description is rendered as text, never as HTML.
//
// Registering is SCRUM-22's flow, which does not exist yet. The page takes it
// as an onRegister prop, so these tests pass a stand-in handler to check the
// seam, and check the page without one never claims to have registered anyone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import { getOpenEvent } from "../../src/services/openEventService";

vi.mock("../../src/services/openEventService", () => ({
  getOpenEvent: vi.fn(),
}));

const TIME = { hour: "2-digit", minute: "2-digit" };
const DATE = { weekday: "short", year: "numeric", month: "short", day: "numeric" };

function event(overrides = {}) {
  return {
    id: "e1",
    eventName: "Open Day",
    description: "Come along.\nBring a friend.",
    startsAt: "2026-10-25T01:00:00.000Z",
    endsAt: "2026-10-25T03:30:00.000Z",
    capacity: 50,
    placesLeft: 12,
    isFull: false,
    isRegistered: false,
    canRegister: true,
    ...overrides,
  };
}

function renderDetails({ onRegister, path = "/open-events/e1" } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/open-events/:eventId" element={<BrowseEventDetails onRegister={onRegister} />} />
        <Route path="/open-events" element={<p data-testid="list-page">The list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const registerButton = () => screen.getByRole("button", { name: /^(Register|Registering\.\.\.|Already registered)$/ });

beforeEach(() => {
  vi.mocked(getOpenEvent).mockReset();
});

describe("SCRUM495 loading and fetching", () => {
  it("says it is loading, and asks for the event named in the URL", async () => {
    vi.mocked(getOpenEvent).mockReturnValue(new Promise(() => {}));

    renderDetails({ path: "/open-events/abc-123" });

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(getOpenEvent).toHaveBeenCalledWith("abc-123");
  });

  it("reads the event again each time the page is opened, not from a copy", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    const first = renderDetails();
    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    first.unmount();
    renderDetails();
    await screen.findByRole("heading", { name: "Open Day", level: 1 });

    expect(getOpenEvent).toHaveBeenCalledTimes(2);
  });
});

describe("SCRUM495_AC5 what the details show", () => {
  it("shows the name, date, start and end times, availability and the description", async () => {
    const e = event();
    vi.mocked(getOpenEvent).mockResolvedValue(e);

    renderDetails();

    expect(await screen.findByRole("heading", { name: "Open Day", level: 1 })).toBeInTheDocument();
    const facts = screen.getByText("Date").closest("dl");
    expect(facts).toHaveTextContent(new Date(e.startsAt).toLocaleDateString(undefined, DATE));
    expect(facts).toHaveTextContent(new Date(e.startsAt).toLocaleTimeString(undefined, TIME));
    expect(facts).toHaveTextContent(new Date(e.endsAt).toLocaleTimeString(undefined, TIME));
    expect(facts).toHaveTextContent("12 places left");
    expect(screen.getByText(/Come along\./)).toHaveTextContent("Come along. Bring a friend.");
  });

  it("says No limit when there is no capacity", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ capacity: null, placesLeft: null }));

    renderDetails();

    expect(await screen.findByText("No limit")).toBeInTheDocument();
  });

  it("says Full when the capacity is used up", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails();

    const facts = (await screen.findByText("Availability")).closest("div");
    expect(within(facts).getByText("Full")).toBeInTheDocument();
    expect(screen.queryByText(/places? left/)).not.toBeInTheDocument();
  });

  it("says so when the organiser wrote no description", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ description: null }));

    renderDetails();

    expect(await screen.findByText("The organiser has not added a description.")).toBeInTheDocument();
  });

  it("renders the description as text, so markup in it is shown, not run", async () => {
    const hostile = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script><b>bold</b>';
    vi.mocked(getOpenEvent).mockResolvedValue(event({ description: hostile }));

    const { container } = renderDetails();

    const description = await screen.findByText(hostile);
    expect(description).toBeInTheDocument();
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(description).toHaveClass("browse-event-details__description");
  });

  it("shows no venue, coordinator or internal planning field even if the response carried one", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(
      event({ venueName: "Grand Hall", venue_requirements: "Main hall", coordinatorName: "Casey", staffNotes: "internal" }),
    );

    const { container } = renderDetails();

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    for (const text of ["Grand Hall", "Main hall", "Casey", "internal"]) {
      expect(container).not.toHaveTextContent(text);
    }
    expect(screen.queryByText(/venue|location|coordinator/i)).not.toBeInTheDocument();
  });
});

describe("SCRUM495_AC5_AC6 the Register action", () => {
  it("offers Register for an open event with a place free and no registration", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toHaveTextContent("Register");
    expect(registerButton()).toBeEnabled();
  });

  it("offers it for an event with no limit", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ capacity: null, placesLeft: null }));

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeEnabled();
  });

  it("shows Registered and disables a duplicate registration", async () => {
    const onRegister = vi.fn();
    vi.mocked(getOpenEvent).mockResolvedValue(event({ isRegistered: true, canRegister: false }));

    renderDetails({ onRegister });

    const badge = await screen.findByText("Registered");
    expect(badge).toBeInTheDocument();
    expect(registerButton()).toHaveTextContent("Already registered");
    expect(registerButton()).toBeDisabled();
    await userEvent.click(registerButton());
    expect(onRegister).not.toHaveBeenCalled();
  });

  it("shows Full and disables registration", async () => {
    const onRegister = vi.fn();
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister });

    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    await userEvent.click(registerButton());
    expect(onRegister).not.toHaveBeenCalled();
  });

  it("shows a full event the caller has joined as Registered, not as an event they can join", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(
      event({ placesLeft: 0, isFull: true, isRegistered: true, canRegister: false }),
    );

    renderDetails({ onRegister: vi.fn() });

    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(registerButton()).toHaveTextContent("Already registered");
    expect(registerButton()).toBeDisabled();
  });

  it("does not offer Register when the server says the caller cannot", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ canRegister: false }));

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeDisabled();
  });

  it("calls the SCRUM-22 handler with the event id, then reads the event again", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ placesLeft: 11, isRegistered: true, canRegister: false }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(onRegister).toHaveBeenCalledWith("e1");
    expect(await screen.findByText("Already registered")).toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
  });

  it("says so and reads the event again when registering fails, without claiming success", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("full"));
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("Registration could not be completed. Please try again.")).toBeInTheDocument();
    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(screen.queryByText("Already registered")).not.toBeInTheDocument();
  });

  it("without a SCRUM-22 handler, disables Register and says it is not available, never registering anyone", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails();

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeDisabled();
    expect(screen.getByText("Registering for events is not available yet.")).toBeInTheDocument();
    expect(screen.queryByText(/you are registered/i)).not.toBeInTheDocument();
  });
});

describe("SCRUM495_AC2 an event that is not open, and errors", () => {
  it("says so and offers the way back to the list when the server answers 404", async () => {
    vi.mocked(getOpenEvent).mockRejectedValue({ response: { status: 404 } });

    renderDetails();

    expect(await screen.findByRole("alert")).toHaveTextContent("This event is not open for registration.");
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/places? left|No limit|Full/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Back to open events" }));
    expect(screen.getByTestId("list-page")).toBeInTheDocument();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Attendees can browse open events."],
    [500, "This event could not be loaded. Please try again."],
  ])("explains a %i, with a way back to the list", async (status, message) => {
    vi.mocked(getOpenEvent).mockRejectedValue({ response: { status } });

    renderDetails();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Back to open events" })).toHaveAttribute("href", "/open-events");
  });

  it("loads again on 'Try again' and shows the event when it works", async () => {
    vi.mocked(getOpenEvent)
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce(event({ eventName: "Back again" }));

    renderDetails();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Back again", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("always links back to the open events list from a loaded event", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails();

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(screen.getByRole("link", { name: "Back to open events" })).toHaveAttribute("href", "/open-events");
  });
});
