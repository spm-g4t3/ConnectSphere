// How an open event's places and "Registered" / "Waitlisted" marks look, shared
// by the list, the details and My Registrations.
import { availabilityLabel } from "../services/openEventDisplay";
import StatusBadge from "./ui/StatusBadge";

export function RegisteredBadge() {
  return <StatusBadge tone="success">Registered</StatusBadge>;
}

/** position is the server's, never worked out here. */
export function WaitlistedBadge({ position }) {
  return <StatusBadge tone="accent">Waitlisted: position {position}</StatusBadge>;
}

// Full is the one an attendee must notice; no limit is not a count at all.
function availabilityTone(event) {
  if (event.isFull) return "warning";
  if (event.placesLeft == null) return "neutral";
  return "info";
}

export default function OpenEventAvailability({ event }) {
  return <StatusBadge tone={availabilityTone(event)}>{availabilityLabel(event)}</StatusBadge>;
}
