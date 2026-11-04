// eventEquipmentService.js
//
// SCRUM-247, for SCRUM-21 (Record Equipment Requirements for an Event). The
// calls behind the coordinator's equipment section, one per route in
// backend/src/routes/eventEquipment.js, plus the catalogue read the add form
// needs.
//
// Every write answers with the event's whole current equipment state:
//
//   { request: null }                      the event has never asked for equipment
//   { request: { id, status, statusLabel, createdAt, updatedAt,
//                lines: [{ id, equipmentTypeId, name, quantity,
//                          technicalNotes, typeRetired, createdAt,
//                          updatedAt }] } }
//
// so a screen redraws from one response and never splices a list by hand.
//
// The status codes a caller will want to tell apart (the screen chooses its own
// words by code, because the database's messages are written for developers):
//
//   400  an invalid field. err.response.data.details names each one:
//        [{ field, message }], and every fault arrives together.
//   403  the caller is not the event's assigned coordinator.
//   404  no such event, or no such line on it.
//   409  the event is not Approved (code EVENT_NOT_APPROVED).

import { deleteData, getData, patchData, postData } from "./apiData";

/**
 * The event's current equipment request and its lines.
 *
 * @param {string} eventRequestId
 * @returns {Promise<{request: Object|null}>}
 */
export async function getEventEquipment(eventRequestId) {
  return getData(`/event-requests/${eventRequestId}/equipment`);
}

/**
 * Add a line. The quantity is a whole number above zero; each equipment type
 * can appear once on an event, so a second line for a type is refused.
 *
 * @param {string} eventRequestId
 * @param {Object} line
 * @param {string} line.equipmentTypeId
 * @param {number} line.quantity
 * @param {string} [line.technicalNotes]
 * @returns {Promise<{request: Object}>}
 */
export async function addEquipmentLine(eventRequestId, { equipmentTypeId, quantity, technicalNotes }) {
  return postData(`/event-requests/${eventRequestId}/equipment/lines`, {
    equipmentTypeId,
    quantity,
    technicalNotes,
  });
}

/**
 * Change a line's quantity, its technical notes, or both. Only the keys passed
 * are sent. technicalNotes: null clears the notes. A line's type cannot be
 * changed: remove it and add another.
 *
 * @param {string} eventRequestId
 * @param {string} lineId
 * @param {Object} changes
 * @param {number} [changes.quantity]
 * @param {string|null} [changes.technicalNotes]
 * @returns {Promise<{request: Object}>}
 */
export async function amendEquipmentLine(eventRequestId, lineId, changes) {
  return patchData(
    `/event-requests/${eventRequestId}/equipment/lines/${lineId}`,
    changes,
  );
}

/**
 * Remove a line. Removing the last one cancels the equipment request.
 *
 * @param {string} eventRequestId
 * @param {string} lineId
 * @returns {Promise<{request: Object}>}
 */
export async function removeEquipmentLine(eventRequestId, lineId) {
  return deleteData(`/event-requests/${eventRequestId}/equipment/lines/${lineId}`);
}

/**
 * The equipment types a coordinator may choose: active ones only, each
 * { id, name, description, category }. Same route the availability check uses
 * (SCRUM-275 AC1).
 *
 * @returns {Promise<Array<{id: string, name: string, description: string|null, category: string|null}>>}
 */
export async function getActiveEquipmentTypes() {
  return getData("/equipment/active");
}
