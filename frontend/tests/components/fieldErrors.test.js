// fieldErrors.test.js
//
// The shared field-error wiring: the ids and aria attributes every form ties
// its controls to their error lists with.

import { describe, it, expect } from "vitest";

import { fieldErrorWiring } from "../../src/components/fieldErrors.js";

const ERRORS = [
  { field: "startsAt", message: "Enter a start." },
  { field: "endsAt", message: "Enter an end." },
  { field: "startsAt", message: "Start must be in the future." },
];

describe("fieldErrorWiring", () => {
  it("lists one field's messages, in order", () => {
    const { messagesFor } = fieldErrorWiring(":r1:", ERRORS);
    expect(messagesFor("startsAt")).toEqual(["Enter a start.", "Start must be in the future."]);
    expect(messagesFor("reason")).toEqual([]);
  });

  it("builds the error list id from the prefix and field", () => {
    expect(fieldErrorWiring(":r1:", ERRORS).errorId("endsAt")).toBe(":r1:-endsAt-error");
  });

  it("marks a field with errors invalid and described by its list", () => {
    expect(fieldErrorWiring(":r1:", ERRORS).ariaFor("endsAt")).toEqual({
      "aria-invalid": "true",
      "aria-describedby": ":r1:-endsAt-error",
    });
  });

  it("sets neither attribute on a field without errors", () => {
    expect(fieldErrorWiring(":r1:", ERRORS).ariaFor("reason")).toEqual({
      "aria-invalid": undefined,
      "aria-describedby": undefined,
    });
  });

  it("reads the errors before any hints", () => {
    const { ariaFor } = fieldErrorWiring(":r1:", ERRORS);
    expect(ariaFor("startsAt", [":r1:-a-hint", ":r1:-b-hint"])["aria-describedby"]).toBe(
      ":r1:-startsAt-error :r1:-a-hint :r1:-b-hint",
    );
    expect(ariaFor("reason", [":r1:-a-hint"])).toEqual({
      "aria-invalid": undefined,
      "aria-describedby": ":r1:-a-hint",
    });
  });
});
