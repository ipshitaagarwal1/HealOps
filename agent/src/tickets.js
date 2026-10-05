// Tickets: incidents handed to a human. Approve/reject are added in Phase 6.

const INSERT_SQL = `
INSERT INTO tickets (incident_id, service, root_cause, evidence, recommended_action,
                     confidence, reason_for_escalation)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id`;

export function createTicketStore(pool) {
  return {
    // reasons: string[]; stored joined so a human can read them in one field.
    async create({ incidentId, service, diagnosis, reasons }) {
      const { rows } = await pool.query(INSERT_SQL, [
        incidentId, service, diagnosis.root_cause, diagnosis.evidence,
        diagnosis.action, diagnosis.confidence, reasons.join('; '),
      ]);
      return rows[0].id;
    },
  };
}
