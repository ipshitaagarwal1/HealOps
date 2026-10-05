import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';
import { createTicketService } from '../src/tickets.js';

// In-memory ticket store with the same conditional-transition semantics as SQL.
function fakeTickets(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    byId,
    get: async (id) => (byId.get(id) ? { ...byId.get(id) } : null),
    transition: async (id, from, to) => {
      const t = byId.get(id);
      if (!t || t.status !== from) return null;
      t.status = to;
      return { ...t };
    },
  };
}

function setup({ action = 'restart_pod', status = 'open', execute } = {}) {
  const ticketStore = fakeTickets([{ id: 1, incident_id: 'inc-1', service: 'service-a', recommended_action: action, status }]);
  const updates = [];
  const audits = [];
  const runs = [];
  const service = createTicketService({
    ticketStore,
    execute: execute ?? (async (a) => { runs.push(a); return { ...a, approved_by: a.approvedBy, ok: true, duration_ms: 5 }; }),
    store: { update: async (id, f) => updates.push({ id, ...f }) },
    audit: async (id, step, detail) => audits.push({ id, step, detail }),
    logger: createLogger({}, { write: () => {} }),
  });
  return { service, ticketStore, updates, audits, runs };
}

test('approve runs the recommended action as human and marks the incident acted', async () => {
  const { service, ticketStore, updates, audits, runs } = setup();
  const r = await service.approve(1);
  assert.equal(r.status, 'approved');
  assert.deepEqual(runs, [{ action: 'restart_pod', service: 'service-a', approvedBy: 'human' }]);
  assert.equal(ticketStore.byId.get(1).status, 'approved');
  assert.equal(updates[0].status, 'acted');
  assert.equal(audits[0].step, 'act');
  assert.equal(audits[0].detail.approved_by, 'human');
  assert.equal(audits[0].detail.ticket_id, 1);
});

test('approve of an escalate ticket is refused (nothing to run)', async () => {
  const { service, runs } = setup({ action: 'escalate' });
  await assert.rejects(service.approve(1), (e) => e.status === 409 && /reject/.test(e.message));
  assert.equal(runs.length, 0);
});

test('approve of a ticket that is not open is refused', async () => {
  const { service } = setup({ status: 'rejected' });
  await assert.rejects(service.approve(1), (e) => e.status === 409);
});

test('approve of a missing ticket is 404', async () => {
  const { service } = setup();
  await assert.rejects(service.approve(99), (e) => e.status === 404);
});

test('concurrent approvals run the action only once', async () => {
  const { service, runs } = setup();
  const results = await Promise.allSettled([service.approve(1), service.approve(1)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(runs.length, 1);
});

test('failed action puts the ticket back to open', async () => {
  const execute = async () => ({ ok: false, error: 'timed out', duration_ms: 5 });
  const { service, ticketStore, updates } = setup({ execute });
  const r = await service.approve(1);
  assert.equal(r.status, 'open');
  assert.equal(ticketStore.byId.get(1).status, 'open');
  assert.equal(updates.length, 0);
});

test('execute throwing also puts the ticket back to open', async () => {
  const execute = async () => { throw new Error('db down'); };
  const { service, ticketStore } = setup({ execute });
  await assert.rejects(service.approve(1), /db down/);
  assert.equal(ticketStore.byId.get(1).status, 'open');
});

test('reject closes the ticket and audits it, without running anything', async () => {
  const { service, ticketStore, audits, runs } = setup({ action: 'escalate' });
  assert.deepEqual(await service.reject(1), { ticket_id: 1, status: 'rejected' });
  assert.equal(ticketStore.byId.get(1).status, 'rejected');
  assert.deepEqual(audits[0], { id: 'inc-1', step: 'ticket', detail: { ticket_id: 1, status: 'rejected' } });
  assert.equal(runs.length, 0);
  await assert.rejects(service.reject(1), (e) => e.status === 409);
});
