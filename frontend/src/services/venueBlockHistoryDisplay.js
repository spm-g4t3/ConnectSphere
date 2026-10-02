// venueBlockHistoryDisplay.js
//
// SCRUM-131 (part of SCRUM-17, AC4: "with the creating or amending user and
// timestamp recorded"). Pure helpers that turn a block's history rows, and a
// block row's own audit fields, into text. BlockHistory and VenueBlocksPanel
// render; this decides what the words are.
//
// History rows come from record_venue_block_change() in
// backend/db/migrations/016_venue_block_history.sql:
//   { id, blockId, action, changedBy, changedAt, oldValues, newValues }
// where oldValues/newValues are raw jsonb, snake_case, as in venue history:
//   - created: oldValues {} and newValues the whole new row;
//   - amended / removed: only the keys that differed.
//
// Like VenueDetail's fmt, nothing here may throw: one odd value would
// otherwise blank the whole trail, the one place a change can be traced.

import { formatTimestamp } from "./displayFormat";
import { reasonLabel } from "./venueBlockReasons";

export const BLOCK_HISTORY_ACTION_LABELS = Object.freeze({
  created: "Created",
  amended: "Amended",
  removed: "Removed",
});

/**
 * The label for a history action, or the raw action -- never blank. A
 * missing action reads "Changed".
 */
export function blockHistoryActionLabel(action) {
  if (typeof action === "string" && Object.hasOwn(BLOCK_HISTORY_ACTION_LABELS, action)) {
    return BLOCK_HISTORY_ACTION_LABELS[action];
  }
  // Whitespace counts as missing, or the entry's header would render blank.
  const missing =
    action === null || action === undefined || (typeof action === "string" && action.trim() === "");
  return missing ? "Changed" : String(action);
}

export const BLOCK_HISTORY_FIELD_LABELS = Object.freeze({
  starts_at: "Start",
  ends_at: "End",
  reason: "Reason",
  notes: "Notes",
});

/** The label for a history key, or the raw key -- never blank. */
export function blockHistoryFieldLabel(key) {
  return Object.hasOwn(BLOCK_HISTORY_FIELD_LABELS, key) ? BLOCK_HISTORY_FIELD_LABELS[key] : key;
}

// Keys a history entry does not list as changes. Who and when are already in
// each entry's header line, and the ids never change after creation.
export const HIDDEN_KEYS = Object.freeze([
  "id",
  "venue_id",
  "created_at",
  "created_by",
  "updated_at",
  "last_modified_by",
  "removed_at",
  "removed_by",
]);

// The order changes are listed in; unknown keys follow, in the order found.
const FIELD_ORDER = ["starts_at", "ends_at", "reason", "notes"];
const TIME_KEYS = new Set(["starts_at", "ends_at"]);

const NONE = "(none)";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One history value, as text. Times through formatTimestamp, the reason
 * through reasonLabel, null or blank as "(none)". Never throws.
 *
 * @param {string} key    the snake_case column name
 * @param {*} value
 * @returns {string}
 */
export function formatBlockHistoryValue(key, value) {
  try {
    if (value === null || value === undefined) return NONE;
    if (typeof value === "string" && value.trim() === "") return NONE;

    if (TIME_KEYS.has(key)) return formatTimestamp(value, NONE);
    if (typeof value === "object") return JSON.stringify(value);
    if (key === "reason") return String(reasonLabel(value));
    return String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return NONE;
    }
  }
}

/** The visible keys of a history entry, start/end/reason/notes first. */
function orderedKeys(...objects) {
  const found = new Set();
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (!HIDDEN_KEYS.includes(key)) found.add(key);
    }
  }
  const known = FIELD_ORDER.filter((key) => found.has(key));
  const unknown = [...found].filter((key) => !FIELD_ORDER.includes(key));
  return [...known, ...unknown];
}

/**
 * The changes an amended or removed entry records, as
 * [{ key, label, from, to }] with from/to already formatted.
 *
 * null when oldValues or newValues is not a plain object: a shape no trigger
 * writes, which the caller shows raw rather than dropping.
 *
 * @param {Object} entry  one history row
 * @returns {Array<{key: string, label: string, from: string, to: string}> | null}
 */
export function blockHistoryChanges(entry) {
  try {
    const oldValues = entry?.oldValues;
    const newValues = entry?.newValues;
    if (!isPlainObject(oldValues) || !isPlainObject(newValues)) return null;

    return orderedKeys(newValues, oldValues).map((key) => ({
      key,
      label: blockHistoryFieldLabel(key),
      from: formatBlockHistoryValue(key, oldValues[key]),
      to: formatBlockHistoryValue(key, newValues[key]),
    }));
  } catch {
    return null;
  }
}

/**
 * What a created entry recorded, as [{ key, label, value }] in field order.
 * [] when newValues is not a plain object.
 *
 * @param {Object} newValues
 * @returns {Array<{key: string, label: string, value: string}>}
 */
export function blockCreationSummary(newValues) {
  try {
    if (!isPlainObject(newValues)) return [];
    return orderedKeys(newValues).map((key) => ({
      key,
      label: blockHistoryFieldLabel(key),
      value: formatBlockHistoryValue(key, newValues[key]),
    }));
  } catch {
    return [];
  }
}

function toTime(value) {
  if (!value) return NaN;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? NaN : time;
}

/**
 * A block row's own audit line: who created it and when, and who last
 * amended it and when.
 *
 * `created` is null when createdAt is missing. `amended` is set only when
 * updatedAt is strictly after createdAt: the two are equal on a block never
 * changed, and an unparseable time is treated as "not after".
 *
 * Note that a no-op save still bumps updatedAt (015), so "Last amended" can
 * name a save that has no history entry. That trade-off is accepted.
 *
 * @param {Object} block
 * @returns {{created: {at, by} | null, amended: {at, by} | null}}
 */
export function blockAuditSummary(block) {
  try {
    if (!block || !block.createdAt) return { created: null, amended: null };

    const created = { at: block.createdAt, by: block.createdBy ?? null };
    const createdTime = toTime(block.createdAt);
    const updatedTime = toTime(block.updatedAt);
    const amended =
      !Number.isNaN(createdTime) && !Number.isNaN(updatedTime) && updatedTime > createdTime
        ? { at: block.updatedAt, by: block.lastModifiedBy ?? null }
        : null;

    return { created, amended };
  } catch {
    return { created: null, amended: null };
  }
}

/** Whether a recorded user id is the signed-in user. False if either is missing. */
export function isCurrentUser(id, currentUserId) {
  return Boolean(id) && Boolean(currentUserId) && id === currentUserId;
}
