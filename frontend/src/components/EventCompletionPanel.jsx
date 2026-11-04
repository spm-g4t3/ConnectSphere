// EventCompletionPanel.jsx
//
// SCRUM-384 (SCRUM-379 AC1, AC2): the assigned coordinator marks a Confirmed event that has ended
// as completed, with optional closing notes and a confirmation step.
//
// Two steps, because completing is final: the notes box, then a confirmation dialog that
// repeats the notes as they will be sent. The notes stay in the box behind it, so going back
// keeps what was typed. Nothing is sent until the confirm.
//
// CoordinatorRequestDetail decides whether to offer the panel; the server decides whether it
// is allowed (complete_event_request, 034).

import { useEffect, useRef, useState } from "react";
import { completeEventRequest } from "../services/eventRequestService";
import {
  CLOSING_NOTES_MAX_LENGTH,
  completionErrorMessage,
} from "../services/eventCompletion";
import { formatVenuePeriod } from "../services/datetimeFormat";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import ErrorNotice from "./ui/ErrorNotice";

/**
 * @param {object} props
 * @param {number} [props.headingLevel]  the page title's level: 1 on the event's
 *   own page, 2 inside a list whose title is the h1
 */
export default function EventCompletionPanel({ eventRequest, onCompleted, onBack, headingLevel = 1 }) {
  const Title = `h${headingLevel}`;
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const notesRef = useRef(null);
  const continueRef = useRef(null);
  // Where focus lands once the dialog has closed without completing, so it is never lost.
  const refocus = useRef(null);
  const headingRef = useRef(null);

  // The button that opened this page has gone, so focus starts on its title.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (confirming || !refocus.current) return;
    refocus.current.current?.focus();
    refocus.current = null;
  }, [confirming]);

  const trimmed = notes.trim();
  // Characters, as the server counts them (an emoji is one), so no maxLength on the box: that
  // counts UTF-16 units. The count is shown and Continue is held back past the limit.
  const characters = [...notes].length;
  const tooLong = [...trimmed].length > CLOSING_NOTES_MAX_LENGTH;

  function handleContinue(event) {
    event.preventDefault();
    /* v8 ignore next -- @preserve Continue is disabled while the notes are too long. */
    if (tooLong) return;
    setError(null);
    setConfirming(true);
  }

  async function handleConfirm() {
    /* v8 ignore next -- @preserve ConfirmDialog disables Confirm while busy. */
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await completeEventRequest(eventRequest.id, { closingNotes: trimmed });
      onCompleted?.(updated);
    } catch (requestError) {
      setError(completionErrorMessage(requestError));
      refocus.current = continueRef;
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="event-completion-page">
      {onBack && (
        <Button variant="link" onClick={onBack} disabled={submitting}>
          Back to event
        </Button>
      )}
      <p className="eyebrow">Coordinator action</p>
      <Title ref={headingRef} tabIndex={-1}>Mark {eventRequest.eventName} as completed</Title>
      <p className="event-completion-page__intro">
        The event ran {formatVenuePeriod(eventRequest.proposedStart, eventRequest.proposedEnd, "at a time that is not recorded")}.
        Completing it is final: its records stay viewable, but it can no longer be changed.
      </p>

      <section className="event-completion">
        <form onSubmit={handleContinue}>
          <label>
            Closing notes (optional)
            <textarea
              ref={notesRef}
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
          <Button ref={continueRef} type="submit" disabled={tooLong}>Continue</Button>
        </form>
        <ConfirmDialog
          open={confirming}
          title={`Mark ${eventRequest.eventName} as completed?`}
          confirmLabel={submitting ? "Marking as completed..." : "Yes, mark as completed"}
          cancelLabel="Edit notes"
          busy={submitting}
          onConfirm={handleConfirm}
          onCancel={() => {
            refocus.current = notesRef;
            setConfirming(false);
          }}
        >
          <div className="event-completion__confirmation">
            <p>This cannot be undone.</p>
            <dl>
              <dt>Closing notes</dt>
              <dd className="event-completion__notes-preview">
                {trimmed || "No closing notes."}
              </dd>
            </dl>
          </div>
        </ConfirmDialog>
        {/* No Try again: Continue and the confirm resend from the same notes. */}
        {error && <ErrorNotice message={error} />}
      </section>
    </main>
  );
}
