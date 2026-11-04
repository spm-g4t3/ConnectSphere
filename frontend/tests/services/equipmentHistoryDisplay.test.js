// Tests for the history sentences (SCRUM-280, AC8, part of SCRUM-275).

import { describe, it, expect } from "vitest";
import { describeChange } from "../../src/services/equipmentHistoryDisplay";

describe("describeChange", () => {
  it("SCRUM275_AC8_says_a_type_was_created_with_its_name", () => {
    expect(describeChange({ field: "created", oldValue: null, newValue: "Projector" })).toBe('Created as "Projector"');
  });

  it("SCRUM275_AC8_says_retired_and_reinstated_for_the_retirement_time", () => {
    expect(describeChange({ field: "retiredAt", oldValue: null, newValue: "2026-10-05T11:00:00+00:00" })).toBe("Retired");
    expect(describeChange({ field: "retiredAt", oldValue: "2026-10-05T11:00:00+00:00", newValue: null })).toBe("Reinstated");
  });

  it("SCRUM275_AC8_shows_the_old_and_new_value_with_a_label", () => {
    expect(describeChange({ field: "damagedQuantity", oldValue: "0", newValue: "3" })).toBe("Damaged: 0 to 3");
    expect(describeChange({ field: "underMaintenanceQuantity", oldValue: "1", newValue: "0" })).toBe("Under maintenance: 1 to 0");
    expect(describeChange({ field: "totalQuantity", oldValue: "10", newValue: "12" })).toBe("Total quantity: 10 to 12");
  });

  it("SCRUM275_AC8_marks_an_empty_value", () => {
    expect(describeChange({ field: "location", oldValue: null, newValue: "Store 1" })).toBe("Location: (empty) to Store 1");
    expect(describeChange({ field: "category", oldValue: "AV", newValue: null })).toBe("Category: AV to (empty)");
  });

  it("SCRUM275_AC8_passes_an_unknown_field_name_through", () => {
    expect(describeChange({ field: "colour", oldValue: "a", newValue: "b" })).toBe("colour: a to b");
  });
});
