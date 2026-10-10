// calendarRange.test.js
//
// SCRUM-180 (part of SCRUM-178, AC4). The date arithmetic behind the venue
// calendar: which days each view covers, how Previous and Next move it, which
// entries land on which day, the window sent to the API, and the headings.
//
// Time-zone safe: every fixture is built with the local Date constructor, and
// entry timestamps are built from local Dates with toISOString, so day
// bucketing reads the same in UTC (CI) and Asia/Singapore (dev machines).
// Headings are compared against the same toLocaleDateString call wherever the
// exact punctuation could differ between ICU versions ("Sep" vs "Sept").

import { describe, it, expect } from "vitest";

import {
  CALENDAR_LOCALE,
  CALENDAR_VIEWS,
  addDays,
  daysIn,
  entriesOnDay,
  parseCalendarDate,
  rangeFor,
  rangeTitle,
  shiftAnchor,
  startOfDay,
  startOfWeek,
  toCalendarDateParam,
  toWireWindow,
} from "../../src/services/calendarRange.js";

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$/;

function local(y, m, d, h = 0, min = 0) {
  return new Date(y, m, d, h, min);
}

function entry(id, start, end) {
  return { id, startsAt: start.toISOString(), endsAt: end.toISOString() };
}

describe("SCRUM178_AC4 constants", () => {
  it("SCRUM178_AC4_offers_day_week_and_month_in_that_order", () => {
    expect(CALENDAR_VIEWS).toEqual(["day", "week", "month"]);
    expect(Object.isFrozen(CALENDAR_VIEWS)).toBe(true);
  });

  it("SCRUM178_AC4_pins_headings_to_en_GB", () => {
    expect(CALENDAR_LOCALE).toBe("en-GB");
  });
});

describe("SCRUM178_AC4 startOfDay and addDays", () => {
  it("SCRUM178_AC4_startOfDay_is_local_midnight_and_does_not_mutate", () => {
    const input = local(2026, 9, 7, 15, 45);
    const before = input.getTime();

    expect(startOfDay(input)).toEqual(local(2026, 9, 7));
    expect(input.getTime()).toBe(before);
  });

  it("SCRUM178_AC4_addDays_rolls_across_month_and_year_ends_and_drops_the_time", () => {
    expect(addDays(local(2026, 9, 31, 10), 1)).toEqual(local(2026, 10, 1));
    expect(addDays(local(2026, 11, 31, 23, 59), 1)).toEqual(local(2027, 0, 1));
    expect(addDays(local(2026, 0, 1), -1)).toEqual(local(2025, 11, 31));
    expect(addDays(local(2028, 1, 28), 1)).toEqual(local(2028, 1, 29));
    expect(addDays(local(2026, 9, 7), 0)).toEqual(local(2026, 9, 7));
  });
});

describe("SCRUM178_AC4 startOfWeek", () => {
  it("SCRUM178_AC4_weeks_start_on_monday", () => {
    // Mon 5 Oct 2026 through Sun 11 Oct 2026 all belong to the week of the 5th.
    for (let d = 5; d <= 11; d += 1) {
      expect(startOfWeek(local(2026, 9, d, 13))).toEqual(local(2026, 9, 5));
    }
    // The next Monday starts a new week.
    expect(startOfWeek(local(2026, 9, 12))).toEqual(local(2026, 9, 12));
  });

  it("SCRUM178_AC4_a_sunday_belongs_to_the_week_before_not_the_one_after", () => {
    expect(startOfWeek(local(2026, 9, 4))).toEqual(local(2026, 8, 28));
    expect(startOfWeek(local(2026, 9, 4)).getDay()).toBe(1);
  });

  it("SCRUM178_AC4_week_start_crosses_a_year_boundary", () => {
    expect(startOfWeek(local(2026, 0, 1))).toEqual(local(2025, 11, 29));
  });
});

describe("SCRUM178_AC4 rangeFor", () => {
  it("SCRUM178_AC4_day_is_one_local_day", () => {
    expect(rangeFor("day", local(2026, 9, 7, 15))).toEqual({
      start: local(2026, 9, 7),
      end: local(2026, 9, 8),
    });
  });

  it("SCRUM178_AC4_week_is_monday_to_the_next_monday", () => {
    expect(rangeFor("week", local(2026, 9, 7, 15))).toEqual({
      start: local(2026, 9, 5),
      end: local(2026, 9, 12),
    });
  });

  it("SCRUM178_AC4_an_unknown_view_falls_back_to_week", () => {
    expect(rangeFor("year", local(2026, 9, 7))).toEqual(rangeFor("week", local(2026, 9, 7)));
    expect(rangeFor(undefined, local(2026, 9, 7))).toEqual({
      start: local(2026, 9, 5),
      end: local(2026, 9, 12),
    });
  });

  it("SCRUM178_AC4_month_is_whole_weeks_around_the_month", () => {
    // October 2026: Thu 1st to Sat 31st.
    const range = rangeFor("month", local(2026, 9, 17));
    expect(range).toEqual({ start: local(2026, 8, 28), end: local(2026, 10, 2) });
    expect(daysIn(range)).toHaveLength(35);
  });

  it("SCRUM178_AC4_month_starting_on_a_monday_starts_on_the_first", () => {
    // June 2026 starts on Monday 1 June and ends on Tuesday 30 June.
    expect(rangeFor("month", local(2026, 5, 15))).toEqual({
      start: local(2026, 5, 1),
      end: local(2026, 6, 6),
    });
  });

  it("SCRUM178_AC4_month_ending_on_a_sunday_ends_the_next_monday", () => {
    // May 2026 starts on Friday 1 May and ends on Sunday 31 May.
    expect(rangeFor("month", local(2026, 4, 31, 23))).toEqual({
      start: local(2026, 3, 27),
      end: local(2026, 5, 1),
    });
  });

  it("SCRUM178_AC4_a_month_of_exactly_four_weeks_has_no_padding", () => {
    // February 2027: Monday 1st to Sunday 28th.
    const range = rangeFor("month", local(2027, 1, 10));
    expect(range).toEqual({ start: local(2027, 1, 1), end: local(2027, 2, 1) });
    expect(daysIn(range)).toHaveLength(28);
  });

  it("SCRUM178_AC4_february_in_a_leap_year_includes_the_29th", () => {
    // February 2028: Tuesday 1st to Tuesday 29th.
    const range = rangeFor("month", local(2028, 1, 1));
    expect(range).toEqual({ start: local(2028, 0, 31), end: local(2028, 2, 6) });
    expect(daysIn(range).some((d) => d.getTime() === local(2028, 1, 29).getTime())).toBe(true);
  });
});

describe("SCRUM178_AC4 shiftAnchor", () => {
  it("SCRUM178_AC4_day_moves_one_day_each_way", () => {
    expect(shiftAnchor("day", local(2026, 9, 7), 1)).toEqual(local(2026, 9, 8));
    expect(shiftAnchor("day", local(2026, 9, 1), -1)).toEqual(local(2026, 8, 30));
  });

  it("SCRUM178_AC4_week_moves_seven_days_each_way", () => {
    expect(shiftAnchor("week", local(2026, 9, 7), 1)).toEqual(local(2026, 9, 14));
    expect(shiftAnchor("week", local(2026, 9, 7), -1)).toEqual(local(2026, 8, 30));
  });

  it("SCRUM178_AC4_week_and_day_shift_across_a_year_boundary", () => {
    expect(shiftAnchor("week", local(2026, 11, 28), 1)).toEqual(local(2027, 0, 4));
    expect(shiftAnchor("day", local(2027, 0, 1), -1)).toEqual(local(2026, 11, 31));
  });

  it("SCRUM178_AC4_month_moves_to_the_first_of_the_next_or_previous_month", () => {
    expect(shiftAnchor("month", local(2026, 9, 17, 14), 1)).toEqual(local(2026, 10, 1));
    expect(shiftAnchor("month", local(2026, 9, 17, 14), -1)).toEqual(local(2026, 8, 1));
  });

  it("SCRUM178_AC4_month_shifts_across_a_year_boundary_both_ways", () => {
    expect(shiftAnchor("month", local(2026, 11, 15), 1)).toEqual(local(2027, 0, 1));
    expect(shiftAnchor("month", local(2027, 0, 15), -1)).toEqual(local(2026, 11, 1));
  });

  it("SCRUM178_AC4_31_january_plus_one_month_is_february_not_march", () => {
    expect(shiftAnchor("month", local(2026, 0, 31), 1)).toEqual(local(2026, 1, 1));
    expect(shiftAnchor("month", local(2026, 2, 31), -1)).toEqual(local(2026, 1, 1));
  });

  it("SCRUM178_AC4_does_not_mutate_the_anchor", () => {
    const anchor = local(2026, 0, 31, 9);
    const before = anchor.getTime();
    shiftAnchor("month", anchor, 1);
    shiftAnchor("week", anchor, 1);
    expect(anchor.getTime()).toBe(before);
  });
});

describe("SCRUM178_AC4 daysIn", () => {
  it("SCRUM178_AC4_lists_every_day_at_midnight_with_end_exclusive", () => {
    const days = daysIn({ start: local(2026, 9, 5), end: local(2026, 9, 12) });
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual(local(2026, 9, 5));
    expect(days[6]).toEqual(local(2026, 9, 11));
  });

  it("SCRUM178_AC4_normalises_a_start_with_a_time_to_midnight", () => {
    expect(daysIn({ start: local(2026, 9, 5, 15), end: local(2026, 9, 7) })).toEqual([
      local(2026, 9, 5),
      local(2026, 9, 6),
    ]);
  });

  it("SCRUM178_AC4_an_empty_range_has_no_days", () => {
    expect(daysIn({ start: local(2026, 9, 5), end: local(2026, 9, 5) })).toEqual([]);
  });
});

describe("SCRUM178_AC2 entriesOnDay", () => {
  const morning = entry("morning", local(2026, 9, 6, 9), local(2026, 9, 6, 12));
  const toMidnight = entry("to-midnight", local(2026, 9, 6, 18), local(2026, 9, 7));
  const fromMidnight = entry("from-midnight", local(2026, 9, 7), local(2026, 9, 7, 2));
  const multiDay = entry("multi", local(2026, 9, 5, 22), local(2026, 9, 8, 6));

  const all = [morning, toMidnight, fromMidnight, multiDay];

  it("SCRUM178_AC2_keeps_entries_that_overlap_the_day_in_their_original_order", () => {
    expect(entriesOnDay(all, local(2026, 9, 6)).map((e) => e.id)).toEqual([
      "morning",
      "to-midnight",
      "multi",
    ]);
  });

  it("SCRUM178_AC2_an_entry_ending_exactly_at_midnight_does_not_leak_into_the_next_day", () => {
    expect(entriesOnDay(all, local(2026, 9, 7)).map((e) => e.id)).toEqual([
      "from-midnight",
      "multi",
    ]);
  });

  it("SCRUM178_AC2_an_entry_starting_exactly_at_the_next_midnight_is_not_on_this_day", () => {
    expect(entriesOnDay([fromMidnight], local(2026, 9, 6))).toEqual([]);
  });

  it("SCRUM178_AC2_a_multi_day_entry_shows_on_every_day_it_covers", () => {
    const covered = [4, 5, 6, 7, 8, 9].map(
      (d) => entriesOnDay([multiDay], local(2026, 9, d)).length,
    );
    expect(covered).toEqual([0, 1, 1, 1, 1, 0]);
  });

  it("SCRUM178_AC2_accepts_a_day_with_a_time_of_day", () => {
    expect(entriesOnDay([morning], local(2026, 9, 6, 20))).toEqual([morning]);
  });

  it("SCRUM178_AC2_reads_offset_timestamps_as_instants", () => {
    // 2026-10-06T01:00Z lies inside local 6 Oct in UTC and in +08:00.
    const offsetEntry = {
      id: "offset",
      startsAt: local(2026, 9, 6, 10).toISOString().replace("Z", "+00:00"),
      endsAt: local(2026, 9, 6, 11).toISOString(),
    };
    expect(entriesOnDay([offsetEntry], local(2026, 9, 6))).toEqual([offsetEntry]);
  });
});

describe("SCRUM484_AC7 entriesOnDay places bookings by their occupied period", () => {
  /** A booking whose venue holds it from occStart to occEnd. */
  function booking(id, start, end, occStart, occEnd) {
    return {
      kind: "booking",
      id,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      occupiedStartsAt: occStart.toISOString(),
      occupiedEndsAt: occEnd.toISOString(),
      setupMinutes: Math.round((start - occStart) / 60000),
      turnaroundMinutes: Math.round((occEnd - end) / 60000),
    };
  }

  // Tuesday 6 Oct 22:00-23:30, 45 minutes of turnaround into Wednesday.
  const lateTurnaround = booking(
    "late",
    local(2026, 9, 6, 22),
    local(2026, 9, 6, 23, 30),
    local(2026, 9, 6, 21, 30),
    local(2026, 9, 7, 0, 15),
  );

  // Wednesday 7 Oct 00:15-02:00, 30 minutes of setup back into Tuesday.
  const earlySetup = booking(
    "early",
    local(2026, 9, 7, 0, 15),
    local(2026, 9, 7, 2),
    local(2026, 9, 6, 23, 45),
    local(2026, 9, 7, 2),
  );

  it("SCRUM484_AC7_a_turnaround_past_midnight_puts_the_booking_on_the_next_day", () => {
    expect(entriesOnDay([lateTurnaround], local(2026, 9, 6))).toEqual([lateTurnaround]);
    expect(entriesOnDay([lateTurnaround], local(2026, 9, 7))).toEqual([lateTurnaround]);
    expect(entriesOnDay([lateTurnaround], local(2026, 9, 8))).toEqual([]);
  });

  it("SCRUM484_AC7_a_setup_before_midnight_puts_the_booking_on_the_previous_day", () => {
    expect(entriesOnDay([earlySetup], local(2026, 9, 6))).toEqual([earlySetup]);
    expect(entriesOnDay([earlySetup], local(2026, 9, 7))).toEqual([earlySetup]);
  });

  it("SCRUM484_AC7_an_occupied_period_ending_at_midnight_does_not_leak", () => {
    const toMidnight = booking(
      "to-midnight",
      local(2026, 9, 6, 22),
      local(2026, 9, 6, 23),
      local(2026, 9, 6, 22),
      local(2026, 9, 7),
    );
    expect(entriesOnDay([toMidnight], local(2026, 9, 7))).toEqual([]);
  });

  it("SCRUM484_AC7_blocks_keep_their_own_times_even_with_occupied_fields", () => {
    // A block has no setup or turnaround; stray occupied fields are ignored.
    const block = {
      kind: "block",
      id: "k1",
      startsAt: local(2026, 9, 6, 22).toISOString(),
      endsAt: local(2026, 9, 6, 23, 30).toISOString(),
      occupiedStartsAt: local(2026, 9, 6, 21).toISOString(),
      occupiedEndsAt: local(2026, 9, 7, 1).toISOString(),
    };
    expect(entriesOnDay([block], local(2026, 9, 6))).toEqual([block]);
    expect(entriesOnDay([block], local(2026, 9, 7))).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["null", { occupiedStartsAt: null, occupiedEndsAt: null }],
    ["unparseable", { occupiedStartsAt: "not a date", occupiedEndsAt: "not a date" }],
  ])("SCRUM484_AC7_%s_occupied_fields_fall_back_to_the_event_times", (_label, occupied) => {
    const legacy = { ...lateTurnaround, ...occupied };
    if (!("occupiedStartsAt" in occupied)) {
      delete legacy.occupiedStartsAt;
      delete legacy.occupiedEndsAt;
    }
    expect(entriesOnDay([legacy], local(2026, 9, 6))).toEqual([legacy]);
    expect(entriesOnDay([legacy], local(2026, 9, 7))).toEqual([]);
  });
});

describe("SCRUM178_AC4 toWireWindow", () => {
  it("SCRUM178_AC4_both_ends_carry_an_explicit_offset_and_name_the_same_instants", () => {
    const range = rangeFor("week", local(2026, 9, 7));
    const { from, to } = toWireWindow(range);

    expect(from).toMatch(OFFSET_SUFFIX);
    expect(to).toMatch(OFFSET_SUFFIX);
    expect(from).toMatch(/^2026-10-05T00:00:00[+-]\d{2}:\d{2}$/);
    expect(to).toMatch(/^2026-10-12T00:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(from).getTime()).toBe(range.start.getTime());
    expect(new Date(to).getTime()).toBe(range.end.getTime());
  });

  it("SCRUM178_AC4_the_offset_matches_the_device_zone", () => {
    const start = local(2026, 9, 5);
    const minutes = -start.getTimezoneOffset();
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    const expected = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;

    expect(toWireWindow({ start, end: local(2026, 9, 6) }).from.endsWith(expected)).toBe(true);
  });
});

describe("SCRUM178_AC4 rangeTitle", () => {
  const FULL = { day: "numeric", month: "short", year: "numeric" };

  it("SCRUM178_AC4_day_title_names_the_weekday_and_date", () => {
    const day = local(2026, 9, 5);
    const title = rangeTitle("day", rangeFor("day", day));

    expect(title).toBe(
      day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    );
    expect(title).toMatch(/^Mon,? 5 Oct 2026$/);
  });

  it("SCRUM178_AC4_week_title_within_one_month_names_the_month_once", () => {
    const title = rangeTitle("week", rangeFor("week", local(2026, 9, 7)));
    expect(title).toBe(
      `${local(2026, 9, 5).toLocaleDateString("en-GB", { day: "numeric" })} – ` +
        local(2026, 9, 11).toLocaleDateString("en-GB", FULL),
    );
    expect(title).toBe("5 – 11 Oct 2026");
  });

  it("SCRUM178_AC4_week_title_across_two_months_names_both_months", () => {
    const title = rangeTitle("week", rangeFor("week", local(2026, 9, 1)));
    expect(title).toBe(
      `${local(2026, 8, 28).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ` +
        local(2026, 9, 4).toLocaleDateString("en-GB", FULL),
    );
    expect(title).toMatch(/^28 Sept? – 4 Oct 2026$/);
  });

  it("SCRUM178_AC4_week_title_across_two_years_names_both_years", () => {
    const title = rangeTitle("week", rangeFor("week", local(2026, 0, 1)));
    expect(title).toBe(
      `${local(2025, 11, 29).toLocaleDateString("en-GB", FULL)} – ` +
        local(2026, 0, 4).toLocaleDateString("en-GB", FULL),
    );
    expect(title).toBe("29 Dec 2025 – 4 Jan 2026");
  });

  it("SCRUM178_AC4_month_title_names_the_month_not_the_padding_before_it", () => {
    // October 2026's grid starts on 28 September.
    expect(rangeTitle("month", rangeFor("month", local(2026, 9, 17)))).toBe("October 2026");
    // January 2026's grid starts in December 2025.
    expect(rangeTitle("month", rangeFor("month", local(2026, 0, 31)))).toBe("January 2026");
    // A month that starts on a Monday has no padding at all.
    expect(rangeTitle("month", rangeFor("month", local(2026, 5, 1)))).toBe("June 2026");
  });
});

describe("SCRUM178_AC1 parseCalendarDate (SCRUM-181)", () => {
  it("SCRUM178_AC1_parses_YYYY_MM_DD_as_local_midnight", () => {
    const date = parseCalendarDate("2026-11-03");

    expect(date).toBeInstanceOf(Date);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(10);
    expect(date.getDate()).toBe(3);
    expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(date).toEqual(local(2026, 10, 3));
  });

  it("SCRUM178_AC1_accepts_29_February_in_a_leap_year", () => {
    expect(parseCalendarDate("2028-02-29")).toEqual(local(2028, 1, 29));
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2027-02-29", "2026-04-31", "2026-10-00"])(
    "SCRUM178_AC1_rejects_the_impossible_date_%s",
    (value) => {
      expect(parseCalendarDate(value)).toBeNull();
    },
  );

  it.each([
    ["an unpadded date", "2026-1-5"],
    ["an empty string", ""],
    ["garbage", "garbage"],
    ["a date with a time", "2026-11-03T00:00"],
    ["a date with surrounding spaces", " 2026-11-03 "],
    ["null", null],
    ["undefined", undefined],
    ["a number", 12345],
  ])("SCRUM178_AC1_returns_null_for_%s", (_label, value) => {
    expect(parseCalendarDate(value)).toBeNull();
  });
});

describe("SCRUM178_AC1 toCalendarDateParam (SCRUM-181)", () => {
  it("SCRUM178_AC1_zero_pads_month_and_day", () => {
    expect(toCalendarDateParam(local(2026, 0, 5))).toBe("2026-01-05");
    expect(toCalendarDateParam(local(2026, 11, 31))).toBe("2026-12-31");
  });

  it("SCRUM178_AC1_uses_the_local_day_whatever_the_time", () => {
    expect(toCalendarDateParam(local(2026, 10, 3, 0, 0))).toBe("2026-11-03");
    expect(toCalendarDateParam(local(2026, 10, 3, 23, 59))).toBe("2026-11-03");
  });

  it.each(["2026-11-03", "2028-02-29", "2026-01-01", "1999-12-31"])(
    "SCRUM178_AC1_round_trips_%s_through_parseCalendarDate",
    (value) => {
      expect(toCalendarDateParam(parseCalendarDate(value))).toBe(value);
    },
  );

  it("SCRUM178_AC1_parse_of_the_param_is_that_day_s_midnight", () => {
    const moment = local(2026, 9, 5, 14, 30);
    expect(parseCalendarDate(toCalendarDateParam(moment))).toEqual(startOfDay(moment));
  });
});

describe("SCRUM491_AC6 entriesOnDay places holds by their occupied period", () => {
  const hold = {
    kind: "hold",
    id: "h1",
    startsAt: local(2026, 9, 6, 22).toISOString(),
    endsAt: local(2026, 9, 6, 23, 30).toISOString(),
    occupiedStartsAt: local(2026, 9, 6, 21, 30).toISOString(),
    occupiedEndsAt: local(2026, 9, 7, 0, 15).toISOString(),
    eventName: "Product Launch",
  };

  it("SCRUM491_AC6_a_hold_turnaround_past_midnight_puts_it_on_the_next_day", () => {
    expect(entriesOnDay([hold], local(2026, 9, 6))).toEqual([hold]);
    expect(entriesOnDay([hold], local(2026, 9, 7))).toEqual([hold]);
    expect(entriesOnDay([hold], local(2026, 9, 8))).toEqual([]);
  });

  it("SCRUM491_AC6_a_hold_without_occupied_fields_falls_back_to_the_event_times", () => {
    const bare = { ...hold, occupiedStartsAt: null, occupiedEndsAt: null };
    expect(entriesOnDay([bare], local(2026, 9, 6))).toEqual([bare]);
    expect(entriesOnDay([bare], local(2026, 9, 7))).toEqual([]);
  });
});
