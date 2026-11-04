import { describe, it, expect, vi } from 'vitest';
import { joinEventWaitlist } from '../../src/services/registrationService.js';
import { leaveWaitlist } from '../../src/services/waitlistDepartureService.js';
import { getRegistrationCounts } from '../../src/services/eventRegistrationService.js';

const ATTENDEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const client = (result) => ({ rpc: vi.fn().mockResolvedValue(result) });
const joining = (result) => joinEventWaitlist({ attendeeId: ATTENDEE, eventId: EVENT, client: client(result) });
const leaving = (result, registrationId = ENTRY) => leaveWaitlist({
  attendeeId: ATTENDEE, registrationId, client: client(result),
});

describe('SCRUM473 joining: answers the database cannot easily produce here', () => {
  it.each([
    ['an unknown outcome', { outcome: 'something_else' }],
    ['a waitlisted outcome without created', { outcome: 'waitlisted', registration: { id: ENTRY, waitlistPosition: 1 } }],
    ['a waitlisted outcome without a position', { outcome: 'waitlisted', created: true, registration: { id: ENTRY } }],
    ['a registered outcome without a row', { outcome: 'registered' }],
  ])('SCRUM473_AC6_refuses_to_report_%s', async (_case, data) => {
    await expect(joining({ data, error: null })).rejects.toThrow('Unexpected outcome from join_event_waitlist');
  });

  it.each([
    [{ code: '40001' }, { status: 409, code: 'REGISTRATION_CHANGED' }],
    [{ code: 'PGRST202' }, { status: 503 }],
  ])('SCRUM473_AC10_database_failure_%j_is_explained', async (error, expected) => {
    await expect(joining({ data: null, error })).rejects.toMatchObject(expected);
  });

  it('SCRUM473_AC7_needs_an_authenticated_attendee_and_a_valid_event', async () => {
    await expect(joinEventWaitlist({ eventId: EVENT, client: client({}) })).rejects.toMatchObject({ status: 401 });
    await expect(joinEventWaitlist({ attendeeId: ATTENDEE, eventId: 'x', client: client({}) }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('SCRUM473 leaving: the departure errors are its own', () => {
  it.each([
    [{ code: 'PGRST202' }, { status: 503, message: 'Waiting lists are temporarily unavailable. Please try again later.' }],
    [{ code: '40P01' }, { status: 409, code: 'REGISTRATION_CHANGED' }],
    [{ code: '42501', message: 'This action is restricted to Attendees' }, { status: 403 }],
    [{ code: '22023', message: 'An attendee and registration are required' }, { status: 400 }],
  ])('SCRUM473_AC10_database_failure_%j_is_explained', async (error, expected) => {
    await expect(leaving({ data: null, error })).rejects.toMatchObject(expected);
  });

  it('SCRUM473_AC10_an_unexpected_reply_is_not_reported_as_success', async () => {
    await expect(leaving({ data: { outcome: 'withdrawn' }, error: null }))
      .rejects.toThrow('Unexpected outcome from leave_event_waitlist');
  });

  it('SCRUM473_AC7_needs_an_authenticated_attendee', async () => {
    await expect(leaveWaitlist({ registrationId: ENTRY, client: client({}) })).rejects.toMatchObject({ status: 401 });
  });

  it('SCRUM473_AC7_sends_the_ids_as_validated', async () => {
    const db = client({ data: { outcome: 'left_waitlist', registration: { id: ENTRY, status: 'withdrawn' } }, error: null });
    await leaveWaitlist({ attendeeId: ` ${ATTENDEE.toUpperCase()} `, registrationId: ENTRY.toUpperCase(), client: db });
    expect(db.rpc).toHaveBeenCalledWith('leave_event_waitlist', { p_registration_id: ENTRY, p_attendee_id: ATTENDEE });
  });
});

describe('SCRUM477 the staff count read', () => {
  const counting = (error) => getRegistrationCounts(EVENT, ATTENDEE, { client: client({ data: null, error }) });

  it.each([
    [{ code: 'PGRST202' }, { status: 503 }],
    [{ code: '42501', message: 'Only the event\'s Organiser or assigned Coordinator can view its registrations' }, { status: 403 }],
    [{ code: 'P0002' }, { status: 404 }],
  ])('SCRUM477_AC6_database_failure_%j_is_explained', async (error, expected) => {
    await expect(counting(error)).rejects.toMatchObject(expected);
  });

  it('SCRUM477_AC6_an_untyped_failure_is_left_for_the_route_to_log', async () => {
    const failure = { code: 'XX000', message: 'boom' };
    await expect(counting(failure)).rejects.toBe(failure);
  });
});
