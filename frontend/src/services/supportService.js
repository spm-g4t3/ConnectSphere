// supportService.js
//
// STUB: no backend endpoint exists yet for Technical Support tickets. This
// function exists purely so the import in TechnicalSupportDashboard.jsx resolves
// and the app can actually run. Replace its body once the real endpoint is built.
// (The equipment request list is real now: equipmentQueueService.js, SCRUM-287.)

/**
 * @returns {Promise<Array>} always empty for now
 */
export async function getOpenTickets() {
  console.warn("getOpenTickets: not implemented yet — no backend endpoint exists.");
  return [];
}
