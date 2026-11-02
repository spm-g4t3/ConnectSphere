// Tests for the equipment error messages (SCRUM-280, part of SCRUM-275).

import { describe, it, expect } from "vitest";
import { equipmentErrorMessages, isStaleEquipmentError } from "../../src/services/equipmentErrors";

const failure = (status, data) => ({ response: { status, data } });

describe("equipmentErrorMessages", () => {
  it("SCRUM280_shows_every_validation_error_from_a_400_with_the_field_named", () => {
    const err = failure(400, {
      details: [
        { field: "name", message: "is required" },
        { field: "totalQuantity", message: "must be a whole number of zero or more" },
        { field: "underMaintenanceQuantity", message: "can't exceed the total" },
        { field: "note", message: "is required" },
      ],
    });

    expect(equipmentErrorMessages(err, "save")).toEqual([
      "Name: is required",
      "Total quantity: must be a whole number of zero or more",
      "Under maintenance: can't exceed the total",
      "Note: is required",
    ]);
  });

  it("SCRUM280_shows_a_detail_without_a_known_field_as_its_message_alone", () => {
    const err = failure(400, {
      details: [{ field: "equipment", message: "nothing changed: damaged and under maintenance already have these values" }],
    });

    expect(equipmentErrorMessages(err, "condition")).toEqual([
      "nothing changed: damaged and under maintenance already have these values",
    ]);
  });

  it.each([
    ["EQUIPMENT_NAME_TAKEN", "Another equipment type already uses that name."],
    ["EQUIPMENT_ALREADY_RETIRED", "This type has already been retired. The list has been refreshed."],
    ["EQUIPMENT_NOT_RETIRED", "This type is not retired. The list has been refreshed."],
  ])("SCRUM280_explains_the_409_code_%s", (code, message) => {
    expect(equipmentErrorMessages(failure(409, { code, error: "database prose with a uuid" }), "save")).toEqual([message]);
  });

  it.each([
    [403, "Only Technical Support Staff can manage the equipment catalogue."],
    [404, "That equipment type no longer exists. The list has been refreshed."],
  ])("SCRUM280_explains_status_%s", (status, message) => {
    expect(equipmentErrorMessages(failure(status, {}), "retire")).toEqual([message]);
  });

  it("SCRUM280_answers_a_400_without_details_generically", () => {
    expect(equipmentErrorMessages(failure(400, { error: "Invalid equipment type id" }), "history")).toEqual([
      "Some details were not accepted. Please check the form.",
    ]);
  });

  it.each([
    ["load", "Could not load the equipment catalogue. Please try again."],
    ["save", "Could not save the equipment type. Please try again."],
    ["condition", "Could not save the quantities. Please try again."],
    ["retire", "Could not retire this type. Please try again."],
    ["reinstate", "Could not reinstate this type. Please try again."],
    ["history", "Could not load this type's history. Please try again."],
  ])("SCRUM280_falls_back_to_a_message_for_%s", (action, message) => {
    expect(equipmentErrorMessages(failure(500, { error: "driver text" }), action)).toEqual([message]);
    expect(equipmentErrorMessages(new Error("network down"), action)).toEqual([message]);
  });

  it("SCRUM280_never_shows_the_servers_own_error_text_outside_a_400", () => {
    const messages = equipmentErrorMessages(failure(500, { error: "secret driver text" }), "save");

    expect(messages.join(" ")).not.toContain("secret");
  });

  it("SCRUM280_has_a_generic_message_for_an_unknown_action", () => {
    expect(equipmentErrorMessages(new Error("x"), "other")).toEqual(["Something went wrong. Please try again."]);
  });
});

describe("isStaleEquipmentError", () => {
  it("SCRUM280_is_true_when_the_type_is_gone_or_already_in_the_requested_state", () => {
    expect(isStaleEquipmentError(failure(404, {}))).toBe(true);
    expect(isStaleEquipmentError(failure(409, { code: "EQUIPMENT_ALREADY_RETIRED" }))).toBe(true);
    expect(isStaleEquipmentError(failure(409, { code: "EQUIPMENT_NOT_RETIRED" }))).toBe(true);
  });

  it("SCRUM280_is_false_for_everything_else", () => {
    expect(isStaleEquipmentError(failure(400, {}))).toBe(false);
    expect(isStaleEquipmentError(failure(409, { code: "EQUIPMENT_NAME_TAKEN" }))).toBe(false);
    expect(isStaleEquipmentError(new Error("network"))).toBe(false);
  });
});
