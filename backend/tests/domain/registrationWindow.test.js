// SCRUM-495 (AC2, AC4): the rule for "open for registration right now".
// The boundaries are half-open, [opens, closes), and an event is listed only
// while start > now. See domain/registrationWindow.js for why.

import { describe, it, expect } from 'vitest';

import { isOpenForRegistration } from '../../src/domain/registrationWindow.js';

const NOW = new Date('2026-10-12T10:00:00.000Z');

const open = (overrides = {}) => ({
  status: 'confirmed',
  registrationEnabled: true,
  registrationOpensAt: '2026-10-01T00:00:00.000Z',
  registrationClosesAt: '2026-10-20T00:00:00.000Z',
  startsAt: '2026-10-25T09:00:00.000Z',
  ...overrides,
});

describe('SCRUM495_AC2 isOpenForRegistration', () => {
  it('is open for a Confirmed, enabled event inside its window that has not started', () => {
    expect(isOpenForRegistration(open(), NOW)).toBe(true);
  });

  it.each([
    'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
    'completed', 'rejected', 'cancelled', 'safety_review', 'safety_approved', undefined,
  ])('is not open when the status is %s', (status) => {
    expect(isOpenForRegistration(open({ status }), NOW)).toBe(false);
  });

  it.each([false, null, undefined, 'true', 1])('is not open when registration is %j', (flag) => {
    expect(isOpenForRegistration(open({ registrationEnabled: flag }), NOW)).toBe(false);
  });

  it('is not open before the window opens', () => {
    expect(isOpenForRegistration(open({ registrationOpensAt: '2026-10-12T10:00:00.001Z' }), NOW)).toBe(false);
  });

  it('is open at the exact opening instant', () => {
    expect(isOpenForRegistration(open({ registrationOpensAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('is not open at the exact closing instant, or after it', () => {
    expect(isOpenForRegistration(open({ registrationClosesAt: NOW.toISOString() }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T09:59:59.999Z' }), NOW)).toBe(false);
  });

  it('is open one millisecond before the window closes', () => {
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T10:00:00.001Z' }), NOW)).toBe(true);
  });

  it('is not open once the event has started, including at the start instant', () => {
    expect(isOpenForRegistration(open({ startsAt: NOW.toISOString() }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ startsAt: '2026-10-12T09:00:00.000Z' }), NOW)).toBe(false);
  });

  it.each([
    ['no opening time', { registrationOpensAt: null }],
    ['no closing time', { registrationClosesAt: null }],
    ['no start', { startsAt: null }],
    ['an unreadable opening time', { registrationOpensAt: 'soon' }],
  ])('is not open with %s', (_label, overrides) => {
    expect(isOpenForRegistration(open(overrides), NOW)).toBe(false);
  });

  it('compares instants, so the same moment written with another offset is the same answer', () => {
    // 2026-10-12T18:00:00+08:00 is 10:00Z, the window's closing instant.
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T18:00:00+08:00' }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T18:00:01+08:00' }), NOW)).toBe(true);
  });
});
