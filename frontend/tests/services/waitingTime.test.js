// waitingTime.test.js
//
// SCRUM-486 (SCRUM-519), AC2-07: "waiting 3 days" / "waiting 1 hour", against
// an injected clock so the answer does not depend on when the suite runs.

import { describe, it, expect } from "vitest";

import { describeWaiting } from "../../src/services/waitingTime.js";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const before = (ms) => new Date(NOW.getTime() - ms).toISOString();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("SCRUM486_AC2 how long a request has waited", () => {
  it.each([
    ["three days", before(3 * DAY), "waiting 3 days"],
    ["one hour", before(HOUR), "waiting 1 hour"],
    ["one day exactly", before(DAY), "waiting 1 day"],
    ["five hours", before(5 * HOUR), "waiting 5 hours"],
    ["23 hours 59 minutes, rounded down", before(DAY - MINUTE), "waiting 23 hours"],
    ["two days and 23 hours, rounded down", before(3 * DAY - HOUR), "waiting 2 days"],
    ["59 minutes", before(59 * MINUTE), "waiting less than an hour"],
    ["no time at all", NOW.toISOString(), "waiting less than an hour"],
  ])("SCRUM486_AC2_a_request_submitted_%s_ago_reads_%j", (_label, submittedAt, expected) => {
    expect(describeWaiting(submittedAt, NOW)).toBe(expected);
  });

  it("SCRUM486_AC2_a_submission_after_the_readers_clock_has_just_arrived", () => {
    // Only when the reader's clock is behind the server's. Never "-1 hours".
    expect(describeWaiting(new Date(NOW.getTime() + 10 * MINUTE).toISOString(), NOW)).toBe(
      "waiting less than an hour",
    );
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["unparseable", "not a date"],
  ])("SCRUM486_AC2_a_%s_submission_time_says_so_rather_than_NaN", (_label, submittedAt) => {
    expect(describeWaiting(submittedAt, NOW)).toBe("waiting time unknown");
  });

  it("SCRUM486_AC2_measures_against_the_real_clock_when_none_is_given", () => {
    // The default the screen uses. Two days back from now is two days.
    expect(describeWaiting(new Date(Date.now() - 2 * DAY - MINUTE).toISOString())).toBe("waiting 2 days");
  });
});
