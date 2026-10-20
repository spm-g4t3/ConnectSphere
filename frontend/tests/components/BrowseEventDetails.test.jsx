// One open event's browse preview, with the service mocked. Registering takes an
// onRegister prop, so a stand-in handler checks the seam.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import { getOpenEvent } from "../../src/services/openEventService";
import { deferred as pending } from "../helpers/async.js";

vi.mock("../../src/services/openEventService", () => ({
  getOpenEvent: vi.fn(),
}));

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
  it("SCRUM495_AC5_says_it_is_loading_and_asks_for_the_event_named_in_the_url", async () => {
    vi.mocked(getOpenEvent).mockReturnValue(new Promise(() => {}));

    renderDetails({ path: "/open-events/abc-123" });

    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    expect(getOpenEvent).toHaveBeenCalledWith("abc-123");
  });

  it("SCRUM495_AC5_reads_the_event_again_each_time_the_page_is_opened_not_from_a_copy", async () => {
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
  it("SCRUM495_AC5_shows_the_name_date_start_and_end_times_availability_and_the_description", async () => {
    const e = event();
    vi.mocked(getOpenEvent).mockResolvedValue(e);

    renderDetails();

    expect(await screen.findByRole("heading", { name: "Open Day", level: 1 })).toBeInTheDocument();
    const facts = screen.getByText("Date").closest("dl");
    expect(facts).toHaveTextContent("2026-10-25");
    expect(facts).toHaveTextContent("09:00");
    expect(facts).toHaveTextContent("11:30");
    expect(facts).toHaveTextContent("12 places left");
    expect(screen.getByText(/Come along\./)).toHaveTextContent("Come along. Bring a friend.");
  });

  it("SCRUM495_AC5_says_no_limit_when_there_is_no_capacity", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ capacity: null, placesLeft: null }));

    renderDetails();

    expect(await screen.findByText("No limit")).toBeInTheDocument();
  });

  it("SCRUM495_AC5_says_full_when_the_capacity_is_used_up", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails();

    const facts = (await screen.findByText("Availability")).closest("div");
    expect(within(facts).getByText("Full")).toBeInTheDocument();
    expect(screen.queryByText(/places? left/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC5_says_so_when_the_organiser_wrote_no_description", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ description: null }));

    renderDetails();

    expect(await screen.findByText("The organiser has not added a description.")).toBeInTheDocument();
  });

  it("SCRUM495_AC5_renders_the_description_as_text_so_markup_in_it_is_shown_not_run", async () => {
    const hostile = '<img src=x onerror="window.__pwned = true"><script>window.__pwned = true</script><b>bold</b>';
    vi.mocked(getOpenEvent).mockResolvedValue(event({ description: hostile }));

    const { container } = renderDetails();

    const description = await screen.findByText(hostile);
    expect(description).toBeInTheDocument();
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect(description).toHaveClass("browse-event-details__description");
  });

  it("SCRUM495_AC5_shows_no_venue_coordinator_or_internal_planning_field_even_if_the_response_carried_one", async () => {
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
  it("SCRUM495_AC5_AC6_offers_register_for_an_open_event_with_a_place_free_and_no_registration", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toHaveTextContent("Register");
    expect(registerButton()).toBeEnabled();
  });

  it("SCRUM495_AC5_AC6_offers_it_for_an_event_with_no_limit", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ capacity: null, placesLeft: null }));

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeEnabled();
  });

  it("SCRUM495_AC5_AC6_shows_registered_and_disables_a_duplicate_registration", async () => {
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

  it("SCRUM495_AC5_AC6_shows_full_and_disables_registration", async () => {
    const onRegister = vi.fn();
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister });

    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(registerButton()).toBeDisabled();
    await userEvent.click(registerButton());
    expect(onRegister).not.toHaveBeenCalled();
  });

  it("SCRUM495_AC5_AC6_shows_a_full_event_the_caller_has_joined_as_registered_not_as_an_event_they_can_join", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(
      event({ placesLeft: 0, isFull: true, isRegistered: true, canRegister: false }),
    );

    renderDetails({ onRegister: vi.fn() });

    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(screen.getByText("Full")).toBeInTheDocument();
    expect(registerButton()).toHaveTextContent("Already registered");
    expect(registerButton()).toBeDisabled();
  });

  it("SCRUM495_AC5_AC6_does_not_offer_register_when_the_server_says_the_caller_cannot", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ canRegister: false }));

    renderDetails({ onRegister: vi.fn() });

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeDisabled();
  });

  it("SCRUM495_AC5_AC6_calls_the_scrum_22_handler_with_the_event_id_then_reads_the_event_again", async () => {
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

  it("SCRUM495_AC5_AC6_says_so_and_reads_the_event_again_when_registering_fails_without_claiming_success", async () => {
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
  it("SCRUM495_AC5_AC6_without_a_scrum_22_handler_disables_register_and_says_it_is_not_available_never_registering_anyone", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails();

    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    expect(registerButton()).toBeDisabled();
    expect(screen.getByText("Registering for events is not available yet.")).toBeInTheDocument();
    expect(screen.queryByText(/you are registered/i)).not.toBeInTheDocument();
  });
});

describe("SCRUM495_AC2 an event that is not open, and errors", () => {
  it("SCRUM495_AC2_says_so_and_offers_the_way_back_to_the_list_when_the_server_answers_404", async () => {
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
    [503, "Event registration is temporarily unavailable. Please try again later."],
  ])("SCRUM495_AC2_explains_a_%i_with_a_way_back_to_the_list", async (status, message) => {
    vi.mocked(getOpenEvent).mockRejectedValue({ response: { status } });

    renderDetails();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("link", { name: "Back to open events" })).toHaveAttribute("href", "/open-events");
  });

  it("SCRUM495_AC2_loads_again_on_try_again_and_shows_the_event_when_it_works", async () => {
    vi.mocked(getOpenEvent)
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce(event({ eventName: "Back again" }));

    renderDetails();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Back again", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM495_AC2_always_links_back_to_the_open_events_list_from_a_loaded_event", async () => {
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

describe("SCRUM495_AC4 stale availability is refreshed", () => {
  it("SCRUM495_AC4_shows_an_event_that_has_since_filled_as_full_and_no_longer_offers_register", async () => {
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

  it("SCRUM495_AC4_does_not_blank_the_page_while_it_refreshes_the_details_stay_until_the_answer_arrives", async () => {
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

  it("SCRUM495_AC4_does_not_refresh_while_the_tab_is_hidden", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());
    renderDetails();
    await screen.findByRole("heading", { name: "Open Day", level: 1 });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

    returnToTab();
    fireEvent(document, new Event("visibilitychange"));

    expect(getOpenEvent).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });

  it("SCRUM495_AC4_keeps_the_newest_answer_when_an_older_read_finishes_after_it", async () => {
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
  it("SCRUM495_AC6_AC7_AC8_withdraws_the_register_action_when_the_event_is_sent_back_to_approved", async () => {
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

  it("SCRUM495_AC6_AC7_AC8_offers_the_event_again_after_reconfirmation_with_the_registration_it_already_had", async () => {
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

  it("SCRUM495_AC6_AC7_AC8_does_not_offer_register_after_reconfirmation_unless_the_server_says_it_can", async () => {
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
  it("SCRUM495_AC2_AC3_shows_the_confirmation_the_new_places_left_and_registered_after_a_successful_registration", async () => {
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

  it("SCRUM495_AC2_AC3_says_the_event_filled_up_when_another_attendee_took_the_last_place_and_refreshes_the_availability", async () => {
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

  it("SCRUM495_AC2_AC3_does_not_trust_its_own_copy_of_the_capacity_it_asks_the_registration_flow_even_when_one_place_is_shown", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("full"));
    vi.mocked(getOpenEvent).mockResolvedValue(event({ placesLeft: 1 }));

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(onRegister).toHaveBeenCalledWith("e1");
    await screen.findByText("Registration could not be completed. Please try again.");
  });

  it("SCRUM495_AC2_AC3_says_the_caller_is_already_registered_when_the_flow_refuses_a_duplicate", async () => {
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

  it("SCRUM495_AC2_AC3_shows_only_the_not_open_message_when_registering_fails_because_the_event_went_back_to_approved", async () => {
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

  it("SCRUM495_AC2_AC3_does_not_refresh_on_a_tab_return_while_a_registration_is_in_flight_the_attempt_refreshes_when_it_ends", async () => {
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

  it("SCRUM495_AC2_AC3_cannot_be_registered_twice_by_a_double_click", async () => {
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

  it("SCRUM495_AC2_AC3_ignores_a_second_click_that_arrives_before_the_page_has_re_rendered", async () => {
    const attempt = pending();
    const onRegister = vi.fn().mockReturnValue(attempt.promise);
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails({ onRegister });
    const button = await screen.findByRole("button", { name: "Register" });
    act(() => {
      button.click();
      button.click();
    });

    expect(onRegister).toHaveBeenCalledTimes(1);
    attempt.resolve();
    await screen.findByText("You are registered for Open Day.");
  });

  it("SCRUM495_AC2_AC3_names_a_nameless_event_plainly_on_the_heading_and_in_the_confirmation", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event({ eventName: "" }));

    renderDetails({ onRegister: vi.fn().mockResolvedValue() });
    expect(await screen.findByRole("heading", { name: "Unnamed event", level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Register" }));

    expect(await screen.findByText("You are registered for this event.")).toBeInTheDocument();
  });
});

describe("SCRUM495 loading and error behaviour during a refresh", () => {
  it("SCRUM495_AC5_gives_a_general_message_when_the_first_read_gets_no_response_at_all", async () => {
    vi.mocked(getOpenEvent).mockRejectedValue(new Error("Network Error"));

    renderDetails();

    expect(await screen.findByRole("alert")).toHaveTextContent("This event could not be loaded. Please try again.");
  });

  it("SCRUM495_AC5_keeps_the_newest_answer_when_an_older_read_fails_after_it", async () => {
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
    fast.resolve(event({ placesLeft: 3 }));
    await screen.findByText("3 places left");
    slow.reject({ response: { status: 500 } });

    await waitFor(() => expect(getOpenEvent).toHaveBeenCalledTimes(3));
    expect(screen.getByText("3 places left")).toBeInTheDocument();
    expect(screen.queryByText(/Could not refresh this event/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC5_keeps_the_last_details_with_a_notice_and_pauses_register_when_a_refresh_cannot_reach_the_server", async () => {
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

  it("SCRUM495_AC5_recovers_on_try_again_and_offers_register_again", async () => {
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
  ])("SCRUM495_AC5_replaces_the_details_with_the_error_when_a_refresh_is_refused_with_%i", async (status, message) => {
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

  it("SCRUM46_AC6_keeps_details_but_hides_unverified_places_when_registration_and_refresh_fail", async () => {
    const onRegister = vi.fn().mockRejectedValue(new Error("boom"));
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 500 } });

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("Registration could not be completed. Please try again.")).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh this event/)).toBeInTheDocument();
    expect(screen.getByText("Availability could not be refreshed.")).toBeInTheDocument();
    expect(screen.queryByText("12 places left")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open Day", level: 1 })).toBeInTheDocument();
  });
});

describe("SCRUM495 moving to another event", () => {
  function renderWithSwitch(onRegister) {
    return render(
      <MemoryRouter initialEntries={["/open-events/e1"]}>
        <Link to="/open-events/e2">Go to B</Link>
        <Routes>
          <Route path="/open-events/:eventId" element={<BrowseEventDetails onRegister={onRegister} />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("SCRUM495_AC5_clears_the_registered_notice_when_another_event_is_opened", async () => {
    vi.mocked(getOpenEvent).mockImplementation(async (id) =>
      id === "e1" ? event() : event({ id: "e2", eventName: "Workshop" }),
    );
    renderWithSwitch(vi.fn().mockResolvedValue({}));
    await screen.findByRole("heading", { name: "Open Day", level: 1 });

    await userEvent.click(registerButton());
    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Go to B" }));

    await screen.findByRole("heading", { name: "Workshop", level: 1 });
    expect(screen.queryByText(/You are registered for/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC5_clears_the_registration_error_when_another_event_is_opened", async () => {
    vi.mocked(getOpenEvent).mockImplementation(async (id) =>
      id === "e1" ? event() : event({ id: "e2", eventName: "Workshop" }),
    );
    renderWithSwitch(vi.fn().mockRejectedValue(new Error("no")));
    await screen.findByRole("heading", { name: "Open Day", level: 1 });

    await userEvent.click(registerButton());
    expect(await screen.findByText(/Registration could not be completed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("link", { name: "Go to B" }));

    await screen.findByRole("heading", { name: "Workshop", level: 1 });
    expect(screen.queryByText(/Registration could not be completed/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC5_a_registration_that_finishes_after_the_move_leaves_the_new_event_alone", async () => {
    let finish;
    vi.mocked(getOpenEvent).mockImplementation(async (id) =>
      id === "e1" ? event() : event({ id: "e2", eventName: "Workshop" }),
    );
    renderWithSwitch(() => new Promise((resolve) => { finish = resolve; }));
    await screen.findByRole("heading", { name: "Open Day", level: 1 });

    await userEvent.click(registerButton());
    await userEvent.click(screen.getByRole("link", { name: "Go to B" }));
    await screen.findByRole("heading", { name: "Workshop", level: 1 });
    await act(async () => finish({}));

    expect(screen.getByRole("heading", { name: "Workshop", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/You are registered for/)).not.toBeInTheDocument();
  });

  it("SCRUM495_AC5_shows_no_notice_when_the_reader_moves_to_another_event_during_the_post_register_reload", async () => {
    const reload = pending();
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockReturnValueOnce(reload.promise)
      .mockResolvedValueOnce(event({ id: "e2", eventName: "Workshop" }));
    renderWithSwitch(vi.fn().mockResolvedValue(undefined));
    await screen.findByRole("heading", { name: "Open Day", level: 1 });

    await userEvent.click(registerButton());
    await waitFor(() => expect(getOpenEvent).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("link", { name: "Go to B" }));
    await screen.findByRole("heading", { name: "Workshop", level: 1 });
    await act(async () => reload.resolve(event({ placesLeft: 11, isRegistered: true, canRegister: false })));

    expect(screen.getByRole("heading", { name: "Workshop", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/You are registered for/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(registerButton()).toBeEnabled();
  });

  it("SCRUM495_AC5_a_refresh_notice_for_one_event_is_not_shown_on_the_next", async () => {
    const next = pending();
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockReturnValueOnce(next.promise);
    renderWithSwitch(vi.fn());
    await screen.findByText("12 places left");
    returnToTab();
    await screen.findByText(/Could not refresh this event/);

    await userEvent.click(screen.getByRole("link", { name: "Go to B" }));

    expect(screen.queryByText(/Could not refresh this event/)).not.toBeInTheDocument();
    await act(async () => next.resolve(event({ id: "e2", eventName: "Workshop" })));
    await screen.findByRole("heading", { name: "Workshop", level: 1 });
    expect(registerButton()).toBeEnabled();
  });
});

describe("SCRUM495 registering while a refresh is in doubt", () => {
  it("SCRUM495_AC6_still_says_registered_when_the_event_has_closed_by_the_time_it_is_reloaded", async () => {
    const onRegister = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event())
      .mockRejectedValueOnce({ response: { status: 404 } });

    renderDetails({ onRegister });
    await userEvent.click(await screen.findByRole("button", { name: "Register" }));

    expect(await screen.findByText("You are registered for Open Day.")).toBeInTheDocument();
    expect(screen.getByText("This event is not open for registration.")).toBeInTheDocument();
  });

  it("SCRUM495_AC3_cannot_retry_a_refresh_mid_registration_and_still_reports_a_full_event", async () => {
    const refresh = pending();
    const registration = pending();
    const onRegister = vi.fn().mockReturnValue(registration.promise);
    vi.mocked(getOpenEvent)
      .mockResolvedValueOnce(event({ placesLeft: 1 }))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(event({ placesLeft: 0, isFull: true, canRegister: false }));

    renderDetails({ onRegister });
    await screen.findByText("1 place left");
    returnToTab();
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    await act(async () => refresh.reject({ response: { status: 500 } }));

    expect(await screen.findByText(/Could not refresh this event/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();

    await act(async () => registration.reject({ response: { status: 409 } }));

    expect(await screen.findByText(/filled up before your registration went through/)).toBeInTheDocument();
    expect(getOpenEvent).toHaveBeenCalledTimes(3);
  });
});

describe("SCRUM495 time zone note", () => {
  it("SCRUM495_AC5_names_singapore_time_beside_the_start_and_end", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(event());

    renderDetails();

    const facts = (await screen.findByText("Starts", { selector: "dt" })).closest("dl");
    expect(facts).toHaveTextContent("09:00 (Singapore time)");
    expect(facts).toHaveTextContent("11:30 (Singapore time)");
  });
});
