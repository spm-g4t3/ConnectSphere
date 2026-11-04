import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Try again goes away while its read reloads, so focus would fall to the page
 * body. The returned retry reloads, then focuses the element headingRef is on
 * (give it tabIndex={-1}). Also after a second failure: Tab from there reaches
 * the new Try again. Counted, so a first load or a tab-return refetch stays put.
 */
export default function useFocusAfterRetry(reload) {
  const [focusRequest, setFocusRequest] = useState(0);
  const headingRef = useRef(null);

  useEffect(() => {
    if (focusRequest) headingRef.current?.focus();
  }, [focusRequest]);

  const retry = useCallback(async () => {
    await reload();
    setFocusRequest((count) => count + 1);
  }, [reload]);

  return { headingRef, retry };
}
