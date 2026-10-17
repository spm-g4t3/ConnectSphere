import { describe, it, expect } from 'vitest';

import { isOpenEventsEnabled } from '../../src/config/featureFlags.js';

describe('SCRUM495 open events feature flag', () => {
  it('SCRUM495_AC2_is_off_when_unset', () => {
    expect(isOpenEventsEnabled({})).toBe(false);
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])('SCRUM495_AC2_is_off_for_%j', (value) => {
    expect(isOpenEventsEnabled({ OPEN_EVENTS_ENABLED: value })).toBe(false);
  });

  it('SCRUM495_AC2_is_on_only_for_true', () => {
    expect(isOpenEventsEnabled({ OPEN_EVENTS_ENABLED: 'true' })).toBe(true);
  });
});
