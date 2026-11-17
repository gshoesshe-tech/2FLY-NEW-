import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const required = [
  'REPLACE_WITH_EXISTING_D1_DATABASE_ID',
  'REPLACE_WITH_EXISTING_TRACKER_ORIGIN',
  'REPLACE_WITH_CURRENT_2FLY_SUPABASE_URL'
];
const found = required.filter(value => text.includes(value));
if (found.length) {
  console.error('\nSTOP: Dispatch Worker is not safe to deploy yet.');
  console.error('Fill these existing-production values in dispatch-worker/wrangler.toml first:');
  found.forEach(value => console.error(' - ' + value));
  console.error('Do not create a new D1 or R2 resource. Reuse the existing bindings.\n');
  process.exit(1);
}
console.log('Dispatch Worker config validation passed.');
