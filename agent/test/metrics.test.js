import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudit } from '../src/audit.js';
import { createEvents } from '../src/events.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';

test('audit steps with a duration feed agent_stage_duration_seconds', async () => {
  const metrics = createMetrics();
  const pool = { query: async () => ({ rows: [{ id: 1, at: new Date() }] }) };
  const audit = createAudit({ pool, events: createEvents(), logger: createLogger({}, { write: () => {} }), metrics });
  await audit('inc', 'diagnose', {}, 1500);
  await audit('inc', 'ticket', { status: 'rejected' }); // no duration: not observed
  const text = await metrics.registry.metrics();
  assert.match(text, /agent_stage_duration_seconds_count\{stage="diagnose"\} 1/);
  assert.match(text, /agent_stage_duration_seconds_sum\{stage="diagnose"\} 1\.5/);
  assert.doesNotMatch(text, /stage="ticket"/);
});

test('decisions are counted by action and decision; unknown actions share one label', async () => {
  const metrics = createMetrics();
  metrics.countDecision('restart_pod', 'execute');
  metrics.countDecision('restart_pod', 'execute');
  metrics.countDecision('delete_everything', 'ticket');
  const text = await metrics.registry.metrics();
  assert.match(text, /agent_decisions_total\{action="restart_pod",decision="execute"\} 2/);
  assert.match(text, /agent_decisions_total\{action="unknown",decision="ticket"\} 1/);
  assert.doesNotMatch(text, /delete_everything/);
});

test('default process metrics are prefixed agent_', async () => {
  assert.match(await createMetrics().registry.metrics(), /agent_process_resident_memory_bytes/);
});
