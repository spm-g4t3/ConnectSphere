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
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    const onRegister = vi.fn().mockRejectedValue(new Error("boom"));
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event());

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("Registration could not be completed. Please try again.")).toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Already registered")).not.toBeInTheDocument();
    expect(screen.queryByText(/You are registered for/)).not.toBeInTheDocument();
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


// ---------------------------------------------------------------------------
// Refresh and stale state
// ---------------------------------------------------------------------------
// Nothing is cached, so these drive the page through a sequence of server
// answers: the same event as it is read at successive moments. The
// Confirmed-to-Approved and reconfirmation cases are the server's 404 and its
// return, because the page only ever sees the API's judgement of eligibility.

/** Comes back to the tab, as a reader does. */
const returnToTab = () => fireEvent(window, new Event("focus"));

/** A read that stays pending until the test settles it. */
function pending() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SCRUM495_AC4 stale availability is refreshed", () => {
  it("shows an event that has since filled as Full, and no longer offers Register", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event({ placesLeft: 1 }))
      .mockResolvedValueOnce(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister: vi.fn() });
    expect(await screen.findByText("1 place left")).toBeInTheDocument();
    expect(registerButton()).toBeEnabled();

    returnToTab();

    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    expect(screen.queryByText("1 place left")).not.toBeInTheDocument();
  });

  it("does not blank the page while it refreshes: the details stay until the answer arrives", async () => {
    const refresh = pending();
    vi.mocked(getOpenEvent).mockResolvedValueOnce(event()).mockReturnValueOnce(refresh.promise);

    renderDetails({ onRegister: vi.fn() });
    await screen.findByText("12 places left");

    returnToTab();

    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    expect(screen.getByText("12 places left")).toBeInTheDocument();
    refresh.resolve(event({ placesLeft: 3 }));
    expect(await screen.findByText("3 places left")).toBeInTheDocument();
  });

  it("does not refresh while the tab is hidden", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());
    renderDetails();
    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    returnToTab();
    fireEvent(document, new Event("visibilitychange"));

    expect(getOpenEvent).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("keeps the newest answer when an older read finishes after it", async () => {
    const slow = pending();
    const fast = pending();
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    renderDetails({ onRegister: vi.fn() });
    await screen.findByText("12 places left");

    returnToTab();
    returnToTab();
    fast.resolve(event({ placesLeft: 0, isFull: true, canRegister: false }));
    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    slow.resolve(event({ placesLeft: 12 }));

    // Let the late answer land, then check it did not win.
    await waitFor(() => expect(getOpenEvent).toHaveBeenCalledTimes(3));
    expect(screen.getByText("This event is full.")).toBeInTheDocument();
    expect(screen.queryByText("12 places left")).not.toBeInTheDocument();
  });
});

describe("SCRUM495_AC6_AC7_AC8 Confirmed to Approved, and back", () => {
  it("withdraws the Register action when the event is sent back to Approved", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 404 } });

    renderDetails({ onRegister: vi.fn() });
    await screen.findByRole("button", { name: "Register" });

    returnToTab();

    expect(await screen.findByText("This event is not open for registration.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/places? left|No limit/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to open events" })).toBeInTheDocument();
  });

  it("offers the event again after reconfirmation, with the registration it already had", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event({ placesLeft: 4, isRegistered: true, canRegister: false }))
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce(event({ placesLeft: 4, isRegistered: true, canRegister: false }));

    renderDetails({ onRegister: vi.fn() });
    expect(await screen.findByText("Registered")).toBeInTheDocument();

    returnToTab();
    expect(await screen.findByText("This event is not open for registration.")).toBeInTheDocument();
    expect(screen.queryByText("Registered")).not.toBeInTheDocument();

    returnToTab();
    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(screen.getByText("4 places left")).toBeInTheDocument();
    expect(screen.queryByText("This event is not open for registration.")).not.toBeInTheDocument();
  });

  it("does not offer Register after reconfirmation unless the server says it can", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister: vi.fn() });
    await screen.findByRole("button", { name: "Register" });

    returnToTab();
    await screen.findByText("This event is not open for registration.");
    returnToTab();

    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
  });
});

describe("SCRUM495_AC2_AC3 registering, then the page the server describes", () => {
  it("shows the confirmation, the new places left and Registered after a successful registration", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event({ placesLeft: 12 }))
      .mockResolvedValueOnce(event({ placesLeft: 11, isRegistered: true, canRegister: false }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
    expect(screen.getByText("11 places left")).toBeInTheDocument();
    expect(screen.getByText("Registered")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    expect(onRegister).toHaveBeenCalledTimes(1);
  });

  it("says the event filled up when another attendee took the last place, and refreshes the availability", async () => {
    // The page still showed a place; the registration flow refused; the server now says Full.
    const onRegister = vi.fn().mockRejectedValue({ response: { status: 409 } });
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event({ placesLeft: 1 }))
      .mockResolvedValueOnce(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText(/filled up before your registration went through/)).toBeInTheDocument();
    expect(screen.getByText("This event is full.")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    expect(screen.queryByText(/You are registered for/)).not.toBeInTheDocument();
    expect(screen.queryByText("1 place left")).not.toBeInTheDocument();
  });

  it("does not trust its own copy of the capacity: it asks the registration flow even when one place is shown", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("full"));
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 1 }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(onRegister).toHaveBeenCalledWith("e1");
    await screen.findByText("Registration could not be completed. Please try again.");
  });

  it("says the caller is already registered when the flow refuses a duplicate", async () => {
    const onRegister = vi.fn().mockRejectedValue({ response: { status: 409 } });
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockResolvedValueOnce(event({ placesLeft: 11, isRegistered: true, canRegister: false }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("You are already registered for this event.")).toBeInTheDocument();
    expect(screen.getByText("Registered")).toBeInTheDocument();
    expect(screen.queryByText(/filled up/)).not.toBeInTheDocument();
  });

  it("shows only the not-open message when registering fails because the event went back to Approved", async () => {
    const onRegister = vi.fn().mockRejectedValue({ response: { status: 409 } });
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 404 } });

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("This event is not open for registration.")).toBeInTheDocument();
    expect(screen.queryByText("Registration could not be completed. Please try again.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /register/i })).not.toBeInTheDocument();
  });

  it("does not refresh on a tab return while a registration is in flight; the attempt refreshes when it ends", async () => {
    const attempt = pending();
    const onRegister = vi.fn().mockReturnValue(attempt.promise);
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));
    expect(screen.getByRole("button", { name: "Registering..." })).toBeDisabled();

    returnToTab();
    expect(getOpenEvent).toHaveBeenCalledTimes(1);

    attempt.resolve();
    await screen.findByText("You are registered for Open Day.");
    expect(getOpenEvent).toHaveBeenCalledTimes(2);
  });

  it("cannot be registered twice by a double click", async () => {
    const attempt = pending();
    const onRegister = vi.fn().mockReturnValue(attempt.promise);
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails({ onRegister });
    const button = await screen.findByRole("button", { name: "Register" });
    await userEvent.dblClick(button);

    expect(onRegister).toHaveBeenCalledTimes(1);
    attempt.resolve();
    await screen.findByText("You are registered for Open Day.");
  });
});

describe("SCRUM495 loading and error behaviour during a refresh", () => {
  it("keeps the last details with a notice, and pauses Register, when a refresh cannot reach the server", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 500 } });

    renderDetails({ onRegister: vi.fn() });
    await screen.findByText("12 places left");

    returnToTab();

    expect(await screen.findByText(/Could not refresh this event/)).toBeInTheDocument();
    expect(screen.getByText("12 places left")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    expect(screen.getByText("Registration is paused until this event can be checked again.")).toBeInTheDocument();
  });

  it("recovers on 'Try again' and offers Register again", async () => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValueOnce(event({ placesLeft: 7 }));

    renderDetails({ onRegister: vi.fn() });
    await screen.findByText("12 places left");
    returnToTab();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("7 places left")).toBeInTheDocument();
    expect(screen.queryByText(/Could not refresh this event/)).not.toBeInTheDocument();
    expect(registerButton()).toBeEnabled();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Attendees can browse open events."],
  ])("replaces the details with the error when a refresh is refused with %i", async (status, message) => {
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status } });

    renderDetails({ onRegister: vi.fn() });
    await screen.findByText("12 places left");

    returnToTab();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("12 places left")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register" })).not.toBeInTheDocument();
  });

  it("gives a general message, and keeps the details, when registering fails and the refresh fails too", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("boom"));
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 500 } });

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("Registration could not be completed. Please try again.")).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh this event/)).toBeInTheDocument();
    expect(screen.getByText("12 places left")).toBeInTheDocument();
  });
});