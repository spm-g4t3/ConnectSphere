// BlockHistory.jsx
//
// SCRUM-131 (part of SCRUM-17, AC4: "An existing block can be shortened,
// extended, or removed by Venue Staff, with the creating or amending user and
// timestamp recorded"). One block's full change trail, opened from a row of
// VenueBlocksPanel. The row itself only carries the latest change; this is
// every one of them.
//
// Copies VenueDetail's change-history section: the same
// venue-history__meta/__value markup, the same "Changed outside the app" for
// a null changedBy, and the same rule that an entry whose shape is unknown is
// shown raw rather than dropped.
//
// It fetches on mount and again whenever refreshKey changes. The panel passes
// the block's updatedAt, so after a save the list refetch changes it and an
// open history refetches by itself. The ignore flag stops a slow, older
// response from overwriting a newer one.
//
// currentUserId is a prop, not useAuth(): useAuth throws without an
// AuthProvider, and the panel (and its tests) render without one.

import { useEffect, useState } from "react";
import { getVenueBlockHistory } from "../services/venueService";
import { formatTimestamp, shortId } from "../services/displayFormat";
import {
  blockCreationSummary,
  blockHistoryActionLabel,
  blockHistoryChanges,
  isCurrentUser,
} from "../services/venueBlockHistoryDisplay";

// Keyed by status. The server's `error` is never shown: it is database prose
// that can carry raw uuids.
const HISTORY_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Venue Staff can see a block's history.",
  404: "That block no longer exists.",
};
const DEFAULT_ERROR = "Could not load this block's history. Please try again.";

/** A last-resort rendering of a raw jsonb value. Never throws. */
function raw(value) {
  try {
    if (value === undefined) return "(none)";
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Who made a change: "by you", "by <short id>" with the full id in a title,
 * or `outsideText` when there is no id -- a change made outside the app, not
 * a user we lost the name of.
 */
export function BlockActor({ id, currentUserId, outsideText = "outside the app" }) {
  if (isCurrentUser(id, currentUserId)) return <span>by you</span>;
  if (id) {
    return (
      <span>
        by <code title={String(id)}>{shortId(id)}</code>
      </span>
    );
  }
  return <span>{outsideText}</span>;
}

function EntryBody({ entry }) {
  const changes = blockHistoryChanges(entry);

  // Not plain objects: a shape no trigger writes. Shown raw, because an audit
  // trail that quietly omits an entry is worse than an ugly one.
  if (changes === null) {
    return (
      <pre className="venue-history__value">
        {raw(entry?.oldValues)} &rarr; {raw(entry?.newValues)}
      </pre>
    );
  }

  if (entry.action === "created") {
    const summary = blockCreationSummary(entry.newValues);
    if (summary.length === 0) return <p className="venue-history__value">Block created</p>;
    return (
      <ul>
        {summary.map((row) => (
          <li key={row.key}>
            <span className="venue-history__value">{`${row.label}: ${row.value}`}</span>
          </li>
        ))}
      </ul>
    );
  }

  const changeList =
    changes.length > 0 ? (
      <ul>
        {changes.map((change) => (
          <li key={change.key}>
            <span className="venue-history__value">
              {`${change.label}: ${change.from} → ${change.to}`}
            </span>
          </li>
        ))}
      </ul>
    ) : null;

  if (entry.action === "removed") {
    return (
      <>
        <p className="venue-history__value">Block removed</p>
        {changeList}
      </>
    );
  }

  return changeList ?? <p className="venue-history__value">No details changed</p>;
}

export default function BlockHistory({ venueId, blockId, refreshKey, currentUserId, id }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      try {
        const data = await getVenueBlockHistory(venueId, blockId);
        if (ignore) return;
        setEntries(Array.isArray(data) ? data : []);
        setError(null);
      } catch (err) {
        if (ignore) return;
        setError(HISTORY_ERROR_MESSAGES[err?.response?.status] || DEFAULT_ERROR);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [venueId, blockId, refreshKey]);

  return (
    <section className="block-history" id={id} aria-label="Change history">
      {loading && entries.length === 0 && <p>Loading history...</p>}
      {error && (
        <p className="venue-blocks__error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && entries.length === 0 && (
        <p>No changes have been recorded for this block.</p>
      )}

      {entries.length > 0 && (
        <>
          <ul>
            {entries.map((entry, index) => (
              <li key={entry?.id ?? index}>
                <div className="venue-history__meta">
                  <strong>{blockHistoryActionLabel(entry?.action)}</strong>
                  <span>{formatTimestamp(entry?.changedAt)}</span>
                  <BlockActor
                    id={entry?.changedBy}
                    currentUserId={currentUserId}
                    outsideText="Changed outside the app"
                  />
                </div>
                <EntryBody entry={entry} />
              </li>
            ))}
          </ul>
          <p className="venue-detail__help">
            Other staff are shown by a short user id &mdash; the API records ids, not names.
          </p>
        </>
      )}
    </section>
  );
}
