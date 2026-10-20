/**
 * Small readers for rows PostgREST returns, shared by the services.
 */

/**
 * PostgREST embeds a many-to-one as an object, but an array if it were ever
 * read as one-to-many. Read defensively.
 *
 * @param {object|object[]|null|undefined} embedded
 * @returns {object|undefined|null}
 */
export function one(embedded) {
  return Array.isArray(embedded) ? embedded[0] : embedded;
}

/**
 * Names for people, by id. A person with no name gets null.
 *
 * @param {object} db  the Supabase client
 * @param {Array<string|null|undefined>} ids  blanks and repeats are dropped
 * @param {(error: object) => Error} translateError  the calling service's translator
 * @returns {Promise<Map<string, string|null>>}
 */
export async function readNames(db, ids, translateError) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await db.from('profiles').select('id, full_name').in('id', unique);
  if (error) throw translateError(error);

  return new Map((data ?? []).map((row) => [row.id, row.full_name ?? null]));
}
