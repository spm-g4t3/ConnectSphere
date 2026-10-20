// coordinatorDisplay.test.js
//
// How a coordinator reads in the assign and hand-over pickers.

import { describe, it, expect } from "vitest";

import {
  activeEventsText,
  coordinatorName,
  coordinatorOptionLabel,
} from "../../src/services/coordinatorDisplay.js";

describe("coordinatorName", () => {
  it("uses the full name, or says there is none on record", () => {
    expect(coordinatorName({ id: "c1", fullName: "Alex Tan" })).toBe("Alex Tan");
    expect(coordinatorName({ id: "c1", fullName: null })).toBe("No name on record (c1)");
  });
});

describe("activeEventsText", () => {
  it("counts active events, singular only for one", () => {
    expect(activeEventsText(0)).toBe("0 active events");
    expect(activeEventsText(1)).toBe("1 active event");
    expect(activeEventsText(4)).toBe("4 active events");
  });
});

describe("coordinatorOptionLabel", () => {
  it("adds the count when the list carries one", () => {
    expect(coordinatorOptionLabel({ id: "c1", fullName: "Alex Tan", activeEvents: 1 })).toBe(
      "Alex Tan, 1 active event",
    );
    expect(coordinatorOptionLabel({ id: "c1", fullName: "Alex Tan", activeEvents: 0 })).toBe(
      "Alex Tan, 0 active events",
    );
  });

  it("shows the name alone when there is no count", () => {
    expect(coordinatorOptionLabel({ id: "c1", fullName: "Alex Tan" })).toBe("Alex Tan");
  });
});
