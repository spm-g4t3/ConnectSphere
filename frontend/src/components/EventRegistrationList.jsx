import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import { getEventRegistrations } from "../services/eventRegistrationService";
import { VENUE_TIME_NOTE } from "../services/datetimeFormat";
import { formatDateTime } from "../services/displayFormat";
import { canRetryRead } from "../services/apiErrors";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";

// Read only by design: no register, withdraw, edit or export actions here.
export default function EventRegistrationList({ eventId }) {
  const { user } = useAuth();
  const [hideWithdrawn, setHideWithdrawn] = useState(false);
  const [list, setList] = useState(null);
  // Bumped by Try again to run the read below once more.
  const [attempt, setAttempt] = useState(0);
  // Which filter and attempt the last answer was for: loading is derived from
  // it, so the effect sets no state before the request settles.
  const [result, setResult] = useState({ hideWithdrawn: null, attempt: null, error: null });
  const loading = result.hideWithdrawn !== hideWithdrawn || result.attempt !== attempt;
  const { error } = result;

  useEffect(() => {
    let active = true;
    getEventRegistrations(eventId, { hideWithdrawn })
      .then((data) => {
        if (!active) return;
        setList(data);
        setResult({ hideWithdrawn, attempt, error: null });
      })
      .catch((err) => {
        if (!active) return;
        setResult({
          hideWithdrawn,
          attempt,
          error: err?.response?.data?.error || "Could not load the registrations.",
          retryable: canRetryRead(err),
        });
      });
    return () => {
      active = false;
    };
  }, [eventId, hideWithdrawn, attempt]);

  // The h1 stays on screen while it reloads, so focus can go there at once.
  const { headingRef, retry } = useFocusAfterRetry(() => setAttempt((count) => count + 1));

  const isCoordinator = normaliseRole(user?.role) === "EVENT_COORDINATOR";
  const back = isCoordinator
    ? { to: `/event-requests/${eventId}`, label: "← Back to event" }
    : { to: "/events", label: "← Back to My Events" };
  const counts = list?.counts;

  return (
    <main className="event-registration-page">
      <Link className="ui-button ui-button--link" to={back.to}>{back.label}</Link>

      {/* Titled before the list loads, so loading and error states still have their h1. */}
      <header className="event-registration-page__header">
        {list && <p className="eyebrow">Registrations</p>}
        <h1 ref={headingRef} tabIndex={-1}>{list?.event.eventName || "Registrations"}</h1>
      </header>

      {error && !loading && <ErrorNotice message={error} onRetry={result.retryable ? retry : undefined} />}

      {list && (
        <>
          <section className="event-registration-page__summary" aria-labelledby="registration-counts-heading">
            <h2 id="registration-counts-heading">Registered</h2>
            <p className="registration-list__count" aria-label="Registered count">
              {counts.capacity == null ? counts.registered : `${counts.registered} / ${counts.capacity}`}
            </p>
            <h2>Waitlisted</h2>
            <p className="registration-list__count" aria-label="Waitlisted count">{counts.waitlisted}</p>
          </section>

          <label className="event-registration-page__toggle registration-list__filter">
            <input
              type="checkbox"
              checked={hideWithdrawn}
              onChange={(event) => setHideWithdrawn(event.target.checked)}
            />
            <span>Hide withdrawn</span>
          </label>

          {list.entries.length === 0 ? (
            <EmptyState
              message="No registrations to show."
              nextStep={hideWithdrawn
                ? "Clear Hide withdrawn to include withdrawn registrations."
                : "Attendees who register for this event will appear here."}
            />
          ) : (
            <table className="registration-list__table">
              <thead>
                <tr>
                  <th scope="col">Attendee</th>
                  <th scope="col">Email</th>
                  {/* The zone is said once, here, rather than in every row. */}
                  <th scope="col">Joined {VENUE_TIME_NOTE}</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => (
                  <tr key={entry.id}>
                    {/* data-label names each cell where a phone stacks the row into a card. */}
                    <td data-label="Attendee">{entry.attendeeName || "Name not set"}</td>
                    <td data-label="Email">{entry.attendeeEmail || "Email not set"}</td>
                    {/* A waitlisted entry is dated, and ordered, by when it joined the queue. */}
                    <td data-label={`Joined ${VENUE_TIME_NOTE}`}>{formatDateTime(entry.waitlistedAt ?? entry.registeredAt, "Unknown")}</td>
                    <td data-label="Status">{entry.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {loading && <LoadingText />}
    </main>
  );
}
