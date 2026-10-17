/**
 * The frontend never queries the database (AGENTS.md); every read goes through
 * Express, which filters on the signed-in user. That is why notifications needs
 * no RLS policies, so a Supabase client added here would bypass that check.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// A path, not `new URL(..., import.meta.url)`: under jsdom URL is jsdom's.
const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every .js/.jsx/.ts/.tsx file under a directory, recursively. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

const IMPORTS_SUPABASE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']@supabase\//;
const CREATES_CLIENT = /\bcreateClient\s*\(/;

describe("no direct database client in the frontend", () => {
  it("SCRUM172_AC8_frontend_has_no_direct_database_client", () => {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.filter((name) => name.startsWith("@supabase/"))).toEqual([]);

    const files = sourceFiles(join(FRONTEND, "src"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((file) => {
      const code = readFileSync(file, "utf8");
      return IMPORTS_SUPABASE.test(code) || CREATES_CLIENT.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("the detectors match a Supabase client and not an API call", () => {
    expect(IMPORTS_SUPABASE.test('import { createClient } from "@supabase/supabase-js";')).toBe(true);
    expect(IMPORTS_SUPABASE.test("const m = await import('@supabase/supabase-js');")).toBe(true);
    expect(CREATES_CLIENT.test("const db = createClient(url, key);")).toBe(true);
    expect(IMPORTS_SUPABASE.test('import { apiFetch } from "./api";')).toBe(false);
    expect(CREATES_CLIENT.test('fetch("/api/notifications")')).toBe(false);
  });
});
