/**
 * Tests for the shared storage limits.
 */

import { describe, it, expect } from 'vitest';

import { MAX_INTEGER } from '../../src/validation/limits.js';

describe('MAX_INTEGER', () => {
  it("is Postgres's integer maximum, 2^31 - 1", () => {
    expect(MAX_INTEGER).toBe(2 ** 31 - 1);
  });
});
