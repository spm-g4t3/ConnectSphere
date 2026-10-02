// venueBlockHistoryDisplay.test.js
//
// SCRUM-131 (part of SCRUM-17, AC4: "with the creating or amending user and
// timestamp recorded"). The pure helpers that turn a block's history rows and
// its own audit fields into text.
//
// Timezone-safe: every expected time string is built here with
// new Date(x).toLocaleString() from fixtures that carry an offset, so the suite
// passes in any zone. None of these helpers may throw, so the hostile-value
// tests matter as much as the happy ones.

import { describe, it, expect } from "vitest";

import {
  BLOCK_HISTORY_ACTION_LABELS,
  BLOCK_HISTORY_FIELD_LABELS,
  HIDDEN_KEYS,
  blockAuditSummary,
  blockCreationSummary,
  blockHistoryActionLabel,
  blockHistoryChanges,
  blockHistoryFieldLabel,
  formatBlockHistoryValue,
  isCurrentUser,
} from "../../src/services/venueBlockHistoryDisplay.js";

const START = "2026-11-01T09:00:00+08:00";
const END = "2026-11-01T17:00:00+08:00";
const LATER_END = "2026-11-02T17:00:00+08:00";
const USER_A = "d1000000-0000-4000-8000-000000000001";
const USER_B = "d2000000-0000-4000-8000-000000000002";

/** Expected rendering of an instant, in whatever zone the suite runs in. */
function local(iso) {
  return new Date(iso).toLocaleString();
}

describe("blockHistoryActionLabel", () => {
  it("SCRUM17_AC4_labels_the_three_actions", () => {
    expect(blockHistoryActionLabel("created")).toBe("Created");
    expect(blockHistoryActionLabel("amended")).toBe("Amended");
    expect(blockHistoryActionLabel("removed")).toBe("Removed");
  });

  it("SCRUM17_AC4_a_missing_action_reads_Changed", () => {
    expect(blockHistoryActionLabel(null)).toBe("Changed");
    expect(blockHistoryActionLabel(undefined)).toBe("Changed");
    expect(blockHistoryActionLabel("")).toBe("Changed");
  });

  it("SCRUM17_AC4_a_whitespace_only_action_is_never_shown_blank", () => {
    // The docstring promises "never blank"; a whitespace action renders blank.
    expect(blockHistoryActionLabel("   ").trim()).not.toBe("");
  });

  it("SCRUM17_AC4_an_unknown_action_shows_raw", () => {
    expect(blockHistoryActionLabel("restored")).toBe("restored");
    expect(blockHistoryActionLabel(5)).toBe("5");
  });

  it("SCRUM17_AC4_inherited_object_keys_are_not_treated_as_labels", () => {
    expect(blockHistoryActionLabel("toString")).toBe("toString");
    expect(blockHistoryActionLabel("constructor")).toBe("constructor");
    expect(blockHistoryActionLabel("__proto__")).toBe("__proto__");
  });

  it("the label table is frozen", () => {
    expect(Object.isFrozen(BLOCK_HISTORY_ACTION_LABELS)).toBe(true);
  });
});

describe("blockHistoryFieldLabel", () => {
  it("SCRUM17_AC4_labels_the_four_editable_fields", () => {
    expect(blockHistoryFieldLabel("starts_at")).toBe("Start");
    expect(blockHistoryFieldLabel("ends_at")).toBe("End");
    expect(blockHistoryFieldLabel("reason")).toBe("Reason");
    expect(blockHistoryFieldLabel("notes")).toBe("Notes");
  });

  it("SCRUM17_AC4_an_unknown_or_inherited_key_shows_raw", () => {
    expect(blockHistoryFieldLabel("colour")).toBe("colour");
    expect(blockHistoryFieldLabel("toString")).toBe("toString");
    expect(blockHistoryFieldLabel("hasOwnProperty")).toBe("hasOwnProperty");
  });

  it("the label table is frozen", () => {
    expect(Object.isFrozen(BLOCK_HISTORY_FIELD_LABELS)).toBe(true);
  });
});

describe("HIDDEN_KEYS", () => {
  it("SCRUM17_AC4_hides_ids_and_the_who_and_when_columns", () => {
    expect([...HIDDEN_KEYS].sort()).toEqual(
      [
        "created_at",
        "created_by",
        "id",
        "last_modified_by",
        "removed_at",
        "removed_by",
        "updated_at",
        "venue_id",
      ].sort(),
    );
    expect(Object.isFrozen(HIDDEN_KEYS)).toBe(true);
  });
});

describe("formatBlockHistoryValue", () => {
  it("SCRUM17_AC4_formats_times_in_the_readers_locale", () => {
    expect(formatBlockHistoryValue("starts_at", START)).toBe(local(START));
    expect(formatBlockHistoryValue("ends_at", END)).toBe(local(END));
  });

  it("SCRUM17_AC4_an_unparseable_time_shows_raw", () => {
    expect(formatBlockHistoryValue("starts_at", "garbage")).toBe("garbage");
  });

  it("SCRUM17_AC4_labels_a_known_reason_and_shows_an_unknown_one_raw", () => {
    expect(formatBlockHistoryValue("reason", "maintenance")).toBe("Maintenance");
    expect(formatBlockHistoryValue("reason", "internal_activity")).toBe("Internal activity");
    expect(formatBlockHistoryValue("reason", "unknown_code")).toBe("unknown_code");
  });

  it("SCRUM17_AC4_null_undefined_and_blank_read_none", () => {
    for (const key of ["starts_at", "ends_at", "reason", "notes", "colour"]) {
      expect(formatBlockHistoryValue(key, null)).toBe("(none)");
      expect(formatBlockHistoryValue(key, undefined)).toBe("(none)");
      expect(formatBlockHistoryValue(key, "")).toBe("(none)");
      expect(formatBlockHistoryValue(key, "  ")).toBe("(none)");
    }
  });

  it("SCRUM17_AC4_plain_values_are_shown_as_text", () => {
    expect(formatBlockHistoryValue("notes", "Aircon servicing")).toBe("Aircon servicing");
    expect(formatBlockHistoryValue("notes", 0)).toBe("0");
    expect(formatBlockHistoryValue("notes", false)).toBe("false");
  });

  it("SCRUM17_AC4_objects_and_arrays_are_shown_as_json", () => {
    expect(formatBlockHistoryValue("x", { a: 1 })).toBe('{"a":1}');
    expect(formatBlockHistoryValue("x", [1, "b"])).toBe('[1,"b"]');
  });

  it("SCRUM17_AC4_never_throws_on_hostile_values", () => {
    const circular = {};
    circular.self = circular;
    expect(() => formatBlockHistoryValue("x", circular)).not.toThrow();
    expect(typeof formatBlockHistoryValue("x", circular)).toBe("string");

    const hostile = {
      toJSON() {
        throw new Error("no json");
      },
      toString() {
        throw new Error("no string");
      },
    };
    expect(formatBlockHistoryValue("x", hostile)).toBe("(none)");

    const nullProto = Object.create(null);
    expect(() => formatBlockHistoryValue("starts_at", nullProto)).not.toThrow();
    expect(formatBlockHistoryValue("x", Symbol("s"))).toBe("Symbol(s)");
    expect(formatBlockHistoryValue("x", 10n)).toBe("10");
  });
});

describe("blockHistoryChanges", () => {
  it("SCRUM17_AC4_an_extension_lists_End_old_to_new", () => {
    const changes = blockHistoryChanges({
      action: "amended",
      oldValues: { ends_at: END },
      newValues: { ends_at: LATER_END },
    });
    expect(changes).toEqual([
      { key: "ends_at", label: "End", from: local(END), to: local(LATER_END) },
    ]);
  });

  it("SCRUM17_AC4_hidden_keys_are_dropped", () => {
    const hidden = Object.fromEntries(HIDDEN_KEYS.map((key) => [key, "x"]));
    const changes = blockHistoryChanges({
      action: "amended",
      oldValues: { ...hidden, reason: "maintenance" },
      newValues: { ...hidden, reason: "renovation" },
    });
    expect(changes).toEqual([
      { key: "reason", label: "Reason", from: "Maintenance", to: "Renovation" },
    ]);
  });

  it("SCRUM17_AC4_lists_start_end_reason_notes_then_unknown_keys_in_the_order_found", () => {
    const changes = blockHistoryChanges({
      action: "amended",
      oldValues: { omega: 1, notes: "a", starts_at: START },
      newValues: { zeta: 1, notes: "b", reason: "safety", ends_at: END, alpha: 2, starts_at: START },
    });
    expect(changes.map((c) => c.key)).toEqual([
      "starts_at",
      "ends_at",
      "reason",
      "notes",
      "zeta",
      "alpha",
      "omega",
    ]);
  });

  it("SCRUM17_AC4_a_cleared_note_reads_none_and_a_missing_side_reads_none", () => {
    const changes = blockHistoryChanges({
      action: "amended",
      oldValues: { notes: "Aircon servicing" },
      newValues: { notes: null, reason: "other" },
    });
    expect(changes).toEqual([
      { key: "reason", label: "Reason", from: "(none)", to: "Other" },
      { key: "notes", label: "Notes", from: "Aircon servicing", to: "(none)" },
    ]);
  });

  it("SCRUM17_AC4_a_removal_with_only_hidden_keys_lists_no_changes", () => {
    expect(
      blockHistoryChanges({
        action: "removed",
        oldValues: { removed_at: null, removed_by: null },
        newValues: { removed_at: END, removed_by: USER_A },
      }),
    ).toEqual([]);
  });

  it("SCRUM17_AC4_returns_null_for_an_unknown_shape", () => {
    expect(blockHistoryChanges(null)).toBeNull();
    expect(blockHistoryChanges(undefined)).toBeNull();
    expect(blockHistoryChanges({})).toBeNull();
    expect(blockHistoryChanges({ oldValues: null, newValues: {} })).toBeNull();
    expect(blockHistoryChanges({ oldValues: {}, newValues: "x" })).toBeNull();
    expect(blockHistoryChanges({ oldValues: [], newValues: {} })).toBeNull();
    expect(blockHistoryChanges({ oldValues: {}, newValues: [1] })).toBeNull();
  });

  it("SCRUM17_AC4_never_throws_on_a_hostile_entry", () => {
    const entry = {
      get oldValues() {
        throw new Error("boom");
      },
    };
    expect(blockHistoryChanges(entry)).toBeNull();
  });
});

describe("blockCreationSummary", () => {
  it("SCRUM17_AC4_summarises_a_created_row_in_field_order_without_hidden_keys", () => {
    const summary = blockCreationSummary({
      id: "b1000000-0000-4000-8000-000000000001",
      venue_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      notes: null,
      reason: "maintenance",
      ends_at: END,
      starts_at: START,
      created_at: START,
      created_by: USER_A,
      removed_at: null,
      removed_by: null,
    });
    expect(summary).toEqual([
      { key: "starts_at", label: "Start", value: local(START) },
      { key: "ends_at", label: "End", value: local(END) },
      { key: "reason", label: "Reason", value: "Maintenance" },
      { key: "notes", label: "Notes", value: "(none)" },
    ]);
  });

  it("SCRUM17_AC4_returns_empty_for_a_non_object", () => {
    expect(blockCreationSummary(null)).toEqual([]);
    expect(blockCreationSummary(undefined)).toEqual([]);
    expect(blockCreationSummary("x")).toEqual([]);
    expect(blockCreationSummary([{ starts_at: START }])).toEqual([]);
  });

  it("SCRUM17_AC4_a_row_of_only_hidden_keys_summarises_to_empty", () => {
    expect(blockCreationSummary({ id: "x", created_by: USER_A })).toEqual([]);
  });
});

describe("blockAuditSummary", () => {
  const BASE = { createdAt: START, createdBy: USER_A, lastModifiedBy: USER_A };

  it("SCRUM17_AC4_a_never_changed_block_has_no_amended", () => {
    expect(blockAuditSummary({ ...BASE, updatedAt: START })).toEqual({
      created: { at: START, by: USER_A },
      amended: null,
    });
  });

  it("SCRUM17_AC4_equal_instants_in_different_offsets_are_not_an_amendment", () => {
    const sameInstantUtc = new Date(START).toISOString();
    expect(blockAuditSummary({ ...BASE, updatedAt: sameInstantUtc }).amended).toBeNull();
  });

  it("SCRUM17_AC4_a_later_updatedAt_is_an_amendment_by_lastModifiedBy", () => {
    const updatedAt = "2026-11-01T10:00:00+08:00";
    expect(
      blockAuditSummary({ ...BASE, updatedAt, lastModifiedBy: USER_B }),
    ).toEqual({
      created: { at: START, by: USER_A },
      amended: { at: updatedAt, by: USER_B },
    });
  });

  it("SCRUM17_AC4_an_earlier_updatedAt_is_not_an_amendment", () => {
    expect(
      blockAuditSummary({ ...BASE, updatedAt: "2026-10-31T09:00:00+08:00" }).amended,
    ).toBeNull();
  });

  it("SCRUM17_AC4_an_unparseable_or_missing_updatedAt_is_not_an_amendment", () => {
    expect(blockAuditSummary({ ...BASE, updatedAt: "garbage" }).amended).toBeNull();
    expect(blockAuditSummary({ ...BASE, updatedAt: null }).amended).toBeNull();
    expect(blockAuditSummary(BASE).amended).toBeNull();
  });

  it("SCRUM17_AC4_an_unparseable_createdAt_still_names_the_creator_but_no_amendment", () => {
    expect(blockAuditSummary({ ...BASE, createdAt: "garbage", updatedAt: END })).toEqual({
      created: { at: "garbage", by: USER_A },
      amended: null,
    });
  });

  it("SCRUM17_AC4_missing_actors_are_null", () => {
    expect(blockAuditSummary({ createdAt: START, updatedAt: END })).toEqual({
      created: { at: START, by: null },
      amended: { at: END, by: null },
    });
  });

  it("SCRUM17_AC4_no_createdAt_means_no_audit_line", () => {
    expect(blockAuditSummary({ updatedAt: END, createdBy: USER_A })).toEqual({
      created: null,
      amended: null,
    });
    expect(blockAuditSummary(null)).toEqual({ created: null, amended: null });
    expect(blockAuditSummary(undefined)).toEqual({ created: null, amended: null });
  });

  it("SCRUM17_AC4_never_throws_on_a_hostile_block", () => {
    const block = {
      get createdAt() {
        throw new Error("boom");
      },
    };
    expect(blockAuditSummary(block)).toEqual({ created: null, amended: null });
  });
});

describe("isCurrentUser", () => {
  it("SCRUM17_AC4_true_only_for_the_same_present_id", () => {
    expect(isCurrentUser(USER_A, USER_A)).toBe(true);
    expect(isCurrentUser(USER_A, USER_B)).toBe(false);
  });

  it("SCRUM17_AC4_false_when_either_id_is_missing", () => {
    expect(isCurrentUser(null, USER_A)).toBe(false);
    expect(isCurrentUser(USER_A, null)).toBe(false);
    expect(isCurrentUser(USER_A, undefined)).toBe(false);
    expect(isCurrentUser(null, null)).toBe(false);
    expect(isCurrentUser(undefined, undefined)).toBe(false);
    expect(isCurrentUser("", "")).toBe(false);
  });
});
