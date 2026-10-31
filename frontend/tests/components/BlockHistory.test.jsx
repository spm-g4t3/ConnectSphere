// BlockHistory.test.jsx
//
// SCRUM-131 (part of SCRUM-17, AC4: "An existing block can be shortened,
// extended, or removed by Venue Staff, with the creating or amending user and
// timestamp recorded"). One block's change trail.
//
// getVenueBlockHistory is mocked, so nothing touches the network.
// Timezone-safe: every expected time string is built with formatTimestamp /
// sgTime (Singapore time) from fixtures that carry an offset. No fake timers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";

import BlockHistory, { BlockActor } from "../../src/components/BlockHistory.jsx";
import { getVenueBlockHistory } from "../../src/services/venueService";
import { formatTimestamp } from "../../src/services/displayFormat";
import { deferred } from "../helpers/async.js";
import { sgTime } from "../helpers/singaporeTime.js";

vi.mock("../../src/services/venueService", () => ({
  getVenueBlockHistory: vi.fn(),
}));

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const VENUE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const BLOCK_ID = "b1000000-0000-4000-8000-000000000001";
const ME = "d1000000-0000-4000-8000-000000000001";
const OTHER = "d2a3b4c5-0000-4000-8000-000000000002";

const START = "2026-11-01T09:00:00+08:00";
const END = "2026-11-01T17:00:00+08:00";
const LATER_END = "2026-11-02T17:00:00+08:00";

const CREATED = {
  id: "c1000000-0000-4000-8000-000000000001",
  blockId: BLOCK_ID,
  action: "created",
  changedBy: ME,
  changedAt: "2026-10-01T10:00:00+08:00",
  oldValues: {},
  newValues: {
    id: BLOCK_ID,
    venue_id: VENUE_ID,
    starts_at: START,
    ends_at: END,
    reason: "maintenance",
    notes: "Aircon servicing",
    created_at: "2026-10-01T10:00:00+08:00",
    created_by: ME,
    removed_at: null,
    removed_by: null,
  },
};
const AMENDED = {
  id: "c2000000-0000-4000-8000-000000000002",
  blockId: BLOCK_ID,
  action: "amended",
  changedBy: OTHER,
  changedAt: "2026-10-02T11:30:00+08:00",
  oldValues: { ends_at: END, reason: "maintenance", notes: "Aircon servicing" },
  newValues: { ends_at: LATER_END, reason: "renovation", notes: null },
};
const REMOVED = {
  id: "c3000000-0000-4000-8000-000000000003",
  blockId: BLOCK_ID,
  action: "removed",
  changedBy: null,
  changedAt: "2026-10-03T08:15:00+08:00",
  oldValues: { removed_at: null, removed_by: null },
  newValues: { removed_at: "2026-10-03T08:15:00+08:00", removed_by: OTHER },
};
const HISTORY = [REMOVED, AMENDED, CREATED];

const UUID_PROSE = `block ${BLOCK_ID} not found at venue ${VENUE_ID}`;

function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: UUID_PROSE } },
  });
}

const MSG = {
  loading: "Loading history...",
  empty: "No changes have been recorded for this block.",
  help: "Other staff are shown by a short user id — the API records ids, not names.",
  401: "Your session has expired. Please sign in again.",
  403: "Only Venue Staff can see a block's history.",
  404: "That block no longer exists.",
  default: "Could not load this block's history. Please try again.",
};

beforeEach(() => {
  vi.mocked(getVenueBlockHistory).mockReset();
  vi.mocked(getVenueBlockHistory).mockResolvedValue(HISTORY);
});

function renderHistory(props = {}) {
  return render(
    <BlockHistory
      venueId={VENUE_ID}
      blockId={BLOCK_ID}
      refreshKey="k1"
      currentUserId={ME}
      id={`block-history-${BLOCK_ID}`}
      {...props}
    />,
  );
}

async function renderLoaded(props) {
  const utils = renderHistory(props);
  await waitFor(() => expect(screen.queryByText(MSG.loading)).not.toBeInTheDocument());
  return utils;
}

/** The entry <li>s (direct children of the section's list). */
function entryItems() {
  return [...document.querySelectorAll(".block-history > ul > li")];
}

/** The entry whose header names this action label. */
function entryFor(label) {
  return entryItems().find(
    (li) => li.querySelector(".venue-history__meta strong")?.textContent === label,
  );
}

function expectNoUuidInText() {
  expect(document.body.textContent).not.toMatch(UUID_PATTERN);
}

// ---- states ----------------------------------------------------------------

describe("BlockHistory states", () => {
  it("SCRUM17_AC4_fetches_the_blocks_history_once_on_mount", async () => {
    await renderLoaded();
    expect(getVenueBlockHistory).toHaveBeenCalledTimes(1);
    expect(getVenueBlockHistory).toHaveBeenCalledWith(VENUE_ID, BLOCK_ID);
  });

  it("SCRUM17_AC4_is_a_labelled_section_with_the_given_id", async () => {
    await renderLoaded();
    const section = screen.getByRole("region", { name: "Change history" });
    expect(section).toHaveAttribute("id", `block-history-${BLOCK_ID}`);
    expect(section).toHaveClass("block-history");
  });

  it("SCRUM17_AC4_shows_Loading_history_while_the_first_fetch_is_in_flight_and_not_the_empty_state", async () => {
    const pending = deferred();
    vi.mocked(getVenueBlockHistory).mockReturnValue(pending.promise);
    renderHistory();

    expect(screen.getByText(MSG.loading)).toBeInTheDocument();
    expect(screen.queryByText(MSG.empty)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => pending.resolve(HISTORY));
    expect(screen.queryByText(MSG.loading)).not.toBeInTheDocument();
    expect(entryItems()).toHaveLength(3);
  });

  it("SCRUM17_AC4_says_when_no_changes_have_been_recorded", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([]);
    await renderLoaded();
    expect(screen.getByText(MSG.empty)).toBeInTheDocument();
    expect(screen.queryByText(MSG.help)).not.toBeInTheDocument();
    expect(entryItems()).toHaveLength(0);
  });

  it("SCRUM17_AC4_a_non_array_response_is_treated_as_empty", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue({ entries: HISTORY });
    await renderLoaded();
    expect(screen.getByText(MSG.empty)).toBeInTheDocument();
    expect(entryItems()).toHaveLength(0);
  });

  for (const [label, err, message] of [
    ["401", () => httpError(401), MSG[401]],
    ["403", () => httpError(403), MSG[403]],
    ["404", () => httpError(404), MSG[404]],
    ["500", () => httpError(500), MSG.default],
    ["network_error", () => new Error("Network Error"), MSG.default],
  ]) {
    it(`SCRUM17_AC4_a_${label}_shows_its_own_message_and_no_uuid`, async () => {
      vi.mocked(getVenueBlockHistory).mockRejectedValue(err());
      await renderLoaded();

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(screen.queryByText(MSG.empty)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain(UUID_PROSE);
      expectNoUuidInText();
    });
  }

  it("SCRUM17_AC4_shows_the_help_line_under_the_entries", async () => {
    await renderLoaded();
    expect(screen.getByText(MSG.help)).toBeInTheDocument();
  });
});

// ---- entries ---------------------------------------------------------------

describe("BlockHistory entries", () => {
  it("SCRUM17_AC4_keeps_the_servers_newest_first_order", async () => {
    await renderLoaded();
    const labels = entryItems().map(
      (li) => li.querySelector(".venue-history__meta strong").textContent,
    );
    expect(labels).toEqual(["Removed", "Amended", "Created"]);
  });

  it("SCRUM17_AC4_each_header_shows_the_action_and_when", async () => {
    await renderLoaded();
    for (const [label, entry] of [
      ["Created", CREATED],
      ["Amended", AMENDED],
      ["Removed", REMOVED],
    ]) {
      const meta = entryFor(label).querySelector(".venue-history__meta");
      expect(within(meta).getByText(formatTimestamp(entry.changedAt))).toBeInTheDocument();
      expect(within(meta).getByText(sgTime(entry.changedAt))).toBeInTheDocument();
    }
  });

  it("SCRUM17_AC4_a_created_entry_summarises_the_new_block", async () => {
    await renderLoaded();
    const created = entryFor("Created");
    const lines = [...created.querySelectorAll(".venue-history__value")].map((el) => el.textContent);
    expect(lines).toEqual([
      `Start: ${formatTimestamp(START)}`,
      `End: ${formatTimestamp(END)}`,
      "Reason: Maintenance",
      "Notes: Aircon servicing",
    ]);
    // Single text nodes, findable as whole strings.
    expect(within(created).getByText(`Start: ${sgTime(START)}`)).toBeInTheDocument();
    // Hidden keys are not listed.
    expect(created.textContent).not.toMatch(/created_by|venue_id|removed_at/);
  });

  it("SCRUM17_AC4_a_created_entry_with_nothing_visible_says_Block_created", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...CREATED, newValues: { id: BLOCK_ID, created_by: ME } },
    ]);
    await renderLoaded();
    expect(within(entryFor("Created")).getByText("Block created")).toBeInTheDocument();
  });

  it("SCRUM17_AC4_an_amended_entry_shows_each_change_old_to_new", async () => {
    await renderLoaded();
    const amended = entryFor("Amended");
    expect(
      within(amended).getByText(
        `End: ${sgTime(END)} → ${sgTime(LATER_END)}`,
      ),
    ).toBeInTheDocument();
    expect(within(amended).getByText("Reason: Maintenance → Renovation")).toBeInTheDocument();
    expect(within(amended).getByText("Notes: Aircon servicing → (none)")).toBeInTheDocument();
    const order = [...amended.querySelectorAll(".venue-history__value")].map((el) =>
      el.textContent.split(":")[0],
    );
    expect(order).toEqual(["End", "Reason", "Notes"]);
  });

  it("SCRUM17_AC4_a_shortened_start_shows_Start_old_to_new", async () => {
    const newStart = "2026-11-01T12:00:00+08:00";
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...AMENDED, oldValues: { starts_at: START }, newValues: { starts_at: newStart } },
    ]);
    await renderLoaded();
    expect(
      screen.getByText(
        `Start: ${sgTime(START)} → ${sgTime(newStart)}`,
      ),
    ).toBeInTheDocument();
  });

  it("SCRUM17_AC4_an_amended_entry_with_only_hidden_keys_says_No_details_changed", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...AMENDED, oldValues: { updated_at: START }, newValues: { updated_at: END } },
    ]);
    await renderLoaded();
    expect(within(entryFor("Amended")).getByText("No details changed")).toBeInTheDocument();
  });

  it("SCRUM17_AC4_a_removed_entry_says_Block_removed", async () => {
    await renderLoaded();
    const removed = entryFor("Removed");
    expect(within(removed).getByText("Block removed")).toBeInTheDocument();
    // removed_at / removed_by are hidden, so nothing else is listed.
    expect(removed.querySelectorAll(".venue-history__value")).toHaveLength(1);
  });

  it("SCRUM17_AC4_a_removed_entry_also_lists_visible_changes", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...REMOVED, oldValues: { notes: "x", removed_at: null }, newValues: { notes: "y", removed_at: END } },
    ]);
    await renderLoaded();
    const removed = entryFor("Removed");
    expect(within(removed).getByText("Block removed")).toBeInTheDocument();
    expect(within(removed).getByText("Notes: x → y")).toBeInTheDocument();
  });

  it("SCRUM17_AC4_an_entry_of_unknown_shape_is_shown_raw_not_dropped", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...AMENDED, oldValues: ["a"], newValues: { notes: "b" } },
    ]);
    await renderLoaded();
    const amended = entryFor("Amended");
    expect(amended).toBeDefined();
    expect(amended.querySelector("pre.venue-history__value").textContent).toBe(
      '["a"] → {"notes":"b"}',
    );
  });

  it("SCRUM17_AC4_an_unknown_action_shows_raw_and_a_missing_one_reads_Changed", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      { ...AMENDED, id: "u1", action: "restored" },
      { ...AMENDED, id: "u2", action: null },
    ]);
    await renderLoaded();
    expect(entryFor("restored")).toBeDefined();
    expect(entryFor("Changed")).toBeDefined();
  });

  it("SCRUM17_AC4_a_missing_changedAt_reads_unknown", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([{ ...AMENDED, changedAt: null }]);
    await renderLoaded();
    const meta = entryFor("Amended").querySelector(".venue-history__meta");
    expect(within(meta).getByText("unknown")).toBeInTheDocument();
  });

  it("SCRUM17_AC4_a_null_entry_does_not_blank_the_trail", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([null, AMENDED]);
    await renderLoaded();
    expect(entryItems()).toHaveLength(2);
    expect(within(entryFor("Amended")).getByText("Reason: Maintenance → Renovation")).toBeInTheDocument();
  });
});

// ---- actors ----------------------------------------------------------------

describe("BlockHistory actors", () => {
  it("SCRUM17_AC4_the_signed_in_users_change_reads_by_you", async () => {
    await renderLoaded();
    const meta = entryFor("Created").querySelector(".venue-history__meta");
    expect(within(meta).getByText("by you")).toBeInTheDocument();
    expect(meta.querySelector("code")).toBeNull();
  });

  it("SCRUM17_AC4_another_users_change_reads_by_a_short_id_with_the_full_id_in_a_title", async () => {
    await renderLoaded();
    const meta = entryFor("Amended").querySelector(".venue-history__meta");
    const code = meta.querySelector("code");
    expect(code).toHaveTextContent("d2a3b4c5");
    expect(code).toHaveAttribute("title", OTHER);
    expect(meta.textContent).toContain("by d2a3b4c5");
    expect(meta.textContent).not.toContain(OTHER);
  });

  it("SCRUM17_AC4_a_null_changedBy_reads_Changed_outside_the_app", async () => {
    await renderLoaded();
    const meta = entryFor("Removed").querySelector(".venue-history__meta");
    expect(within(meta).getByText("Changed outside the app")).toBeInTheDocument();
  });

  it("SCRUM17_AC4_without_a_currentUserId_the_users_own_change_is_a_short_id", async () => {
    await renderLoaded({ currentUserId: undefined });
    const meta = entryFor("Created").querySelector(".venue-history__meta");
    expect(within(meta).queryByText("by you")).not.toBeInTheDocument();
    expect(meta.querySelector("code")).toHaveAttribute("title", ME);
    expect(meta.querySelector("code")).toHaveTextContent("d1000000");
  });

  it("SCRUM17_AC4_no_full_uuid_appears_in_the_rendered_text", async () => {
    await renderLoaded();
    expectNoUuidInText();
  });
});

describe("BlockActor", () => {
  it("SCRUM17_AC4_renders_you_a_short_id_or_the_outside_text", () => {
    const { rerender, container } = render(<BlockActor id={ME} currentUserId={ME} />);
    expect(container.textContent).toBe("by you");

    rerender(<BlockActor id={OTHER} currentUserId={ME} />);
    expect(container.textContent).toBe("by d2a3b4c5");
    expect(container.querySelector("code")).toHaveAttribute("title", OTHER);

    rerender(<BlockActor id={null} currentUserId={ME} />);
    expect(container.textContent).toBe("outside the app");

    rerender(<BlockActor id={null} currentUserId={ME} outsideText="Changed outside the app" />);
    expect(container.textContent).toBe("Changed outside the app");
  });
});

// ---- refetch and races -----------------------------------------------------

describe("BlockHistory refetch", () => {
  it("SCRUM17_AC4_a_new_refreshKey_refetches_and_shows_the_new_entries", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValueOnce([CREATED]);
    const { rerender } = await renderLoaded();
    expect(entryItems()).toHaveLength(1);

    vi.mocked(getVenueBlockHistory).mockResolvedValueOnce([AMENDED, CREATED]);
    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );

    await waitFor(() => expect(entryItems()).toHaveLength(2));
    expect(getVenueBlockHistory).toHaveBeenCalledTimes(2);
    expect(getVenueBlockHistory).toHaveBeenLastCalledWith(VENUE_ID, BLOCK_ID);
  });

  it("SCRUM17_AC4_the_same_refreshKey_does_not_refetch", async () => {
    const { rerender } = await renderLoaded();
    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k1" currentUserId={ME} />,
    );
    expect(getVenueBlockHistory).toHaveBeenCalledTimes(1);
  });

  it("SCRUM17_AC4_does_not_show_Loading_history_above_existing_entries_during_a_refetch", async () => {
    const { rerender } = await renderLoaded();
    const refetch = deferred();
    vi.mocked(getVenueBlockHistory).mockReturnValueOnce(refetch.promise);

    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );
    expect(getVenueBlockHistory).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(MSG.loading)).not.toBeInTheDocument();
    expect(entryItems()).toHaveLength(3);

    await act(async () => refetch.resolve([CREATED]));
    expect(entryItems()).toHaveLength(1);
  });

  it("SCRUM17_AC4_a_failed_refetch_keeps_the_old_entries_and_shows_an_alert", async () => {
    const { rerender } = await renderLoaded();
    vi.mocked(getVenueBlockHistory).mockRejectedValueOnce(httpError(500));

    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(MSG.default));
    expect(entryItems()).toHaveLength(3);
    expect(screen.queryByText(MSG.empty)).not.toBeInTheDocument();
    expectNoUuidInText();
  });

  it("SCRUM17_AC4_a_successful_refetch_clears_an_earlier_error", async () => {
    vi.mocked(getVenueBlockHistory).mockRejectedValueOnce(httpError(500));
    const { rerender } = await renderLoaded();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );
    await waitFor(() => expect(entryItems()).toHaveLength(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM17_AC4_a_stale_response_is_ignored", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(getVenueBlockHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = renderHistory();
    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );
    expect(getVenueBlockHistory).toHaveBeenCalledTimes(2);

    // The newer request answers first...
    await act(async () => second.resolve([AMENDED, CREATED]));
    expect(entryItems()).toHaveLength(2);

    // ...then the older one, which must not overwrite it.
    await act(async () => first.resolve([CREATED]));
    expect(entryItems()).toHaveLength(2);
    expect(entryFor("Amended")).toBeDefined();
  });

  it("SCRUM17_AC4_a_stale_error_is_ignored", async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(getVenueBlockHistory)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = renderHistory();
    rerender(
      <BlockHistory venueId={VENUE_ID} blockId={BLOCK_ID} refreshKey="k2" currentUserId={ME} />,
    );

    await act(async () => second.resolve(HISTORY));
    await act(async () => first.reject(httpError(500)));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(entryItems()).toHaveLength(3);
  });

  it("SCRUM17_AC4_a_response_after_unmount_is_ignored_without_errors", async () => {
    const pending = deferred();
    vi.mocked(getVenueBlockHistory).mockReturnValue(pending.promise);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHistory();
    unmount();
    await act(async () => pending.resolve(HISTORY));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("BlockHistory coverage gaps (SCRUM-132)", () => {
  it("SCRUM17_AC4_an_entry_whose_values_JSON_cannot_serialise_is_still_shown_raw", async () => {
    vi.mocked(getVenueBlockHistory).mockResolvedValue([
      {
        ...AMENDED,
        // Neither is a plain object, so the entry is shown raw. A BigInt makes
        // JSON.stringify throw; a Symbol makes it return undefined.
        oldValues: 10n,
        newValues: Symbol("odd"),
      },
    ]);

    await renderLoaded();

    const entry = entryFor("Amended");
    const pre = entry.querySelector("pre.venue-history__value");
    expect(pre).not.toBeNull();
    expect(pre.textContent).toBe("10 → Symbol(odd)");
  });
});
