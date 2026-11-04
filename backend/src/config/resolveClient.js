/**
 * The Supabase client a service should use: the one its caller supplied,
 * usually a test double, else the shared one.
 *
 * supabaseClient.js throws at import time without credentials, on purpose, so
 * it is imported only when no client was supplied. A module that imports this
 * one, and a test that passes its own client, never needs a .env. ESM caches
 * the import, so production pays for it once.
 */

/** Any falsy client means "use the shared one". */
export async function resolveClient(client) {
  if (client) return client;

  const { supabase } = await import('./supabaseClient.js');
  return supabase;
}

/** Only a missing client (null or undefined) means "use the shared one". */
export async function resolveClientIfMissing(client) {
  return client ?? (await import('./supabaseClient.js')).supabase;
}
