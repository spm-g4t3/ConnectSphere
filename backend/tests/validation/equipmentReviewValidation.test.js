/**
 * Tests for the equipment review input validation.
 *
 * SCRUM-290, subtask SCRUM-294 (the note that marks a line "Cannot be
 * provided"). Named SCRUM290_AC<n>_<what_it_checks>.
 */

import { describe, it, expect } from 'vitest';

import {
  checkOutcomeNote,
  MAX_OUTCOME_NOTE_LENGTH,
} from '../../src/validation/equipmentReviewValidation.js';

describe('AC7: the note on a "Cannot be provided" mark', () => {
  it('SCRUM290_AC7_accepts_a_note_and_trims_it', () => {
    expect(checkOutcomeNote({ note: '  Only two in stock  ' })).toEqual({
      value: { note: 'Only two in stock' },
      details: [],
    });
  });

  it('SCRUM290_AC7_accepts_a_note_of_exactly_the_longest_length', () => {
    const { value, details } = checkOutcomeNote({ note: 'a'.repeat(MAX_OUTCOME_NOTE_LENGTH) });

    expect(details).toEqual([]);
    expect(value.note).toHaveLength(MAX_OUTCOME_NOTE_LENGTH);
  });

  it.each([
    ['missing', {}],
    ['null', { note: null }],
    ['empty', { note: '' }],
    ['spaces only', { note: '   \n\t ' }],
  ])('SCRUM290_AC7_refuses_a_%s_note_as_required', (_label, body) => {
    const { value, details } = checkOutcomeNote(body);

    expect(value).toBeNull();
    expect(details).toEqual([{ field: 'note', message: 'is required: say what is missing' }]);
  });

  it.each([[5], [true], [['a']], [{ text: 'a' }]])(
    'SCRUM290_AC7_refuses_a_note_that_is_not_text_%j',
    (note) => {
      const { details } = checkOutcomeNote({ note });

      expect(details).toEqual([{ field: 'note', message: 'must be text' }]);
    },
  );

  it('SCRUM290_AC7_refuses_a_note_over_the_limit', () => {
    const { value, details } = checkOutcomeNote({ note: 'a'.repeat(MAX_OUTCOME_NOTE_LENGTH + 1) });

    expect(value).toBeNull();
    expect(details).toEqual([
      { field: 'note', message: `must be ${MAX_OUTCOME_NOTE_LENGTH} characters or fewer` },
    ]);
  });

  it('SCRUM290_AC7_counts_the_note_in_characters_so_an_emoji_counts_once', () => {
    const atLimit = `${'a'.repeat(MAX_OUTCOME_NOTE_LENGTH - 1)}😀`;

    expect(checkOutcomeNote({ note: atLimit }).details).toEqual([]);
    expect(checkOutcomeNote({ note: `${atLimit}😀` }).details).toEqual([
      { field: 'note', message: `must be ${MAX_OUTCOME_NOTE_LENGTH} characters or fewer` },
    ]);
  });

  it.each([[null], [undefined], ['text'], [[]], [42]])(
    'SCRUM290_AC7_refuses_a_body_that_is_not_an_object_%j',
    (body) => {
      expect(checkOutcomeNote(body).details).toEqual([
        { field: 'outcome', message: 'must be an object' },
      ]);
    },
  );

  it('SCRUM290_AC7_reads_only_the_note', () => {
    const { value } = checkOutcomeNote({ note: 'None left', userId: 'someone-else', outcome: 'x' });

    expect(value).toEqual({ note: 'None left' });
  });
});
