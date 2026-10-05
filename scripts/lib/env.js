import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env from the repo root. Values already in the environment win.
export function loadEnv() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

// Returns the named variables, or exits listing every missing one (names only).
export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`missing required settings in .env: ${missing.join(', ')}`);
    process.exit(1);
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]]));
}
