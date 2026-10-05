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

test('health returns 503 when the database check fails', async () => {
  const webhook = { route: () => {} };
  await withServer({ webhook, checkHealth: async () => { throw new Error('down'); } }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 503);
  });
});
