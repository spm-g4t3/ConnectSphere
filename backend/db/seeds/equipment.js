/**
 * Seed demo equipment (SCRUM-281).
 *
 * Run with: npm run equipment:seed
 *
 * Adds a small, realistic equipment catalogue so every availability result can
 * be demonstrated. The usable figure is total minus damaged minus under
 * maintenance:
 *
 *   - most types have plenty usable, so a modest request is fully available
 *   - the projector and the speaker are short, so a larger request is only
 *     partly available
 *   - the video-conference kit has nothing usable, so any request is unavailable
 *   - one legacy type is retired, so the picker's retired filter can be shown
 *
 * Safe to run twice: a type whose name already exists (ignoring capitalisation)
 * is left exactly as it is, so edits made since the first run are not undone.
 * Remove demo rows by retiring them in the app, or by deleting them in the
 * Supabase Table Editor, history rows first.
 *
 * Writes straight to the table, because the service has no way to create a
 * type that already has damaged units.
 */

import { supabase } from '../../src/config/supabaseClient.js';

const DEMO_EQUIPMENT = [
  { name: 'Projector (HD)', description: '4000 lumens, HDMI and VGA', category: 'Display', location: 'Store room 1', total: 8, damaged: 1, maintenance: 1 },
  { name: 'Wireless microphone', description: 'Handheld, with receiver', category: 'Audio', location: 'Store room 1', total: 12, damaged: 2, maintenance: 0 },
  { name: 'Portable speaker', description: 'Battery PA speaker', category: 'Audio', location: 'Store room 2', total: 6, damaged: 0, maintenance: 2 },
  { name: 'Video-conference kit', description: 'Camera, speakerphone and hub', category: 'Conferencing', location: 'Tech office', total: 3, damaged: 1, maintenance: 2 },
  { name: 'Presentation laptop', description: 'Preloaded with slide software', category: 'Computing', location: 'Tech office', total: 10, damaged: 0, maintenance: 0 },
  { name: 'Overhead projector (legacy)', description: 'Retired, kept for past events', category: 'Display', location: 'Store room 2', total: 2, damaged: 0, maintenance: 0, retired: true },
];

/** ilike treats % and _ as wildcards; escape them so a name is matched literally. */
const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

async function main() {
  console.log('\nSeeding demo equipment\n');

  let created = 0;
  let kept = 0;

  for (const item of DEMO_EQUIPMENT) {
    const existing = await supabase
      .from('equipment_types')
      .select('id')
      .ilike('name', escapeLike(item.name))
      .limit(1);
    if (existing.error) throw existing.error;

    if (existing.data.length > 0) {
      console.log(`  kept     ${item.name}`);
      kept += 1;
      continue;
    }

    const { error } = await supabase.from('equipment_types').insert({
      name: item.name,
      description: item.description,
      category: item.category,
      location: item.location,
      total_quantity: item.total,
      damaged_quantity: item.damaged,
      under_maintenance_quantity: item.maintenance,
      retired_at: item.retired ? new Date().toISOString() : null,
    });
    if (error) throw error;

    const usable = item.total - item.damaged - item.maintenance;
    console.log(`  created  ${item.name}  (usable ${usable} of ${item.total}${item.retired ? ', retired' : ''})`);
    created += 1;
  }

  console.log(`\nDone: ${created} created, ${kept} already present.\n`);
}

try {
  await main();
} catch (err) {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
}
