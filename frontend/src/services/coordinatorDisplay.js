// coordinatorDisplay.js
//
// How a coordinator reads in the assign and hand-over pickers, so the Lead
// sees the same name and active-event count in both.

import { pluralise } from "./displayFormat";

/** A coordinator's name, never "null". */
export function coordinatorName(coordinator) {
  return coordinator.fullName ?? `No name on record (${coordinator.id})`;
}

/** "1 active event", "3 active events". */
export function activeEventsText(activeEvents) {
  return pluralise(activeEvents, "active event");
}

/**
 * "Name, N active events", or the name alone when the list carries no count
 * (the coordinators' own list does not; the Lead's workload list does).
 */
export function coordinatorOptionLabel(coordinator) {
  const name = coordinatorName(coordinator);
  if (typeof coordinator.activeEvents !== "number") return name;
  return `${name}, ${activeEventsText(coordinator.activeEvents)}`;
}
