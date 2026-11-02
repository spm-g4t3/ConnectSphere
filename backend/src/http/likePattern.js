/**
 * "Contains this text" filters for PostgREST's ilike (SCRUM-592).
 *
 * What a person types reaches Postgres through up to two parsers, so it is
 * escaped in two layers, innermost first:
 *
 *   1. LIKE. % and _ are wildcards, and \ is LIKE's escape character (the
 *      Postgres default), so each gets a \ in front: 50% becomes 50\%, which
 *      matches only a literal "50%". The result is wrapped in %...% for
 *      "contains".
 *   2. PostgREST's or=(...) list. Commas, parentheses, periods and colons are
 *      its syntax, so each value is wrapped in double quotes, and inside them
 *      " and \ get a \ in front. Layer 1's backslashes are doubled again here.
 *
 * A plain .ilike(column, pattern) is one query parameter whose value PostgREST
 * reads verbatim, so it needs layer 1 only (toIlikePattern). A value inside
 * .or() needs both (anyColumnContains). For the text 50%_"x\. :
 *
 *   layer 1   %50\%\_"x\\.%
 *   layer 2   "%50\\%\\_\"x\\\\.%"
 *
 * * is left as typed. PostgREST rewrites every * in a like pattern as %
 * before Postgres sees it, and no escape survives that (\* would become \%, a
 * literal percent), so the pattern over-matches on *. searchVenues re-checks
 * each row with includes() for q, which makes * literal there (SCRUM-592 D3).
 *
 * Pure, like pgErrors.js: it builds strings and never reaches the client.
 */

/** LIKE's own metacharacters, each escaped with LIKE's default escape, \. */
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * An ilike pattern matching any value that contains `text`, every character
 * of it taken literally.
 *
 * @param {string} text  already trimmed and non-blank (the validator's job)
 * @returns {string}
 */
export function toIlikePattern(text) {
  return `%${escapeLike(text)}%`;
}

/** A value quoted for a PostgREST logic list: " and \ escaped, then wrapped. */
function quoteForLogicList(value) {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

/**
 * The .or() filter for "any of these columns contains `text`", ignoring case.
 *
 * @param {string[]} columns  column names: ours, never user input
 * @param {string} text       already trimmed and non-blank
 * @returns {string} e.g. name.ilike."%hall%",location.ilike."%hall%"
 */
export function anyColumnContains(columns, text) {
  const value = quoteForLogicList(toIlikePattern(text));
  return columns.map((column) => `${column}.ilike.${value}`).join(',');
}
