// eventChangeFields.js
//
// What an Organiser can say a change request is about, and how each choice
// translates into the enum the database actually stores.
//
// Two lists, deliberately, because they are not the same list:
//
//   CHANGE_FIELD_OPTIONS is the dropdown. Its values are distinct because
//   React needs a distinct key per <option> and because a select whose two
//   entries share a value cannot show which one was picked.
//
//   CHANGE_FIELD_BY_OPTION is the wire mapping, applied once at submit. It is
//   many-to-one: the enum event_change_field (006_event_change_requests.sql,
//   035 for cancellation, mirrored in backend/src/domain/eventChangeField.js)
//   has ten members and the dropdown offers eleven choices.
//
// Before this existed the form sent its own option value straight to the API
// -- "eventName", "venueRequirements" -- and the backend validator refused
// every one of them, because the enum spells them event_name and venue. The
// translation had to happen somewhere; it happens here rather than by
// teaching the database a second vocabulary or the form the database's one.
//
// The option labels deliberately differ from the backend's CHANGE_FIELD_LABEL
// and that is not drift to be tidied away. The UI says "Venue requirements"
// because that is the name of the field on the request form the Organiser
// just filled in; the enum says "Venue" because that is what the change is
// about once a Coordinator is reading it. Aligning them would make one of the
// two audiences read a label written for the other.

/**
 * Which enum member each dropdown choice travels as.
 *
 * Every value here must be a member of CHANGE_FIELD in
 * backend/src/domain/eventChangeField.js -- the backend validator checks the
 * value against that vocabulary and a 400 is the only thing a mismatch buys.
 */
const CHANGE_FIELD_BY_OPTION = Object.freeze({
  eventName: "event_name",
  purpose: "purpose",
  description: "description",
  proposedStart: "proposed_start",
  proposedEnd: "proposed_end",
  expectedAttendance: "expected_attendance",
  venueRequirements: "venue",
  equipmentRequirements: "equipment",

  // DECIDED: accessibility has no enum member and is not getting one. It
  // travels as `other`, with the specifics in the free-text details -- which
  // is exactly what 006_event_change_requests.sql's own comment says `other`
  // is for. No migration, no enum change, and the dropdown option stays,
  // because "accessibility requirements" is a thing Organisers ask to change
  // and hiding the option would not stop them asking.
  accessibilityRequirements: "other",

  other: "other",

  // SCRUM-402 AC7 (035): asking for the event to be cancelled. It stands alone
  // in a request, and its text is the Organiser's reason.
  cancelEvent: "cancellation",
});

/**
 * The dropdown, in the order the request form lists the same fields, so the
 * two screens read in the same sequence.
 */
export const CHANGE_FIELD_OPTIONS = Object.freeze([
  { value: "eventName", label: "Event name" },
  { value: "purpose", label: "Purpose" },
  { value: "description", label: "Description" },
  { value: "proposedStart", label: "Proposed start date/time" },
  { value: "proposedEnd", label: "Proposed end date/time" },
  { value: "expectedAttendance", label: "Expected attendance" },
  { value: "venueRequirements", label: "Venue requirements" },
  { value: "accessibilityRequirements", label: "Accessibility requirements" },
  { value: "equipmentRequirements", label: "Equipment requirements" },
  { value: "other", label: "Something else" },
  { value: "cancelEvent", label: "Cancel the event" },
]);

/**
 * The enum member for a dropdown value.
 *
 * Returns undefined for anything not in the map rather than guessing at
 * `other`: an unknown option means this file and the form have fallen out of
 * step, and a 400 naming the field is a better outcome than a change request
 * silently filed under the wrong heading.
 *
 * @param {string} option  a value from CHANGE_FIELD_OPTIONS
 * @returns {string|undefined} the event_change_field member
 */
export function toChangeField(option) {
  return CHANGE_FIELD_BY_OPTION[option];
}
