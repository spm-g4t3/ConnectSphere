import { beforeAll, afterAll } from 'vitest';

import { createSchemaDb } from '../../db/helpers/schemaDb.js';

// One built schema per test file, opened before its tests and closed after.
// Returns a getter, because the database only exists once beforeAll has run.
export function useSchemaDb() {
  let db;
  beforeAll(async () => {
    db = await createSchemaDb();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  return () => db;
}

/** An enum's labels in the order Postgres holds them. */
export async function enumLabels(db, typeName) {
  const { rows } = await db.query(
    `select e.enumlabel::text as label
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = $1
      order by e.enumsortorder`,
    [typeName],
  );
  if (rows.length === 0) throw new Error(`no enum named ${typeName}`);
  return rows.map((row) => row.label);
}

/** A constraint's definition as Postgres prints it back. */
export async function constraintDef(db, constraintName) {
  const { rows } = await db.query(
    'select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1',
    [constraintName],
  );
  if (rows.length !== 1) throw new Error(`expected one constraint named ${constraintName}, found ${rows.length}`);
  return rows[0].def;
}

/**
 * The values of a `column = ANY (ARRAY[...])` CHECK, in declared order:
 * numbers as numbers, quoted literals with their `::type` cast dropped.
 */
export async function checkListValues(db, constraintName) {
  const def = await constraintDef(db, constraintName);
  const list = def.match(/ARRAY\[([^\]]*)\]/);
  if (!list) throw new Error(`${constraintName} is not a value-list CHECK: ${def}`);
  return list[1].split(',').map((item) => {
    const text = item.trim();
    const quoted = text.match(/^'([^']*)'/);
    return quoted ? quoted[1] : Number(text);
  });
}

/** A column's default expression, or null when it has none. */
export async function columnDefault(db, table, column) {
  const { rows } = await db.query(
    `select column_default as def
       from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  if (rows.length !== 1) throw new Error(`no column ${table}.${column}`);
  return rows[0].def;
}

/** The body of the one public function with this name. */
export async function functionSource(db, name) {
  const { rows } = await db.query(
    `select p.prosrc as src
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`,
    [name],
  );
  if (rows.length !== 1) throw new Error(`expected one function named ${name}, found ${rows.length}`);
  return rows[0].src;
}
