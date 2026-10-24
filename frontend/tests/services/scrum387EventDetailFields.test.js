// scrum387EventDetailFields.test.js
//
// SCRUM-387: the frontend's copy of the editable fields and statuses, checked
// against backend/src/domain/eventDetailField.js read as text, not imported,
// so the frontend bundle never pulls in backend code (as setupOptions.test.js does).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  DETAIL_FIELDS,
  DETAIL_FIELD_LABELS,
  ORDINARY_DETAIL_FIELDS,
  SIGNIFICANT_DETAIL_FIELDS,
  STATUSES_ALLOWING_ANY_EDIT,
  STATUSES_ALLOWING_ORDINARY_EDITS,
  detailFieldLabel,
  detailFieldList,
  editableDetailFields,
} from "../../src/services/eventDetailFields.js";

/** The backend's lists. A STATUS.X constant is its lower-cased value; a spread is the list it names. */
function backendDeclaration() {
  const text = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/src/domain/eventDetailField.js"),
    "utf8",
  ).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const lists = {};
  for (const name of [
    "ORDINARY_DETAIL_FIELDS", "SIGNIFICANT_DETAIL_FIELDS", "STATUSES_ALLOWING_ANY_EDIT", "STATUSES_ALLOWING_ORDINARY_EDITS",
  ]) {
    const match = text.match(new RegExp(`export const ${name}\\s*=\\s*Object\\.freeze\\(\\s*\\[([^\\]]*)\\]`));
    if (!match) throw new Error(`could not read ${name} from backend/src/domain/eventDetailField.js`);
    lists[name] = match[1].split(",").map((item) => item.trim()).filter(Boolean).flatMap((item) => {
      if (item.startsWith("...")) return lists[item.slice(3)];
      const status = item.match(/^STATUS\.([A-Z_]+)$/);
      return status ? [status[1].toLowerCase()] : [item.replace(/^'|'$/g, "")];
    });
  }
  return lists;
}

describe("SCRUM-387 the frontend's editable fields", () => {
  it("SCRUM387_AC3_mirrors_the_backend_field_and_status_lists", () => {
    const backend = backendDeclaration();

    expect([...ORDINARY_DETAIL_FIELDS]).toEqual(backend.ORDINARY_DETAIL_FIELDS);
    expect([...SIGNIFICANT_DETAIL_FIELDS]).toEqual(backend.SIGNIFICANT_DETAIL_FIELDS);
    expect([...STATUSES_ALLOWING_ANY_EDIT]).toEqual(backend.STATUSES_ALLOWING_ANY_EDIT);
    expect([...STATUSES_ALLOWING_ORDINARY_EDITS]).toEqual(backend.STATUSES_ALLOWING_ORDINARY_EDITS);
    expect(Object.keys(DETAIL_FIELD_LABELS)).toEqual([...DETAIL_FIELDS]);
  });

  it.each([
    ["under_review", DETAIL_FIELDS],
    ["pending_clarification", DETAIL_FIELDS],
    ["approved", ORDINARY_DETAIL_FIELDS],
    ["safety_review", ORDINARY_DETAIL_FIELDS],
    ["safety_approved", ORDINARY_DETAIL_FIELDS],
    ["confirmed", []],
    ["submitted", []],
    ["draft", []],
  ])("SCRUM387_AC2_AC3_AC4_AC5_an_event_that_is_%s_shows_its_fields", (status, fields) => {
    expect([...editableDetailFields(status)]).toEqual([...fields]);
  });

  it("SCRUM387_AC8_a_field_this_build_does_not_know_is_spelled_out", () => {
    expect(detailFieldLabel("eventName")).toBe("Event name");
    expect(detailFieldLabel("equipment")).toBe("Equipment");
    expect(detailFieldLabel("cateringHeadcount")).toBe("Catering headcount");
    expect(detailFieldLabel("")).toBe("A field");
    expect(detailFieldLabel(undefined)).toBe("A field");
  });

  it("SCRUM387_AC8_lists_fields_as_one_phrase", () => {
    expect(detailFieldList([])).toBe("");
    expect(detailFieldList(["purpose"])).toBe("Purpose");
    expect(detailFieldList(["eventName", "purpose", "description"])).toBe("Event name, Purpose and Description");
  });
});
