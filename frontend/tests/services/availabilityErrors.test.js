// Tests for the availability error messages (SCRUM-70, part of SCRUM-23).

import { describe, it, expect } from "vitest";
import { availabilityErrorMessages } from "../../src/services/availabilityErrors";

const failure = (status, data) => ({ response: { status, data } });

describe("availabilityErrorMessages", () => {
  it("SCRUM23_AC2_shows_every_validation_error_from_a_400_with_the_input_named", () => {
    const err = failure(400, {
      details: [
        { field: "equipmentTypeId", message: "is required" },
        { field: "quantity", message: "must be a whole number greater than zero" },
        { field: "startAt", message: "is required" },
        { field: "endAt", message: "must be later than the start" },
        { field: "eventRequestId", message: "must be a UUID" },
      ],
    });

    expect(availabilityErrorMessages(err, "check")).toEqual([
      "Equipment type: is required",
      "Quantity: must be a whole number greater than zero",
      "Start: is required",
      "End: must be later than the start",
      "Event: must be a UUID",
    ]);
  });

  it("SCRUM23_AC2_shows_a_detail_with_no_known_field_as_its_message_alone", () => {
    expect(availabilityErrorMessages(failure(400, { details: [{ field: "request", message: "must be an object" }] }), "check")).toEqual([
      "must be an object",
    ]);
  });

  it.each([
    [403, "Only Technical Support Staff can check equipment availability."],
  ])("SCRUM23_AC1_explains_status_%s", (status, message) => {
    expect(availabilityErrorMessages(failure(status, {}), "check")).toEqual([message]);
  });

  it("SCRUM23_answers_a_400_without_details_generically", () => {
    expect(availabilityErrorMessages(failure(400, { error: "x" }), "check")).toEqual([
      "Some details were not accepted. Please check the form.",
    ]);
  });

  it.each([
    ["check", "Could not check availability. Please try again."],
    ["load", "Could not load the equipment types. Please try again."],
    ["other", "Something went wrong. Please try again."],
  ])("SCRUM23_falls_back_to_a_message_for_%s", (action, message) => {
    expect(availabilityErrorMessages(failure(500, { error: "driver text" }), action)).toEqual([message]);
    expect(availabilityErrorMessages(new Error("network down"), action)).toEqual([message]);
  });

  it("SCRUM23_never_shows_the_servers_own_error_text_outside_a_400", () => {
    expect(availabilityErrorMessages(failure(500, { error: "secret driver text" }), "check").join(" ")).not.toContain("secret");
  });
});
