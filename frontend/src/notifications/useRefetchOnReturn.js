// useRefetchOnReturn.js
//
// Re-reads when the user comes back to the tab: notifications are written by
// other people's actions while the screen is not being looked at, so the
// moment worth re-reading on is the moment it is looked at again. No polling.

import { useEffect } from "react";

/**
 * Calls `refetch` on window focus and on a visibilitychange to visible.
 *
 * @param {Function} refetch  keep it stable (useCallback); a new one re-registers
 * @param {boolean} enabled   false registers nothing (e.g. no one signed in)
 */
export function useRefetchOnReturn(refetch, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;

    function refetchIfVisible() {
      if (document.visibilityState === "visible") refetch();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [refetch, enabled]);
}
