// useOpenEventRead.js
//
// SCRUM-495. The read the browse list and the event details share: show a
// spinner on the first load, then refresh in the background without blanking
// what is on screen. A failed refresh keeps the last answer with a notice; a
// lost session or refused role replaces it; the newest read wins.
//
// `fetcher` must be stable (module scope or useCallback): a new one is a new
// subject, so the read starts again from scratch and nothing from the old one,
// including its refresh notice, carries over.
//
// load() resolves to what was found, so a caller that needs the fresh state
// can act on it: { kind: "ok", data }, { kind: "not-found" }, { kind: "error" }
// or { kind: "superseded" } when a newer read took over.
import { useCallback, useEffect, useRef, useState } from "react";

// A refusal is not transient: keeping data on screen after one would be wrong.
const REFUSALS = [401, 403];

/**
 * @param {() => Promise<*>} fetcher
 * @param {object} options
 * @param {Record<number, string>} options.messages  load-error text by status; a stable object
 * @param {string} options.fallback  load-error text for any other status
 * @param {boolean} [options.notFoundIsAnswer]  a 404 means "no longer open", not a failure
 */
export default function useOpenEventRead(fetcher, { messages, fallback, notFoundIsAnswer = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const latest = useRef(0);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    const background = loaded.current;
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
      const status = err.response?.status;

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
  }, [fetcher, messages, fallback, notFoundIsAnswer]);

  useEffect(() => {
    loaded.current = false;
    load();
  }, [load]);

  return { data, loading, notFound, error, refreshFailed, load };
}
