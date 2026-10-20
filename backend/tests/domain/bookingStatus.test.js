/**
 * Tests for the booking status vocabulary and the venue block schema.
 *
 * SCRUM-17 (AC1, AC3, AC4) / SCRUM-123: a block only conflicts with approved
 * bookings, active blocks on one venue may not overlap, and every block
 * records who created, amended and removed it.
 *
 * Mirrors the structure of changeRequestStatus.test.js: the JS list and the
 * database enum, read from the built schema, must not drift apart.
 */

import { describe, it, expect } from 'vitest';

import {
  BOOKING_STATUS,
  BOOKING_STATUS_DISPLAY,
  getBookingStatusDisplay,
  isBookingStatus,
} from '../../src/domain/bookingStatus.js';
import { useSchemaDb, enumLabels, constraintDef } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();


describe('BOOKING_STATUS mirrors the database enum', () => {
  it('SCRUM17_AC3_booking_statuses_match_the_sql_enum', async () => {
    expect(Object.values(BOOKING_STATUS)).toEqual(await enumLabels(schemaDb(), 'booking_status'));
  });

  it('SCRUM250_exposes_the_three_original_statuses_then_the_request_statuses, in order', () => {
    expect(Object.values(BOOKING_STATUS)).toEqual([
      'approved',
      'flagged_for_review',
      'cancelled',
      'pending',
      'rejected',
      'withdrawn',
      'conflicting',
      // SCRUM-492 appends released, as SCRUM-261 appended conflicting.
      'released',
    ]);
  });

  it('is frozen, so no caller can add or rewrite a status at runtime', () => {
    expect(Object.isFrozen(BOOKING_STATUS)).toBe(true);
  });
});


describe('isBookingStatus', () => {
  it.each(Object.values(BOOKING_STATUS))('accepts %s', (value) => {
    expect(isBookingStatus(value)).toBe(true);
  });

  it.each([
    ['an unknown string', 'declined'],
    ['a status in the wrong case', 'Pending'],
    ['an inherited key', 'toString'],
    ['an enum key rather than its value', 'APPROVED'],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('rejects %s', (_label, value) => {
    expect(isBookingStatus(value)).toBe(false);
  });
});


describe('venue_blocks schema', () => {
  it('SCRUM17_AC1_schema_declares_the_active_block_exclusion_constraint', async () => {
    expect(await constraintDef(schemaDb(), 'venue_blocks_no_overlap')).toBe(
      "EXCLUDE USING gist (venue_id WITH =, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE ((removed_at IS NULL))",
    );
  });

  it.each([
    ['created_by', 'uuid'],
    ['last_modified_by', 'uuid'],
    ['removed_at', 'timestamp with time zone'],
    ['removed_by', 'uuid'],
  ])('SCRUM17_AC4_venue_blocks_has_audit_columns: %s', async (column, type) => {
    const { rows } = await schemaDb().query(
      `select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'venue_blocks' and column_name = $1`,
      [column],
    );
    expect(rows).toEqual([{ data_type: type }]);
  });
});

describe('SCRUM-255: how a booking status is shown to the coordinator', () => {
  it('SCRUM255_has_a_display_for_every_status_and_nothing_else', () => {
    expect(Object.keys(BOOKING_STATUS_DISPLAY).sort()).toEqual(Object.values(BOOKING_STATUS).sort());
    expect(Object.isFrozen(BOOKING_STATUS_DISPLAY)).toBe(true);
  });

  it.each([
    ['pending', 'Pending', 'PENDING'],
    ['rejected', 'Rejected', 'REJECTED'],
    ['withdrawn', 'Withdrawn', 'WITHDRAWN'],
    ['approved', 'Approved', 'APPROVED'],
    ['flagged_for_review', 'Flagged for review', 'FLAGGED'],
    ['cancelled', 'Cancelled', 'CANCELLED'],
  ])('SCRUM255_shows_%s_as_%s_in_group_%s', (status, label, group) => {
    const display = getBookingStatusDisplay(status);
    expect(display).toMatchObject({ status, label, group });
    expect(display.description).toEqual(expect.any(String));
    expect(Object.isFrozen(display)).toBe(true);
  });

  it('SCRUM255_every_status_has_its_own_label_and_group', () => {
    const displays = Object.values(BOOKING_STATUS).map(getBookingStatusDisplay);
    expect(new Set(displays.map((d) => d.label)).size).toBe(displays.length);
    expect(new Set(displays.map((d) => d.group)).size).toBe(displays.length);
  });

  it.each([
    ['a status this build does not know', 'on_hold', 'on_hold'],
    ['an inherited key', 'toString', 'toString'],
    ['nothing', undefined, null],
    ['null', null, null],
    ['a number', 7, null],
  ])('SCRUM255_never_returns_undefined_for_%s', (_label, value, expectedStatus) => {
    expect(getBookingStatusDisplay(value)).toMatchObject({
      status: expectedStatus,
      label: 'Unknown Status',
      group: 'UNKNOWN',
    });
  });
});