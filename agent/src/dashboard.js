// Read-only dashboard API and the live Server-Sent Events feed (docs/SPEC.md section 8).
// The page itself is agent/public/index.html, served as a static file.
import express from 'express';
import { latenciesOf, loadStats } from './stats.js';

const INCIDENT_LIST_SQL = `
SELECT id, service, alertname, status, fired_at, received_at, decided_at, acted_at, resolved_at,
       diagnosis->>'action' AS action, (diagnosis->>'confidence')::float AS confidence,
       guardrail->>'decision' AS decision, guardrail->'reasons' AS reasons
FROM incidents ORDER BY received_at DESC LIMIT $1`;

const TICKET_LIST_SQL = `
SELECT t.*, i.alertname FROM tickets t LEFT JOIN incidents i ON i.id = t.incident_id
WHERE ($1::text IS NULL OR t.status = $1) ORDER BY t.created_at DESC LIMIT 100`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEARTBEAT_MS = 15000;

const clampLimit = (v, def, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
};

export function createDashboardRouter({ pool, events, logger }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  router.get('/api/incidents', wrap(async (req, res) => {
    const { rows } = await pool.query(INCIDENT_LIST_SQL, [clampLimit(req.query.limit, 20, 200)]);
    res.json(rows.map((r) => ({ ...r, latency_s: latenciesOf(r) })));
  }));

  router.get('/api/incidents/:id', wrap(async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'id must be a UUID' });
    const [incident, audit, tickets] = await Promise.all([
      pool.query('SELECT * FROM incidents WHERE id = $1', [req.params.id]),
      pool.query('SELECT id, step, detail, duration_ms, at FROM audit_log WHERE incident_id = $1 ORDER BY id', [req.params.id]),
      pool.query('SELECT * FROM tickets WHERE incident_id = $1 ORDER BY id', [req.params.id]),
    ]);
    if (!incident.rows[0]) return res.status(404).json({ error: 'incident not found' });
    res.json({ ...incident.rows[0], latency_s: latenciesOf(incident.rows[0]), audit: audit.rows, tickets: tickets.rows });
  }));

  router.get('/api/tickets', wrap(async (req, res) => {
    const status = ['open', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const { rows } = await pool.query(TICKET_LIST_SQL, [status]);
    res.json(rows);
  }));

  router.get('/api/stats', wrap(async (req, res) => {
    res.json(await loadStats(pool));
  }));

  // SSE: one "audit" event per pipeline step, plus a comment heartbeat so proxies
  // and browsers keep the connection open.
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (event) => res.write(`event: audit\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    logger.debug('sse client connected');
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
