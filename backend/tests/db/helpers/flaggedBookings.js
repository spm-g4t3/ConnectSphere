import { expect } from 'vitest';

import { at } from '../../fixtures/time.js';
import { approveBooking } from './bookingFlow.js';

/** A block over start-end, created with the override that flags bookingIds; returns its id. */
export async function blockFlagging(db, { venueId, start, end, bookingIds, caller, notes = null }) {
  const { rows } = await db.query(
    `select create_venue_block($1, $2, $3, 'maintenance', $6, $4, true, $5::uuid[]) as result`,
    [venueId, start, end, caller, bookingIds, notes],
  );
  const { result } = rows[0];
  expect(result.outcome).toBe('created');
  return result.block.id;
}

/**
 * An approved booking on the event at the venue, flagged by a block over
 * 15:00-17:00 on D. The flagged-booking files' events run 14:00-16:00, so the
 * block overlaps them.
 */
export async function flaggedByBlock(db, { venueId, eventId, caller, notes }) {
  const id = await approveBooking(db, { venueId, eventId, caller });
  const blockId = await blockFlagging(db, { venueId, start: at('15:00'), end: at('17:00'), bookingIds: [id], caller, notes });
  const { rows } = await db.query('select status from bookings where id = $1', [id]);
  expect(rows[0].status).toBe('flagged_for_review');
  return { id, venueId, eventId, blockId };
}

// Flagged by a reason rather than a block, as a venue setup change or a
// safety review flags them.
export async function flagForReason(db, bookingId, { reason, flaggedBy }) {
  await db.query(
    `update bookings
        set status = 'flagged_for_review', review_reason = $2, flagged_at = now(), flagged_by = $3
      where id = $1`,
    [bookingId, reason, flaggedBy],
  );
}
