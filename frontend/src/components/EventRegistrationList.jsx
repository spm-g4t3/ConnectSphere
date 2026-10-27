import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import { getEventRegistrations } from "../services/eventRegistrationService";
import { formatMediumTimestamp } from "../services/displayFormat";

// Read only by design: no register, withdraw, edit or export actions here.
export default function EventRegistrationList({ eventId }) {
  const { user } = useAuth();
  const [hideWithdrawn, setHideWithdrawn] = useState(false);
  const [list, setList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getEventRegistrations(eventId, { hideWithdrawn })
      .then((data) => {
        if (active) setList(data);
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || "Could not load the registrations.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [eventId, hideWithdrawn]);

  const isCoordinator = normaliseRole(user?.role) === "EVENT_COORDINATOR";
  const back = isCoordinator
    ? { to: `/event-requests/${eventId}`, label: "← Back to event" }
    : { to: "/events", label: "← Back to My Events" };
  const counts = list?.counts;

  return (
    <main className="event-registration-page">
      <Link className="event-registration-page__back" to={back.to}>{back.label}</Link>

      {error && (
        <div className="event-registration-page__error" role="alert">{error}</div>
      )}

      {list && (
        <>
          <header className="event-registration-page__header">
            <p className="eyebrow">Registrations</p>
            <h1>{list.event.eventName}</h1>
          </header>

          <section className="event-registration-page__summary" aria-labelledby="registration-counts-heading">
            <h2 id="registration-counts-heading">Registered</h2>
            <p className="registration-list__count" aria-label="Registered count">
              {counts.capacity == null ? counts.registered : `${counts.registered} / ${counts.capacity}`}
            </p>
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
            <p>No registrations to show.</p>
          ) : (
            <table className="registration-list__table">
              <thead>
                <tr>
                  <th scope="col">Attendee</th>
                  <th scope="col">Email</th>
                  <th scope="col">Registered</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.attendeeName || "Name not set"}</td>
                    <td>{entry.attendeeEmail || "Email not set"}</td>
                    <td>{formatMediumTimestamp(entry.registeredAt, "Unknown")}</td>
                    <td>{entry.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {loading && <p role="status">Loading registrations…</p>}
    </main>
  );
}
