/**
 * Tests for the change request status vocabulary.
 *
 * SCRUM-34 (AC4): show whether each change request is outstanding, in
 * progress, or processed.
 *
 * Mirrors the structure of eventRequestStatus.test.js: the JS list and the
 * database enum must not drift apart.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CHANGE_REQUEST_STATUS,
  CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_STATUS_LABEL,
  isValidChangeRequestStatus,
  CHANGE_REQUEST_DECISION,
  CHANGE_REQUEST_DECISIONS,
  CHANGE_REQUEST_DECISION_LABEL,
  isValidChangeRequestDecision,
} from '../../src/domain/changeRequestStatus.js';


describe('CHANGE_REQUEST_STATUS mirrors the database enum', () => {
  /** Pull the enum values straight out of the migration, comments stripped. */
  function statusesDeclaredInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      resolve(here, '../../db/migrations/006_event_change_requests.sql'),
      'utf8',
    );

    const block = sql.match(
      /create type change_request_status as enum \(([\s\S]*?)\);/i,
    );
    if (!block) throw new Error('could not find the enum in the migration');

    return [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]);
  }

  it('declares exactly the same values as the SQL migration', () => {
    expect([...CHANGE_REQUEST_STATUSES].sort()).toEqual(statusesDeclaredInSql().sort());
  });
});


describe('AC4: an Organiser can tell outstanding, in progress and processed apart', () => {
  it('exposes exactly the three states this subtask asks for', () => {
    expect([...CHANGE_REQUEST_STATUSES].sort()).toEqual(
      ['outstanding', 'in_progress', 'processed'].sort(),
    );
  });

  it('gives every status a human-readable label', () => {
    for (const status of CHANGE_REQUEST_STATUSES) {
      expect(CHANGE_REQUEST_STATUS_LABEL[status]).toBeTypeOf('string');
      expect(CHANGE_REQUEST_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });

  it.each(Object.values(CHANGE_REQUEST_STATUS))('accepts %s as a valid status', (value) => {
    expect(isValidChangeRequestStatus(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'approved'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(isValidChangeRequestStatus(value)).toBe(false);
  });
});


describe('CHANGE_REQUEST_DECISION mirrors the database enum', () => {
  /** Pull the enum values straight out of the migration, comments stripped. */
  function decisionsDeclaredInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      resolve(here, '../../db/migrations/006_event_change_requests.sql'),
      'utf8',
    );

    const block = sql.match(
      /create type change_request_decision as enum \(([\s\S]*?)\);/i,
    );
    if (!block) throw new Error('could not find the enum in the migration');

    return [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]);
  }

  it('declares exactly the same values as the SQL migration', () => {
    expect([...CHANGE_REQUEST_DECISIONS].sort()).toEqual(decisionsDeclaredInSql().sort());
  });
});


describe('SCRUM-37: a processed change request can be told approved from rejected', () => {
  it('exposes exactly the two outcomes processing can have', () => {
    expect([...CHANGE_REQUEST_DECISIONS].sort()).toEqual(['approved', 'rejected'].sort());
  });

  it('gives every decision a human-readable label', () => {
    for (const decision of CHANGE_REQUEST_DECISIONS) {
      expect(CHANGE_REQUEST_DECISION_LABEL[decision]).toBeTypeOf('string');
      expect(CHANGE_REQUEST_DECISION_LABEL[decision].length).toBeGreaterThan(0);
    }
  });

  it.each(Object.values(CHANGE_REQUEST_DECISION))('accepts %s as a valid decision', (value) => {
    expect(isValidChangeRequestDecision(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'outstanding'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(isValidChangeRequestDecision(value)).toBe(false);
  });
});
