import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import client from 'prom-client';
import { createFaults, parseFaultBody, parseReplicas } from './faults.js';
import { log } from './log.js';

const SERVICE_NAME = process.env.SERVICE_NAME;
const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!SERVICE_NAME || !ADMIN_TOKEN) {
  log('error', 'missing required env: SERVICE_NAME and ADMIN_TOKEN must be set');
  process.exit(1);
}

// Every metric (including default process metrics) carries the service label,
// so alert rules can tell the agent which service to act on.
client.register.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics();

const requests = new client.Counter({
  name: 'http_requests_total',
  help: 'Requests to GET / by status code',
  labelNames: ['status'],
});
const duration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Latency of GET /',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

const faults = createFaults();
const app = express();
app.use(express.json({ limit: '10kb' }));

function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (tokenMatches(req.get('x-admin-token'))) return next();
  log('warn', 'admin auth failed', { path: req.path });
  res.status(401).json({ error: 'unauthorized' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.get('/', async (req, res) => {
  const end = duration.startTimer();
  const { fail, delayMs } = faults.decide();
  if (delayMs) await sleep(delayMs);
  const status = fail ? 500 : 200;
  requests.inc({ status: String(status) });
  end();
  if (fail) return res.status(500).json({ error: 'injected fault', service: SERVICE_NAME });
  res.json({ ok: true, service: SERVICE_NAME });
});

app.get('/health', (req, res) => {
  if (faults.healthy()) return res.json({ status: 'ok', service: SERVICE_NAME });
  res.status(503).json({ status: 'crashed', service: SERVICE_NAME });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.send(await client.register.metrics());
});

app.get('/admin/state', requireAdmin, (req, res) => res.json(faults.snapshot()));

app.post('/admin/fault', requireAdmin, (req, res) => {
  const parsed = parseFaultBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  faults.setFault(parsed.mode, parsed.rate);
  log('info', 'fault set', { mode: parsed.mode, rate: parsed.rate });
  res.json(faults.snapshot());
});

app.post('/admin/restart', requireAdmin, (req, res) => {
  faults.restart();
  const at = new Date().toISOString();
  log('info', 'restarted (simulated)', { at });
  res.json({ restarted: true, at });
});

app.post('/admin/scale', requireAdmin, (req, res) => {
  const parsed = parseReplicas(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  faults.scale(parsed.replicas);
  log('info', 'scaled (simulated)', { replicas: parsed.replicas });
  res.json({ scaled: true, ...faults.snapshot() });
});

// Bad JSON bodies and anything unexpected end up here.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  log('error', 'request error', { path: req.path, status, error: err.message });
  res.status(status).json({ error: status === 500 ? 'internal error' : err.message });
});

const server = app.listen(PORT, () => log('info', 'listening', { port: PORT }));

function shutdown(signal) {
  log('info', 'shutting down', { signal });
  faults.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
