// equipmentHistoryDisplay.js
//
// SCRUM-280. One history row, from GET /equipment/:id/history, as a sentence.
// Values arrive as text ("10"), and `field` is the API's name for what changed,
// or "created" for the row written when the type was first made.

const FIELD_LABELS = {
  name: "Name",
  description: "Description",
  category: "Category",
  location: "Location",
  totalQuantity: "Total quantity",
  damagedQuantity: "Damaged",
  underMaintenanceQuantity: "Under maintenance",
};

const EMPTY = "(empty)";

/**
 * @param {{field: string, oldValue: string|null, newValue: string|null}} entry
 * @returns {string}
 */
export function describeChange({ field, oldValue, newValue }) {
  if (field === "created") return `Created as "${newValue}"`;
  // retiredAt going from empty to a time is a retirement, and back is a reinstatement.
  if (field === "retiredAt") return newValue ? "Retired" : "Reinstated";

  const label = FIELD_LABELS[field] ?? field;
  return `${label}: ${oldValue ?? EMPTY} to ${newValue ?? EMPTY}`;
}
