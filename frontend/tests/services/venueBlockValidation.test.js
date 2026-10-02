// venueBlockValidation.test.js
//
// SCRUM-126 (part of SCRUM-17, AC1): the client-side block rules mirror the
// backend's wording, and buildBlockChanges sends only what changed.
//
// Timezone-safe: form values are built from instants through
// toDatetimeLocalValue, results are compared with getTime(), and offsets are
// matched by shape -- no wall-clock string is hard-coded.

import { describe, it, expect } from "vitest";

import {
  NOTES_MAX_LENGTH,
  buildBlockChanges,
  validateBlockInput,
} from "../../src/services/venueBlockValidation.js";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const REASON_MESSAGE =
  "must be one of: maintenance, renovation, safety, internal_activity, other";

const NOW = new Date("2026-09-23T00:00:00Z");

/** A datetime-local value for an instant, in this device's zone. */
function local(iso) {
  return toDatetimeLocalValue(new Date(iso).toISOString());
}

function validValues(overrides = {}) {
  return {
    startsAt: local("2026-10-01T01:00:00Z"),
    endsAt: local("2026-10-01T09:00:00Z"),
    reason: "maintenance",
    notes: "",
    ...overrides,
  };
}

function check(values, options = {}) {
  return validateBlockInput(values, { now: NOW, ...options });
}

describe("validateBlockInput", () => {
  it("SCRUM17_AC1_valid_block_gives_no_errors", () => {
    expect(check(validValues())).toEqual([]);
  });

  it("exports the notes limit", () => {
    expect(NOTES_MAX_LENGTH).toBe(1000);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])("SCRUM17_AC1_start_end_and_reason_are_required (%s)", (_label, value) => {
    expect(check(validValues({ startsAt: value, endsAt: value, reason: value }))).toEqual([
      { field: "startsAt", message: "is required" },
      { field: "endsAt", message: "is required" },
      { field: "reason", message: "is required" },
    ]);
  });

  it.each(["2026", "June 1", "2026-02-30T09:00", "2026-13-01T09:00", "not a date"])(
    "SCRUM17_AC1_rejects_an_unparseable_date %s",
    (value) => {
      expect(check(validValues({ startsAt: value }))).toEqual([
        { field: "startsAt", message: "must be a valid date and time" },
      ]);
    },
  );

  it("SCRUM17_AC1_end_before_start_is_rejected", () => {
    expect(
      check(
        validValues({
          startsAt: local("2026-10-02T01:00:00Z"),
          endsAt: local("2026-10-01T09:00:00Z"),
        }),
      ),
    ).toEqual([{ field: "endsAt", message: "must be later than the start" }]);
  });

  it("SCRUM17_AC1_end_equal_to_start_is_rejected", () => {
    const same = local("2026-10-01T01:00:00Z");
    expect(check(validValues({ startsAt: same, endsAt: same }))).toEqual([
      { field: "endsAt", message: "must be later than the start" },
    ]);
  });

  it("skips the order check when a side is missing", () => {
    expect(check(validValues({ startsAt: "" }))).toEqual([
      { field: "startsAt", message: "is required" },
    ]);
    expect(check(validValues({ endsAt: "", startsAt: local("2026-12-01T00:00:00Z") }))).toEqual([
      { field: "endsAt", message: "is required" },
    ]);
  });

  it("SCRUM17_AC1_end_at_or_before_now_is_rejected", () => {
    const start = local("2026-09-01T00:00:00Z");
    expect(check(validValues({ startsAt: start, endsAt: local("2026-09-22T00:00:00Z") }))).toEqual([
      { field: "endsAt", message: "must be in the future" },
    ]);
    expect(check(validValues({ startsAt: start, endsAt: local(NOW.toISOString()) }))).toEqual([
      { field: "endsAt", message: "must be in the future" },
    ]);
  });

  it("SCRUM17_AC1_end_one_minute_after_now_passes", () => {
    const oneMinuteLater = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      check(validValues({ startsAt: local("2026-09-01T00:00:00Z"), endsAt: local(oneMinuteLater) })),
    ).toEqual([]);
  });

  it("SCRUM17_AC1_past_start_is_allowed", () => {
    expect(
      check(validValues({ startsAt: local("2020-01-01T00:00:00Z") })),
    ).toEqual([]);
  });

  it("requireFutureEnd: false skips the future check", () => {
    const values = validValues({
      startsAt: local("2026-09-01T00:00:00Z"),
      endsAt: local("2026-09-02T00:00:00Z"),
    });
    expect(check(values, { requireFutureEnd: false })).toEqual([]);
    expect(check(values)).toEqual([{ field: "endsAt", message: "must be in the future" }]);
  });

  it("reports both end faults together when a period is backwards and past", () => {
    expect(
      check(
        validValues({
          startsAt: local("2026-09-10T00:00:00Z"),
          endsAt: local("2026-09-05T00:00:00Z"),
        }),
      ),
    ).toEqual([
      { field: "endsAt", message: "must be later than the start" },
      { field: "endsAt", message: "must be in the future" },
    ]);
  });

  it.each(["toString", "constructor", "MAINTENANCE", "holiday"])(
    "SCRUM17_AC1_rejects_unknown_reason %s",
    (reason) => {
      expect(check(validValues({ reason }))).toEqual([{ field: "reason", message: REASON_MESSAGE }]);
    },
  );

  it.each(["maintenance", "renovation", "safety", "internal_activity", "other"])(
    "SCRUM17_AC1_accepts_reason %s",
    (reason) => {
      expect(check(validValues({ reason, notes: "why" }))).toEqual([]);
    },
  );

  it.each([
    ["empty", ""],
    ["whitespace", "  \n "],
    ["null", null],
    ["undefined", undefined],
  ])("SCRUM17_AC1_other_requires_notes (%s)", (_label, notes) => {
    expect(check(validValues({ reason: "other", notes }))).toEqual([
      { field: "notes", message: "is required when the reason is other" },
    ]);
  });

  it("notes: 1000 pass and 1001 fail", () => {
    expect(check(validValues({ notes: "a".repeat(1000) }))).toEqual([]);
    expect(check(validValues({ notes: "a".repeat(1001) }))).toEqual([
      { field: "notes", message: "must be 1000 characters or fewer" },
    ]);
  });

  it("notes: counted in code points, after trimming", () => {
    expect(check(validValues({ notes: "\u{1F6A7}".repeat(1000) }))).toEqual([]);
    expect(check(validValues({ notes: `  ${"a".repeat(1000)}  ` }))).toEqual([]);
  });

  it.each([null, undefined])("notes: %s is fine for a non-other reason", (notes) => {
    expect(check(validValues({ notes }))).toEqual([]);
  });

  it("reports non-string notes once, even for other", () => {
    expect(check(validValues({ reason: "other", notes: 42 }))).toEqual([
      { field: "notes", message: "must be text" },
    ]);
  });

  it("SCRUM17_AC1_every_fault_is_reported_at_once", () => {
    expect(
      check({ startsAt: "garbage", endsAt: "", reason: "holiday", notes: "x".repeat(1001) }),
    ).toEqual([
      { field: "startsAt", message: "must be a valid date and time" },
      { field: "endsAt", message: "is required" },
      { field: "reason", message: REASON_MESSAGE },
      { field: "notes", message: "must be 1000 characters or fewer" },
    ]);
  });

  it("treats an offset ISO string and a datetime-local value for the same instant the same", () => {
    const endIso = "2026-09-23T00:00:00Z"; // exactly NOW
    const startIso = "2026-09-22T00:00:00Z";
    const asIso = check(validValues({ startsAt: startIso, endsAt: endIso }));
    const asLocal = check(validValues({ startsAt: local(startIso), endsAt: local(endIso) }));

    expect(asIso).toEqual([{ field: "endsAt", message: "must be in the future" }]);
    expect(asLocal).toEqual(asIso);

    const futureIso = "2026-10-01T09:00:00+08:00";
    expect(check(validValues({ startsAt: startIso, endsAt: futureIso }))).toEqual([]);
    expect(check(validValues({ startsAt: local(startIso), endsAt: local(futureIso) }))).toEqual([]);
  });

  it("tolerates a missing values object", () => {
    expect(validateBlockInput(undefined, { now: NOW })).toEqual([
      { field: "startsAt", message: "is required" },
      { field: "endsAt", message: "is required" },
      { field: "reason", message: "is required" },
    ]);
  });
});

describe("buildBlockChanges", () => {
  const initialBlock = {
    startsAt: "2026-10-01T01:00:30.000Z", // seconds a datetime-local cannot show
    endsAt: "2026-10-01T09:00:45+00:00",
    reason: "maintenance",
    notes: "Deep clean",
  };

  function untouchedForm() {
    return {
      startsAt: toDatetimeLocalValue(initialBlock.startsAt),
      endsAt: toDatetimeLocalValue(initialBlock.endsAt),
      reason: initialBlock.reason,
      notes: initialBlock.notes,
    };
  }

  it("an untouched form gives {}, even when the stored time has seconds", () => {
    expect(buildBlockChanges(untouchedForm(), initialBlock)).toEqual({});
  });

  it("moving only the end gives just endsAt, as offset ISO naming the same instant", () => {
    const newEnd = "2026-10-01T12:00:00Z";
    const changes = buildBlockChanges({ ...untouchedForm(), endsAt: local(newEnd) }, initialBlock);

    expect(Object.keys(changes)).toEqual(["endsAt"]);
    expect(changes.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(changes.endsAt).getTime()).toBe(new Date(newEnd).getTime());
  });

  it("a changed reason is sent as is", () => {
    expect(buildBlockChanges({ ...untouchedForm(), reason: "safety" }, initialBlock)).toEqual({
      reason: "safety",
    });
  });

  it("cleared notes are sent as null", () => {
    expect(buildBlockChanges({ ...untouchedForm(), notes: "   " }, initialBlock)).toEqual({
      notes: null,
    });
  });

  it("notes are compared and sent trimmed", () => {
    expect(buildBlockChanges({ ...untouchedForm(), notes: "  Deep clean " }, initialBlock)).toEqual({});
    expect(buildBlockChanges({ ...untouchedForm(), notes: "  Repaint  " }, initialBlock)).toEqual({
      notes: "Repaint",
    });
  });

  it("adding notes to a block with none sends them", () => {
    const block = { ...initialBlock, notes: null };
    const form = { ...untouchedForm(), notes: "" };
    expect(buildBlockChanges(form, block)).toEqual({});
    expect(buildBlockChanges({ ...form, notes: "new" }, block)).toEqual({ notes: "new" });
  });
});

describe("venueBlockValidation coverage gaps (SCRUM-132)", () => {
  it("SCRUM17_AC1_refuses_a_well_shaped_date_with_an_impossible_time_of_day", () => {
    const errors = validateBlockInput(
      validValues({ startsAt: "2026-10-01T25:00", endsAt: "2026-10-01T09:60" }),
      { now: NOW },
    );
    expect(errors).toEqual([
      { field: "startsAt", message: "must be a valid date and time" },
      { field: "endsAt", message: "must be a valid date and time" },
    ]);
  });

  it("SCRUM17_AC4_an_edit_that_empties_a_date_sends_that_date_as_null", () => {
    const initial = {
      startsAt: "2026-10-01T01:00:00Z",
      endsAt: "2026-10-01T09:00:00Z",
      reason: "maintenance",
      notes: null,
    };
    const changes = buildBlockChanges(
      { startsAt: "", endsAt: local(initial.endsAt), reason: "maintenance", notes: "" },
      initial,
    );
    expect(changes).toEqual({ startsAt: null });
  });

  it("SCRUM17_AC4_a_form_without_a_notes_field_clears_the_stored_notes", () => {
    const initial = {
      startsAt: "2026-10-01T01:00:00Z",
      endsAt: "2026-10-01T09:00:00Z",
      reason: "maintenance",
      notes: "Aircon servicing",
    };
    const changes = buildBlockChanges(
      { startsAt: local(initial.startsAt), endsAt: local(initial.endsAt), reason: "maintenance" },
      initial,
    );
    expect(changes).toEqual({ notes: null });
  });
});
