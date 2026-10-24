// scrum387EventChangeHistory.test.jsx
//
// SCRUM-387 (SCRUM-392, AC7): one event's change history as the server sends
// it, newest first, each entry in words.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import EventChangeHistory from "../../src/components/EventChangeHistory.jsx";
import { getEventChangeHistory } from "../../src/services/eventRequestService";
import { formatMediumTimestamp, formatTimestamp } from "../../src/services/displayFormat.js";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventChangeHistory: vi.fn(),
}));

const entry = (overrides) => ({
  id: "h1",
  field: "purpose",
  oldValue: "Networking",
  newValue: "Alumni networking",
  reason: "Organiser asked by email",
  source: "direct_edit",
  changedByName: "Priya Nair",
  changedAt: "2026-10-21T03:00:00Z",
  ...overrides,
});

const items = () => screen.getAllByRole("listitem");

beforeEach(() => {
  vi.mocked(getEventChangeHistory).mockReset();
});

describe("SCRUM-387 the change history", () => {
  it("SCRUM387_AC7_each_entry_names_the_field_both_values_who_when_why_and_its_source", async () => {
    vi.mocked(getEventChangeHistory).mockResolvedValue([entry()]);

    render(<EventChangeHistory eventRequestId="e1" />);

    const item = (await screen.findAllByRole("listitem"))[0];
    expect(within(item).getByText("Purpose")).toBeInTheDocument();
    expect(within(item).getByText("Edited")).toBeInTheDocument();
    expect(item).toHaveTextContent("Networking → Alumni networking");
    expect(item).toHaveTextContent(`Priya Nair, ${formatMediumTimestamp("2026-10-21T03:00:00Z")}`);
    expect(item).toHaveTextContent("Reason: Organiser asked by email");
    expect(getEventChangeHistory).toHaveBeenCalledWith("e1");
  });

  it("SCRUM387_AC7_keeps_the_servers_newest_first_order", async () => {
    vi.mocked(getEventChangeHistory).mockResolvedValue([
      entry({ id: "h3", field: "description", changedAt: "2026-10-20T03:00:00Z" }),
      entry({ id: "h2", field: "eventName", changedAt: "2026-10-22T03:00:00Z" }),
      entry({ id: "h1", field: "purpose", changedAt: "2026-10-21T03:00:00Z" }),
    ]);

    render(<EventChangeHistory eventRequestId="e1" />);

    await screen.findAllByRole("listitem");
    expect(items().map((li) => li.querySelector("strong").textContent)).toEqual(["Description", "Event name", "Purpose"]);
  });

  it("SCRUM387_AC7_timestamps_attendance_empty_values_and_395s_equipment_read_as_words", async () => {
    vi.mocked(getEventChangeHistory).mockResolvedValue([
      entry({ id: "a", field: "proposedStart", oldValue: "2026-12-01T09:00:00Z", newValue: "2026-12-02T09:00:00Z", source: "significant_change" }),
      entry({ id: "b", field: "expectedAttendance", oldValue: 100, newValue: 150 }),
      entry({ id: "c", field: "description", oldValue: null, newValue: "" }),
      entry({ id: "d", field: "equipment", oldValue: { changeRequested: false }, newValue: { changeRequested: true }, source: "significant_change" }),
      entry({ id: "e", field: "venueRequirements", oldValue: { rooms: 2 }, newValue: "One hall" }),
    ]);

    render(<EventChangeHistory eventRequestId="e1" />);

    await screen.findAllByRole("listitem");
    const [start, attendance, description, equipment, odd] = items();
    expect(start).toHaveTextContent(`${formatTimestamp("2026-12-01T09:00:00Z")} → ${formatTimestamp("2026-12-02T09:00:00Z")}`);
    expect(within(start).getByText("Significant change")).toBeInTheDocument();
    expect(attendance).toHaveTextContent("100 → 150");
    expect(description).toHaveTextContent("Not specified → Not specified");
    expect(within(equipment).getByText("Equipment")).toBeInTheDocument();
    expect(equipment).toHaveTextContent("No equipment change → Equipment change requested");
    expect(odd).toHaveTextContent('{"rooms":2} → One hall');
  });

  it.each([
    ["change_request", "Change request"],
    [null, "Recorded"],
  ])("SCRUM387_AC7_a_source_this_build_does_not_know_(%s)_still_reads", async (source, label) => {
    vi.mocked(getEventChangeHistory).mockResolvedValue([entry({ source })]);

    render(<EventChangeHistory eventRequestId="e1" />);

    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("SCRUM387_AC7_a_missing_name_time_or_reason_still_reads", async () => {
    vi.mocked(getEventChangeHistory).mockResolvedValue([entry({ changedByName: null, changedAt: null, reason: "" })]);

    render(<EventChangeHistory eventRequestId="e1" />);

    const item = (await screen.findAllByRole("listitem"))[0];
    expect(item).toHaveTextContent("A coordinator with no name on record, at an unrecorded time");
    expect(item).toHaveTextContent("Reason: No reason was recorded.");
  });

  it("SCRUM387_AC7_says_loading_then_that_nothing_has_been_recorded", async () => {
    const pending = deferred();
    vi.mocked(getEventChangeHistory).mockReturnValue(pending.promise);

    render(<EventChangeHistory eventRequestId="e1" />);
    expect(screen.getByText("Loading change history...")).toBeInTheDocument();

    pending.resolve([]);
    expect(await screen.findByText("No changes have been recorded.")).toBeInTheDocument();
  });

  it("SCRUM387_AC7_a_failed_read_is_one_alert_line", async () => {
    vi.mocked(getEventChangeHistory).mockRejectedValue(new Error("boom"));

    render(<EventChangeHistory eventRequestId="e1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The change history could not be loaded.");
  });

  it("SCRUM387_AC7_a_read_that_lands_after_unmounting_is_ignored", async () => {
    const pending = deferred();
    const failing = deferred();
    vi.mocked(getEventChangeHistory).mockReturnValueOnce(pending.promise).mockReturnValueOnce(failing.promise);

    const first = render(<EventChangeHistory eventRequestId="e1" />);
    first.unmount();
    const second = render(<EventChangeHistory eventRequestId="e2" />);
    second.unmount();
    pending.resolve([entry()]);
    failing.reject(new Error("late"));
    await Promise.allSettled([pending.promise, failing.promise]);

    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
