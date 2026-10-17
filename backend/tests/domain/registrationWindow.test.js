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
  it('SCRUM495_AC2_is_open_for_a_confirmed_enabled_event_inside_its_window_that_has_not_started', () => {
    expect(isOpenForRegistration(open(), NOW)).toBe(true);
  });

  it.each([
    'draft', 'submitted', 'under_review', 'pending_clarification', 'approved',
    'completed', 'rejected', 'cancelled', 'safety_review', 'safety_approved', undefined,
  ])('SCRUM495_AC2_is_not_open_when_the_status_is_%s', (status) => {
    expect(isOpenForRegistration(open({ status }), NOW)).toBe(false);
  });

  it.each([false, null, undefined, 'true', 1])('SCRUM495_AC2_is_not_open_when_registration_is_%j', (flag) => {
    expect(isOpenForRegistration(open({ registrationEnabled: flag }), NOW)).toBe(false);
  });

  it('SCRUM495_AC2_is_not_open_before_the_window_opens', () => {
    expect(isOpenForRegistration(open({ registrationOpensAt: '2026-10-12T10:00:00.001Z' }), NOW)).toBe(false);
  });

  it('SCRUM495_AC2_is_open_at_the_exact_opening_instant', () => {
    expect(isOpenForRegistration(open({ registrationOpensAt: NOW.toISOString() }), NOW)).toBe(true);
  });

  it('SCRUM495_AC2_is_not_open_at_the_exact_closing_instant_or_after_it', () => {
    expect(isOpenForRegistration(open({ registrationClosesAt: NOW.toISOString() }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T09:59:59.999Z' }), NOW)).toBe(false);
  });

  it('SCRUM495_AC2_is_open_one_millisecond_before_the_window_closes', () => {
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T10:00:00.001Z' }), NOW)).toBe(true);
  });

  it('SCRUM495_AC2_is_not_open_once_the_event_has_started_including_at_the_start_instant', () => {
    expect(isOpenForRegistration(open({ startsAt: NOW.toISOString() }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ startsAt: '2026-10-12T09:00:00.000Z' }), NOW)).toBe(false);
  });

  it.each([
    ['no opening time', { registrationOpensAt: null }],
    ['no start', { startsAt: null }],
    ['an unreadable opening time', { registrationOpensAt: 'soon' }],
    ['an unreadable closing time', { registrationClosesAt: 'soon' }],
  ])('SCRUM495_AC2_is_not_open_with_%s', (_label, overrides) => {
    expect(isOpenForRegistration(open(overrides), NOW)).toBe(false);
  });

  it.each([null, undefined])('SCRUM495_AC2_is_open_with_no_closing_time_%s_open_until_the_organiser_closes_it_by_hand', (closes) => {
    expect(isOpenForRegistration(open({ registrationClosesAt: closes }), NOW)).toBe(true);
  });

  it('SCRUM495_AC2_is_not_open_with_no_closing_time_once_the_event_has_started_or_while_registration_is_off', () => {
    expect(isOpenForRegistration(open({ registrationClosesAt: null, startsAt: NOW.toISOString() }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ registrationClosesAt: null, registrationEnabled: false }), NOW)).toBe(false);
  });

  it('SCRUM495_AC2_compares_instants_so_the_same_moment_written_with_another_offset_is_the_same_answer', () => {
    // 2026-10-12T18:00:00+08:00 is 10:00Z, the window's closing instant.
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T18:00:00+08:00' }), NOW)).toBe(false);
    expect(isOpenForRegistration(open({ registrationClosesAt: '2026-10-12T18:00:01+08:00' }), NOW)).toBe(true);
  });
});
