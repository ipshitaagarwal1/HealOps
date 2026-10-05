import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import { createPipeline } from '../src/pipeline.js';
import { fallbackDiagnosis } from '../src/diagnose.js';

const incident = { id: 'inc-1', service: 'service-a', alertname: 'HighMemory', alert: { labels: {} } };
const good = { root_cause: 'leak', evidence: 'e', action: 'restart_pod', confidence: 0.9, reasoning: 'r' };
const hit = { id: 7, kind: 'runbook', title: 'Memory leak', similarity: 0.8, recommended_action: 'restart_pod', content: 'c' };

function setup({ retrieve, diagnose, updateFails = false } = {}) {
  const updates = [];
  const audits = [];
  const tickets = [];
  const deps = {
    retrieve: retrieve ?? (async () => ({ query: 'q', candidates: [hit], kept: [hit], error: null })),
    diagnose: diagnose ?? (async () => ({ diagnosis: good, attempts: 1 })),
    store: { update: async (id, f) => { if (updateFails) throw new Error('db down'); updates.push(f); } },
    tickets: { create: async (t) => { tickets.push(t); return 42; } },
    audit: async (id, step, detail) => audits.push({ id, step, detail }),
    logger: createLogger({}, { write: () => {} }),
  };
  return { pipeline: createPipeline(deps), updates, audits, tickets };
}

test('happy path: retrieve and diagnose are stored and audited, no ticket', async () => {
  const { pipeline, updates, audits, tickets } = setup();
  await pipeline.run(incident);
  assert.deepEqual(audits.map((a) => a.step), ['retrieve', 'diagnose']);
  assert.deepEqual(updates[0].retrieved, [{ id: 7, kind: 'runbook', title: 'Memory leak', similarity: 0.8, recommended_action: 'restart_pod' }]);
  assert.equal(updates[1].status, 'diagnosed');
  assert.deepEqual(updates[1].diagnosis, good);
  assert.equal(tickets.length, 0);
});

test('llm_error: ticket opened with reason llm_error and incident ticketed', async () => {
  const diagnose = async () => ({ diagnosis: fallbackDiagnosis('llm_error', 'HTTP 401'), attempts: 1, error: 'HTTP 401' });
  const { pipeline, updates, audits, tickets } = setup({ diagnose });
  await pipeline.run(incident);
  assert.deepEqual(tickets[0].reasons, ['llm_error']);
  assert.equal(tickets[0].diagnosis.action, 'escalate');
  assert.equal(updates.at(-1).status, 'ticketed');
  assert.ok(updates.at(-1).decided_at instanceof Date);
  assert.deepEqual(audits.map((a) => a.step), ['retrieve', 'diagnose', 'ticket']);
});

test('embedding failure: continues with no context and audits the error', async () => {
  const retrieve = async () => ({ query: 'q', candidates: [], kept: [], error: 'embedding HTTP 500' });
  let seen;
  const diagnose = async (args) => { seen = args; return { diagnosis: good, attempts: 1 }; };
  const { pipeline, audits } = setup({ retrieve, diagnose });
  await pipeline.run(incident);
  assert.deepEqual(seen.retrieved, []);
  assert.equal(audits[0].detail.error, 'embedding HTTP 500');
  assert.equal(audits[1].step, 'diagnose');
});

test('unexpected error: audited as error, never throws', async () => {
  const { pipeline, audits } = setup({ updateFails: true });
  await pipeline.run(incident);
  assert.equal(audits.at(-1).step, 'error');
  assert.equal(audits.at(-1).detail.message, 'db down');
});
