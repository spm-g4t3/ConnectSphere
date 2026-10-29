// SCRUM-434 AC5: an attendee opening a cancelled event sees that it is cancelled and the
// coordinator's optional message, and nothing that could carry the internal reason.
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AttendeeEventInformation from "../../src/components/AttendeeEventInformation";
import { getAttendeeEvent } from "../../src/services/attendeeEventService";

vi.mock("../../src/services/attendeeEventService", () => ({
  getAttendeeEvent: vi.fn(), withdrawRegistration: vi.fn(),
}));

const REASON = "INTERNAL_REASON_SENTINEL";
const cancelled = (overrides = {}) => ({
  eventRequestId: "e1", registrationId: "r1", state: "cancelled", eventName: "Open day",
  message: "We are sorry. The venue is no longer available.", ...overrides,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/registered-events/e1"]}>
      <Routes><Route path="/registered-events/:eventId" element={<AttendeeEventInformation />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getAttendeeEvent).mockReset();
});

describe("SCRUM-434 AC5: a cancelled event for an attendee", () => {
  it("SCRUM434_AC5_says_the_event_is_cancelled_and_shows_the_coordinators_message", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled());
    renderPage();

    const status = await screen.findByText("This event has been cancelled.");
    const box = status.closest("[role='status']");
    expect(within(box).getByRole("heading", { name: "Message from the coordinator" })).toBeInTheDocument();
    expect(within(box).getByText("We are sorry. The venue is no longer available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Open day" })).toBeInTheDocument();
  });

  it.each([null, undefined, ""])("SCRUM434_AC5_with_no_message_%j_only_the_cancellation_is_shown", async (message) => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled({ message }));
    renderPage();

    expect(await screen.findByText("This event has been cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Message from the coordinator" })).not.toBeInTheDocument();
  });

  it("SCRUM434_AC5_a_cancelled_event_is_not_described_as_awaiting_confirmation", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled());
    renderPage();

    await screen.findByText("This event has been cancelled.");
    expect(screen.queryByText("Event details are not currently confirmed.")).not.toBeInTheDocument();
  });

  it("SCRUM434_AC5_no_arrangements_are_shown_for_a_cancelled_event", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled({
      startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
      venues: [{ bookingId: "b", name: "PRIVATE_HALL", location: "PRIVATE_LOCATION" }],
    }));
    renderPage();

    await screen.findByText("This event has been cancelled.");
    expect(screen.queryByRole("heading", { name: "Confirmed arrangements" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Venues" })).not.toBeInTheDocument();
    expect(screen.queryByText("PRIVATE_HALL")).not.toBeInTheDocument();
  });

  it("SCRUM434_AC5_a_reason_field_in_the_response_is_never_rendered", async () => {
    // The backend never sends it. If a later change ever did, the screen still must not show it.
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled({ cancellationReason: REASON, reason: REASON }));
    renderPage();

    await screen.findByText("This event has been cancelled.");
    expect(document.body).not.toHaveTextContent(REASON);
  });

  it("SCRUM434_AC5_a_message_with_markup_is_shown_as_plain_text", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled({ message: "<b>bold</b> <script>alert(1)</script>" }));
    renderPage();

    expect(await screen.findByText("<b>bold</b> <script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector(".attendee-event-information__message b")).toBeNull();
  });

  it("SCRUM434_AC5_a_message_with_line_breaks_keeps_them", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled({ message: "Line one\nLine two" }));
    renderPage();

    const message = await screen.findByText(/Line one/);
    expect(message.textContent).toBe("Line one\nLine two");
    expect(message.className).toContain("attendee-event-information__message");
  });

  it("SCRUM434_AC5_the_other_states_are_unchanged", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue({ eventRequestId: "e1", registrationId: "r1", state: "unavailable", eventName: "Open day" });
    renderPage();

    expect(await screen.findByText("Event details are not currently confirmed.")).toBeInTheDocument();
    expect(screen.queryByText("This event has been cancelled.")).not.toBeInTheDocument();
  });

  it("SCRUM434_AC5_a_confirmed_event_shows_its_arrangements_and_no_cancellation", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue({
      eventRequestId: "e1", registrationId: "r1", state: "confirmed", eventName: "Open day",
      startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
      venues: [{ bookingId: "b1", name: "Hall A", location: "Building A" }],
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Confirmed arrangements" })).toBeInTheDocument();
    expect(screen.queryByText("This event has been cancelled.")).not.toBeInTheDocument();
  });
  it("SCRUM434_AC5_a_cancelled_event_offers_no_withdrawal_and_no_withdrawal_refusal", async () => {
    // Withdrawing from an event that no longer happens is meaningless, and its refusal text
    // ("You are still registered") would contradict the cancellation.
    vi.mocked(getAttendeeEvent).mockResolvedValue(cancelled());
    renderPage();

    await screen.findByText("This event has been cancelled.");
    expect(screen.queryByRole("region", { name: "Withdraw registration" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Withdraw your registration/)).not.toBeInTheDocument();
    expect(screen.queryByText(/still registered/)).not.toBeInTheDocument();
  });

  it.each(["unavailable", "confirmed"])("SCRUM434_AC5_a_%s_event_still_offers_the_withdrawal", async (state) => {
    vi.mocked(getAttendeeEvent).mockResolvedValue({
      eventRequestId: "e1", registrationId: "r1", state, eventName: "Open day",
      startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z", venues: [],
    });
    renderPage();

    expect(await screen.findByRole("region", { name: "Withdraw registration" })).toBeInTheDocument();
  });
});
