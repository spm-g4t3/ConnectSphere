// How an open event's places and "Registered" / "Waitlisted" marks look, shared
// by the list, the details and My Registrations.
import { availabilityLabel } from "../services/openEventDisplay";

export function RegisteredBadge() {
  return (
    <span className="browse-open-events__badge browse-open-events__badge--registered">
      Registered
    </span>
  );
}

/** position is the server's, never worked out here. */
export function WaitlistedBadge({ position }) {
  return (
    <span className="browse-open-events__badge browse-open-events__badge--waitlisted">
      Waitlisted: position {position}
    </span>
  );
}

export default function OpenEventAvailability({ event }) {
  return (
    <span
      className={
        event.isFull
          ? "browse-open-events__availability browse-open-events__availability--full"
          : "browse-open-events__availability"
      }
    >
      {availabilityLabel(event)}
    </span>
  );
}
