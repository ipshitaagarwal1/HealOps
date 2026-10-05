import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import { createPipeline } from '../src/pipeline.js';
import { fallbackDiagnosis } from '../src/diagnose.js';

const incident = { id: 'inc-1', service: 'service-a', alertname: 'HighMemory', alert: { labels: {} } };
const good = { root_cause: 'leak', evidence: 'e', action: 'restart_pod', confidence: 0.9, reasoning: 'r' };
const hit = { id: 7, kind: 'runbook', title: 'Memory leak', similarity: 0.8, recommended_action: 'restart_pod', content: 'c' };

const config = {
  confRestart: 0.8, confScale: 0.75, cooldownMin: 10, maxActionsPerHour: 3,
  noContextPenalty: 0.15, ragMinSimilarity: 0.72, dryRun: false,
};
const NOW = new Date('2026-10-06T12:00:00Z');

function setup({ retrieve, diagnose, history = [], updateFails = false, execute } = {}) {
  const updates = [];
  const audits = [];
  const tickets = [];
  const runs = [];
  const deps = {
    execute: execute ?? (async (a) => { runs.push(a); return { action: a.action, service: a.service, approved_by: a.approvedBy, ok: true, duration_ms: 4 }; }),
    retrieve: retrieve ?? (async () => ({ query: 'q', candidates: [hit], kept: [hit], error: null })),
    diagnose: diagnose ?? (async () => ({ diagnosis: good, attempts: 1 })),
    loadHistory: async () => history,
    config,
    now: () => NOW,
    store: { update: async (id, f) => { if (updateFails) throw new Error('db down'); updates.push(f); } },
    tickets: { create: async (t) => { tickets.push(t); return 42; } },
    audit: async (id, step, detail) => audits.push({ id, step, detail }),
    logger: createLogger({}, { write: () => {} }),
  };
  return { pipeline: createPipeline(deps), updates, audits, tickets, runs };
}

test('happy path: retrieve, diagnose, guardrail, act; incident acted, no ticket', async () => {
  const { pipeline, updates, audits, tickets, runs } = setup();
  await pipeline.run(incident);
  assert.deepEqual(audits.map((a) => a.step), ['retrieve', 'diagnose', 'guardrail', 'act']);
  assert.deepEqual(updates[0].retrieved, [{ id: 7, kind: 'runbook', title: 'Memory leak', similarity: 0.8, recommended_action: 'restart_pod' }]);
  assert.equal(updates[1].status, 'diagnosed');
  assert.deepEqual(updates[1].diagnosis, good);
  assert.equal(updates[2].guardrail.decision, 'execute');
  assert.equal(updates[2].decided_at, NOW);
  assert.deepEqual(runs, [{ action: 'restart_pod', service: 'service-a', approvedBy: 'agent' }]);
  assert.equal(updates[3].status, 'acted');
  assert.ok(updates[3].acted_at instanceof Date);
  assert.equal(tickets.length, 0);
});

test('failed action opens a ticket with reason action_failed', async () => {
  const execute = async (a) => ({ action: a.action, ok: false, error: 'POST /admin/restart timed out after 5000ms', duration_ms: 5000 });
  const { pipeline, updates, audits, tickets } = setup({ execute });
  await pipeline.run(incident);
  assert.deepEqual(tickets[0].reasons, ['action_failed: POST /admin/restart timed out after 5000ms']);
  assert.equal(updates.at(-1).status, 'ticketed');
  assert.ok(!updates.some((u) => u.status === 'acted'));
  assert.deepEqual(audits.map((a) => a.step), ['retrieve', 'diagnose', 'guardrail', 'act', 'ticket']);
});

test('ticket decisions never call execute', async () => {
  const diagnose = async () => ({ diagnosis: { ...good, confidence: 0.5 }, attempts: 1 });
  const { pipeline, runs, tickets } = setup({ diagnose });
  await pipeline.run(incident);
  assert.equal(runs.length, 0);
  assert.match(tickets[0].reasons[0], /^low_confidence:/);
});

test('two incidents for one service: second sees the first action and hits cooldown', async () => {
  const history = [];
  const execute = async (a) => {
    await new Promise((r) => setTimeout(r, 20)); // slow action: the race window
    history.push({ service: a.service, action: a.action, approved_by: a.approvedBy, at: NOW });
    return { action: a.action, ok: true, duration_ms: 20 };
  };
  const { pipeline, tickets } = setup({ execute, history });
  await Promise.all([pipeline.run({ ...incident, id: 'i1' }), pipeline.run({ ...incident, id: 'i2' })]);
  assert.equal(history.length, 1, 'only one action may run');
  assert.match(tickets[0].reasons[0], /^cooldown_active:/);
});

test('llm_error: guardrail tickets the escalation and the ticket keeps the llm_error reason', async () => {
  const diagnose = async () => ({ diagnosis: fallbackDiagnosis('llm_error', 'HTTP 401'), attempts: 1, error: 'HTTP 401' });
  const { pipeline, updates, audits, tickets } = setup({ diagnose });
  await pipeline.run(incident);
  assert.equal(tickets[0].reasons[0], 'llm_error: HTTP 401');
  assert.match(tickets[0].reasons[1], /^escalate:/);
  assert.equal(tickets[0].diagnosis.action, 'escalate');
  assert.equal(updates.at(-1).status, 'ticketed');
  assert.deepEqual(audits.map((a) => a.step), ['retrieve', 'diagnose', 'guardrail', 'ticket']);
});

test('guardrail ticket: recent agent action puts the incident in cooldown', async () => {
  const history = [{ service: 'service-a', action: 'restart_pod', approved_by: 'agent', at: new Date(NOW - 3 * 60000) }];
  const { pipeline, audits, tickets } = setup({ history });
  await pipeline.run(incident);
  assert.match(tickets[0].reasons[0], /^cooldown_active:/);
  const guard = audits.find((a) => a.step === 'guardrail');
  assert.equal(guard.detail.decision, 'ticket');
  assert.equal(guard.detail.recent_actions, 1);
});

test('rollback diagnosis is never executed', async () => {
  const diagnose = async () => ({ diagnosis: { ...good, action: 'rollback_deploy', confidence: 1 }, attempts: 1 });
  const { pipeline, tickets } = setup({ diagnose });
  await pipeline.run(incident);
  assert.match(tickets[0].reasons[0], /^high_risk_action:/);
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
