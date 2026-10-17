// NotificationInbox.jsx
//
// The signed-in user's inbox, mounted on every role's dashboard. The API
// scopes it to the caller, so one component serves every role.
//
// Read and unread are listed together, newest first, with the unread count
// in the heading. Hiding read ones would make "what did that message say?"
// unanswerable once it had been marked; the count is what keeps unread ones
// from getting lost among them.
//
// Like ReviewQueue it renders a <section> and not the dashboard wrapper, so
// its card styling and scoped rules come from the parent that mounts it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  listNotifications,
  markNotificationRead,
} from "../services/notificationService";
import { describeNotification } from "../services/notificationDisplay";
import { formatTimestamp } from "../services/displayFormat";
import { notificationLink } from "../services/notificationLink";
import { useUnreadCount } from "../notifications/UnreadCountContext";
import { useRefetchOnReturn } from "../notifications/useRefetchOnReturn";
import { useAuth } from "../auth/AuthContext";

// Keyed by status, the same shape as ReviewQueue's QUEUE_ERROR_MESSAGES. No
// 403: the route has no role gate, so a 403 cannot happen. A 500 reads the
// same as any other failure, so it takes the fallback below.
const LIST_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
};

// The same idea for a single row. 404 gets its own words because it is the
// one failure with a known cause -- the notification is gone or is not this
// account's -- and retrying the button will never fix it.
const MARK_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  404: "This notification is no longer available.",
};

export default function NotificationInbox() {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Per row, keyed by notification id, so marking one row never disables or
  // clears the error on another.
  const [marking, setMarking] = useState({});
  const [rowErrors, setRowErrors] = useState({});

  const { unreadCount: serverUnreadCount, refreshUnreadCount } = useUnreadCount();
  const { user } = useAuth();
  const location = useLocation();
  const sectionRef = useRef(null);

  // Keyed on location.key too, so clicking the nav link while already on
  // /dashboard#notifications still scrolls. jsdom has no scrollIntoView.
  useEffect(() => {
    if (location.hash !== "#notifications") return;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, [location.key, location.hash]);

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listNotifications();
      setNotifications(data);
      setError(null);
      refreshUnreadCount();
    } catch (err) {
      setError(
        LIST_ERROR_MESSAGES[err.response?.status] ||
          "Notifications could not be loaded. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [refreshUnreadCount]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Re-read on returning to the tab, as ReviewQueue does: other people's
  // actions (a Venue Staff member overriding a block) land while it is hidden.
  useRefetchOnReturn(fetchNotifications);

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
      refreshUnreadCount();
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

  // SCRUM-172 (AC7): opening a notification counts as reading it. The count
  // re-reads when the user returns, so navigation never waits on this call
  // and a failure is left for the next visit.
  function markOpenedRead(notification) {
    if (notification.readAt) return;
    markNotificationRead(notification.id)
      .then(() => refreshUnreadCount())
      .catch(() => {});
  }

  // The list is capped at 50 and the server count is exact, so the server
  // count wins whenever it is known: the nav badge shows the same number, and
  // the two must never disagree.
  const unreadCount = typeof serverUnreadCount === "number"
    ? serverUnreadCount
    : notifications.filter((notification) => !notification.readAt).length;

  return (
    <section id="notifications" className="notification-inbox" ref={sectionRef}>
      <h2>Notifications{unreadCount > 0 && ` (${unreadCount} unread)`}</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="notification-inbox__error" role="alert">
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
          const link = user ? notificationLink(notification, user.role) : null;

          return (
            <li
              key={notification.id}
              className={
                unread
                  ? "notification-inbox__item notification-inbox__item--unread"
                  : "notification-inbox__item notification-inbox__item--read"
              }
            >
              <div className="notification-inbox__body">
                <p className="notification-inbox__headline">
                  {link ? (
                    <Link
                      className="notification-inbox__link"
                      to={link.to}
                      state={link.state}
                      onClick={() => markOpenedRead(notification)}
                    >
                      <strong>{headline}</strong>
                    </Link>
                  ) : (
                    <strong>{headline}</strong>
                  )}
                  {unread && <span className="notification-inbox__new">New</span>}
                </p>
                <p className="notification-inbox__detail">{detail}</p>
                <p className="notification-inbox__time">
                  Received {formatTimestamp(notification.createdAt)}
                </p>
                {rowError && (
                  <p className="notification-inbox__row-error" role="alert">
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
