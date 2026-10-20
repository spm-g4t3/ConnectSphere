// The read the work-list screens share: "Loading..." on every fetch, and a
// failed fetch shows its message over whatever list was already there.
// Unlike useOpenEventRead it keeps no "loaded" state and no stale guard.
import { useCallback, useEffect, useState } from "react";

/**
 * @param {() => Promise<Array>} fetcher  must be stable; it is read on mount
 * @param {object} options
 * @param {Record<number, string>} options.messages  load-error text by status; a stable object
 * @param {string} options.fallback  load-error text for any other status
 * @returns {{ data: Array, loading: boolean, error: string|null, load: () => Promise<Array|null> }}
 *   load() resolves to the fresh list, or null when the fetch failed; it never rejects
 */
export default function useListRead(fetcher, { messages, fallback }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await fetcher();
      setData(fresh);
      setError(null);
      return fresh;
    } catch (err) {
      setError(messages[err.response?.status] || fallback);
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetcher, messages, fallback]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, load };
}
