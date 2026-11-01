// EventCompletionPanel.jsx
//
// SCRUM-384 (SCRUM-379 AC1, AC2): the assigned coordinator marks a Confirmed event that has ended
// as completed, with optional closing notes and a confirmation step.
//
// Two steps, because completing is final: the notes box, then a summary of what is about to
// happen with an explicit confirm. Editing the notes again from the summary keeps what was typed. Nothing is
// sent until the confirm.
//
// A page-sized panel with a back button, like EventCancellationPanel: the house pattern, since
// there is no modal anywhere in this frontend. CoordinatorRequestDetail decides whether to offer
// it; the server decides whether it is allowed (complete_event_request, 034).

import { useState } from "react";
import { completeEventRequest } from "../services/eventRequestService";
import {
  CLOSING_NOTES_MAX_LENGTH,
  completionErrorMessage,
} from "../services/eventCompletion";
import { formatVenuePeriod } from "../services/datetimeFormat";

export default function EventCompletionPanel({ eventRequest, onCompleted, onBack }) {
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const trimmed = notes.trim();
  // Characters, as the server counts them (an emoji is one), so no maxLength on the box: that
  // counts UTF-16 units. The count is shown and Continue is held back past the limit.
  const characters = [...notes].length;
  const tooLong = [...trimmed].length > CLOSING_NOTES_MAX_LENGTH;

  function handleContinue(event) {
    event.preventDefault();
    if (tooLong) return;
    setError(null);
    setConfirming(true);
  }

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await completeEventRequest(eventRequest.id, { closingNotes: trimmed });
      onCompleted?.(updated);
    } catch (requestError) {
      setError(completionErrorMessage(requestError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="event-completion-page">
      {onBack && (
        <button className="event-completion-page__back" type="button" onClick={onBack} disabled={submitting}>
          Back to event
        </button>
      )}
      <p className="eyebrow">Coordinator action</p>
      <h1>Mark {eventRequest.eventName} as completed</h1>
      <p className="event-completion-page__intro">
        The event ran {formatVenuePeriod(eventRequest.proposedStart, eventRequest.proposedEnd, "at a time that is not recorded")}.
        Completing it is final: its records stay viewable, but it can no longer be changed.
      </p>

      <section className="event-completion">
        {!confirming ? (
          <form onSubmit={handleContinue}>
            <label>
              Closing notes (optional)
              <textarea
                value={notes}
                onChange={(event) => { setNotes(event.target.value); setError(null); }}
                rows={5}
                aria-describedby="closing-notes-help"
                aria-invalid={tooLong || undefined}
              />
            </label>
            <p id="closing-notes-help" className="event-completion__help">
              Only coordinators can see these notes. {characters} of {CLOSING_NOTES_MAX_LENGTH} characters.
            </p>
            {tooLong && (
              <p role="alert">
                Closing notes can be at most {CLOSING_NOTES_MAX_LENGTH} characters. Shorten them to continue.
              </p>
            )}
            <button type="submit" disabled={tooLong}>Continue</button>
          </form>
        ) : (
          <div className="event-completion__confirmation" role="group" aria-label="Confirm completion">
            <h2>Confirm completion</h2>
            <p>
              You are about to mark <strong>{eventRequest.eventName}</strong> as completed. This
              cannot be undone.
            </p>
            <dl>
              <dt>Closing notes</dt>
              <dd className="event-completion__notes-preview">
                {trimmed || "No closing notes."}
              </dd>
            </dl>
            <div className="event-completion__actions">
              <button type="button" onClick={handleConfirm} disabled={submitting}>
                {submitting ? "Marking as completed..." : "Yes, mark as completed"}
              </button>
              <button
                type="button"
                className="event-completion__secondary"
                onClick={() => { setConfirming(false); setError(null); }}
                disabled={submitting}
              >
                Edit notes
              </button>
            </div>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
