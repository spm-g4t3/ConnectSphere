import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EventConfirmationPanel from "../../src/components/EventConfirmationPanel";
import { confirmEventRequest, getEventReadiness } from "../../src/services/eventRequestService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({ confirmEventRequest: vi.fn(), getEventReadiness: vi.fn() }));

const EVENT = { id: "event-1", status: "safety_approved" };
const READY = { eventRequestId: EVENT.id, ready: true, items: [
  { key: "venue", met: true, detail: "Approved", bookingId: "b1", venueName: "Hall A" },
  { key: "equipment", met: true, detail: "Arranged", equipmentRequestId: "e1" },
  { key: "date", met: true, detail: "Starts in the future" },
] };
const CONFIRMED = { ...EVENT, status: "confirmed" };
const ACK = { key: "no_equipment_confirmation", met: false, detail: "Confirm that this event needs no equipment", organiserRequirements: "Projectors" };
const button = () => screen.getByRole("button", { name: /Confirm Event|Confirming/ });
const failure = (status, data) => ({ response: { status, data } });
function setup(props = {}) {
  const onConfirmed = vi.fn();
  const onStale = vi.fn();
  return { onConfirmed, onStale, ...render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={onConfirmed} onStale={onStale} {...props} />) };
}
async function ready() { await waitFor(() => expect(button()).toBeEnabled()); }

beforeEach(() => {
  vi.mocked(getEventReadiness).mockReset().mockResolvedValue(READY);
  vi.mocked(confirmEventRequest).mockReset().mockResolvedValue(CONFIRMED);
});

describe("SCRUM-363: confirmation panel", () => {
  it("SCRUM363_AC4_shows_every_server_condition_and_refuses_outstanding_readiness", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue({ ...READY, ready: false, items: [
      ...READY.items,
      { key: "venue", met: false, detail: "Flagged for review", bookingId: "b2", venueName: "Room 2" },
      { key: "equipment", met: false, detail: "Pending review", equipmentRequestId: "e2" },
      { key: "unknown", met: false, detail: "Additional server condition" },
    ] });
    setup();
    const table = await screen.findByRole("table", { name: "Readiness checklist" });
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(table).toHaveTextContent("Venue: Hall A");
    expect(table).toHaveTextContent("Venue: Room 2");
    expect(table).toHaveTextContent("Other");
    expect(within(table).getAllByText("Met")).toHaveLength(3);
    expect(within(table).getAllByText("Outstanding")).toHaveLength(3);
    expect(button()).toBeDisabled();
    fireEvent.submit(button().closest("form"));
    expect(confirmEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM363_AC4_loading_a_checklist_prevents_submission", async () => {
    const pending = deferred();
    vi.mocked(getEventReadiness).mockReturnValue(pending.promise);
    setup();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the readiness checklist");
    expect(button()).toBeDisabled();
    await act(async () => pending.resolve(READY));
    await ready();
    expect(getEventReadiness).toHaveBeenCalledWith(EVENT.id, { noEquipmentConfirmed: false });
  });

  it.each([null, failure(401), failure(403), failure(404)])("SCRUM363_AC4_failed_read_%j_can_be_retried", async (error) => {
    vi.mocked(getEventReadiness).mockRejectedValueOnce(error);
    setup();
    expect(await screen.findByRole("alert")).not.toBeEmptyDOMElement();
    expect(button()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry checklist" }));
    await ready();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([null, { eventRequestId: EVENT.id, ready: "yes", items: [] }, { eventRequestId: EVENT.id, ready: true, items: null }])(
    "SCRUM363_AC4_unexpected_readiness_%j_shows_a_retryable_error", async (result) => {
      vi.mocked(getEventReadiness).mockResolvedValueOnce(result);
      setup();
      expect(await screen.findByRole("alert")).toHaveTextContent("checklist could not be loaded");
      expect(button()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Retry checklist" })).toBeInTheDocument();
    },
  );

  it("SCRUM363_AC5_requires_explicit_acknowledgement_and_server_recheck_in_both_directions", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue({ ...READY, items: [ACK] });
    const { onConfirmed } = setup();
    const checkbox = await screen.findByRole("checkbox", { name: "The organiser mentioned equipment, but none is needed for this event" });
    expect(checkbox).not.toBeChecked();
    expect(button()).toBeDisabled();
    expect(screen.getByText("Projectors")).toBeInTheDocument();
    const pending = deferred();
    vi.mocked(getEventReadiness).mockReturnValueOnce(pending.promise);
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(button()).toBeDisabled();
    await act(async () => pending.resolve({ ...READY, items: [{ ...ACK, met: true }] }));
    await ready();
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(button()).toBeDisabled();
    expect(getEventReadiness).toHaveBeenLastCalledWith(EVENT.id, { noEquipmentConfirmed: false });
    vi.mocked(getEventReadiness).mockResolvedValue({ ...READY, items: [{ ...ACK, met: true }] });
    await userEvent.click(checkbox);
    await ready();
    await userEvent.click(button());
    expect(confirmEventRequest).toHaveBeenCalledWith(EVENT.id, { noEquipmentConfirmed: true });
    expect(onConfirmed).toHaveBeenCalledWith(CONFIRMED);
  });

  it("SCRUM363_AC6_success_uses_the_server_response_and_blocks_repeated_submissions", async () => {
    const pending = deferred();
    vi.mocked(confirmEventRequest).mockReturnValue(pending.promise);
    const { onConfirmed } = setup();
    await ready();
    const form = button().closest("form");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(button()).toHaveTextContent("Confirming...");
    expect(form).toHaveAttribute("aria-busy", "true");
    expect(button()).toBeDisabled();
    expect(confirmEventRequest).toHaveBeenCalledTimes(1);
    expect(confirmEventRequest).toHaveBeenCalledWith(EVENT.id, { noEquipmentConfirmed: false });
    await act(async () => pending.resolve(CONFIRMED));
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith(CONFIRMED);
    fireEvent.submit(form);
    expect(confirmEventRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM363_AC5_a_new_event_revision_clears_the_checkbox_and_rechecks_without_replaying_acknowledgement", async () => {
    vi.mocked(getEventReadiness).mockImplementation(async (_id, { noEquipmentConfirmed }) => ({
      ...READY, ready: noEquipmentConfirmed, items: [{ ...ACK, met: noEquipmentConfirmed }],
    }));
    const onConfirmed = vi.fn();
    const onStale = vi.fn();
    const initial = { ...EVENT, updatedAt: '2026-11-01T00:00:00.000Z' };
    const { rerender } = setup({ eventRequest: initial, onConfirmed, onStale });
    const checkbox = await screen.findByRole('checkbox');
    await userEvent.click(checkbox);
    await ready();
    const fresh = { ...initial, updatedAt: '2026-11-02T00:00:00.000Z' };
    rerender(<EventConfirmationPanel eventRequest={fresh} onConfirmed={onConfirmed} onStale={onStale} />);
    expect(checkbox).not.toBeChecked();
    expect(button()).toBeDisabled();
    await waitFor(() => expect(getEventReadiness).toHaveBeenLastCalledWith(EVENT.id, { noEquipmentConfirmed: false }));
    await waitFor(() => expect(checkbox).toBeEnabled());
    await userEvent.click(checkbox);
    await ready();
    await userEvent.click(button());
    expect(confirmEventRequest).toHaveBeenCalledWith(EVENT.id, { noEquipmentConfirmed: true, expectedUpdatedAt: fresh.updatedAt });
  });

  it.each([false, true])("SCRUM363_AC6_a_late_submission_for_an_old_revision_is_ignored_failure_%s", async (failed) => {
    const pending = deferred();
    vi.mocked(confirmEventRequest).mockReturnValue(pending.promise);
    const { onConfirmed, onStale, rerender } = setup({ eventRequest: { ...EVENT, updatedAt: "2026-11-01T00:00:00Z" } });
    await ready();
    await userEvent.click(button());
    rerender(<EventConfirmationPanel eventRequest={{ ...EVENT, updatedAt: "2026-11-02T00:00:00Z" }} onConfirmed={onConfirmed} onStale={onStale} />);
    await act(async () => failed ? pending.reject(failure(409)) : pending.resolve(CONFIRMED));
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
    await ready();
  });

  it("SCRUM363_AC3_a_fresh_revision_clears_obsolete_refusals_and_allows_a_new_attempt", async () => {
    vi.mocked(confirmEventRequest).mockRejectedValue(failure(409, { error: "This event has changed. Refresh its checklist." }));
    const { onConfirmed, onStale, rerender } = setup({ eventRequest: { ...EVENT, updatedAt: "2026-11-01T00:00:00Z" } });
    await ready();
    await userEvent.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("This event has changed");
    expect(button()).toBeDisabled();
    rerender(<EventConfirmationPanel eventRequest={{ ...EVENT, updatedAt: "2026-11-02T00:00:00Z" }} onConfirmed={onConfirmed} onStale={onStale} />);
    await ready();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM363_AC3_lists_all_outstanding_items_and_refreshes_after_stale_readiness", async () => {
    const conflicts = [{ key: "venue", met: false, detail: "Flagged for review" }, { key: "equipment", met: false, detail: "Pending review" }];
    vi.mocked(confirmEventRequest).mockRejectedValue(failure(409, { code: "EVENT_NOT_READY", error: "This event is not ready for confirmation.", conflicts }));
    const { onStale, onConfirmed } = setup();
    await ready();
    vi.mocked(getEventReadiness).mockResolvedValue({ ...READY, ready: false, items: conflicts });
    await userEvent.click(button());
    const outstanding = await screen.findByRole("table", { name: "Still outstanding" });
    expect(outstanding).toHaveTextContent("Flagged for review");
    expect(outstanding).toHaveTextContent("Pending review");
    expect(within(outstanding).getByText("Venue")).toBeInTheDocument();
    await waitFor(() => expect(getEventReadiness).toHaveBeenCalledTimes(2));
    expect(onStale).toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(button()).toBeDisabled();
  });

  it("SCRUM363_AC3_malformed_conflicts_do_not_hide_the_refusal_or_failed_refresh", async () => {
    vi.mocked(confirmEventRequest).mockRejectedValue(failure(409, { code: "EVENT_NOT_READY" }));
    setup({ onStale: undefined });
    await ready();
    vi.mocked(getEventReadiness).mockRejectedValue(new Error("offline"));
    await userEvent.click(button());
    expect(await screen.findByRole("table", { name: "Still outstanding" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Retry checklist" })).toBeInTheDocument();
    expect(button()).toBeDisabled();
  });

  it.each([
    [failure(403), /assigned Event Coordinator/],
    [failure(404), /no longer available/],
    [failure(409, { error: "Its current status is confirmed." }), /current status is confirmed/],
    [failure(400, { error: "Invalid acknowledgement" }), /Invalid acknowledgement/],
    [failure(500), /could not be verified/],
    [new Error("Network Error"), /could not be verified/],
    [undefined, /could not be verified/],
  ])("SCRUM363_AC3_submission_failure_%j_never_confirms", async (error, message) => {
    vi.mocked(confirmEventRequest).mockRejectedValue(error);
    const refresh = vi.fn().mockRejectedValue(new Error("refresh failed"));
    const { onConfirmed } = setup({ onStale: refresh });
    await ready();
    await userEvent.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onConfirmed).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByText("Event confirmed successfully.")).not.toBeInTheDocument();
    if ([401, 403, 404, 409].includes(error?.response?.status)) expect(button()).toBeDisabled();
  });

  it.each([undefined, { id: EVENT.id, status: "safety_approved" }])("SCRUM363_AC6_unexpected_success_payload_%j_is_not_a_confirmation", async (data) => {
    vi.mocked(confirmEventRequest).mockResolvedValue(data);
    const { onConfirmed } = setup();
    await ready();
    await userEvent.click(button());
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be verified");
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it.each(["read", "read_failure", "success", "failure"])("SCRUM363_AC6_late_%s_after_leaving_the_event_is_ignored", async (kind) => {
    const pending = deferred();
    const reading = kind.startsWith("read");
    if (reading) vi.mocked(getEventReadiness).mockReturnValue(pending.promise);
    else vi.mocked(confirmEventRequest).mockReturnValue(pending.promise);
    const { unmount, onConfirmed, onStale } = setup();
    if (!reading) {
      await ready();
      await userEvent.click(button());
    }
    unmount();
    await act(async () => kind.endsWith("failure") ? pending.reject(new Error("offline")) : pending.resolve(reading ? READY : CONFIRMED));
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });
});
