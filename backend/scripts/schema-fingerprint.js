// Builds and compares catalog fingerprints (scripts/schema-fingerprint.sql), to
// show that the baseline plus later migrations and the live database define
// the same schema.
//
//   node scripts/schema-fingerprint.js build baseline <out.csv>
//   node scripts/schema-fingerprint.js diff <a.csv> <b.csv> [--ignore kind,kind]
//
// Both run in memory (PGlite); neither touches the live database. The live CSV
// comes from running the .sql file in the Supabase SQL editor.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineFiles, createDatabase } from '../db/loadSchema.js';

const FINGERPRINT_SQL = join(dirname(fileURLToPath(import.meta.url)), 'schema-fingerprint.sql');
const COLUMNS = ['kind', 'name', 'detail'];

export async function fingerprint(db) {
  const { rows } = await db.query(readFileSync(FINGERPRINT_SQL, 'utf8'));
  return rows.map(({ kind, name, detail }) => ({ kind, name, detail: detail ?? '' }));
}

function csvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(rows) {
  const lines = [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((c) => csvField(row[c])).join(','))];
  return `${lines.join('\n')}\n`;
}

// RFC 4180: quoted fields may hold commas, doubled quotes and line breaks.
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // A BOM can lead an exported file; header names locate the columns.
  const header = (records.shift() ?? []).map((name) => name.replace(/^﻿/, '').trim());
  const index = COLUMNS.map((name) => header.indexOf(name));
  if (index.includes(-1)) {
    throw new Error(`CSV header must contain ${COLUMNS.join(',')}; got ${header.join(',')}`);
  }
  return records
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => ({ kind: r[index[0]], name: r[index[1]], detail: r[index[2]] ?? '' }));
}

export function diffRows(a, b, { ignore = [] } = {}) {
  const keyed = (rows) =>
    new Map(rows.filter((r) => !ignore.includes(r.kind)).map((r) => [`${r.kind}\u0000${r.name}`, r]));
  const left = keyed(a);
  const right = keyed(b);
  const onlyA = [];
  const onlyB = [];
  const changed = [];
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other) onlyA.push(row);
    else if (other.detail !== row.detail) changed.push({ kind: row.kind, name: row.name, a: row.detail, b: other.detail });
  }
  for (const [key, row] of right) {
    if (!left.has(key)) onlyB.push(row);
  }
  return { onlyA, onlyB, changed };
}

function printDiff({ onlyA, onlyB, changed }, aName, bName) {
  const show = (title, rows, line) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const row of rows) console.log(line(row));
  };
  show(`Only in ${aName}`, onlyA, (r) => `  ${r.kind}  ${r.name}  ${r.detail}`);
  show(`Only in ${bName}`, onlyB, (r) => `  ${r.kind}  ${r.name}  ${r.detail}`);
  show('Changed', changed, (r) => `  ${r.kind}  ${r.name}\n    a: ${r.a}\n    b: ${r.b}`);
}

const SOURCES = { baseline: baselineFiles };

async function main([command, ...args]) {
  if (command === 'build' && SOURCES[args[0]] && args[1]) {
    const db = await createDatabase(SOURCES[args[0]]());
    try {
      const rows = await fingerprint(db);
      writeFileSync(resolve(args[1]), toCsv(rows));
      console.log(`${rows.length} rows written to ${args[1]}`);
    } finally {
      await db.close();
    }
    return 0;
  }
  if (command === 'diff' && args.length >= 2) {
    const flag = args.indexOf('--ignore');
    const ignore = flag === -1 ? [] : (args[flag + 1] ?? '').split(',').filter(Boolean);
    const [aPath, bPath] = args;
    const result = diffRows(parseCsv(readFileSync(aPath, 'utf8')), parseCsv(readFileSync(bPath, 'utf8')), {
      ignore,
    });
    printDiff(result, aPath, bPath);
    return result.onlyA.length + result.onlyB.length + result.changed.length > 0 ? 1 : 0;
  }
  console.error(
    'Usage:\n  node scripts/schema-fingerprint.js build baseline <out.csv>\n' +
      '  node scripts/schema-fingerprint.js diff <a.csv> <b.csv> [--ignore kind,kind]',
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
