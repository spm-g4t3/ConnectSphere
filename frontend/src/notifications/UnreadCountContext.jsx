// UnreadCountContext.jsx
//
// The signed-in user's exact unread count, shared so the nav badge and the
// inbox heading read one number and can never disagree.

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { getUnreadCount } from "../services/notificationService";

const UnreadCountContext = createContext(null);

// Outside a provider (a component rendered on its own in a test) there is no
// count to show, so it shows none rather than throwing as useAuth does.
const NO_PROVIDER = { unreadCount: null, refreshUnreadCount: () => {} };

export function UnreadCountProvider({ children }) {
  const { user } = useAuth();
  // Each reading remembers whose it was, so after a sign-out or a switch of
  // user, the previous user's count (or a reply still in flight for them)
  // never reaches the next user's badge.
  const [reading, setReading] = useState(null);
  // null means "show no number": never known, or no one is signed in.
  const unreadCount = user && reading?.user === user ? reading.count : null;

  const refreshUnreadCount = useCallback(async () => {
    if (!user) return;
    try {
      const count = await getUnreadCount();
      setReading({ user, count });
    } catch {
      // Keep the last known value: a badge must never show a wrong number,
      // and a failed read says nothing about the count.
    }
  }, [user]);

  useEffect(() => {
    refreshUnreadCount();
  }, [refreshUnreadCount]);

  // Re-read when the user comes back to the tab, the inbox's pattern and its
  // reason: notifications are written by other people's actions while this
  // screen is not being looked at. No polling.
  useEffect(() => {
    if (!user) return undefined;

    function refetchIfVisible() {
      if (document.visibilityState === "visible") refreshUnreadCount();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [user, refreshUnreadCount]);

  return (
    <UnreadCountContext.Provider value={{ unreadCount, refreshUnreadCount }}>
      {children}
    </UnreadCountContext.Provider>
  );
}

export function useUnreadCount() {
  return useContext(UnreadCountContext) ?? NO_PROVIDER;
}
