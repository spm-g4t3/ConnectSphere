/**
 * Comma-separated code lists in a query string.
 *
 * Lifted out of routes/venues.js (SCRUM-140, for SCRUM-20) by SCRUM-190, so
 * the venue suitability check reads ?accessibility=a,b&facilities=x,y exactly
 * as the event search does. Two copies would be two places for "a,,b" or a
 * repeated key to start meaning different things.
 *
 * Imports nothing, so any router can use it without reaching the Supabase
 * client.
 */

/**
 * Split comma-separated codes into one list, for accessibility and facilities.
 *
 * Why commas: axios's default serialisation of an array param is `key[]=a&
 * key[]=b`, and Express 5's default query parser ('simple', which is Node's
 * querystring.parse -- express/lib/application.js sets it, utils.js
 * compileQueryParser maps it) keeps that as a key literally named 'key[]', so
 * req.query.key would be undefined and the criterion silently lost. A single
 * `key=a,b` survives any client and any parser, and codes never contain
 * commas. A repeated `key=a&key=b`, which querystring.parse does turn into an
 * array, is accepted too and split the same way.
 *
 * Blank pieces are dropped (`a,,b`, a trailing comma, an untouched field), and
 * if nothing is left the result is undefined so the caller leaves the key out
 * -- the validator treats a missing list as "not filtered on".
 *
 * Only strings are split. Anything else -- a non-string array entry, or an
 * object a different query parser might build -- is passed through as it
 * came, so validateEventSearchCriteria (or validateSuitabilityQuery) reports it ("must be an array of
 * codes", "entry N must be a non-empty code") rather than this quietly
 * dropping it. The simple parser only produces strings, so in production that
 * is a guard, not a path.
 */
export function parseCodeList(value) {
  if (typeof value !== 'string' && !Array.isArray(value)) return value;

  const pieces = typeof value === 'string' ? [value] : value;
  const codes = pieces.flatMap((piece) =>
    typeof piece === 'string'
      ? piece.split(',').map((code) => code.trim()).filter((code) => code !== '')
      : [piece],
  );

  return codes.length > 0 ? codes : undefined;
}
