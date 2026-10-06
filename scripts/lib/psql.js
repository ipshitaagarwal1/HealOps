// Run SQL against Postgres. On the host (local dev) this shells out to `docker compose
// exec`: no npm dependencies and no Postgres port published. Inside a container on the
// compose network (docker compose run --rm seed - see scripts/Dockerfile) there is no
// docker CLI to exec through, but postgres:5432 is directly reachable, so this connects
// straight there with the psql client instead.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ROOT } from './env.js';

// Standard marker file for "this process is inside a Docker container".
const IN_CONTAINER = existsSync('/.dockerenv');

export function dbFromUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  return { user: decodeURIComponent(url.username), database: url.pathname.slice(1), url: databaseUrl };
}

export function runSql(sql, { user, database, url: databaseUrl, timeoutMs = 60000 }) {
  const [cmd, args] = IN_CONTAINER
    ? ['psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', databaseUrl]]
    : ['docker', ['compose', 'exec', '-T', 'postgres',
        'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database]];
  const res = spawnSync(cmd, args, {
    cwd: ROOT, input: sql, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`psql failed (exit ${res.status}): ${res.stderr.trim() || 'is postgres reachable?'}`);
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
