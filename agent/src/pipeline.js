// Runs one incident through the pipeline after the webhook opened it:
//   retrieve -> diagnose -> (Phase 5: guardrail -> act | ticket)
// Each step is audited. Any unexpected error marks the incident failed; it never acts.
import { performance } from 'node:perf_hooks';

const timed = async (fn) => {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
};

export function createPipeline({ retrieve, diagnose, store, tickets, audit, logger }) {
  async function openTicket(incident, diagnosis, reasons, log) {
    const { value: ticketId, ms } = await timed(() => tickets.create({
      incidentId: incident.id, service: incident.service, diagnosis, reasons,
    }));
    await store.update(incident.id, { status: 'ticketed', decided_at: new Date() });
    await audit(incident.id, 'ticket', { ticket_id: ticketId, reasons, action: diagnosis.action }, ms);
    log.info('ticket opened', { ticket_id: ticketId, reasons });
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

      // Until the guardrail exists (Phase 5), only LLM failures are routed: always to a ticket.
      if (diagnosis.fallback_reason) await openTicket(incident, diagnosis, [diagnosis.fallback_reason], log);
    } catch (err) {
      log.error('pipeline failed', { err });
      await audit(incident.id, 'error', { message: err.message });
      await store.update(incident.id, { status: 'failed' }).catch((e) => log.error('could not mark failed', { err: e }));
    }
  }

  return { run };
}
