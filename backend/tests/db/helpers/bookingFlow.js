import { expect } from 'vitest';

import { seedBooking } from './schemaDb.js';

// The period Venue Staff are shown for an approval: the event's (or the
// request's own when the event has none). A missing booking gets any instant,
// since the function refuses it before comparing.
const APPROVAL_PERIOD = `
  select coalesce(er.proposed_start, b.starts_at) as starts_at,
         coalesce(er.proposed_end, b.ends_at)     as ends_at
    from bookings b join event_requests er on er.id = b.event_request_id
   where b.id = $1`;

// A reinstatement keeps a booking's own period while it still covers the
// event's, else takes the event's (reinstate_flagged_booking, step 6).
const REINSTATE_PERIOD = `
  select case when b.starts_at <= er.proposed_start and b.ends_at >= er.proposed_end
              then b.starts_at else coalesce(er.proposed_start, b.starts_at) end as starts_at,
         case when b.starts_at <= er.proposed_start and b.ends_at >= er.proposed_end
              then b.ends_at else coalesce(er.proposed_end, b.ends_at) end     as ends_at
    from bookings b join event_requests er on er.id = b.event_request_id
   where b.id = $1`;

async function periodShown(db, sql, bookingId) {
  const { rows } = await db.query(sql, [bookingId]);
  return rows[0] ? [rows[0].starts_at, rows[0].ends_at] : ['epoch', 'epoch'];
}

/**
 * decide_booking_request's jsonb answer. An approval is sent the period Venue
 * Staff were shown unless `expected` gives one ([start, end], or null for none).
 */
export async function decideBooking(
  db,
  bookingId,
  { caller, decision, reason = null, alternative = null, expected, suitability = null },
) {
  const [start, end] =
    expected === undefined
      ? decision === 'approve' ? await periodShown(db, APPROVAL_PERIOD, bookingId) : [null, null]
      : expected ?? [null, null];
  const { rows } = await db.query(
    'select decide_booking_request($1, $2, $3, $4, $5, $6, $7, $8) as result',
    [bookingId, caller, decision, reason, alternative, start, end, suitability],
  );
  return rows[0].result;
}

/**
 * reinstate_flagged_booking's jsonb answer, sent the period Venue Staff were
 * shown unless `expected` gives one ([start, end], or null for none).
 */
export async function reinstateBooking(
  db,
  bookingId,
  { caller, reason = 'Block moved', expected, suitability = null },
) {
  const [start, end] =
    expected === undefined ? await periodShown(db, REINSTATE_PERIOD, bookingId) : expected ?? [null, null];
  const { rows } = await db.query(
    'select reinstate_flagged_booking($1, $2, $3, $4, $5, $6) as result',
    [bookingId, caller, reason, start, end, suitability],
  );
  return rows[0].result;
}

// Approved through the real function, not written as 'approved', so the
// decision (who, when) is recorded as the flows downstream expect.
export async function approveBooking(db, { venueId, eventId, caller }) {
  const id = await seedBooking(db, { venueId, eventId });
  expect((await decideBooking(db, id, { caller, decision: 'approve' })).outcome).toBe('approved');
  return id;
}
