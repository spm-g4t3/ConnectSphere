// useRefreshOnReturn.js
//
// SCRUM-495. Runs `refresh` when the reader comes back to the tab or window,
// the same two events MyBookingRequests and MyAssignedEvents refetch on, for
// the same reason: what is on offer changes while nobody is looking (a place
// is taken, a window closes, an event goes back to Approved). Nothing else
// here is a cache: the list and the details read the server on every call.

import { useEffect } from "react";

export default function useRefreshOnReturn(refresh) {
  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === "visible") refresh();
    }

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);
}
