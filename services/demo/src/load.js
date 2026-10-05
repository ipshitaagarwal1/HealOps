// Load generator: hits each target on a fixed interval so error rates are measurable.
// Requests are fire-and-forget so a slow (latency-faulted) target doesn't throttle load.
import { writeFileSync } from 'node:fs';
import { log } from './log.js';

const TARGETS = (process.env.LOAD_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Number(process.env.LOAD_INTERVAL_MS || 100);
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS || 5000);
const HEARTBEAT_FILE = '/tmp/loadgen-heartbeat';

if (TARGETS.length === 0) {
  log('error', 'LOAD_TARGETS is empty');
  process.exit(1);
}

const counts = Object.fromEntries(TARGETS.map((t) => [t, { ok: 0, fail: 0, error: 0 }]));

async function hit(target) {
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer();
    counts[target][res.ok ? 'ok' : 'fail'] += 1;
  } catch {
    counts[target].error += 1;
  }
}

setInterval(() => {
  for (const t of TARGETS) hit(t);
  try {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    // heartbeat is best effort; the healthcheck will notice if it stops
  }
}, INTERVAL_MS);

setInterval(() => {
  log('info', 'load summary (last 30s)', { counts });
  for (const c of Object.values(counts)) Object.assign(c, { ok: 0, fail: 0, error: 0 });
}, 30000);

log('info', 'load generator started', { targets: TARGETS, interval_ms: INTERVAL_MS });
process.on('SIGTERM', () => process.exit(0));
