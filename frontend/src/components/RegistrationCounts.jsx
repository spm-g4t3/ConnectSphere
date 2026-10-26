import { useEffect, useState } from "react";
import { getRegistrationCounts } from "../services/eventRegistrationService";

/**
 * Registered and waitlisted totals for the event's assigned Coordinator. The
 * backend decides who may read them; a refusal simply hides the panel.
 */
export default function RegistrationCounts({ eventId }) {
  const [counts, setCounts] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    getRegistrationCounts(eventId)
      .then((data) => { if (active) setCounts(data); })
      .catch((error) => { if (active && error?.response?.status !== 403) setFailed(true); });
    return () => { active = false; };
  }, [eventId]);

  if (failed) return <p role="alert">Registration numbers could not be loaded.</p>;
  if (!counts) return null;

  return (
    <section className="registration-counts" aria-labelledby="registration-counts-heading">
      <h3 id="registration-counts-heading">Registrations</h3>
      <dl>
        <div>
          <dt>Registered</dt>
          <dd>{counts.registeredCount}{counts.capacity ? ` / ${counts.capacity}` : ""}</dd>
        </div>
        <div>
          <dt>Waitlisted</dt>
          <dd>{counts.waitlistEnabled || counts.waitlistCount > 0 ? counts.waitlistCount : "No waiting list"}</dd>
        </div>
      </dl>
    </section>
  );
}
