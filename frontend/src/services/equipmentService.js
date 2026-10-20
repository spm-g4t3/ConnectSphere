// equipmentService.js
//
// SCRUM-280, part of SCRUM-275 "Maintain Equipment Catalogue and Status".
// One function per endpoint of /api/equipment, all Technical Support Staff
// only (SCRUM-276 to 279). Each returns the response body, and lets an axios
// error through for equipmentErrors.js to turn into messages.
//
//   GET   /equipment                    the whole catalogue, retired included
//   POST  /equipment                    create a type
//   PATCH /equipment/:id                edit name, description, category,
//                                       location or totalQuantity
//   PATCH /equipment/:id/condition      damaged and under-maintenance
//                                       quantities, with a required note
//   POST  /equipment/:id/retire         retire a type
//   POST  /equipment/:id/reinstate      bring a retired type back
//   GET   /equipment/:id/history        who changed what, newest first
//
// A type is { id, name, description, category, location, totalQuantity,
// damagedQuantity, underMaintenanceQuantity, usableQuantity, retiredAt,
// createdAt, updatedAt }.

import { getData, patchData, postData } from "./apiData";

export async function listEquipment() {
  return getData("/equipment");
}

export async function createEquipment(body) {
  return postData("/equipment", body);
}

export async function updateEquipment(id, changes) {
  return patchData(`/equipment/${id}`, changes);
}

export async function recordEquipmentCondition(id, body) {
  return patchData(`/equipment/${id}/condition`, body);
}

export async function retireEquipment(id) {
  return postData(`/equipment/${id}/retire`);
}

export async function reinstateEquipment(id) {
  return postData(`/equipment/${id}/reinstate`);
}

export async function getEquipmentHistory(id) {
  return getData(`/equipment/${id}/history`);
}
