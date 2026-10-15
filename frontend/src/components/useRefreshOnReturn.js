// Runs `refresh` when the reader returns to the tab: availability changes while
// nobody is looking, and neither browse page caches.

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
