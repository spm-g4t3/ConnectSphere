import { baselineFiles, createDatabase } from '../../../db/loadSchema.js';

// The final schema, built the way production's is: Supabase's preamble (auth
// schema, auth.users, the three API roles) and then every baseline file. Each
// call returns a fresh in-memory database, so suites never share rows.
export function createSchemaDb() {
  return createDatabase(baselineFiles());
}
