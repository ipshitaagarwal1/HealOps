import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createWebhookHandler } from '../src/webhook.js';

const quiet = createLogger({}, { write: () => {} });

async function withServer(deps, fn) {
  const server = createApp({ logger: quiet, checkHealth: async () => {}, ...deps }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('webhook answers 202 before slow processing finishes', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const store = {
    createIfNotOpen: async (r) => { await slow; return { created: true, id: r.id }; },
    resolveOpen: async () => null,
  };
  const webhook = createWebhookHandler({ store, audit: async () => {}, logger: quiet });
  await withServer({ webhook }, async (base) => {
    const alert = { status: 'firing', fingerprint: 'f', labels: { alertname: 'A', service: 's' } };
    const res = await post(`${base}/webhook/alertmanager`, { alerts: [alert] });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 1 });
    release();
    await webhook.drain();
  });
});

test('webhook rejects bad bodies with 400', async () => {
  const webhook = createWebhookHandler({ store: {}, audit: async () => {}, logger: quiet });
  await withServer({ webhook }, async (base) => {
    assert.equal((await post(`${base}/webhook/alertmanager`, { nope: 1 })).status, 400);
    assert.equal((await post(`${base}/webhook/alertmanager`, '{not json')).status, 400);
  });
});

test('ticket endpoints require the admin token', async () => {
  const ticketService = { approve: async (id) => ({ ticket_id: id, status: 'approved', result: { ok: true } }) };
  await withServer({ webhook: { route: () => {} }, ticketService, adminToken: 'right-token-123456' }, async (base) => {
    const call = (headers, id = 5) => fetch(`${base}/api/tickets/${id}/approve`, { method: 'POST', headers });
    assert.equal((await call({})).status, 401);
    assert.equal((await call({ 'x-admin-token': 'wrong-token-123456' })).status, 401);
    const good = await call({ 'x-admin-token': 'right-token-123456' });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ticket_id, 5);
    assert.equal((await call({ 'x-admin-token': 'right-token-123456' }, 'abc')).status, 400);
  });
});

test('ticket errors map to their HTTP status; failed action is 502', async () => {
  const ticketService = {
    approve: async () => { throw Object.assign(new Error('ticket 5 is rejected, not open'), { status: 409 }); },
    reject: async () => ({ ticket_id: 5, status: 'open', result: { ok: false } }),
  };
  await withServer({ webhook: { route: () => {} }, ticketService, adminToken: 't'.repeat(16) }, async (base) => {
    const headers = { 'x-admin-token': 't'.repeat(16) };
    const res = await fetch(`${base}/api/tickets/5/approve`, { method: 'POST', headers });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /not open/);
    assert.equal((await fetch(`${base}/api/tickets/5/reject`, { method: 'POST', headers })).status, 502);
  });
});

test('ticket endpoints rate-limit after 10 requests in the window', async () => {
  const ticketService = { approve: async (id) => ({ ticket_id: id, status: 'approved', result: { ok: true } }) };
  await withServer({ webhook: { route: () => {} }, ticketService, adminToken: 'right-token-123456' }, async (base) => {
    const headers = { 'x-admin-token': 'right-token-123456' };
    const call = () => fetch(`${base}/api/tickets/5/approve`, { method: 'POST', headers });
    for (let i = 0; i < 10; i += 1) assert.equal((await call()).status, 200);
    const limited = await call();
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
  });
});

test('health returns 503 when the database check fails', async () => {
  const webhook = { route: () => {} };
  await withServer({ webhook, checkHealth: async () => { throw new Error('down'); } }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 503);
  });
});
