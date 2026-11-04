/**
 * Tests for the acting-user reader the routes share.
 */

import { describe, it, expect } from 'vitest';

import { actingUser } from '../../src/http/actingUser.js';

describe('actingUser', () => {
  it('is the signed-in user, never one the body names', () => {
    expect(actingUser({ user: { id: 'u-1' }, body: { userId: 'someone-else' } })).toBe('u-1');
  });
});
