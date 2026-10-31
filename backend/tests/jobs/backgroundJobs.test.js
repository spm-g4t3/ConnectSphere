/**
 * Which background jobs the API process starts (src/jobs/backgroundJobs.js),
 * and the switches that turn each off. The start functions are fakes, so no
 * timer runs and no credentials are read.
 */

import { describe, it, expect, vi } from 'vitest';

import { startBackgroundJobs } from '../../src/jobs/backgroundJobs.js';

const fakeStarters = () => ({
  venueHoldExpiry: vi.fn(),
  waitlistPromotion: vi.fn(),
  registrationWindow: vi.fn(),
});

describe('startBackgroundJobs', () => {
  it('SCRUM177_AC1_starts_the_registration_window_job_with_the_others', () => {
    const starters = fakeStarters();

    expect(startBackgroundJobs({ env: { NODE_ENV: 'production' }, starters }))
      .toEqual(['venueHoldExpiry', 'waitlistPromotion', 'registrationWindow']);
    expect(starters.registrationWindow).toHaveBeenCalledTimes(1);
    expect(starters.waitlistPromotion).toHaveBeenCalledTimes(1);
    expect(starters.venueHoldExpiry).toHaveBeenCalledWith({});
  });

  it('starts nothing under test', () => {
    const starters = fakeStarters();

    expect(startBackgroundJobs({ env: { NODE_ENV: 'test' }, starters })).toEqual([]);
    expect(Object.values(starters).some((start) => start.mock.calls.length)).toBe(false);
  });

  it.each([
    ['REGISTRATION_WINDOW_JOB', 'registrationWindow'],
    ['WAITLIST_PROMOTION_JOB', 'waitlistPromotion'],
    ['VENUE_HOLD_EXPIRY_JOB', 'venueHoldExpiry'],
  ])('%s=off turns off only %s', (variable, job) => {
    const starters = fakeStarters();

    const started = startBackgroundJobs({ env: { [variable]: 'off' }, starters });

    expect(started).not.toContain(job);
    expect(started).toHaveLength(2);
    expect(starters[job]).not.toHaveBeenCalled();
  });

  it('passes a positive VENUE_HOLD_REMINDER_HOURS to the hold job and ignores anything else', () => {
    const starters = fakeStarters();
    startBackgroundJobs({ env: { VENUE_HOLD_REMINDER_HOURS: '6' }, starters });
    startBackgroundJobs({ env: { VENUE_HOLD_REMINDER_HOURS: '-1' }, starters });
    startBackgroundJobs({ env: { VENUE_HOLD_REMINDER_HOURS: 'soon' }, starters });

    expect(starters.venueHoldExpiry.mock.calls).toEqual([[{ reminderLeadHours: 6 }], [{}], [{}]]);
  });

  it('reads process.env and the real jobs by default, which start nothing under test', () => {
    expect(startBackgroundJobs()).toEqual([]);
  });
});
