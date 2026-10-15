// How an open event's places and "Registered" mark look, shared by the list and the details.
import { availabilityLabel } from "../services/openEventDisplay";

export function RegisteredBadge() {
  return (
    <span className="browse-open-events__badge browse-open-events__badge--registered">
      Registered
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
