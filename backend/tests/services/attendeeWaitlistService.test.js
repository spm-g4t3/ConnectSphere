import { describe, it, expect, vi } from 'vitest';
import { listAttendeeWaitlist } from '../../src/services/attendeeEventService.js';
import { ROLE } from '../../src/domain/userRole.js';

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const user = { id: ATTENDEE.toUpperCase(), role: ROLE.ATTENDEE };
const client = (result) => ({ rpc: vi.fn().mockResolvedValue(result) });

describe('SCRUM460 the attendee waiting-list read', () => {
  it('SCRUM460_AC2_maps_each_place_with_its_numeric_position_for_the_token_attendee', async () => {
    const db = client({ data: [
      { registration_id: 'r1', event_request_id: 'e1', event_name: 'Open Day', waitlist_position: '2', waitlisted_at: 't1', places_offered: true },
      { registration_id: 'r2', event_request_id: 'e2', event_name: null, waitlist_position: 1, waitlisted_at: 't2', places_offered: false },
    ], error: null });
    await expect(listAttendeeWaitlist({ user, client: db })).resolves.toEqual([
      { registrationId: 'r1', eventRequestId: 'e1', eventName: 'Open Day', waitlistPosition: 2, waitlistedAt: 't1', placesOffered: true },
      { registrationId: 'r2', eventRequestId: 'e2', eventName: null, waitlistPosition: 1, waitlistedAt: 't2', placesOffered: false },
    ]);
    expect(db.rpc).toHaveBeenCalledWith('list_attendee_waitlist', { p_attendee_id: ATTENDEE });
  });

  it('SCRUM460_AC2_no_rows_is_an_empty_list', async () => {
    await expect(listAttendeeWaitlist({ user, client: client({ data: null, error: null }) })).resolves.toEqual([]);
  });

  it.each([
    ['the database refuses the caller', { code: '42501' }, { name: 'ForbiddenError' }],
    ['the function is missing', { code: 'PGRST202' }, { name: 'ServiceUnavailableError' }],
  ])('SCRUM460_AC2_answers_when_%s', async (_case, error, expected) => {
    await expect(listAttendeeWaitlist({ user, client: client({ data: null, error }) })).rejects.toMatchObject(expected);
  });

  it('SCRUM460_AC2_refuses_a_non_attendee_before_any_read', async () => {
    const db = client({ data: [], error: null });
    await expect(listAttendeeWaitlist({ user: { id: ATTENDEE, role: ROLE.EVENT_ORGANISER }, client: db }))
      .rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
