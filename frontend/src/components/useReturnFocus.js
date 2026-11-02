// Back from a list's detail view returns focus to the row button that opened
// it, or to the list heading if that row is no longer listed, so keyboard and
// screen reader users land where they left off. Focus moves once the list is
// showing and has finished loading.
import { useEffect, useRef } from "react";

/**
 * @param {*} selectedId  the open row's id, or null while the list is showing
 * @param {boolean} loading  whether the list is loading
 * @returns {{ listHeadingRef: object, rowRef: (id: *) => (node: HTMLElement|null) => void,
 *   returnFocusTo: (id: *) => void }}
 *   returnFocusTo(id) is called on Back, before the list shows again
 */
export default function useReturnFocus(selectedId, loading) {
  const rowButtons = useRef(new Map());
  const listHeadingRef = useRef(null);
  const returnFocusId = useRef(null);

  useEffect(() => {
    if (selectedId || loading || returnFocusId.current === null) return;
    const target = rowButtons.current.get(returnFocusId.current) ?? listHeadingRef.current;
    returnFocusId.current = null;
    target?.focus();
  }, [selectedId, loading]);

  function rowRef(id) {
    return (node) => {
      if (node) rowButtons.current.set(id, node);
      else rowButtons.current.delete(id);
    };
  }

  function returnFocusTo(id) {
    returnFocusId.current = id;
  }

  return { listHeadingRef, rowRef, returnFocusTo };
}
