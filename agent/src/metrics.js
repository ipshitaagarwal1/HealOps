// Agent's own Prometheus metrics (docs/SPEC.md section 7). A private registry keeps
// tests independent of each other.
import client from 'prom-client';

const KNOWN_ACTIONS = new Set(['restart_pod', 'scale_up', 'rollback_deploy', 'escalate']);

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry, prefix: 'agent_' });

  const stageDuration = new client.Histogram({
    name: 'agent_stage_duration_seconds',
    help: 'Duration of each pipeline stage',
    labelNames: ['stage'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });
  const decisions = new client.Counter({
    name: 'agent_decisions_total',
    help: 'Guardrail decisions by diagnosed action',
    labelNames: ['action', 'decision'],
    registers: [registry],
  });

  return {
    registry,
    observeStage(stage, durationMs) {
      if (Number.isFinite(durationMs)) stageDuration.observe({ stage }, durationMs / 1000);
    },
    // LLM output is free text: unknown actions share one label to keep cardinality bounded.
    countDecision(action, decision) {
      decisions.inc({ action: KNOWN_ACTIONS.has(action) ? action : 'unknown', decision });
    },
  };
}
