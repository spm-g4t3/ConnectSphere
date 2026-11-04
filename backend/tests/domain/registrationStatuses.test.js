import { describe, expect, it } from 'vitest';
import { REGISTRATION_CONFIGURABLE_STATUSES } from '../../src/domain/registrationStatuses.js';
import { REGISTRATION_CONFIGURABLE_STATUSES as FRONTEND_STATUSES } from '../../../frontend/src/services/registrationStatuses.js';

describe('registration configurable statuses', () => {
  it('SCRUM494_AC2_frontend_list_matches_backend_domain', () => {
    expect([...FRONTEND_STATUSES]).toEqual([...REGISTRATION_CONFIGURABLE_STATUSES]);
  });
});
