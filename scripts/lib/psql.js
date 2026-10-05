// Run SQL through psql inside the postgres container (`docker compose exec`).
// No npm dependencies and no Postgres port published on the host.
import { spawnSync } from 'node:child_process';
import { ROOT } from './env.js';

export function dbFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  return { user: decodeURIComponent(url.username), database: url.pathname.slice(1) };
}

export function runSql(sql, { user, database, timeoutMs = 60000 }) {
  const args = ['compose', 'exec', '-T', 'postgres',
    'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database];
  const res = spawnSync('docker', args, {
    cwd: ROOT, input: sql, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run docker: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`psql failed (exit ${res.status}): ${res.stderr.trim() || 'is the postgres container running?'}`);
  }
  return res.stdout;
}

// SQL string literal. standard_conforming_strings is on (Postgres default), so only
// single quotes need escaping.
export function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value);
  if (s.includes('\0')) throw new Error('text contains a NUL byte');
  return `'${s.replaceAll("'", "''")}'`;
}

export function sqlVector(values) {
  if (!values.every(Number.isFinite)) throw new Error('vector contains a non-finite number');
  return `'[${values.join(',')}]'::vector`;
}
