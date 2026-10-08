// VenueForm.jsx
//
// SCRUM-15 AC1 (create) and AC2 (edit), in one component, the same way
// EventRequestForm covers SCRUM-29 and SCRUM-11 with one form: the fields are
// identical either way, so two components would be one component and a copy
// that drifts. `venueId` is the only thing that differs -- null means create.
//
// Edit prefills from getVenueDetails (GET /venues/:id), not from the
// catalogue row it was opened from. The catalogue list selects five columns
// and carries no layouts, accessibility, facilities or hours; opening the
// form on that row would render four empty sections and then -- see
// buildChanges below -- offer to save them as empty.
//
// SCRUM-186 adds the turnaround between events: one select from a fixed list
// of durations (turnaroundOptions.js), sent on create and, like every other
// field, on edit only when it moved.
//
// SCRUM-137 (SCRUM-20) adds the setup time before an event the same way: its
// own select (setupOptions.js), placed just before turnaround so the two read
// in time order -- before the event, then after it.
//
// SCRUM-493 adds emergency access and known restrictions: two optional text
// boxes after turnaround, labelled from SAFETY_FACTS (venueSafetyFacts.js) so
// the details screen and the Safety Officer's view use the same words. Like
// every other field, an edit sends them only when they changed.

import { Fragment, useCallback, useEffect, useId, useState } from "react";
import { createVenue, getVenueDetails, updateVenue } from "../services/venueService";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  NEED_A_CODE_HELP,
  ROOM_LAYOUTS,
  UNKNOWN_CODE_TITLE,
  optionsWithUnknownCodes,
} from "../services/venueLookups";
import {
  DEFAULT_TURNAROUND_MINUTES,
  turnaroundOptionsWith,
} from "../services/turnaroundOptions";
import { DEFAULT_SETUP_MINUTES, setupOptionsWith } from "../services/setupOptions";
import {
  SAFETY_FACTS,
  SAFETY_TEXT_MAX_LENGTH,
  codePointLength,
} from "../services/venueSafetyFacts";

// Keyed by status, like RETIRE_ERROR_MESSAGES and AuthContext's
// LOGIN_ERROR_MESSAGES.
//
// 400 is deliberately absent. Every 400 this endpoint produces comes from
// venueValidation, which collects `{field, message}` details rather than
// stopping at the first fault -- so the details renderer below says strictly
// more than any line that could go here, and a generic "check your details"
// would be a step backwards. The one 400 without details (a non-object body)
// falls through to the data.error passthrough.
const VENUE_SAVE_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Venue Staff can add or change a venue.",
  404: "That venue no longer exists. Go back and refresh the catalogue.",
  500: "The server could not save this venue. Please try again.",
};

// 002_venues.sql:50 -- day_of_week is 0-6 with 0 = Sunday, chosen to match
// Date.getDay(). Index into this array is the wire value; no conversion.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const DEFAULT_OPENS_AT = "09:00";
const DEFAULT_CLOSES_AT = "18:00";

/**
 * 'HH:MM' -> 'HH:MM:SS'. The same normalisation venueValidation.withSeconds
 * does, and for the same reason: PostgREST hands back "09:00:00" while
 * <input type="time"> emits "09:00". TIME_PATTERN accepts both, so nothing
 * needs converting on the wire -- but the dirty-diff compares strings, and
 * without this every save would look like an hours change.
 */
function withSeconds(time) {
  return typeof time === "string" && time.length === 5 ? `${time}:00` : time;
}

/** A code array reduced to one comparable string, order-insensitive. */
function normaliseCodes(codes) {
  // "\n" rather than "," as the joiner: a lookup code is only checked for
  // lowercase and non-blank (002_venues.sql:71), so a comma in one is not
  // impossible, and ['a,b'] must not compare equal to ['a','b'].
  return [...(codes ?? [])].sort().join("\n");
}

/** Hours reduced to one comparable string: day order and time shape fixed. */
function normaliseHours(hours) {
  return JSON.stringify(
    [...(hours ?? [])]
      .map((entry) => ({
        day_of_week: entry.day_of_week,
        opens_at: withSeconds(entry.opens_at),
        closes_at: withSeconds(entry.closes_at),
      }))
      .sort((a, b) => a.day_of_week - b.day_of_week),
  );
}

/**
 * The seven-row grid, prefilled from whatever hours the venue has.
 *
 * Seven fixed rows rather than an add-a-row list makes two of the validator's
 * rules unreachable by construction: no day can repeat, and no day can be
 * missing-but-meant. What is left -- closes_at must be after opens_at -- is
 * left to the validator, which already words it well.
 */
function toHourRows(hours) {
  const byDay = new Map((hours ?? []).map((entry) => [entry.day_of_week, entry]));
  return DAY_NAMES.map((_, day) => {
    const existing = byDay.get(day);
    return {
      open: Boolean(existing),
      // slice(0, 5) because <input type="time"> will not display "09:00:00".
      opensAt: existing ? String(existing.opens_at).slice(0, 5) : DEFAULT_OPENS_AT,
      closesAt: existing ? String(existing.closes_at).slice(0, 5) : DEFAULT_CLOSES_AT,
    };
  });
}

/** The seven rows back to the wire shape: open days only, snake_case keys. */
function fromHourRows(rows) {
  return rows
    .map((row, day) =>
      row.open
        ? { day_of_week: day, opens_at: row.opensAt, closes_at: row.closesAt }
        : null,
    )
    .filter(Boolean);
}

/**
 * The capacity box, as the wire wants it.
 *
 * NOT `Number(raw) || undefined`. Number("") is 0, which the validator reports
 * as "must be greater than zero" -- a confident, wrong answer to a box the
 * user simply left empty, whose truth is "is required". Blank must become
 * undefined so the required-field rule is the one that fires.
 *
 * NaN is passed through rather than caught here: venueValidation.js:92 already
 * says "must be a number", against the right field, alongside every other
 * fault in the form. A second opinion from the client could only disagree.
 */
function capacityValue(raw) {
  const trimmed = String(raw ?? "").trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

const EMPTY_FORM = {
  name: "",
  location: "",
  maxCapacity: "",
  layouts: [],
  accessibility: [],
  facilities: [],
  hours: toHourRows([]),
  // A string because <select> values are strings; Number() at submit.
  turnaroundMinutes: String(DEFAULT_TURNAROUND_MINUTES),
  setupMinutes: String(DEFAULT_SETUP_MINUTES),
  // SCRUM-493: "" in the box, whatever the server holds (null = not recorded).
  emergencyAccess: "",
  knownRestrictions: "",
};

/** One vocabulary's checkboxes, including any code this build has never met. */
function CodeCheckboxes({ legend, options, selected, onToggle, disabled }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <ul>
        {options.map((option) => (
          <li key={option.code}>
            <label title={option.unknown ? UNKNOWN_CODE_TITLE : undefined}>
              <input
                type="checkbox"
                checked={selected.includes(option.code)}
                onChange={() => onToggle(option.code)}
                disabled={disabled}
              />
              {option.label}
              {option.unknown && " (unrecognised code)"}
            </label>
          </li>
        ))}
      </ul>
      <p className="venue-form__help">{NEED_A_CODE_HELP}</p>
    </fieldset>
  );
}

export default function VenueForm({ venueId = null, onSaved }) {
  const isEdit = Boolean(venueId);
  const turnaroundHelpId = useId();
  const setupHelpId = useId();
  // One base id for both safety boxes; each field's key is appended.
  const safetyHelpId = useId();

  const [form, setForm] = useState(EMPTY_FORM);

  // The venue as the server last told us it was. Two jobs: it is what
  // buildChanges diffs against, and its code arrays are what
  // optionsWithUnknownCodes folds into the checkbox lists. Null in create
  // mode, and until the prefill lands.
  const [baseline, setBaseline] = useState(null);

  const [loading, setLoading] = useState(isEdit);
  const [loadError, setLoadError] = useState(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  // Field faults are an array of { field, message } because the venue
  // validators report every fault at once rather than stopping at the first --
  // the same shape, and the same renderer, as EventRequestForm's submit errors.
  const [saveDetails, setSaveDetails] = useState([]);

  const fetchVenue = useCallback(async () => {
    if (!venueId) return;
    try {
      const venue = await getVenueDetails(venueId);
      setBaseline(venue);
      setForm({
        name: venue.name ?? "",
        location: venue.location ?? "",
        // A string in state, a number on the wire. The control is text-ish
        // either way and a half-typed "4" must not become the number 4 and
        // back; capacityValue does the conversion once, at submit.
        maxCapacity: venue.maxCapacity == null ? "" : String(venue.maxCapacity),
        layouts: venue.layouts ?? [],
        accessibility: venue.accessibility ?? [],
        facilities: venue.facilities ?? [],
        hours: toHourRows(venue.hours),
        // `??`, not `||`: a saved 0 is a real choice ("None"), not a gap.
        // A server that omits the field (a backend before 017) reads as the
        // default, which is also what buildChanges compares against -- so an
        // untouched select sends nothing.
        turnaroundMinutes: String(venue.turnaroundMinutes ?? DEFAULT_TURNAROUND_MINUTES),
        // Same `??` reasoning; a backend before 023 omits setupMinutes.
        setupMinutes: String(venue.setupMinutes ?? DEFAULT_SETUP_MINUTES),
        // SCRUM-493: null means not recorded, and a backend before 036 omits
        // the keys; both prefill an empty box.
        emergencyAccess: venue.emergencyAccess ?? "",
        knownRestrictions: venue.knownRestrictions ?? "",
      });
      setLoadError(null);
    } catch {
      setLoadError("Could not load this venue. Please go back and try again.");
    } finally {
      setLoading(false);
    }
  }, [venueId]);

  useEffect(() => {
    fetchVenue();
  }, [fetchVenue]);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function toggleCode(field, code) {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].includes(code)
        ? prev[field].filter((c) => c !== code)
        : [...prev[field], code],
    }));
  }

  function updateHourRow(day, patch) {
    setForm((prev) => ({
      ...prev,
      hours: prev.hours.map((row, i) => (i === day ? { ...row, ...patch } : row)),
    }));
  }

  /** Everything, for POST /venues. Create has nothing to diff against. */
  function buildCreatePayload() {
    return {
      name: form.name.trim(),
      location: form.location.trim(),
      maxCapacity: capacityValue(form.maxCapacity),
      layouts: form.layouts,
      accessibility: form.accessibility,
      facilities: form.facilities,
      hours: fromHourRows(form.hours),
      // Always sent, even at the default, so what is saved is what was shown.
      turnaroundMinutes: Number(form.turnaroundMinutes),
      setupMinutes: Number(form.setupMinutes),
      // SCRUM-493: an empty box is left out rather than sent as "", so the
      // payload says only what was entered; the server stores not recorded
      // either way.
      emergencyAccess: form.emergencyAccess.trim() || undefined,
      knownRestrictions: form.knownRestrictions.trim() || undefined,
    };
  }

  /**
   * Only what the user actually changed, for PATCH /venues/:id.
   *
   * THIS IS NOT AN OPTIMISATION. PATCH REPLACES an attribute array outright
   * and an empty array clears it (venueService.updateVenue's docblock), so a
   * form that submits its whole state deletes every code it failed to render:
   * a code added to the catalogue after this build shipped, a code added by
   * another staff member while this form was open. Sending only the fields
   * that moved means an untouched array is never mentioned, so it cannot be
   * replaced by a stale copy of itself. optionsWithUnknownCodes covers the
   * codes that ARE rendered; this covers the ones that are not.
   *
   * The pleasant side effect is that validateUpdateVenue's empty-change-set
   * 400 stops being reachable by an ordinary user: saving without editing
   * anything is caught below, before the request, rather than coming back as
   * an error about a request they did not knowingly make.
   */
  function buildChanges() {
    const changes = {};

    const name = form.name.trim();
    if (name !== baseline.name) changes.name = name;

    const location = form.location.trim();
    if (location !== baseline.location) changes.location = location;

    // `?? null` rather than leaving it undefined: a PATCH cannot clear a
    // mandatory field, and undefined would be filtered out as "unchanged"
    // (validateUpdateVenue:240), silently discarding the user's edit. null
    // reaches checkCapacity, which answers "maxCapacity: is required" -- the
    // same message an empty box gets on the create path.
    const capacity = capacityValue(form.maxCapacity);
    if (capacity !== baseline.maxCapacity) changes.maxCapacity = capacity ?? null;

    for (const field of ["layouts", "accessibility", "facilities"]) {
      if (normaliseCodes(form[field]) !== normaliseCodes(baseline[field])) {
        changes[field] = form[field];
      }
    }

    const hours = fromHourRows(form.hours);
    if (normaliseHours(hours) !== normaliseHours(baseline.hours)) {
      changes.hours = hours;
    }

    // Compared as numbers: the select holds "0", the server sends 0.
    const turnaround = Number(form.turnaroundMinutes);
    if (turnaround !== (baseline.turnaroundMinutes ?? DEFAULT_TURNAROUND_MINUTES)) {
      changes.turnaroundMinutes = turnaround;
    }

    const setup = Number(form.setupMinutes);
    if (setup !== (baseline.setupMinutes ?? DEFAULT_SETUP_MINUTES)) {
      changes.setupMinutes = setup;
    }

    // SCRUM-493. Compared trimmed against the baseline, which the server has
    // already trimmed, so whitespace typed into a field that is not recorded
    // ("" vs "") sends nothing.
    //
    // A cleared box is sent as null, NOT left undefined. On PATCH a missing
    // key means "keep the current value" (venueValidation checkSafetyText,
    // venueService toSafetyTextParam), so `|| undefined` here would drop the
    // key and the old text would survive a save that looked like it removed
    // it. null is the API's "clear it".
    for (const { key } of SAFETY_FACTS) {
      const text = form[key].trim();
      if (text !== (baseline[key] ?? "")) changes[key] = text === "" ? null : text;
    }

    return changes;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return; // closes the double-click window before it opens

    let payload;
    if (isEdit) {
      if (!baseline) return; // prefill has not landed; there is nothing to diff
      payload = buildChanges();
      if (Object.keys(payload).length === 0) {
        setSaveError("Nothing has changed, so there is nothing to save.");
        setSaveDetails([]);
        return;
      }
    } else {
      payload = buildCreatePayload();
    }

    setSaving(true);
    setSaveError(null);
    setSaveDetails([]);

    try {
      const saved = isEdit
        ? await updateVenue(venueId, payload)
        : await createVenue(payload);
      onSaved?.(saved);
    } catch (err) {
      // The ladder, most specific rung first.
      const status = err.response?.status;
      const details = err.response?.data?.details;

      if (Array.isArray(details) && details.length > 0) {
        setSaveDetails(details);
      } else if (VENUE_SAVE_ERROR_MESSAGES[status]) {
        setSaveError(VENUE_SAVE_ERROR_MESSAGES[status]);
      } else if (err.response?.data?.error) {
        // A 400 the validator raised before it started collecting -- "expected
        // an object", "no changes supplied". It names the fault precisely and
        // carries no uuid or database prose, so passing it through is safe in
        // the way the retire 409 body was not.
        setSaveError(err.response.data.error);
      } else {
        setSaveError("Could not save this venue. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p>Loading...</p>;

  if (loadError) {
    return (
      <p className="venue-form__error" role="alert">
        {loadError}
      </p>
    );
  }

  // Built from the BASELINE's codes, not the live selection, so an
  // unrecognised code's checkbox stays on screen after it is unticked and the
  // removal remains reversible. See optionsWithUnknownCodes.
  const layoutOptions = optionsWithUnknownCodes(ROOM_LAYOUTS, baseline?.layouts);
  const accessibilityOptions = optionsWithUnknownCodes(
    ACCESSIBILITY_FEATURES,
    baseline?.accessibility,
  );
  const facilityOptions = optionsWithUnknownCodes(FACILITIES, baseline?.facilities);
  // From the BASELINE for the same reason: a saved value the list lacks keeps
  // its option even after another one is chosen.
  const turnaroundOptions = turnaroundOptionsWith(baseline?.turnaroundMinutes);
  const setupOptions = setupOptionsWith(baseline?.setupMinutes);

  return (
    <form className="venue-form" onSubmit={handleSubmit}>
      <h2>{isEdit ? "Edit venue" : "Add a new venue"}</h2>

      <label>
        Name
        <input
          type="text"
          value={form.name}
          onChange={(e) => updateField("name", e.target.value)}
          disabled={saving}
        />
      </label>

      <label>
        Location
        <input
          type="text"
          value={form.location}
          onChange={(e) => updateField("location", e.target.value)}
          disabled={saving}
        />
      </label>

      <label>
        Maximum capacity
        <input
          type="number"
          min="1"
          step="1"
          value={form.maxCapacity}
          onChange={(e) => updateField("maxCapacity", e.target.value)}
          disabled={saving}
        />
      </label>

      <CodeCheckboxes
        legend="Room layouts"
        options={layoutOptions}
        selected={form.layouts}
        onToggle={(code) => toggleCode("layouts", code)}
        disabled={saving}
      />

      <CodeCheckboxes
        legend="Accessibility features"
        options={accessibilityOptions}
        selected={form.accessibility}
        onToggle={(code) => toggleCode("accessibility", code)}
        disabled={saving}
      />

      <CodeCheckboxes
        legend="Facilities"
        options={facilityOptions}
        selected={form.facilities}
        onToggle={(code) => toggleCode("facilities", code)}
        disabled={saving}
      />

      <fieldset>
        <legend>Opening hours</legend>
        <ul>
          {form.hours.map((row, day) => (
            <li key={DAY_NAMES[day]}>
              <label>
                <input
                  type="checkbox"
                  checked={row.open}
                  onChange={() => updateHourRow(day, { open: !row.open })}
                  disabled={saving}
                />
                {DAY_NAMES[day]}
              </label>
              <input
                type="time"
                value={row.opensAt}
                onChange={(e) => updateHourRow(day, { opensAt: e.target.value })}
                disabled={saving || !row.open}
                aria-label={`${DAY_NAMES[day]} opens at`}
              />
              <input
                type="time"
                value={row.closesAt}
                onChange={(e) => updateHourRow(day, { closesAt: e.target.value })}
                disabled={saving || !row.open}
                aria-label={`${DAY_NAMES[day]} closes at`}
              />
            </li>
          ))}
        </ul>
        <p className="venue-form__help">
          Leave a day unticked to record the venue as closed that day.
        </p>
      </fieldset>

      <label>
        Setup before events
        <select
          value={form.setupMinutes}
          onChange={(e) => updateField("setupMinutes", e.target.value)}
          disabled={saving}
          aria-describedby={setupHelpId}
        >
          {setupOptions.map((option) => (
            <option key={option.minutes} value={String(option.minutes)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {/* Same pattern as the turnaround help below: outside the label, tied
          back by aria-describedby, and silent on enforcement (SCRUM-139). */}
      <p className="venue-form__help" id={setupHelpId}>
        Time Venue Staff need to prepare the room before an event starts.
      </p>

      <label>
        Turnaround between events
        <select
          value={form.turnaroundMinutes}
          onChange={(e) => updateField("turnaroundMinutes", e.target.value)}
          disabled={saving}
          aria-describedby={turnaroundHelpId}
        >
          {turnaroundOptions.map((option) => (
            <option key={option.minutes} value={String(option.minutes)}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {/* Outside the label so it is not part of the select's accessible name;
          aria-describedby ties it back. Says what the field means, not that
          anything enforces it -- nothing does yet (SCRUM-139). */}
      <p className="venue-form__help" id={turnaroundHelpId}>
        Time Venue Staff need to reset the room after an event ends.
      </p>

      {SAFETY_FACTS.map(({ key, label, help }) => {
        const helpId = `${safetyHelpId}-${key}`;
        const length = codePointLength(form[key]);
        const overLimit = length > SAFETY_TEXT_MAX_LENGTH;
        return (
          // A Fragment, not a wrapper div, so the label stays a direct child
          // of the form and keeps the `.venue-form > label` grid.
          <Fragment key={key}>
            <label>
              {label}
              {/*
                No maxLength, for VenueBlockForm's notes reason: the browser
                counts UTF-16 units, so an emoji would use up two of the 2,000
                while the server counts it once. And no client check either,
                as with capacity: the server's details[] already says
                "must be 2000 characters or fewer" against this field. The
                counter is the early warning.
              */}
              <textarea
                value={form[key]}
                onChange={(e) => updateField(key, e.target.value)}
                rows={4}
                disabled={saving}
                aria-describedby={helpId}
              />
            </label>
            {/* Help and counter in one described-by line, outside the label
                like the setup and turnaround help, so neither becomes part of
                the textarea's name. */}
            <p className="venue-form__help" id={helpId}>
              {help}{" "}
              <span
                className={
                  overLimit
                    ? "venue-form__counter venue-form__counter--over"
                    : "venue-form__counter"
                }
              >
                {length}/{SAFETY_TEXT_MAX_LENGTH}
              </span>
            </p>
          </Fragment>
        );
      })}

      {saveError && (
        <p className="venue-form__error" role="alert">
          {saveError}
        </p>
      )}

      {saveDetails.length > 0 && (
        <div className="venue-form__errors" role="alert">
          <p>This venue can't be saved yet:</p>
          <ul>
            {saveDetails.map((err, i) => (
              <li key={i}>
                {err.field ? `${err.field}: ` : ""}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="submit" disabled={saving}>
        {saving ? "Saving..." : isEdit ? "Save changes" : "Create venue"}
      </button>
    </form>
  );
}
