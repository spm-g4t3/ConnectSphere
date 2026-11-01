/**
 * SCRUM-383 (SCRUM-379 AC7): the rules behind the Needs attention list, with no database
 * and no clock. Every instant below is written out, so these never depend on when they run.
 */
import { describe, it, expect } from 'vitest';

import {
  NEEDS_ATTENTION_CODE,
  NEEDS_ATTENTION_ORDER,
  MARK_COMPLETED_REASON,
  NOT_CONFIRMED_REASON,
  eventHasEnded,
  dateOnly,
  clarificationIsOverdue,
  clarificationOverdueReason,
  venueReadinessReason,
  equipmentReadinessReason,
  compareNeedsAttentionItems,
} from '../../src/domain/coordinatorAttentionList.js';

const at = (iso) => new Date(iso);

describe('SCRUM-383: eventHasEnded', () => {
  const NOW = at('2030-06-15T09:00:00Z');

  it('SCRUM379_AC7_an_event_ending_before_now_has_ended', () => {
    expect(eventHasEnded('2030-06-15T08:59:59Z', NOW)).toBe(true);
  });

  it('SCRUM379_AC7_an_event_ending_exactly_now_has_ended_the_instant_it_can_be_completed', () => {
    expect(eventHasEnded('2030-06-15T09:00:00Z', NOW)).toBe(true);
  });

  it('SCRUM379_AC7_an_event_ending_one_millisecond_from_now_has_not_ended', () => {
    expect(eventHasEnded('2030-06-15T09:00:00.001Z', NOW)).toBe(false);
  });

  it.each([
    ['UTC', '2030-06-15T09:00:00Z'],
    ['Singapore +08:00', '2030-06-15T17:00:00+08:00'],
    ['-08:00', '2030-06-15T01:00:00-08:00'],
    ['+14:00', '2030-06-15T23:00:00+14:00'],
    ['-12:00', '2030-06-14T21:00:00-12:00'],
  ])('SCRUM379_AC7_the_same_instant_written_in_%s_has_ended_at_now', (_label, written) => {
    expect(eventHasEnded(written, NOW)).toBe(true);
  });

  it.each([
    ['UTC', '2030-06-15T09:00:01Z'],
    ['Singapore +08:00', '2030-06-15T17:00:01+08:00'],
    ['-08:00', '2030-06-15T01:00:01-08:00'],
  ])('SCRUM379_AC7_one_second_later_written_in_%s_has_not_ended', (_label, written) => {
    expect(eventHasEnded(written, NOW)).toBe(false);
  });

  it('SCRUM379_AC7_a_Date_object_works_like_the_text', () => {
    expect(eventHasEnded(at('2030-06-15T09:00:00Z'), NOW)).toBe(true);
    expect(eventHasEnded(at('2030-06-15T09:00:01Z'), NOW)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['text that is not a date', 'soon'],
    ['an invalid Date', new Date('nope')],
  ])('SCRUM379_AC7_%s_has_not_ended', (_label, value) => {
    expect(eventHasEnded(value, NOW)).toBe(false);
  });
});

describe('SCRUM-383: dateOnly', () => {
  it.each([
    ['2030-06-15', '2030-06-15'],
    ['2030-06-15T00:00:00.000Z', '2030-06-15'],
    [at('2030-06-15T00:00:00Z'), '2030-06-15'],
  ])('SCRUM379_AC7_%s_reads_as_%s', (value, expected) => {
    expect(dateOnly(value)).toBe(expected);
  });

  it.each([null, undefined, '', 'tomorrow', new Date('nope')])('SCRUM379_AC7_%s_reads_as_no_date', (value) => {
    expect(dateOnly(value)).toBeNull();
  });
});

describe('SCRUM-383: clarificationIsOverdue (a reply-by date is a Singapore date)', () => {
  it('SCRUM379_AC7_still_open_on_the_reply_by_date_until_midnight_in_singapore', () => {
    // 2030-06-15T15:59:59Z is 23:59:59 on the 15th in Singapore.
    expect(clarificationIsOverdue('2030-06-15', at('2030-06-15T15:59:59Z'))).toBe(false);
  });

  it('SCRUM379_AC7_overdue_from_the_first_second_after_the_reply_by_date_in_singapore', () => {
    // 2030-06-15T16:00:00Z is 00:00:00 on the 16th in Singapore.
    expect(clarificationIsOverdue('2030-06-15', at('2030-06-15T16:00:00Z'))).toBe(true);
  });

  it('SCRUM379_AC7_a_future_reply_by_date_is_not_overdue', () => {
    expect(clarificationIsOverdue('2030-06-16', at('2030-06-15T16:00:00Z'))).toBe(false);
  });

  it('SCRUM379_AC7_the_singapore_date_decides_not_the_utc_date', () => {
    // At 17:00 UTC on the 15th it is already the 16th in Singapore, though the UTC date is the 15th.
    expect(clarificationIsOverdue('2030-06-15', at('2030-06-15T17:00:00Z'))).toBe(true);
    expect(clarificationIsOverdue('2030-06-16', at('2030-06-15T17:00:00Z'))).toBe(false);
  });

  it('SCRUM379_AC7_a_reply_by_date_a_long_time_ago_is_overdue', () => {
    expect(clarificationIsOverdue('2020-01-01', at('2030-06-15T00:00:00Z'))).toBe(true);
  });

  it('SCRUM379_AC7_a_reply_by_date_that_arrives_as_a_Date_is_read_by_its_date', () => {
    expect(clarificationIsOverdue(at('2030-06-14T00:00:00Z'), at('2030-06-15T09:00:00Z'))).toBe(true);
    expect(clarificationIsOverdue(at('2030-06-15T00:00:00Z'), at('2030-06-15T09:00:00Z'))).toBe(false);
  });

  it.each([null, undefined, '', 'next week'])('SCRUM379_AC7_%s_has_no_deadline_to_miss', (value) => {
    expect(clarificationIsOverdue(value, at('2030-06-15T09:00:00Z'))).toBe(false);
  });
});

describe('SCRUM-383: the wording', () => {
  it('SCRUM379_AC7_the_two_fixed_reasons', () => {
    expect(MARK_COMPLETED_REASON).toBe('Mark as completed');
    expect(NOT_CONFIRMED_REASON).toBe('Not confirmed; cancel');
  });

  it('SCRUM379_AC7_an_overdue_clarification_names_the_date_it_was_due', () => {
    expect(clarificationOverdueReason('2030-06-10')).toBe('Clarification overdue: reply was due 2030-06-10');
    expect(clarificationOverdueReason(at('2030-06-10T00:00:00Z'))).toBe('Clarification overdue: reply was due 2030-06-10');
  });

  it.each([
    ['No venue booking', 'No valid venue booking'],
    ['Flagged for review', 'Venue booking flagged for review'],
    ['Awaiting approval', 'Venue booking: Awaiting approval'],
    ['Conflicting, awaiting a decision', 'Venue booking: Conflicting, awaiting a decision'],
    ["Does not cover the event's start to end", "Venue booking: Does not cover the event's start to end"],
  ])('SCRUM379_AC7_venue_detail_%s_reads_%s', (detail, expected) => {
    expect(venueReadinessReason(detail)).toBe(expected);
  });

  it.each([
    ['Pending review', 'Equipment request: Pending review'],
    ['Under review', 'Equipment request: Under review'],
    ['Cannot be fully arranged', 'Equipment request: Cannot be fully arranged'],
  ])('SCRUM379_AC7_equipment_detail_%s_reads_%s', (detail, expected) => {
    expect(equipmentReadinessReason(detail)).toBe(expected);
  });

  it('SCRUM379_AC7_there_is_one_code_per_source_and_all_are_ordered', () => {
    expect(Object.values(NEEDS_ATTENTION_CODE)).toHaveLength(6);
    expect([...NEEDS_ATTENTION_ORDER].sort()).toEqual(Object.values(NEEDS_ATTENTION_CODE).sort());
    expect(Object.isFrozen(NEEDS_ATTENTION_CODE)).toBe(true);
    expect(Object.isFrozen(NEEDS_ATTENTION_ORDER)).toBe(true);
  });
});

describe('SCRUM-383: compareNeedsAttentionItems', () => {
  const item = (eventRequestId, proposedStart, code = NEEDS_ATTENTION_CODE.MARK_COMPLETED) => ({
    eventRequestId, proposedStart, code,
  });
  const sorted = (items) => [...items].sort(compareNeedsAttentionItems);

  it('SCRUM379_AC7_the_earlier_event_comes_first', () => {
    const early = item('b', '2030-06-01T09:00:00Z');
    const late = item('a', '2030-06-02T09:00:00Z');
    expect(sorted([late, early])).toEqual([early, late]);
  });

  it('SCRUM379_AC7_the_same_instant_in_different_offsets_ties_and_falls_back_to_the_id', () => {
    const a = item('a', '2030-06-01T17:00:00+08:00');
    const b = item('b', '2030-06-01T09:00:00Z');
    expect(sorted([b, a])).toEqual([a, b]);
  });

  it('SCRUM379_AC7_an_event_with_no_start_comes_last', () => {
    const none = item('a', null);
    const dated = item('z', '2030-06-01T09:00:00Z');
    expect(sorted([none, dated])).toEqual([dated, none]);
  });

  it('SCRUM379_AC7_two_events_with_no_start_fall_back_to_the_id', () => {
    const a = item('a', null);
    const b = item('b', null);
    expect(sorted([b, a])).toEqual([a, b]);
  });

  it('SCRUM379_AC7_one_event_lists_its_reasons_in_the_documented_order', () => {
    const reasons = [...NEEDS_ATTENTION_ORDER].reverse().map((code) => item('a', '2030-06-01T09:00:00Z', code));
    expect(sorted(reasons).map((i) => i.code)).toEqual([...NEEDS_ATTENTION_ORDER]);
  });

  it('SCRUM379_AC7_the_result_does_not_depend_on_the_input_order', () => {
    const items = [
      item('c', '2030-06-03T09:00:00Z'),
      item('a', '2030-06-01T09:00:00Z', NEEDS_ATTENTION_CODE.EQUIPMENT_NOT_READY),
      item('a', '2030-06-01T09:00:00Z', NEEDS_ATTENTION_CODE.MARK_COMPLETED),
      item('b', null),
      item('d', '2030-06-02T09:00:00Z'),
    ];
    const expected = sorted(items);
    expect(sorted([...items].reverse())).toEqual(expected);
    expect(sorted([items[3], items[0], items[4], items[2], items[1]])).toEqual(expected);
    expect(expected.map((i) => i.eventRequestId)).toEqual(['a', 'a', 'd', 'c', 'b']);
  });
});
