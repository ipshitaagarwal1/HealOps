import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import { createWebhookHandler, parseAlert, validatePayload } from '../src/webhook.js';

const NOW = new Date('2026-10-06T12:00:00Z');

const alert = (over = {}) => ({
  status: 'firing',
  fingerprint: 'fp1',
  labels: { alertname: 'HighErrorRate', service: 'service-a', severity: 'critical' },
  startsAt: '2026-10-06T11:59:00Z',
  endsAt: '0001-01-01T00:00:00Z',
  ...over,
});

// In-memory stand-in for incidents.js with the same open/dedupe semantics.
function fakeStore() {
  const rows = [];
  return {
    rows,
    async createIfNotOpen(r) {
      const open = rows.find((x) => x.fingerprint === r.fingerprint && !x.resolvedAt);
      if (open) return { created: false, id: open.id };
      rows.push({ ...r });
      return { created: true, id: r.id };
    },
    async resolveOpen({ fingerprint, resolvedAt }) {
      const open = rows.find((x) => x.fingerprint === fingerprint && !x.resolvedAt);
      if (!open) return null;
      open.resolvedAt = resolvedAt;
      return { id: open.id, firedAt: open.firedAt };
    },
  };
}

function setup(store = fakeStore()) {
  const audits = [];
  const logs = [];
  const logger = createLogger({}, { write: (s) => logs.push(JSON.parse(s)) });
  const audit = async (incidentId, step, detail, ms) => audits.push({ incidentId, step, detail, ms });
  const handler = createWebhookHandler({ store, audit, logger, now: () => NOW });
  return { store, audits, logs, handler };
}

test('validatePayload requires an alerts array', () => {
  assert.equal(validatePayload({ alerts: [] }), null);
  assert.ok(validatePayload(null));
  assert.ok(validatePayload({ alerts: 'x' }));
});

test('parseAlert extracts fields and treats 0001-01-01 as unset', () => {
  const a = parseAlert(alert());
  assert.equal(a.ok, true);
  assert.equal(a.service, 'service-a');
  assert.equal(a.startsAt.toISOString(), '2026-10-06T11:59:00.000Z');
  assert.equal(a.endsAt, null);
});

test('parseAlert rejects alerts the agent cannot act on', () => {
  assert.equal(parseAlert(alert({ labels: { alertname: 'X' } })).reason, 'missing service label');
  assert.equal(parseAlert(alert({ fingerprint: '' })).reason, 'missing fingerprint');
  assert.equal(parseAlert(alert({ status: 'weird' })).ok, false);
});

test('firing alert opens an incident and writes a webhook audit row', async () => {
  const { store, audits, handler } = setup();
  await handler.processPayload({ alerts: [alert()] });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].firedAt.toISOString(), '2026-10-06T11:59:00.000Z');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].step, 'webhook');
  assert.equal(audits[0].incidentId, store.rows[0].id);
});

test('repeat of an open alert creates nothing and logs with the open incident id', async () => {
  const { store, audits, logs, handler } = setup();
  await handler.processPayload({ alerts: [alert()] });
  await handler.processPayload({ alerts: [alert()] });
  assert.equal(store.rows.length, 1);
  assert.equal(audits.length, 1);
  const repeat = logs.find((l) => l.msg.startsWith('alert repeat ignored'));
  assert.equal(repeat.incident_id, store.rows[0].id);
});

test('resolved alert closes the incident at endsAt; a new firing then opens a new one', async () => {
  const { store, audits, handler } = setup();
  await handler.processPayload({ alerts: [alert()] });
  await handler.processPayload({ alerts: [alert({ status: 'resolved', endsAt: '2026-10-06T11:59:45Z' })] });
  assert.equal(store.rows[0].resolvedAt.toISOString(), '2026-10-06T11:59:45.000Z');
  assert.equal(audits[1].step, 'resolve');
  assert.equal(audits[1].detail.time_to_recovery_ms, 45000);
  await handler.processPayload({ alerts: [alert()] });
  assert.equal(store.rows.length, 2);
});

test('resolved alert with no open incident does nothing', async () => {
  const { audits, handler } = setup();
  await handler.processPayload({ alerts: [alert({ status: 'resolved' })] });
  assert.equal(audits.length, 0);
});

test('a store failure on one alert is logged and the next alert still runs', async () => {
  const store = fakeStore();
  const real = store.createIfNotOpen;
  let calls = 0;
  store.createIfNotOpen = async (r) => (++calls === 1 ? Promise.reject(new Error('db down')) : real(r));
  const { logs, handler } = setup(store);
  await handler.processPayload({ alerts: [alert(), alert({ fingerprint: 'fp2' })] });
  assert.ok(logs.some((l) => l.level === 'error' && l.err.message === 'db down'));
  assert.equal(store.rows.length, 1);
});

test('bad alerts are skipped with a warning', async () => {
  const { logs, handler } = setup();
  await handler.processPayload({ alerts: [alert({ labels: { alertname: 'X' } })] });
  assert.ok(logs.some((l) => l.level === 'warn' && l.reason === 'missing service label'));
});
