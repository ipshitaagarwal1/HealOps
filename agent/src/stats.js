// Latency stats (docs/SPEC.md section 7): median and p95 over the last 50 incidents.
//   detection lag    received_at - fired_at   (alert firing -> agent has it)
//   decision time    decided_at  - received_at (agent has it -> guardrail decided)
//   time to action   acted_at    - fired_at   (includes human approval time if approved)
//   time to recovery resolved_at - fired_at

export const LATENCIES = {
  detection_lag: ['fired_at', 'received_at'],
  decision_time: ['received_at', 'decided_at'],
  time_to_action: ['fired_at', 'acted_at'],
  time_to_recovery: ['fired_at', 'resolved_at'],
};

const toMs = (d) => (d ? new Date(d).getTime() : NaN);

// Per-incident latencies in seconds (null when a timestamp is missing).
export function latenciesOf(incident) {
  const out = {};
  for (const [name, [from, to]] of Object.entries(LATENCIES)) {
    const s = (toMs(incident[to]) - toMs(incident[from])) / 1000;
    out[name] = Number.isFinite(s) ? Math.round(s * 1000) / 1000 : null;
  }
  return out;
}

// Linear interpolation between closest ranks (same as Postgres percentile_cont).
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(value * 1000) / 1000;
}

export function summarize(incidents) {
  const stats = {};
  for (const name of Object.keys(LATENCIES)) {
    const values = incidents.map((i) => latenciesOf(i)[name]).filter((v) => v !== null).sort((a, b) => a - b);
    stats[name] = { n: values.length, median_s: percentile(values, 0.5), p95_s: percentile(values, 0.95) };
  }
  return { window: incidents.length, stats };
}

const RECENT_SQL = `
SELECT fired_at, received_at, decided_at, acted_at, resolved_at
FROM incidents ORDER BY received_at DESC LIMIT $1`;

export async function loadStats(pool, limit = 50) {
  const { rows } = await pool.query(RECENT_SQL, [limit]);
  return summarize(rows);
}
