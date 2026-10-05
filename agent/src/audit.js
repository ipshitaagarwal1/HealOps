// Audit trail: every pipeline step writes one audit_log row and broadcasts an event.
// A failed audit write is logged but never breaks the pipeline.

export const STEPS = ['webhook', 'retrieve', 'diagnose', 'guardrail', 'act', 'ticket', 'resolve', 'error'];

const INSERT_SQL = `
INSERT INTO audit_log (incident_id, step, detail, duration_ms)
VALUES ($1, $2, $3, $4)
RETURNING id, at`;

export function createAudit({ pool, events, logger }) {
  return async function record(incidentId, step, detail = {}, durationMs = null) {
    if (!STEPS.includes(step)) throw new Error(`unknown audit step: ${step}`);
    const ms = durationMs == null ? null : Math.round(durationMs);
    const event = { incident_id: incidentId, step, detail, duration_ms: ms, at: new Date().toISOString() };
    try {
      // Stringify explicitly: pg would turn a JS array into a Postgres array, not jsonb.
      const { rows } = await pool.query(INSERT_SQL, [incidentId, step, JSON.stringify(detail), ms]);
      Object.assign(event, { id: rows[0].id, at: rows[0].at });
    } catch (err) {
      logger.error('audit write failed', { incident_id: incidentId, step, err });
    }
    events.publish(event);
    return event;
  };
}
