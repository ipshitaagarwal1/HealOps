import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createHealthRouter } from '../src/health.js';
import { createLogger } from '../src/logger.js';
import { createOutageSwitch } from '../src/outage.js';

const quiet = createLogger({}, { write: () => {} });

const baseConfig = {
  adminToken: 'right-token-123456',
  actionTargets: Object.freeze({ 'service-a': 'http://service-a:8080', 'service-b': 'http://service-b:8080' }),
  actionTimeoutMs: 2000,
  prometheusUrl: 'http://prom:9090',
};

async function withServer({ config = baseConfig, fetchImpl, outageSwitch }, fn) {
  const health = createHealthRouter({ config, logger: quiet, fetchImpl, outageSwitch });
  const app = createApp({ webhook: { route: () => {} }, checkHealth: async () => {}, logger: quiet, health, adminToken: config.adminToken });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function promFetch({ errorRate = '0', latency = '0.1', memory = String(100 * 1024 * 1024) } = {}) {
  return async (url) => {
    if (url.includes('/admin/state')) return { ok: true, json: async () => ({ mode: 'none' }) };
    const u = new URL(url);
    const query = u.searchParams.get('query') || '';
    const isRange = url.includes('query_range');
    const value = query.includes('status=~"5..') ? errorRate : query.includes('histogram_quantile') ? latency : memory;
    const data = isRange
      ? { result: [{ metric: {}, values: [[Math.floor(Date.now() / 1000), value]] }] }
      : { result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), value] }] };
    return { ok: true, json: async () => ({ status: 'success', data }) };
  };
}

test('GET /api/health/services returns per-service status from the Prometheus proxy', async () => {
  await withServer({ fetchImpl: promFetch() }, async (base) => {
    const rows = await (await fetch(`${base}/api/health/services`)).json();
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.service === 'service-a');
    assert.equal(a.status, 'healthy');
    assert.equal(a.error_rate, 0);
    assert.ok(Array.isArray(a.sparklines.error_rate));
  });
});

test('GET /api/health/services marks a service down on a high error rate', async () => {
  await withServer({ fetchImpl: promFetch({ errorRate: '0.9' }) }, async (base) => {
    const rows = await (await fetch(`${base}/api/health/services`)).json();
    assert.equal(rows.find((r) => r.service === 'service-a').status, 'down');
  });
});

test('GET /api/health/services degrades the card when a fault is active', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/admin/state')) return { ok: true, json: async () => ({ mode: 'latency' }) };
    return promFetch()(url);
  };
  await withServer({ fetchImpl }, async (base) => {
    const rows = await (await fetch(`${base}/api/health/services`)).json();
    assert.equal(rows.find((r) => r.service === 'service-a').status, 'degraded');
    assert.equal(rows.find((r) => r.service === 'service-a').fault_mode, 'latency');
  });
});

test('GET /api/health/services survives Prometheus being unreachable', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/admin/state')) return { ok: true, json: async () => ({ mode: 'none' }) };
    throw new Error('ECONNREFUSED');
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/health/services`);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.equal(rows.find((r) => r.service === 'service-a').error_rate, null);
  });
});

test('POST /api/fault/:service requires the admin token', async () => {
  await withServer({ fetchImpl: promFetch() }, async (base) => {
    const res = await fetch(`${base}/api/fault/service-a`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'error' }),
    });
    assert.equal(res.status, 401);
  });
});

test('POST /api/fault/:service forwards to the service admin endpoint with the admin token', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/admin/fault')) { seen = { url, opts }; return { ok: true, json: async () => ({ mode: 'error', rate: 0.9 }) }; }
    return promFetch()(url);
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/fault/service-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': baseConfig.adminToken },
      body: JSON.stringify({ action: 'error' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.url, 'http://service-a:8080/admin/fault');
    assert.equal(seen.opts.headers['x-admin-token'], baseConfig.adminToken);
    assert.deepEqual(JSON.parse(seen.opts.body), { mode: 'error', rate: 0.9 });
  });
});

test('POST /api/fault/:service heal calls /admin/restart', async () => {
  let path;
  const fetchImpl = async (url) => {
    if (url.includes('/admin/restart')) { path = url; return { ok: true, json: async () => ({ restarted: true }) }; }
    return promFetch()(url);
  };
  await withServer({ fetchImpl }, async (base) => {
    const res = await fetch(`${base}/api/fault/service-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': baseConfig.adminToken },
      body: JSON.stringify({ action: 'heal' }),
    });
    assert.equal(res.status, 200);
    assert.equal(path, 'http://service-a:8080/admin/restart');
  });
});

test('POST /api/fault/:service rejects unknown service and unknown action', async () => {
  await withServer({ fetchImpl: promFetch() }, async (base) => {
    const headers = { 'Content-Type': 'application/json', 'x-admin-token': baseConfig.adminToken };
    const unknownService = await fetch(`${base}/api/fault/service-z`, { method: 'POST', headers, body: JSON.stringify({ action: 'error' }) });
    assert.equal(unknownService.status, 404);
    const unknownAction = await fetch(`${base}/api/fault/service-a`, { method: 'POST', headers, body: JSON.stringify({ action: 'nope' }) });
    assert.equal(unknownAction.status, 400);
  });
});

test('POST /api/fault/:service is rate limited', async () => {
  await withServer({ fetchImpl: promFetch() }, async (base) => {
    const headers = { 'Content-Type': 'application/json', 'x-admin-token': baseConfig.adminToken };
    const call = () => fetch(`${base}/api/fault/service-a`, { method: 'POST', headers, body: JSON.stringify({ action: 'heal' }) });
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await call()).status);
    assert.ok(results.includes(429), `expected a 429 among: ${results}`);
  });
});

test('GET /api/debug/outage reports whether the next diagnosis is armed to fail', async () => {
  const outageSwitch = createOutageSwitch();
  await withServer({ fetchImpl: promFetch(), outageSwitch }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/debug/outage`)).json(), { armed: false });
    outageSwitch.arm();
    assert.deepEqual(await (await fetch(`${base}/api/debug/outage`)).json(), { armed: true });
  });
});

test('GET /api/debug/outage 404s when the route was never wired (no outageSwitch)', async () => {
  await withServer({ fetchImpl: promFetch() }, async (base) => {
    assert.equal((await fetch(`${base}/api/debug/outage`)).status, 404);
  });
});

test('POST /api/debug/simulate-outage requires the admin token and arms the switch', async () => {
  const outageSwitch = createOutageSwitch();
  await withServer({ fetchImpl: promFetch(), outageSwitch }, async (base) => {
    const unauthorised = await fetch(`${base}/api/debug/simulate-outage`, { method: 'POST' });
    assert.equal(unauthorised.status, 401);
    assert.equal(outageSwitch.armed, false);

    const res = await fetch(`${base}/api/debug/simulate-outage`, { method: 'POST', headers: { 'x-admin-token': baseConfig.adminToken } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { armed: true });
    assert.equal(outageSwitch.armed, true);
  });
});

test('POST /api/debug/simulate-outage shares the demo-control rate limiter', async () => {
  const outageSwitch = createOutageSwitch();
  await withServer({ fetchImpl: promFetch(), outageSwitch }, async (base) => {
    const headers = { 'x-admin-token': baseConfig.adminToken };
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await fetch(`${base}/api/debug/simulate-outage`, { method: 'POST', headers })).status);
    assert.ok(results.includes(429), `expected a 429 among: ${results}`);
  });
});
