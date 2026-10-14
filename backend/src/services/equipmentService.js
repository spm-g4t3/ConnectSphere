/**
 * Equipment catalogue service.
 *
 * SCRUM-276, a subtask of SCRUM-275 "Maintain Equipment Catalogue and Status".
 *
 * Creates and edits equipment types and reads them back (SCRUM-276), and
 * records damaged and under-maintenance quantities with a note (SCRUM-277), and
 * retires and reinstates types (SCRUM-278). SCRUM-279 adds the change history:
 * the acting user goes in with every write and a database trigger records the
 * change (023_equipment_history.sql), and getEquipmentTypeHistory reads it back.
 *
 * Equipment is tracked as a quantity per type, not as individual units, so one
 * row is one type and a quantity is just a number on it.
 *
 * Input is validated before any network call (equipmentValidation.js), apart
 * from the two rules that need a read. Those are added to the same list of
 * problems, so a caller still sees every invalid field at once (AC2):
 *   - the name is unique ignoring capitalisation (checked by ilike here, and
 *     backed by the unique index in 022 if two writers race), and
 *   - the total can't go below damaged plus under maintenance (backed by the
 *     check constraint in 022).
 * translateError turns whatever the database still refuses into a typed error.
 */

import { supabase } from '../config/supabaseClient.js';
import { ValidationError, NotFoundError, ConflictError } from '../errors.js';
import {
  checkCreateEquipmentType,
  checkUpdateEquipmentType,
  checkConditionChange,
  hasField,
  throwIfInvalid,
  validateEquipmentTypeId,
} from '../validation/equipmentValidation.js';
import { assertNoOverCommitment } from './equipmentOverCommitment.js';

const TABLE = 'equipment_types';

const COLUMNS =
  'id, name, description, category, location, total_quantity, ' +
  'damaged_quantity, under_maintenance_quantity, retired_at, created_at, updated_at';

/** API field -> column, for the fields this service writes. */
const COLUMN_FOR = {
  name: 'name',
  description: 'description',
  category: 'category',
  location: 'location',
  totalQuantity: 'total_quantity',
};

const NAME_TAKEN = 'is already used by another equipment type';


/**
 * Turn a raw Postgres error into a typed one.
 *
 * 23505 is the unique index on lower(trim(name)): the only unique constraint
 * on this table besides its primary key. 23514 is a check constraint, such as
 * damaged plus under maintenance exceeding the total.
 */
function translateError(error) {
  if (!error) return null;

  const code = error.code;
  const detail = error.message ?? '';

  if (code === '23514') {
    return new ValidationError(`A value was rejected by the database: ${detail}`);
  }

  // last_modified_by names a user who does not exist
  if (code === '23503') {
    return new ValidationError(`The editing user does not exist: ${detail}`);
  }

  if (code === '23505') {
    return new ConflictError(`An equipment type with that name already exists: ${detail}`, {
      code: 'EQUIPMENT_NAME_TAKEN',
    });
  }

  // 061 makes these lock in one order, so this should not happen. If Postgres
  // still undoes one of two changes, nothing was saved: try again.
  if (code === '40P01') {
    return new ConflictError('Someone changed this equipment at the same moment. Please try again.', {
      code: 'EQUIPMENT_CHANGED_AT_THE_SAME_TIME',
    });
  }

  return new Error(detail || 'Unexpected database error');
}

/** The full record, as Technical Support Staff see it. */
function toEquipmentType(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    location: row.location,
    totalQuantity: row.total_quantity,
    damagedQuantity: row.damaged_quantity,
    underMaintenanceQuantity: row.under_maintenance_quantity,
    usableQuantity: row.total_quantity - row.damaged_quantity - row.under_maintenance_quantity,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * What an Event Coordinator's picker needs, and nothing more (SCRUM-21).
 *
 * Quantities are left out on purpose: damaged and under-maintenance counts are
 * Technical Support's working figures, and "how many are free for my dates" is
 * answered by the availability check (SCRUM-23), which a coordinator does not
 * run. Add a field here if the picker needs it, rather than widening who can
 * read the full record.
 */
function toPickerType(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
  };
}

const HISTORY_COLUMNS =
  'id, equipment_type_id, field_name, old_value, new_value, note, changed_by, changed_at';

/** Column names in history rows, as the API names those fields. */
const FIELD_FOR_COLUMN = {
  total_quantity: 'totalQuantity',
  damaged_quantity: 'damagedQuantity',
  under_maintenance_quantity: 'underMaintenanceQuantity',
  retired_at: 'retiredAt',
};

/**
 * Values are returned as stored, which is text: a quantity of 10 is "10".
 * field is 'created' for the row written when a type is first made.
 */
function toHistoryEntry(row) {
  return {
    id: row.id,
    equipmentTypeId: row.equipment_type_id,
    field: FIELD_FOR_COLUMN[row.field_name] ?? row.field_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    note: row.note,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

function toColumns(value) {
  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => [COLUMN_FOR[field], fieldValue]),
  );
}

/** ilike treats % and _ as wildcards; escape them so a name is matched literally. */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function isNameTaken(name, excludeId = null) {
  let query = supabase.from(TABLE).select('id').ilike('name', escapeLike(name)).limit(1);
  if (excludeId) query = query.neq('id', excludeId);

  const { data, error } = await query;
  if (error) throw translateError(error);

  return (data ?? []).length > 0;
}

function alreadyRetired() {
  return new ConflictError('Equipment type is already retired', { code: 'EQUIPMENT_ALREADY_RETIRED' });
}

async function readRow(id) {
  const { data, error } = await supabase.from(TABLE).select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw translateError(error);
  return data;
}


/**
 * AC2: create an equipment type.
 *
 * Damaged and under-maintenance quantities start at zero, from the column
 * defaults, so a new type is fully usable.
 *
 * @param {object} input  name and totalQuantity are required
 * @param {string|null} [userId]  who is creating it, recorded in the history
 * @returns {Promise<object>} the created type
 * @throws {ValidationError} listing every invalid field, before any write
 * @throws {ConflictError} when two writers race to the same name
 */
export async function createEquipmentType(input, userId = null) {
  const { value, details } = checkCreateEquipmentType(input);

  // A body that is not an object is refused before any query.
  if (hasField(details, 'equipment')) throwIfInvalid(details);

  if (!hasField(details, 'name') && (await isNameTaken(value.name))) {
    details.push({ field: 'name', message: NAME_TAKEN });
  }
  throwIfInvalid(details);

  const { data, error } = await supabase
    .from(TABLE)
    .insert({ ...toColumns(value), last_modified_by: userId })
    .select(COLUMNS)
    .single();

  if (error) throw translateError(error);

  return toEquipmentType(data);
}


/**
 * AC3: edit an equipment type. Fields left out stay as they were.
 *
 * Editing a retired type is allowed: the story doesn't forbid it, and a typo
 * in a retired type's name should still be fixable.
 *
 * @param {string} id
 * @param {object} changes  any of name, description, category, location, totalQuantity
 * @param {string|null} [userId]  who is editing it, recorded in the history
 * @returns {Promise<object>} the updated type
 * @throws {ValidationError} listing every invalid field, or for a malformed id
 * @throws {NotFoundError} when no type has that id
 */
export async function updateEquipmentType(id, changes, userId = null) {
  validateEquipmentTypeId(id);

  const { value, details } = checkUpdateEquipmentType(changes);

  // A body that is not an object, or names no field, is refused before any query.
  if (hasField(details, 'equipment')) throwIfInvalid(details);

  const current = await readRow(id);
  if (!current) throw new NotFoundError(`Equipment type ${id} not found`);

  if (value.name !== undefined && (await isNameTaken(value.name, id))) {
    details.push({ field: 'name', message: NAME_TAKEN });
  }

  if (value.totalQuantity !== undefined) {
    const unusable = current.damaged_quantity + current.under_maintenance_quantity;
    if (value.totalQuantity < unusable) {
      details.push({
        field: 'totalQuantity',
        message: `can't be below damaged plus under maintenance (${unusable})`,
      });
    }
  }
  throwIfInvalid(details);

  // AC7: a smaller total can leave fewer usable units than are reserved.
  if (value.totalQuantity !== undefined) {
    const unusable = current.damaged_quantity + current.under_maintenance_quantity;
    const usableBefore = current.total_quantity - unusable;
    const usableAfter = value.totalQuantity - unusable;
    if (usableAfter < usableBefore) {
      await assertNoOverCommitment({ equipmentTypeId: id, usableAfter });
    }
  }

  const { data, error } = await supabase
    .from(TABLE)
    // last_change_note is cleared so a note from an earlier damage or
    // maintenance change can never be attached to a later one.
    .update({ ...toColumns(value), last_modified_by: userId, last_change_note: null })
    .eq('id', id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Equipment type ${id} not found`);

  return toEquipmentType(data);
}


/**
 * AC4 and AC5: record how many units are damaged and how many are under
 * maintenance, with a note.
 *
 * Either quantity, or both, may be given; the one left out stays as it was.
 * Reducing a number is how units are marked usable again, and needs no special
 * handling. Sending the values a type already has is refused: there is
 * nothing to record a note against, and accepting it would lose the note.
 *
 * Damaged plus under maintenance can never exceed the total. When the change
 * would leave fewer usable units than before, the over-commitment hook runs
 * before anything is saved (AC7, SCRUM-310). The note is written with the
 * change, and the history trigger copies it onto the damaged and
 * under-maintenance rows (SCRUM-279).
 *
 * @param {string} id
 * @param {object} input  damagedQuantity and/or underMaintenanceQuantity, and note
 * @param {string|null} [userId]  who is recording it, kept in the history
 * @returns {Promise<object>} the updated type, usableQuantity included
 * @throws {ValidationError} listing every invalid field, or for a malformed id
 * @throws {NotFoundError} when no type has that id
 */
export async function recordEquipmentCondition(id, input, userId = null) {
  validateEquipmentTypeId(id);

  const { value, details } = checkConditionChange(input);

  // A body that is not an object, or names neither quantity, is refused before any query.
  if (hasField(details, 'equipment')) throwIfInvalid(details);

  const current = await readRow(id);
  if (!current) throw new NotFoundError(`Equipment type ${id} not found`);

  const damaged = value.damagedQuantity ?? current.damaged_quantity;
  const underMaintenance = value.underMaintenanceQuantity ?? current.under_maintenance_quantity;

  if (damaged + underMaintenance > current.total_quantity) {
    details.push({
      field: value.damagedQuantity !== undefined ? 'damagedQuantity' : 'underMaintenanceQuantity',
      message:
        `damaged plus under maintenance (${damaged + underMaintenance}) ` +
        `can't exceed the total (${current.total_quantity})`,
    });
  }

  // Nothing changed means no history row, so the note would be lost without a
  // word. Only judged once every other check has passed, because a rejected
  // value falls back to the current one and would look like "no change".
  if (
    details.length === 0 &&
    damaged === current.damaged_quantity &&
    underMaintenance === current.under_maintenance_quantity
  ) {
    details.push({
      field: 'equipment',
      message: 'nothing changed: damaged and under maintenance already have these values',
    });
  }
  throwIfInvalid(details);

  const usableBefore =
    current.total_quantity - current.damaged_quantity - current.under_maintenance_quantity;
  const usableAfter = current.total_quantity - damaged - underMaintenance;
  if (usableAfter < usableBefore) {
    await assertNoOverCommitment({ equipmentTypeId: id, usableAfter });
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      ...(value.damagedQuantity !== undefined && { damaged_quantity: value.damagedQuantity }),
      ...(value.underMaintenanceQuantity !== undefined && {
        under_maintenance_quantity: value.underMaintenanceQuantity,
      }),
      last_modified_by: userId,
      last_change_note: value.note,
    })
    .eq('id', id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Equipment type ${id} not found`);

  return toEquipmentType(data);
}


/**
 * AC6: retire a type, so it drops out of the active list and can't be chosen
 * on new equipment lines.
 *
 * Existing lines and reservations that use it are untouched: nothing here
 * reads or writes them, and retirement is a timestamp on the type, never a
 * delete, so past events keep their equipment history. A retired type keeps
 * its quantities and can still be edited.
 *
 * Retiring takes every usable unit out of service, so when any are usable the
 * over-commitment hook runs first with usableAfter 0 (AC7, SCRUM-310). The
 * history trigger records retired_at going from empty to a time, with the user.
 *
 * @param {string} id
 * @param {string|null} [userId]  who is retiring it, kept in the history
 * @returns {Promise<object>} the updated type, retiredAt set
 * @throws {ValidationError} for a malformed id
 * @throws {NotFoundError} when no type has that id
 * @throws {ConflictError} EQUIPMENT_ALREADY_RETIRED when it is already retired
 */
export async function retireEquipmentType(id, userId = null) {
  validateEquipmentTypeId(id);

  const current = await readRow(id);
  if (!current) throw new NotFoundError(`Equipment type ${id} not found`);
  if (current.retired_at) throw alreadyRetired();

  const usableBefore =
    current.total_quantity - current.damaged_quantity - current.under_maintenance_quantity;
  if (usableBefore > 0) {
    await assertNoOverCommitment({ equipmentTypeId: id, usableAfter: 0 });
  }

  // The retired_at guard means a second writer racing this one is refused
  // instead of overwriting the first retirement time.
  const { data, error } = await supabase
    .from(TABLE)
    .update({ retired_at: new Date().toISOString(), last_modified_by: userId, last_change_note: null })
    .eq('id', id)
    .is('retired_at', null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw alreadyRetired();

  return toEquipmentType(data);
}


/**
 * AC6: bring a retired type back. It returns to the active list and can be
 * chosen on new equipment lines again.
 *
 * @param {string} id
 * @param {string|null} [userId]  who is reinstating it, kept in the history
 * @returns {Promise<object>} the updated type, retiredAt empty
 * @throws {ValidationError} for a malformed id
 * @throws {NotFoundError} when no type has that id
 * @throws {ConflictError} EQUIPMENT_NOT_RETIRED when it is not retired
 */
export async function reinstateEquipmentType(id, userId = null) {
  validateEquipmentTypeId(id);

  const current = await readRow(id);
  if (!current) throw new NotFoundError(`Equipment type ${id} not found`);
  if (!current.retired_at) {
    throw new ConflictError('Equipment type is not retired', { code: 'EQUIPMENT_NOT_RETIRED' });
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ retired_at: null, last_modified_by: userId, last_change_note: null })
    .eq('id', id)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw translateError(error);
  if (!data) throw new NotFoundError(`Equipment type ${id} not found`);

  return toEquipmentType(data);
}


/**
 * The whole catalogue, retired types included, with every quantity. For the
 * Technical Support catalogue screen (SCRUM-280), which shows retired types
 * separately. Retirement is stamped in retiredAt, so the screen can split on it.
 *
 * @returns {Promise<object[]>} possibly empty
 */
export async function listEquipmentTypes() {
  const { data, error } = await supabase.from(TABLE).select(COLUMNS).order('name');

  if (error) throw translateError(error);

  return (data ?? []).map(toEquipmentType);
}


/**
 * Active types only, in the reduced shape a picker needs. Retired types never
 * appear here (AC6), which is what keeps them off new equipment lines.
 *
 * @returns {Promise<object[]>} possibly empty
 */
export async function listActiveEquipmentTypes() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .is('retired_at', null)
    .order('name');

  if (error) throw translateError(error);

  return (data ?? []).map(toPickerType);
}


/**
 * A type's change history, newest first (AC8).
 *
 * The type is deliberately not checked for existence first: a type with no
 * history and a type that never existed both answer with an empty list, the
 * same choice venueService.getVenueHistory makes. The id is still validated so
 * a malformed one is a 400 rather than a Postgres cast error.
 *
 * @param {string} id
 * @returns {Promise<object[]>} possibly empty
 * @throws {ValidationError} when the id is malformed, before any query
 */
export async function getEquipmentTypeHistory(id) {
  validateEquipmentTypeId(id);

  const { data, error } = await supabase
    .from('equipment_type_history')
    .select(HISTORY_COLUMNS)
    .eq('equipment_type_id', id)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) throw translateError(error);

  return (data ?? []).map(toHistoryEntry);
}