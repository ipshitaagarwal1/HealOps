// Runs one incident through the pipeline after the webhook opened it:
//   retrieve -> diagnose -> guardrail -> act | ticket
// Each step is audited. Any unexpected error marks the incident failed; it never acts.
import { performance } from 'node:perf_hooks';
import { evaluateGuardrail } from './guardrail.js';

const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
};

// Serialises work per key. Two alerts for the same service (e.g. HighErrorRate and
// HighMemory) must not both pass the cooldown check before either action is recorded.
export function createKeyedLock() {
  const tails = new Map();
  return async function withLock(key, fn) {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((r) => { release = r; });
    const tail = prev.then(() => current);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function createPipeline({
  retrieve, diagnose, loadHistory, execute, config, store, tickets, audit, logger, now = () => new Date(),
}) {
  const withServiceLock = createKeyedLock();
  async function openTicket(incident, diagnosis, reasons, log) {
    const { value: ticketId, ms } = await timed(() => tickets.create({
      incidentId: incident.id, service: incident.service, diagnosis, reasons,
    }));
    await store.update(incident.id, { status: 'ticketed' });
    await audit(incident.id, 'ticket', { ticket_id: ticketId, reasons, action: diagnosis.action }, ms);
    log.info('ticket opened', { ticket_id: ticketId, reasons });
  }

  async function decideAndAct(incident, diagnosis, retrieved, log) {
    const g = await timed(async () => {
      const history = await loadHistory(incident.service);
      const at = now();
      const result = evaluateGuardrail({
        diagnosis, service: incident.service, retrieved, history, config, now: at,
      });
      return { result, at, historyCount: history.length };
    });
    const { result: verdict, at: decidedAt } = g.value;
    await store.update(incident.id, { guardrail: verdict, decided_at: decidedAt });
    await audit(incident.id, 'guardrail', { ...verdict, action: diagnosis.action, recent_actions: g.value.historyCount }, g.ms);
    log.info('guardrail decided', { decision: verdict.decision, action: diagnosis.action, reasons: verdict.reasons });

    if (verdict.decision === 'ticket') {
      // Keep why the LLM failed (e.g. "llm_error: HTTP 401 ...") ahead of the guardrail reasons.
      const reasons = diagnosis.fallback_reason ? [diagnosis.reasoning, ...verdict.reasons] : verdict.reasons;
      await openTicket(incident, diagnosis, reasons, log);
      return;
    }

    const result = await execute({ action: diagnosis.action, service: incident.service, approvedBy: 'agent' });
    await audit(incident.id, 'act', result, result.duration_ms);
    if (result.ok) {
      await store.update(incident.id, { action_result: result, acted_at: new Date(), status: 'acted' });
      log.info('action executed', { action: result.action, duration_ms: result.duration_ms });
      return;
    }
    await store.update(incident.id, { action_result: result });
    log.warn('action failed', { action: result.action, error: result.error });
    await openTicket(incident, diagnosis, [`action_failed: ${result.error}`], log);
  }

  async function run(incident) {
    const log = logger.child({ incident_id: incident.id });
    try {
      const r = await timed(() => retrieve(incident.alert));
      const retrieved = r.value.kept.map(({ id, kind, title, similarity, recommended_action }) => (
        { id, kind, title, similarity, recommended_action }));
      await store.update(incident.id, { retrieved });
      await audit(incident.id, 'retrieve', {
        query: r.value.query,
        candidates: r.value.candidates.map(({ id, title, similarity }) => ({ id, title, similarity })),
        kept: retrieved.length,
        error: r.value.error,
      }, r.ms);
      if (r.value.error) log.warn('embedding failed, continuing without context', { error: r.value.error });

      const d = await timed(() => diagnose({
        alert: incident.alert, service: incident.service, retrieved: r.value.kept,
      }));
      const { diagnosis, attempts, error } = d.value;
      await store.update(incident.id, { diagnosis, status: 'diagnosed' });
      await audit(incident.id, 'diagnose', { ...diagnosis, attempts, error: error ?? null }, d.ms);
      log.info('diagnosed', { action: diagnosis.action, confidence: diagnosis.confidence, attempts });

      // Guardrail + act hold the service lock so the cooldown check sees every action.
      await withServiceLock(incident.service, () => decideAndAct(incident, diagnosis, retrieved, log));
    } catch (err) {
      log.error('pipeline failed', { err });
      await audit(incident.id, 'error', { message: err.message });
      await store.update(incident.id, { status: 'failed' }).catch((e) => log.error('could not mark failed', { err: e }));
    }
  }

  return { run };
}
