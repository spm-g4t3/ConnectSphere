import { expect } from 'vitest';

import { seedBooking } from './schemaDb.js';

/** decide_booking_request's jsonb answer. */
export async function decideBooking(db, bookingId, { caller, decision, reason = null, alternative = null }) {
  const { rows } = await db.query('select decide_booking_request($1, $2, $3, $4, $5) as result', [
    bookingId,
    caller,
    decision,
    reason,
    alternative,
  ]);
  return rows[0].result;
}

// Approved through the real function, not written as 'approved', so the
// decision (who, when) is recorded as the flows downstream expect.
export async function approveBooking(db, { venueId, eventId, caller }) {
  const id = await seedBooking(db, { venueId, eventId });
  expect((await decideBooking(db, id, { caller, decision: 'approve' })).outcome).toBe('approved');
  return id;
}
