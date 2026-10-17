// notificationService.js
//
// SCRUM-128 (SCRUM-17 AC3). The signed-in user's notifications, served by
// backend/src/routes/notifications.js at /api/notifications.
//
// The backend scopes both calls to the caller's token, so neither passes a
// user id -- the same stance eventRequestService takes for "my requests".
//
// Errors are not caught here. The component decides what a 401, 404 or 500
// means to the reader, and it can only do that with err.response intact.

import { apiClient } from "./apiClient";

/**
 * The caller's notifications, newest first, read and unread together (the
 * backend caps the list at 50).
 *
 * @returns {Promise<Array<{id, type, bookingId, blockId, venueHoldId,
 *          eventRequestId, payload, readAt, createdAt}>>}
 */
export async function listNotifications() {
  const response = await apiClient.get("/notifications");
  return response.data;
}

/**
 * Marks one notification as read. Idempotent: an already-read notification
 * comes back unchanged, with its original readAt.
 *
 * @param {string} id
 * @returns {Promise<Object>} the notification, readAt set
 */
export async function markNotificationRead(id) {
  const response = await apiClient.patch(`/notifications/${id}/read`);
  return response.data;
}

/**
 * The caller's exact unread count. Not derived from listNotifications, which
 * is capped at 50 and so undercounts past that.
 *
 * @returns {Promise<number>}
 */
export async function getUnreadCount() {
  const response = await apiClient.get("/notifications/unread-count");
  return response.data.unreadCount;
}
