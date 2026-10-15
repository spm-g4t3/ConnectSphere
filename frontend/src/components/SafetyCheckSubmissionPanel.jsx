// SafetyCheckSubmissionPanel.jsx
//
// SCRUM-489: the assigned coordinator submits an Approved event for the
// Operational Safety Check. The checklist is the server's (event_readiness);
// this panel shows it and never decides readiness itself, so Submit being
// enabled is a convenience and the server checks again under its locks.

import { useEffect, useState } from "react";
import {
  getEventReadiness,
  submitForSafetyReview,
} from "../services/eventRequestService";

// The server's limit, counted as the server counts it: after trimming.
const SAFETY_NOTE_MAX = 2000;

const KEY_LABEL = {
  venue: "Venue",
  equipment: "Equipment",
  no_equipment_confirmation: "No equipment needed",
  date: "Date",
};

const NOT_APPROVED_MESSAGE =
  "This event is no longer Approved, so it cannot be submitted for the safety check. The page has been refreshed to show where it stands.";

const NOTE_REFUSED_MESSAGE = "The note could not be sent. It must be 2,000 characters or fewer.";

// A 400 is about the note only when its details name the note field: the
// database's own refusals (a check or a foreign key) are 400s too.
const OTHER_400_MESSAGE =
  "The submission was refused and nothing was changed. Please try again, or tell the team if it keeps happening.";

const SUBMIT_ERROR_MESSAGES = {
  403: "You are no longer this event's coordinator, so you cannot submit it.",
};

const GENERIC_SUBMIT_ERROR =
  "The event could not be submitted for the safety check. No changes have been made; try again.";

function formatCount(value) {
  return value.toLocaleString("en-US");
}

function isAboutTheNote(data) {
  return Array.isArray(data?.details) && data.details.some((entry) => entry?.field === "note");
}

function itemLabel(item) {
  const label = KEY_LABEL[item.key] ?? "Other";
  return item.key === "venue" && item.venueName ? `${label}: ${item.venueName}` : label;
}

/** The server's lines, in its order. The status is a word; colour only adds to it. */
function ChecklistTable({ caption, items }) {
  return (
    <table className="safety-check-submission__checklist">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Status</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={`${item.key}-${item.bookingId ?? item.equipmentRequestId ?? index}`}>
            <td>{itemLabel(item)}</td>
            <td>
              <span className={`safety-check-submission__badge safety-check-submission__badge--${item.met ? "met" : "outstanding"}`}>
                {item.met ? "Met" : "Outstanding"}
              </span>
            </td>
            <td>{item.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SafetyCheckSubmissionPanel({ eventRequest, onSubmitted, onStale }) {
  const [readiness, setReadiness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Bumped to re-read the checklist: Retry, or a refusal saying it changed.
  const [readVersion, setReadVersion] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [notReadyLines, setNotReadyLines] = useState(null);

  useEffect(() => {
    let cancelled = false;
    // Any failure, thrown or rejected, is the panel's error state, never the page's.
    async function read() {
      setLoading(true);
      setLoadError(false);
      try {
        const result = await getEventReadiness(eventRequest.id, { noEquipmentConfirmed: confirmed });
        if (!cancelled) setReadiness(result);
      } catch {
        if (!cancelled) {
          setReadiness(null);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    read();
    return () => {
      cancelled = true;
    };
  }, [eventRequest.id, confirmed, readVersion]);

  const items = readiness?.items ?? [];
  const confirmation = items.find((item) => item.key === "no_equipment_confirmation");
  const noteLength = note.trim().length;
  const noteTooLong = noteLength > SAFETY_NOTE_MAX;
  const canSubmit = !loading && readiness?.ready === true && !noteTooLong && !submitting;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setNotReadyLines(null);
    try {
      const updated = await submitForSafetyReview(eventRequest.id, {
        note: note.trim() || undefined,
        noEquipmentConfirmed: confirmed,
      });
      onSubmitted?.(updated);
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      if (status === 409 && data?.code === "EVENT_NOT_READY") {
        setNotReadyLines(Array.isArray(data.conflicts) ? data.conflicts : []);
        setReadVersion((version) => version + 1);
      } else if (status === 409) {
        setSubmitError(NOT_APPROVED_MESSAGE);
        onStale?.();
      } else if (status === 400) {
        setSubmitError(isAboutTheNote(data) ? NOTE_REFUSED_MESSAGE : OTHER_400_MESSAGE);
      } else {
        setSubmitError(SUBMIT_ERROR_MESSAGES[status] ?? GENERIC_SUBMIT_ERROR);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="safety-check-submission" aria-label="Submit for the safety check">
      <h3>Submit for the safety check</h3>
      <p>
        A Safety Officer checks the arrangements before the event can be
        confirmed. Every item below must be met first.
      </p>

      {loading && <p>Loading the checklist...</p>}
      {!loading && loadError && (
        <div role="alert">
          <p>The checklist could not be loaded.</p>
          <button type="button" onClick={() => setReadVersion((version) => version + 1)}>
            Retry
          </button>
        </div>
      )}
      {!loading && readiness && (
        <ChecklistTable caption="Readiness checklist" items={items} />
      )}

      <form onSubmit={handleSubmit}>
        {confirmation && (
          <div className="safety-check-submission__confirmation">
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={loading}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              This event needs no equipment
            </label>
            <p>The organiser asked for:</p>
            <blockquote>{confirmation.organiserRequirements}</blockquote>
          </div>
        )}

        <label className="safety-check-submission__note">
          Note for the Safety Officer (optional)
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            aria-describedby="safety-check-note-hint"
          />
        </label>
        <p className="safety-check-submission__hint" id="safety-check-note-hint">
          For example, how the crowd will move and where equipment will be placed.
        </p>
        <p className="safety-check-submission__counter">
          {formatCount(noteLength)} / {formatCount(SAFETY_NOTE_MAX)}
        </p>
        {noteTooLong && (
          <p role="alert">The note must be 2,000 characters or fewer.</p>
        )}

        <button type="submit" disabled={!canSubmit}>
          {submitting ? "Submitting..." : "Submit for safety check"}
        </button>
      </form>

      {notReadyLines && (
        <div role="alert">
          <p>This event is not ready for the safety check.</p>
          <ChecklistTable caption="Still outstanding" items={notReadyLines} />
        </div>
      )}
      {submitError && <p role="alert">{submitError}</p>}
    </section>
  );
}
