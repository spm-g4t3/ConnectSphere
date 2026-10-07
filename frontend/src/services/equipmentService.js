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

import { apiClient } from "./apiClient";

export async function listEquipment() {
  const response = await apiClient.get("/equipment");
  return response.data;
}

export async function createEquipment(body) {
  const response = await apiClient.post("/equipment", body);
  return response.data;
}

export async function updateEquipment(id, changes) {
  const response = await apiClient.patch(`/equipment/${id}`, changes);
  return response.data;
}

export async function recordEquipmentCondition(id, body) {
  const response = await apiClient.patch(`/equipment/${id}/condition`, body);
  return response.data;
}

export async function retireEquipment(id) {
  const response = await apiClient.post(`/equipment/${id}/retire`);
  return response.data;
}

export async function reinstateEquipment(id) {
  const response = await apiClient.post(`/equipment/${id}/reinstate`);
  return response.data;
}

export async function getEquipmentHistory(id) {
  const response = await apiClient.get(`/equipment/${id}/history`);
  return response.data;
}
