// The read the browse list and details share: a spinner on first load, then
// background refreshes that keep what is on screen by default. `fetcher` must be stable;
// a new one is a new subject and starts from scratch. load() resolves to
// { kind: "ok", data } | "not-found" | "error" | "superseded".
import { useCallback, useEffect, useRef, useState } from "react";

// A refusal is not transient: keeping data on screen after one would be wrong.
const REFUSALS = [401, 403];

/**
 * @param {() => Promise<*>} fetcher
 * @param {object} options
 * @param {Record<number, string>} options.messages  load-error text by status; a stable object
 * @param {string} options.fallback  load-error text for any other status
 * @param {boolean} [options.notFoundIsAnswer]  a 404 means "no longer open", not a failure
 * @param {boolean} [options.retainDataOnRefresh=true] false clears protected data until revalidated
 */
export default function useOpenEventRead(fetcher, {
  messages, fallback, notFoundIsAnswer = false, retainDataOnRefresh = true,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    const background = loaded.current && retainDataOnRefresh;
    if (!background) {
      setLoading(true);
      setError(null);
      setNotFound(false);
      setRefreshFailed(false);
      setData(null);
    }

    try {
      const fresh = await fetcher();
      if (mine !== latest.current) return { kind: "superseded" };
      loaded.current = true;
      setData(fresh);
      setNotFound(false);
      setError(null);
      setRefreshFailed(false);
      return { kind: "ok", data: fresh };
    } catch (err) {
      if (mine !== latest.current) return { kind: "superseded" };
      const status = err?.response?.status;

      if (notFoundIsAnswer && status === 404) {
        // No longer open, for whatever reason: nothing may still offer to register.
        loaded.current = true;
        setData(null);
        setNotFound(true);
        setError(null);
        setRefreshFailed(false);
        return { kind: "not-found" };
      }

      if (background && !REFUSALS.includes(status)) {
        setRefreshFailed(true);
        return { kind: "error" };
      }

      loaded.current = false;
      setData(null);
      setNotFound(false);
      setRefreshFailed(false);
      setError(messages[status] || fallback);
      return { kind: "error" };
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [fetcher, messages, fallback, notFoundIsAnswer, retainDataOnRefresh]);

  useEffect(() => {
    loaded.current = false;
    load();
  }, [load]);

  return { data, loading, notFound, error, refreshFailed, load };
}
