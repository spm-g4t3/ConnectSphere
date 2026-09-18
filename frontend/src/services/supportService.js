// supportService.js
//
// STUB — no backend endpoint exists yet for Technical Support tickets or
// equipment requests. These functions exist purely so the import in
// TechnicalSupportDashboard.jsx resolves and the app can actually run.
// Replace the body of each function once the real endpoint is built.

/**
 * @returns {Promise<Array>} always empty for now
 */
export async function getOpenTickets() {
  console.warn("getOpenTickets: not implemented yet — no backend endpoint exists.");
  return [];
}

/**
 * @returns {Promise<Array>} always empty for now
 */
export async function getEquipmentRequests() {
  console.warn("getEquipmentRequests: not implemented yet — no backend endpoint exists.");
  return [];
}
