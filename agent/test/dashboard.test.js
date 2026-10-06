import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createDashboardRouter } from '../src/dashboard.js';
import { createEvents } from '../src/events.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';

const quiet = createLogger({}, { write: () => {} });
const ID = '11111111-2222-4333-8444-555555555555';
const T0 = new Date('2026-10-06T12:00:00Z');
const plus = (s) => new Date(T0.getTime() + s * 1000);

// Answers each query by matching a fragment of its SQL.
function fakePool(routes) {
  return {
    query: async (sql, params) => {
      for (const [fragment, fn] of routes) if (sql.includes(fragment)) return { rows: fn(params) };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function withServer({ pool, events = createEvents(), metrics }, fn) {
  const dashboard = createDashboardRouter({ pool, events, logger: quiet });
  const app = createApp({ webhook: { route: () => {} }, checkHealth: async () => {}, logger: quiet, dashboard, metrics });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, events);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const incidentRow = { id: ID, service: 'service-a', alertname: 'HighErrorRate', status: 'resolved',
  fired_at: T0, received_at: plus(8), decided_at: plus(11), acted_at: plus(11.2), resolved_at: plus(30) };

test('GET / serves the dashboard page', async () => {
  await withServer({ pool: fakePool([]) }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /new EventSource\('\/events'\)/);
  });
});

test('GET /api/incidents adds per-incident latencies and clamps the limit', async () => {
  let limit;
  const pool = fakePool([['FROM incidents ORDER BY', (p) => { limit = p[0]; return [incidentRow]; }]]);
  await withServer({ pool }, async (base) => {
    const rows = await (await fetch(`${base}/api/incidents?limit=5000`)).json();
    assert.equal(limit, 200);
    assert.deepEqual(rows[0].latency_s, { detection_lag: 8, decision_time: 3, time_to_action: 11.2, time_to_recovery: 30 });
  });
});

test('GET /api/incidents/:id returns the audit trail; bad id 400; missing 404', async () => {
  const pool = fakePool([
    ['FROM incidents WHERE id', (p) => (p[0] === ID ? [incidentRow] : [])],
    ['FROM audit_log', () => [{ id: 1, step: 'webhook', detail: {}, duration_ms: 7 }]],
    ['FROM tickets WHERE incident_id', () => []],
  ]);
  await withServer({ pool }, async (base) => {
    const inc = await (await fetch(`${base}/api/incidents/${ID}`)).json();
    assert.equal(inc.audit[0].step, 'webhook');
    assert.equal(inc.latency_s.time_to_recovery, 30);
    assert.equal((await fetch(`${base}/api/incidents/not-a-uuid`)).status, 400);
    assert.equal((await fetch(`${base}/api/incidents/${ID.replace('1', '9')}`)).status, 404);
  });
});

test('GET /api/tickets passes only known status filters', async () => {
  const seen = [];
  const pool = fakePool([['FROM tickets t', (p) => { seen.push(p[0]); return []; }]]);
  await withServer({ pool }, async (base) => {
    await fetch(`${base}/api/tickets?status=open`);
    await fetch(`${base}/api/tickets?status=x' OR 1=1`);
    assert.deepEqual(seen, ['open', null]);
  });
});

test('GET /api/stats returns median and p95 per latency', async () => {
  const pool = fakePool([['LIMIT $1', () => [incidentRow]]]);
  await withServer({ pool }, async (base) => {
    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.window, 1);
    assert.deepEqual(s.stats.detection_lag, { n: 1, median_s: 8, p95_s: 8 });
  });
});

test('GET /events streams audit events as SSE', async () => {
  await withServer({ pool: fakePool([]) }, async (base, events) => {
    const res = await fetch(`${base}/events`);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    events.publish({ incident_id: ID, step: 'diagnose', detail: { action: 'restart_pod' } });
    while (!text.includes('event: audit')) text += decoder.decode((await reader.read()).value);
    const data = JSON.parse(text.split('event: audit\ndata: ')[1].split('\n')[0]);
    assert.equal(data.step, 'diagnose');
    await reader.cancel();
  });
});

test('GET /metrics exposes the agent histograms', async () => {
  const metrics = createMetrics();
  metrics.observeStage('retrieve', 900);
  await withServer({ pool: fakePool([]), metrics }, async (base) => {
    const text = await (await fetch(`${base}/metrics`)).text();
    assert.match(text, /agent_stage_duration_seconds_bucket\{le="1",stage="retrieve"\} 1/);
  });
});
