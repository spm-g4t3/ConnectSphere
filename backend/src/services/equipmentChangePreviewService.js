/**
 * Preview of a catalogue change, before anything is saved: which reservations a change
 * to a type's usable quantity (damage, maintenance, a smaller total, a retirement) would
 * leave short.
 *
 * It only reads. The answer comes from equipment_change_affected, the same function
 * apply_equipment_change uses, so the preview and the save run one rule and can't drift.
 * The preview is a snapshot: the confirmed save recalculates and refuses when the list moved.
 */

import { supabase } from '../config/supabaseClient.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { createPgTranslator, rejected, invalid, forbidden, notFound } from '../http/pgErrors.js';
import { isNameTaken, NAME_TAKEN } from './equipmentService.js';
import {
  checkChangePreview,
  throwIfInvalid,
  validateEquipmentTypeId,
} from '../validation/equipmentValidation.js';

const COLUMNS =
  'id, name, total_quantity, damaged_quantity, under_maintenance_quantity, retired_at';

/**
 * 42501, P0002 and 22023 are what equipment_change_affected raises for a caller who is not
 * Technical Support Staff, a type that does not exist, and a negative usable quantity.
 * 22P02 is a value that slipped past validation and is still the caller's input.
 */
const translateError = createPgTranslator({
  codes: {
    '42501': forbidden,
    'P0002': notFound('Equipment type not found'),
    '22023': invalid,
    '22P02': rejected,
  },
});

export function toAffected(row) {
  return {
    reservationId: row.reservation_id,
    eventRequestId: row.event_request_id,
    eventName: row.event_name,
    equipmentLineId: row.equipment_line_id,
    quantity: row.quantity,
    startAt: row.start_at,
    endAt: row.end_at,
    coordinatorId: row.coordinator_id,
    coordinatorName: row.coordinator_name,
    flagged: row.flagged,
    reservedAt: row.reserved_at,
  };
}

/**
 * Which reservations a change would leave short.
 *
 * @param {string} id  the equipment type
 * @param {object} input  totalQuantity, damagedQuantity and/or
 *   underMaintenanceQuantity; or retire: true. Quantities left out stay as they are.
 * @param {string} userId  the signed-in user, checked again by the database
 * @returns {Promise<{equipmentTypeId: string, equipmentName: string,
 *   usableBefore: number, usableAfter: number, affectedCount: number,
 *   affectedUnits: number, affected: object[]}>}
 * @throws {ValidationError} for a malformed id or body, or damaged plus under
 *   maintenance above the total; before any query for the first two
 * @throws {NotFoundError} when no type has that id
 * @throws {ConflictError} EQUIPMENT_ALREADY_RETIRED when asked to retire a retired type
 */
export async function previewEquipmentChange(id, input, userId) {
  validateEquipmentTypeId(id);

  const { value, details } = checkChangePreview(input);

  // A bad body is refused before any query. Unlike an edit, there is nothing
  // to gain from reading the type first: the one rule that needs the stored
  // figures (damaged plus under maintenance within the total) can't be judged
  // while a figure is itself invalid.
  if (details.length > 0) throwIfInvalid(details);

  const { data: current, error: readError } = await supabase
    .from('equipment_types')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (readError) throw translateError(readError);
  if (!current) throw new NotFoundError(`Equipment type ${id} not found`);

  if (value.retire && current.retired_at) {
    throw new ConflictError('Equipment type is already retired', { code: 'EQUIPMENT_ALREADY_RETIRED' });
  }

  // Whether the stored figures fit together is the one rule judged here, so the message
  // can name the field that broke it. The usable quantities themselves come from the database.
  if (!value.retire) {
    const total = value.totalQuantity ?? current.total_quantity;
    const damaged = value.damagedQuantity ?? current.damaged_quantity;
    const underMaintenance = value.underMaintenanceQuantity ?? current.under_maintenance_quantity;
    if (damaged + underMaintenance > total) {
      let field = 'underMaintenanceQuantity';
      if (value.totalQuantity !== undefined) field = 'totalQuantity';
      else if (value.damagedQuantity !== undefined) field = 'damagedQuantity';
      details.push({
        field,
        message:
          `damaged plus under maintenance (${damaged + underMaintenance}) ` +
          `can't exceed the total (${total})`,
      });
    }
  }

  // Refused now, not after staff have confirmed the list: the save would refuse it too.
  if (value.name !== undefined && (await isNameTaken(value.name, id))) {
    details.push({ field: 'name', message: NAME_TAKEN });
  }
  throwIfInvalid(details);

  const { data, error } = await supabase.rpc('equipment_change_affected', {
    p_equipment_type_id: id,
    p_caller: userId,
    p_total: value.totalQuantity ?? null,
    p_damaged: value.damagedQuantity ?? null,
    p_under_maintenance: value.underMaintenanceQuantity ?? null,
    p_retire: value.retire === true,
  });
  if (error) throw translateError(error);

  // Anything but the documented answer means the database and this code disagree, and
  // guessing "nothing is affected" would let a change through unchecked.
  if (
    data === null || typeof data !== 'object' || !Array.isArray(data.affected)
    || !Number.isInteger(data.usable_before) || !Number.isInteger(data.usable_after)
  ) {
    throw new Error('equipment_change_affected did not return a list');
  }

  const affected = data.affected.map(toAffected);
  return {
    equipmentTypeId: current.id,
    equipmentName: current.name,
    usableBefore: data.usable_before,
    usableAfter: data.usable_after,
    affectedCount: affected.length,
    affectedUnits: affected.reduce((sum, row) => sum + row.quantity, 0),
    affected,
  };
}
