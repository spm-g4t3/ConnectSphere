/**
 * Tests for the role authorisation middleware.
 *
 * SCRUM-15 AC2: "an authorised change to a venue's details". These prove the
 * gate itself; tests/routes/venues.test.js proves it is actually mounted in
 * front of the routes that need it, which is the half that would otherwise be
 * easy to get wrong silently.
 */

import { describe, it, expect, vi } from 'vitest';

import { createRequireRole } from '../../src/middleware/requireRole.js';
import { ROLE } from '../../src/domain/userRole.js';


const req = (user, rest = {}) => ({ user, ...rest });

function createFakeResponse() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}


describe('AC2: only an authorised role may change the catalogue', () => {
  it('SCRUM15_AC2_lets_the_allowed_role_through', () => {
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1', role: ROLE.VENUE_STAFF }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  it('SCRUM15_AC2_refuses_a_different_role_with_403', () => {
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1', role: ROLE.EVENT_ORGANISER }), res, next);

    // 403 rather than 401: they are signed in, and signing in again changes
    // nothing. The frontend clears its session on a 401, so using one here
    // would log out a legitimate user for asking the wrong question.
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('SCRUM15_AC2_names_the_role_that_would_work', () => {
    const res = createFakeResponse();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1', role: ROLE.ATTENDEE }), res, vi.fn());

    expect(res.body.error).toContain('Venue Staff');

    // Not the caller's own role -- that is not actionable, and echoing it
    // tells them nothing about who to ask.
    expect(res.body.error).not.toContain('Attendee');
  });

  it('SCRUM15_AC2_allows_any_one_of_several_roles', () => {
    const gate = createRequireRole(ROLE.VENUE_STAFF, ROLE.EVENT_COORDINATOR);

    for (const role of [ROLE.VENUE_STAFF, ROLE.EVENT_COORDINATOR]) {
      const next = vi.fn();
      gate(req({ id: 'u1', role }), createFakeResponse(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const denied = createFakeResponse();
    gate(req({ id: 'u1', role: ROLE.ATTENDEE }), denied, vi.fn());
    expect(denied.statusCode).toBe(403);
  });

  it('SCRUM15_AC2_refuses_a_user_with_no_role_at_all', () => {
    const res = createFakeResponse();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1' }), res, vi.fn());

    expect(res.statusCode).toBe(403);
  });

  it('SCRUM15_AC2_refuses_a_role_outside_the_vocabulary', () => {
    const res = createFakeResponse();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1', role: 'admin' }), res, vi.fn());

    expect(res.statusCode).toBe(403);
  });

  it('SCRUM15_AC2_is_not_fooled_by_an_inherited_property', () => {
    const res = createFakeResponse();

    createRequireRole(ROLE.VENUE_STAFF)(req({ id: 'u1', role: 'constructor' }), res, vi.fn());

    expect(res.statusCode).toBe(403);
  });

  it('SCRUM15_AC2_never_reads_a_role_from_the_body_or_query', () => {
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(ROLE.VENUE_STAFF)(
      req({ id: 'u1', role: ROLE.EVENT_ORGANISER }, {
        body: { role: ROLE.VENUE_STAFF },
        query: { role: ROLE.VENUE_STAFF },
      }),
      res,
      next,
    );

    // The whole point. A client may claim whatever it likes; the role comes
    // from the profiles table by way of requireAuth, and nowhere else.
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});


describe('a wiring mistake is reported as a fault, not as a refusal', () => {
  it('SCRUM15_AC2_answers_500_when_requireAuth_did_not_run_first', () => {
    const res = createFakeResponse();
    const next = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    createRequireRole(ROLE.VENUE_STAFF)({ headers: {} }, res, next);

    // 403 here would make a missing requireAuth look like working
    // authorisation, and it would stay hidden until someone asked why no
    // Venue Staff member could reach the endpoint.
    expect(res.statusCode).toBe(500);
    expect(next).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('SCRUM15_AC2_refuses_to_build_a_gate_that_allows_nobody', () => {
    expect(() => createRequireRole()).toThrow(/at least one role/);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-485 AC5: the two new roles pass no existing gate
// ---------------------------------------------------------------------------
// docs/test-cases/SCRUM-485.md, AC5-08, and the decision "The Lead inherits
// nothing from Event Coordinator". These are the real proof that every route is
// refused: each route file builds its gate from this one factory (coordinatorOnly,
// venueStaffOnly, technicalSupportOnly, internalReaders, activeReaders), so a
// role this middleware refuses is refused on every route behind that gate. The
// route suites sample one route per gate to prove the gate is mounted.
describe('SCRUM-485 AC5: the Event Coordinator Lead and the Safety Officer pass no existing gate', () => {
  const NEW_ROLES = [ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER];

  it.each(NEW_ROLES)('SCRUM485_AC5_the_coordinator_gate_refuses_%s', (role) => {
    // AC5-08. The case an examiner asks about: event_coordinator_lead begins
    // with event_coordinator, and is still refused, because the gate compares
    // the whole value with includes, never a prefix.
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(ROLE.EVENT_COORDINATOR)(req({ id: 'u1', role }), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ error: 'This action is restricted to Event Coordinators' });
  });

  // Every gate the routes build, as the route files build them.
  const GATES = [
    ['Venue Staff', [ROLE.VENUE_STAFF]],
    ['Technical Support Staff', [ROLE.TECHNICAL_SUPPORT_STAFF]],
    ['Venue Staff or Event Coordinators', [ROLE.VENUE_STAFF, ROLE.EVENT_COORDINATOR]],
    ['Technical Support Staff or Event Coordinators', [ROLE.TECHNICAL_SUPPORT_STAFF, ROLE.EVENT_COORDINATOR]],
  ];
  const CASES = GATES.flatMap(([named, allowed]) => NEW_ROLES.map((role) => [named, role, allowed]));

  it.each(CASES)('SCRUM485_AC5_the_%s_gate_refuses_%s', (named, role, allowed) => {
    // The same for the other single-role gates, and for the two two-role
    // gates (internalReaders on the venue routes, activeReaders on the
    // equipment routes).
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(...allowed)(req({ id: 'u1', role }), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ error: `This action is restricted to ${named}` });
  });

  it.each(NEW_ROLES)('SCRUM485_AC5_a_refusal_names_the_role_that_would_work_not_%s', (role) => {
    // As for every role: the caller's own label is not actionable, so it is
    // never echoed. The labels themselves are tested in userRole.test.js.
    const res = createFakeResponse();

    createRequireRole(ROLE.EVENT_COORDINATOR)(req({ id: 'u1', role }), res, vi.fn());

    expect(res.body.error).not.toMatch(/Lead|Safety/);
  });

  it.each(NEW_ROLES)('SCRUM485_AC5_a_gate_that_names_%s_lets_it_through', (role) => {
    // The other half: the role is recognised by the gate, not refused because
    // it is new. No route builds this gate yet; the stories that grant each
    // role an ability will (SCRUM-486, 487, 489, 490).
    const res = createFakeResponse();
    const next = vi.fn();

    createRequireRole(role)(req({ id: 'u1', role }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});
