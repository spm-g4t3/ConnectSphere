import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfirmedArrangements from "../../src/components/ConfirmedArrangements";
import { getConfirmedArrangements } from "../../src/services/eventRequestService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({ getConfirmedArrangements: vi.fn() }));
const ID = "event-1";
const arrangements = (changes = {}) => ({
  eventRequestId: ID, status: "confirmed", statusDisplay: { label: "Confirmed", group: "CONFIRMED", description: "Going ahead." },
  startsAt: "2026-11-01T16:00:00Z", endsAt: "2026-11-01T18:00:00Z",
  venues: [{ bookingId: "b1", name: "Hall A", location: "Level 1" }, { bookingId: "b2", name: "Room 2", location: "Level 2" }],
  equipment: [{ lineId: "l1", name: "Microphone", quantity: 3 }, { lineId: "l2", name: "Projector", quantity: 2 }],
  ...changes,
});
async function open() {
  const view = render(<ConfirmedArrangements eventRequestId={ID} />);
  await userEvent.click(screen.getByText("Confirmed arrangements"));
  return view;
}
beforeEach(() => {
  vi.mocked(getConfirmedArrangements).mockReset().mockResolvedValue(arrangements());
});

describe("SCRUM363 organiser confirmed arrangements", () => {
  it("SCRUM363_AC7_only_loads_on_open_and_displays_all_authoritative_venues_and_equipment_quantities", async () => {
    render(<ConfirmedArrangements eventRequestId={ID} />);
    expect(getConfirmedArrangements).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Confirmed arrangements"));
    expect(await screen.findByRole("region", { name: "Current confirmed arrangements" })).toBeInTheDocument();
    expect(screen.getByText("Hall A — Level 1")).toBeInTheDocument();
    expect(screen.getByText("Room 2 — Level 2")).toBeInTheDocument();
    expect(screen.getByText("Microphone: 3")).toBeInTheDocument();
    expect(screen.getByText("Projector: 2")).toBeInTheDocument();
    expect(screen.getByText("2026-11-02 00:00 – 02:00 (Singapore time)")).toBeInTheDocument();
    expect(getConfirmedArrangements).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it("SCRUM363_AC7_cross_midnight_dates_use_Singapore_time_on_both_ends", async () => {
    vi.mocked(getConfirmedArrangements).mockResolvedValue(arrangements({ startsAt: "2026-11-01T15:00:00Z", endsAt: "2026-11-01T17:00:00Z" }));
    await open();
    expect(await screen.findByText("2026-11-01 23:00 – 2026-11-02 01:00 (Singapore time)")).toBeInTheDocument();
  });

  it("SCRUM363_AC7_no_equipment_and_missing_venue_or_date_data_are_explicit", async () => {
    vi.mocked(getConfirmedArrangements).mockResolvedValue(arrangements({ startsAt: null, endsAt: null, venues: [], equipment: [] }));
    await open();
    expect(await screen.findByText("No equipment is arranged for this event.")).toBeInTheDocument();
    expect(screen.getByText("No confirmed venue booking is available.")).toBeInTheDocument();
    expect(screen.getByText("Date and time unavailable")).toBeInTheDocument();
  });

  it("SCRUM363_AC7_missing_names_locations_and_quantities_are_understandable", async () => {
    vi.mocked(getConfirmedArrangements).mockResolvedValue(arrangements({ venues: [{ bookingId: "b1", name: null, location: null }], equipment: [{ lineId: "l1", name: null, quantity: null }] }));
    await open();
    expect(await screen.findByText("Venue name unavailable — Location unavailable")).toBeInTheDocument();
    expect(screen.getByText("Equipment type unavailable: Quantity unavailable")).toBeInTheDocument();
  });

  it("SCRUM363_AC7_loading_has_accessible_feedback", async () => {
    const pending = deferred();
    vi.mocked(getConfirmedArrangements).mockReturnValue(pending.promise);
    await open();
    expect(screen.getByRole("status")).toHaveTextContent("Loading confirmed arrangements");
    await act(async () => pending.resolve(arrangements()));
    expect(screen.getByRole("region")).toBeInTheDocument();
  });

  it.each([
    [401, /session has expired/], [403, /event's organiser/], [404, /no longer available/], [500, /could not be loaded/],
  ])("SCRUM363_AC7_HTTP_%s_has_an_accessible_retryable_error", async (status, message) => {
    vi.mocked(getConfirmedArrangements).mockRejectedValueOnce({ response: { status } });
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await userEvent.click(screen.getByRole("button", { name: "Retry arrangements" }));
    expect(await screen.findByRole("region")).toBeInTheDocument();
  });

  it.each([null, { eventRequestId: ID, status: null }, { eventRequestId: ID, status: "confirmed", venues: null }, { eventRequestId: ID, status: "confirmed", venues: [], equipment: null }])(
    "SCRUM363_AC7_malformed_response_%j_is_not_presented_as_confirmed", async (data) => {
      vi.mocked(getConfirmedArrangements).mockResolvedValue(data);
      await open();
      expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    },
  );

  it("SCRUM363_AC7_significant_change_hides_old_confirmation_and_reconfirmation_fetches_latest_arrangements", async () => {
    await open();
    await screen.findByText("Hall A — Level 1");
    vi.mocked(getConfirmedArrangements).mockResolvedValueOnce(arrangements({ status: "approved", statusDisplay: { label: "Planning", group: "APPROVED", description: "Planning again." }, venues: [], equipment: [] }));
    fireEvent.focus(window);
    expect(await screen.findByRole("status")).toHaveTextContent("now Planning");
    expect(screen.queryByText("Hall A — Level 1")).not.toBeInTheDocument();
    vi.mocked(getConfirmedArrangements).mockResolvedValue(arrangements({ startsAt: "2026-12-01T02:00:00Z", endsAt: "2026-12-01T04:00:00Z", venues: [{ bookingId: "b3", name: "New hall", location: "New location" }], equipment: [{ lineId: "l3", name: "Projector", quantity: 5 }] }));
    fireEvent.focus(window);
    expect(await screen.findByText("New hall — New location")).toBeInTheDocument();
    expect(screen.getByText("Projector: 5")).toBeInTheDocument();
    expect(screen.getByText("2026-12-01 10:00 – 12:00 (Singapore time)")).toBeInTheDocument();
    expect(screen.queryByText("Microphone: 3")).not.toBeInTheDocument();
  });

  it("SCRUM363_AC7_refresh_failure_hides_previous_arrangements_and_network_errors_are_safe", async () => {
    await open();
    await screen.findByText("Hall A — Level 1");
    vi.mocked(getConfirmedArrangements).mockRejectedValue(undefined);
    fireEvent.focus(window);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("Hall A — Level 1")).not.toBeInTheDocument();
  });

  it("SCRUM363_AC7_an_older_response_cannot_overwrite_a_newer_refresh", async () => {
    const pending = deferred();
    vi.mocked(getConfirmedArrangements).mockReturnValueOnce(pending.promise).mockResolvedValue(arrangements({ venues: [], equipment: [] }));
    await open();
    fireEvent.focus(window);
    expect(await screen.findByText("No confirmed venue booking is available.")).toBeInTheDocument();
    await act(async () => pending.resolve(arrangements()));
    expect(screen.queryByText("Hall A — Level 1")).not.toBeInTheDocument();
  });

  it.each([false, true])("SCRUM363_AC7_late_response_after_closing_is_ignored_failure_%s", async (failed) => {
    const pending = deferred();
    vi.mocked(getConfirmedArrangements).mockReturnValueOnce(pending.promise);
    await open();
    await userEvent.click(screen.getByText("Confirmed arrangements"));
    await act(async () => failed ? pending.reject(new Error("offline")) : pending.resolve(arrangements()));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    vi.mocked(getConfirmedArrangements).mockResolvedValue(arrangements());
    await userEvent.click(screen.getByText("Confirmed arrangements"));
    expect(await screen.findByRole("region")).toBeInTheDocument();
  });
});
