// CoordinatorNotifications.jsx
//
// SCRUM-128 (SCRUM-17 AC3): "... each affected booking is flagged for review
// and its Event Coordinator is notified." This is where the Coordinator sees
// that notification. It replaces the "Pending venue bookings" stub on
// EventCoordinatorDashboard, which never had an endpoint behind it.
//
// Read and unread are listed together, newest first, with the unread count
// in the heading. Hiding read ones would make "what did that message say?"
// unanswerable once it had been marked; the count is what keeps unread ones
// from getting lost among them.
//
// Like ReviewQueue it renders a <section> and not the dashboard wrapper, so
// its card styling and scoped rules come from the parent that mounts it.

import { useCallback, useEffect, useState } from "react";
import {
  listNotifications,
  markNotificationRead,
} from "../services/notificationService";
import { describeNotification } from "../services/notificationDisplay";
import { formatTimestamp } from "../services/displayFormat";

// Keyed by status, the same shape as ReviewQueue's QUEUE_ERROR_MESSAGES. No
// 403: the route has no role gate, so a 403 cannot happen.
const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  500: "Notifications could not be loaded. Please try again.",
};

// The same idea for a single row. 404 gets its own words because it is the
// one failure with a known cause -- the notification is gone or is not this
// account's -- and retrying the button will never fix it.
const MARK_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  404: "This notification is no longer available.",
};

export default function CoordinatorNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Per row, keyed by notification id, so marking one row never disables or
  // clears the error on another.
  const [marking, setMarking] = useState({});
  const [rowErrors, setRowErrors] = useState({});

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listNotifications();
      setNotifications(data);
      setError(null);
    } catch (err) {
      setError(
        LIST_ERROR_MESSAGES[err.response?.status] ||
          "Notifications could not be loaded. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Refetch when the Coordinator comes back to the tab, copied from
  // ReviewQueue and for the same reason: notifications are written by other
  // people's actions (a Venue Staff member overriding a block) while this
  // screen is not being looked at, so the moment worth re-reading on is the
  // moment it is looked at again. No polling.
  useEffect(() => {
    function refetchIfVisible() {
      if (document.visibilityState === "visible") fetchNotifications();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [fetchNotifications]);

  // Not optimistic: the row changes only once the server has said it is read.
  // Flipping it first and rolling back on failure would briefly show the
  // unread count dropping for a notification that is still unread -- the one
  // number on this card the Coordinator relies on.
  async function handleMarkRead(id) {
    setMarking((current) => ({ ...current, [id]: true }));
    setRowErrors((current) => ({ ...current, [id]: null }));

    try {
      const updated = await markNotificationRead(id);
      setNotifications((current) =>
        current.map((notification) => (notification.id === id ? updated : notification)),
      );
    } catch (err) {
      const status = err.response?.status;
      setRowErrors((current) => ({
        ...current,
        [id]:
          MARK_ERROR_MESSAGES[status] ||
          "This notification could not be marked as read. Please try again.",
      }));
      // The list this row came from is stale, so re-read it rather than
      // leave a row the server no longer recognises.
      if (status === 404) fetchNotifications();
    } finally {
      setMarking((current) => ({ ...current, [id]: false }));
    }
  }

  const unreadCount = notifications.filter((notification) => !notification.readAt).length;

  return (
    <section className="coordinator-notifications">
      <h2>Notifications{unreadCount > 0 && ` (${unreadCount} unread)`}</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="coordinator-notifications__error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && notifications.length === 0 && (
        <p>You have no notifications.</p>
      )}

      {/* Newest first, as the backend orders them; not re-sorted here, for
          the reason ReviewQueue gives. */}
      <ul>
        {notifications.map((notification) => {
          const { headline, detail } = describeNotification(notification);
          const unread = !notification.readAt;
          const rowError = rowErrors[notification.id];

          return (
            <li
              key={notification.id}
              className={
                unread
                  ? "coordinator-notifications__item coordinator-notifications__item--unread"
                  : "coordinator-notifications__item coordinator-notifications__item--read"
              }
            >
              <div className="coordinator-notifications__body">
                <p className="coordinator-notifications__headline">
                  <strong>{headline}</strong>
                  {unread && <span className="coordinator-notifications__new">New</span>}
                </p>
                <p className="coordinator-notifications__detail">{detail}</p>
                <p className="coordinator-notifications__time">
                  Received {formatTimestamp(notification.createdAt)}
                </p>
                {rowError && (
                  <p className="coordinator-notifications__row-error" role="alert">
                    {rowError}
                  </p>
                )}
              </div>

              {unread && (
                <button
                  onClick={() => handleMarkRead(notification.id)}
                  disabled={Boolean(marking[notification.id])}
                >
                  {marking[notification.id] ? "Marking..." : "Mark as read"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
