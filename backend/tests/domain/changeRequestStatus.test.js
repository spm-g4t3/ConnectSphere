/**
 * Tests for the change request status vocabulary.
 *
 * SCRUM-34 (AC4): show whether each change request is outstanding, in
 * progress, or processed.
 *
 * Mirrors the structure of eventRequestStatus.test.js: the JS list and the
 * database enum, read from the built schema, must not drift apart.
 */

import { describe, it, expect } from 'vitest';

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
import { useSchemaDb, enumLabels } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();

// Written only by cancel_event_request when the whole event is cancelled, and by
// reject_approved_event (025) when it is rejected; a reviewer never chooses
// either, so the decision endpoint must not accept them.
const SYSTEM_ONLY_SQL_DECISIONS = ['event_cancelled', 'event_rejected'];


describe('CHANGE_REQUEST_STATUS mirrors the database enum', () => {
  it('declares exactly the values of the change_request_status enum in the schema', async () => {
    expect([...CHANGE_REQUEST_STATUSES]).toEqual(await enumLabels(schemaDb(), 'change_request_status'));
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
  ])('rejects %s as a status', (_label, value) => {
    expect(isValidChangeRequestStatus(value)).toBe(false);
  });
});


describe('CHANGE_REQUEST_DECISION mirrors the database enum', () => {
  it('declares the change_request_decision enum values a reviewer can choose', async () => {
    const reviewerDecisions = (await enumLabels(schemaDb(), 'change_request_decision'))
      .filter((decision) => !SYSTEM_ONLY_SQL_DECISIONS.includes(decision));
    expect([...CHANGE_REQUEST_DECISIONS]).toEqual(reviewerDecisions);
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
  ])('rejects %s as a decision', (_label, value) => {
    expect(isValidChangeRequestDecision(value)).toBe(false);
  });
});
