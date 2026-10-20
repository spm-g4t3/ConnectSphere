// equipmentAvailabilityService.js
//
// SCRUM-70, part of SCRUM-23 "Check Equipment Availability for a Period".
//
//   GET /equipment/active        the equipment types a check can be run for
//   GET /equipment/availability  one check: type, quantity, period
//
// Both are Technical Support Staff only for this screen's purposes. The check
// is a GET because it changes nothing. axios encodes the `+` of a timezone
// offset as %2B, which the backend needs: a raw `+` would decode to a space
// and be refused.
//
// A check answers
//   { result, quantityRequested, quantityAvailable, message, breakdown,
//     reservations }
// where result is "Fully available", "Partially available" or "Unavailable";
// message is set only for an unknown or retired type, which has no breakdown;
// breakdown is { total, damaged, underMaintenance, damagedOrUnderMaintenance,
// reserved, available }; and each reservation is { id, eventRequestId,
// eventName, quantity, startAt, endAt, flagged }.

import { getData } from "./apiData";

export async function listActiveEquipmentTypes() {
  return getData("/equipment/active");
}

export async function checkEquipmentAvailability({ equipmentTypeId, quantity, startAt, endAt }) {
  return getData("/equipment/availability", {
    params: { equipmentTypeId, quantity, startAt, endAt },
  });
}
