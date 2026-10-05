// Tickets: incidents handed to a human, and the approve / reject flow.

const INSERT_SQL = `
INSERT INTO tickets (incident_id, service, root_cause, evidence, recommended_action,
                     confidence, reason_for_escalation)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id`;

// Moves a ticket from one status to another only if it is still in the expected
// status, so two people approving at once cannot both run the action.
const TRANSITION_SQL = 'UPDATE tickets SET status = $3 WHERE id = $1 AND status = $2 RETURNING *';

// Only these can be run on approval. escalate has nothing to run: reject it instead.
export const RUNNABLE = ['restart_pod', 'scale_up', 'rollback_deploy'];

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
    async get(id) {
      const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
      return rows[0] ?? null;
    },
    async transition(id, from, to) {
      const { rows } = await pool.query(TRANSITION_SQL, [id, from, to]);
      return rows[0] ?? null;
    },
  };
}

class TicketError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// approve/reject return a plain result or throw TicketError(status, message).
export function createTicketService({ ticketStore, execute, store, audit, logger }) {
  async function openTicket(id) {
    const ticket = await ticketStore.get(id);
    if (!ticket) throw new TicketError(404, `ticket ${id} not found`);
    if (ticket.status !== 'open') throw new TicketError(409, `ticket ${id} is ${ticket.status}, not open`);
    return ticket;
  }

  async function approve(id) {
    const ticket = await openTicket(id);
    if (!RUNNABLE.includes(ticket.recommended_action)) {
      throw new TicketError(409, `recommended action "${ticket.recommended_action}" has nothing to run; reject the ticket instead`);
    }
    if (!(await ticketStore.transition(id, 'open', 'approved'))) {
      throw new TicketError(409, `ticket ${id} was changed by someone else`);
    }
    const log = logger.child({ incident_id: ticket.incident_id });
    // A human decision overrides the guardrail (cooldown, confidence), not the allowlist.
    let result;
    try {
      result = await execute({ action: ticket.recommended_action, service: ticket.service, approvedBy: 'human' });
    } catch (err) {
      await ticketStore.transition(id, 'approved', 'open');
      throw err;
    }
    if (result.ok) {
      await store.update(ticket.incident_id, { action_result: result, acted_at: new Date(), status: 'acted' });
    } else {
      // Put it back so it can be retried or rejected.
      await ticketStore.transition(id, 'approved', 'open');
    }
    await audit(ticket.incident_id, 'act', { ...result, ticket_id: id }, result.duration_ms);
    log.info('ticket approved', { ticket_id: id, action: result.action, ok: result.ok, error: result.error });
    return { ticket_id: id, status: result.ok ? 'approved' : 'open', result };
  }

  async function reject(id) {
    await openTicket(id);
    const ticket = await ticketStore.transition(id, 'open', 'rejected');
    if (!ticket) throw new TicketError(409, `ticket ${id} was changed by someone else`);
    await audit(ticket.incident_id, 'ticket', { ticket_id: id, status: 'rejected' });
    logger.child({ incident_id: ticket.incident_id }).info('ticket rejected', { ticket_id: id });
    return { ticket_id: id, status: 'rejected' };
  }

  return { approve, reject };
}
