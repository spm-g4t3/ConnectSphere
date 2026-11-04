import { describe, it, expect, vi } from 'vitest';

import { assertCoordinatorMayRead, listEventRequestsForReview } from '../../src/services/eventRequestService.js';
import { NotFoundError, ValidationError } from '../../src/errors.js';
import { ROLE } from '../../src/domain/userRole.js';

// SCRUM-444 AC1, AC4: who may read an event as a coordinator, and the queue's
// caller, without a database. Cases: docs/test-cases/SCRUM-444.md.
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const HOLDER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const LEAD = '44444444-4444-4444-8444-444444444444';

const held = { id: EVENT_ID, assignedCoordinatorId: HOLDER };
const missingIdError = new NotFoundError(`Event request ${EVENT_ID} not found`);

describe('SCRUM-444 AC1: assertCoordinatorMayRead', () => {
  it('SCRUM444_AC1_the_lead_may_read_any_event', () => {
    expect(() => assertCoordinatorMayRead(held, LEAD, ROLE.EVENT_COORDINATOR_LEAD)).not.toThrow();
    expect(() => assertCoordinatorMayRead({ id: EVENT_ID, assignedCoordinatorId: null }, LEAD, ROLE.EVENT_COORDINATOR_LEAD))
      .not.toThrow();
  });

  it('SCRUM444_AC1_the_holder_may_read_their_event', () => {
    expect(() => assertCoordinatorMayRead(held, HOLDER, ROLE.EVENT_COORDINATOR)).not.toThrow();
  });

  it.each([
    ['another_coordinator', held, OTHER, ROLE.EVENT_COORDINATOR],
    ['a_coordinator_on_an_event_nobody_holds', { id: EVENT_ID, assignedCoordinatorId: null }, OTHER, ROLE.EVENT_COORDINATOR],
    ['a_coordinator_with_no_id_on_an_event_nobody_holds', { id: EVENT_ID, assignedCoordinatorId: null }, null, ROLE.EVENT_COORDINATOR],
    ['the_holders_id_with_the_organiser_role', held, HOLDER, ROLE.EVENT_ORGANISER],
    ['venue_staff', held, OTHER, ROLE.VENUE_STAFF],
    ['technical_support_staff', held, OTHER, ROLE.TECHNICAL_SUPPORT_STAFF],
    ['a_safety_officer', held, OTHER, ROLE.SAFETY_OFFICER],
    ['an_attendee', held, OTHER, ROLE.ATTENDEE],
    ['no_role', held, HOLDER, null],
  ])('SCRUM444_AC1_%s_is_refused_with_the_missing_ids_error', (_label, event, userId, role) => {
    let err;
    try {
      assertCoordinatorMayRead(event, userId, role);
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(missingIdError.status);
    expect(err.message).toBe(missingIdError.message);
  });
});

describe('SCRUM-444 AC1: the queue takes its caller', () => {
  it('SCRUM444_AC1_the_queue_refuses_a_missing_caller_before_any_query', async () => {
    // Unfiltered, the queue would list every coordinator's events.
    const client = { from: vi.fn() };

    for (const missing of [undefined, null, '', '   ']) {
      await expect(listEventRequestsForReview(missing, { client })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(client.from).not.toHaveBeenCalled();
  });
});
