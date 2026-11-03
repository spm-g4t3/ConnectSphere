/**
 * Tests for the ilike pattern and .or() filter builders (SCRUM-592).
 *
 * Exact strings, written with String.raw so each backslash below is one
 * backslash sent. These prove the string built; how PostgREST reads it is
 * proved against the real project by scripts/check-venue-search-text.js.
 */

import { describe, it, expect } from 'vitest';

import { toIlikePattern, anyColumnContains } from '../../src/http/likePattern.js';

const COLUMNS = ['name', 'location'];

describe('SCRUM-592 toIlikePattern: layer 1, LIKE', () => {
  it('SCRUM592_AC1_plain_text_is_wrapped_for_contains', () => {
    expect(toIlikePattern('meeting room')).toBe('%meeting room%');
  });

  it.each([
    ['a_percent_sign', '%', String.raw`%\%%`],
    ['an_underscore', '_', String.raw`%\_%`],
    ['a_backslash', '\\', String.raw`%\\%`],
  ])('SCRUM592_AC2_escapes_%s', (_label, text, pattern) => {
    expect(toIlikePattern(text)).toBe(pattern);
  });

  it.each([
    ['a_double_quote', '"'],
    ['a_comma', 'a,b'],
    ['parentheses', '(x)'],
    ['a_period', 'a.b'],
    ['a_colon', 'x:y'],
  ])('SCRUM592_AC2_leaves_%s_alone_since_LIKE_gives_it_no_meaning', (_label, text) => {
    expect(toIlikePattern(text)).toBe(`%${text}%`);
  });

  it('SCRUM592_AC2_leaves_an_asterisk_in_the_pattern_for_the_post_filter', () => {
    // PostgREST reads * as % and no escape survives that, so searchVenues'
    // includes() re-check makes it literal (D3), not the pattern.
    expect(toIlikePattern('a*b')).toBe('%a*b%');
  });

  it('SCRUM592_AC2_escapes_a_mix_in_one_pass', () => {
    expect(toIlikePattern(String.raw`50%_"x\.`)).toBe(String.raw`%50\%\_"x\\.%`);
  });
});

describe('SCRUM-592 anyColumnContains: layer 2, the or=(...) list', () => {
  it('SCRUM592_AC1_matches_each_column_with_one_quoted_value', () => {
    expect(anyColumnContains(COLUMNS, 'meeting')).toBe(
      'name.ilike."%meeting%",location.ilike."%meeting%"',
    );
  });

  it.each([
    ['a_comma', 'a,b', '"%a,b%"'],
    ['parentheses', '(x)', '"%(x)%"'],
    ['a_period', 'a.b', '"%a.b%"'],
    ['a_colon', 'x:y', '"%x:y%"'],
  ])('SCRUM592_AC2_quotes_%s_so_it_is_not_list_syntax', (_label, text, value) => {
    expect(anyColumnContains(COLUMNS, text)).toBe(`name.ilike.${value},location.ilike.${value}`);
  });

  it.each([
    ['a_double_quote', '"', String.raw`"%\"%"`],
    ['a_backslash', '\\', String.raw`"%\\\\%"`],
    ['a_percent_sign', '%', String.raw`"%\\%%"`],
    ['an_underscore', '_', String.raw`"%\\_%"`],
  ])('SCRUM592_AC2_escapes_%s_inside_the_quotes', (_label, text, value) => {
    expect(anyColumnContains(COLUMNS, text)).toBe(`name.ilike.${value},location.ilike.${value}`);
  });

  it('SCRUM592_AC2_escapes_a_mix_through_both_layers', () => {
    const value = String.raw`"%50\\%\\_\"x\\\\.%"`;
    expect(anyColumnContains(COLUMNS, String.raw`50%_"x\.`)).toBe(
      `name.ilike.${value},location.ilike.${value}`,
    );
  });

  it('SCRUM592_AC1_a_single_column_has_no_separator', () => {
    expect(anyColumnContains(['name'], 'hall')).toBe('name.ilike."%hall%"');
  });
});
