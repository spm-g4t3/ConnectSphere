/**
 * Preview of a catalogue change, before anything is saved.
 *
 * SCRUM-312, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
 *
 * Technical Support Staff are about to lower a type's usable quantity: by
 * recording damage or maintenance, by reducing the total, or by retiring it.
 * This answers "which reservations would that leave short?" so they can see
 * the cost and decide, and so SCRUM-313's confirmed save has a list to compare
 * against.
 *
 * It only reads. Nothing here inserts, updates or deletes, and the database
 * function behind it (equipment_over_commitment, migration 020) is STABLE.
 *
 * The answer comes from the database, not from JavaScript, so the preview and
 * the confirmed save run one rule: first come, first served, oldest
 * reservations kept (SCRUM-311).
 *
 * The preview is a snapshot. A reservation made or released a moment later
 * can change the list, which is why the confirmed save recalculates and
 * refuses when the list moved.
 */

import { supabase } from '../config/supabaseClient.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { createPgTranslator, rejected, invalid, forbidden, notFound } from '../http/pgErrors.js';
import {
  checkChangePreview,
  throwIfInvalid,
  validateEquipmentTypeId,
} from '../validation/equipmentValidation.js';

const COLUMNS =
  'id, name, total_quantity, damaged_quantity, under_maintenance_quantity, retired_at';

/**
 * 42501 and P0002 and 22023 are the codes equipment_over_commitment raises for
 * a caller who is not Technical Support Staff, a type that does not exist, and
 * a usable figure that is null or negative. 22P02 is a value that slipped past
 * validation and is still the caller's input.
 */
const translateError = createPgTranslator({
  codes: {
    '42501': forbidden,
    'P0002': notFound('Equipment type not found'),
    '22023': invalid,
    '22P02': rejected,
  },
});

const usable = (total, damaged, underMaintenance) => total - damaged - underMaintenance;

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

  const total = value.totalQuantity ?? current.total_quantity;
  const damaged = value.damagedQuantity ?? current.damaged_quantity;
  const underMaintenance = value.underMaintenanceQuantity ?? current.under_maintenance_quantity;

  // Retiring leaves nothing to offer, whatever the quantities are.
  if (!value.retire && damaged + underMaintenance > total) {
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
  throwIfInvalid(details);

  const usableBefore = usable(
    current.total_quantity, current.damaged_quantity, current.under_maintenance_quantity,
  );
  const usableAfter = value.retire ? 0 : usable(total, damaged, underMaintenance);

  // Only a change that leaves fewer usable units can leave a reservation short.
  // The confirmed save (apply_equipment_change) makes the same call, so a change
  // that does not reduce usable units previews as affecting nothing, and the
  // preview can never show a list the save would not ask to confirm.
  let data = [];
  if (usableAfter < usableBefore) {
    const result = await supabase.rpc('equipment_over_commitment', {
      p_equipment_type_id: id,
      p_usable_after: usableAfter,
      p_caller: userId,
    });
    if (result.error) throw translateError(result.error);
    data = result.data;
  }

  // The function always answers with a list. Anything else means the database
  // and this code disagree, and guessing "nothing is affected" would let a
  // change through unchecked.
  if (!Array.isArray(data)) {
    throw new Error('equipment_over_commitment did not return a list');
  }

  const affected = data.map(toAffected);
  return {
    equipmentTypeId: current.id,
    equipmentName: current.name,
    usableBefore,
    usableAfter,
    affectedCount: affected.length,
    affectedUnits: affected.reduce((sum, row) => sum + row.quantity, 0),
    affected,
  };
}
