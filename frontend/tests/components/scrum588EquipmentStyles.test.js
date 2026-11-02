// scrum588EquipmentStyles.test.js
//
// The four equipment stylesheets take every colour from the shared tokens. jsdom
// does not apply CSS, so the files are read from disk and checked as text.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const read = (path) => readFileSync(resolve(SRC, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const FILES = [
  "components/EquipmentRequestQueue.css",
  "components/EquipmentReview.css",
  "components/EquipmentCatalogue.css",
  "components/EquipmentAvailabilityCheck.css",
];
const sheets = FILES.map((file) => [file, read(file)]);

// Every match in every sheet, as "file: match", so a failure names where it is.
const found = (pattern) => sheets.flatMap(([file, css]) => (css.match(pattern) ?? []).map((m) => `${file}: ${m}`));

describe("SCRUM588 AC7 the equipment styles use the shared tokens", () => {
  it("SCRUM588_AC7_no_literal_colours", () => {
    expect(found(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black)(?![\w-])/gi)).toEqual([]);
  });

  it("SCRUM588_AC7_no_old_alias_variables", () => {
    expect(found(/var\(--(?:line|teal|teal-dark|muted|ink|paper|shadow)\s*[,)]/g)).toEqual([]);
  });

  it("SCRUM588_AC7_every_variable_used_is_a_defined_token", () => {
    const defined = new Set(
      ["index.css", "components/ui/ui.css"].flatMap((file) => [...read(file).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])),
    );
    expect(found(/var\(--[\w-]+/g).filter((use) => !defined.has(use.split("var(")[1]))).toEqual([]);
  });

  it("SCRUM588_AC7_rules_for_the_replaced_button_and_status_classes_are_gone", () => {
    expect(found(/er-btn|er-pill|equipment-review__status|equipment-queue__status|availability-reservations__flag/g)).toEqual([]);
  });
});
