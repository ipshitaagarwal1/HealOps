import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ACTIONS = ['restart_pod', 'scale_up', 'rollback_deploy', 'escalate'];
const KINDS = ['runbook', 'incident'];

const keyOf = (row) => `${row.kind}\u0000${row.title}`;

// Returns a list of problems with one seed entry (empty when valid).
export function seedErrors(entry) {
  const errors = [];
  if (!KINDS.includes(entry?.kind)) errors.push(`kind must be one of ${KINDS.join('|')}`);
  if (typeof entry?.title !== 'string' || !entry.title.trim()) errors.push('title is required');
  if (typeof entry?.content !== 'string' || !entry.content.trim()) errors.push('content is required');
  const action = entry?.recommended_action;
  if (action != null && !ACTIONS.includes(action)) {
    errors.push(`recommended_action must be one of ${ACTIONS.join('|')} or null`);
  }
  return errors;
}

// Read and validate every db/seed/*.json file. Throws listing all problems.
export function loadSeeds(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const seeds = [];
  const problems = [];
  for (const file of files) {
    const entries = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!Array.isArray(entries)) {
      problems.push(`${file}: must contain a JSON array`);
      continue;
    }
    entries.forEach((entry, i) => {
      for (const e of seedErrors(entry)) problems.push(`${file}[${i}]: ${e}`);
      seeds.push({ ...entry, recommended_action: entry.recommended_action ?? null, file });
    });
  }
  const seen = new Set();
  for (const s of seeds) {
    if (seen.has(keyOf(s))) problems.push(`duplicate ${s.kind} title: ${s.title}`);
    seen.add(keyOf(s));
  }
  if (problems.length) throw new Error(`invalid seed data:\n  ${problems.join('\n  ')}`);
  return seeds;
}

// Decide which seeds need (re-)embedding. A row is unchanged only when its text,
// action, and embedding model all match what is already stored.
export function planChanges(seeds, existing, model, { force = false } = {}) {
  const stored = new Map(existing.map((row) => [keyOf(row), row]));
  const toEmbed = [];
  const unchanged = [];
  for (const seed of seeds) {
    const row = stored.get(keyOf(seed));
    const same = row
      && row.content === seed.content
      && (row.recommended_action ?? null) === seed.recommended_action
      && row.embedding_model === model;
    if (same && !force) unchanged.push(seed);
    else toEmbed.push({ ...seed, isNew: !row });
  }
  const seedKeys = new Set(seeds.map(keyOf));
  const extra = existing.filter((row) => !seedKeys.has(keyOf(row)));
  return { toEmbed, unchanged, extra };
}
