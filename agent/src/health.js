// Dashboard support for the demo-control panel (docs/SPEC.md section 8 extension):
// - GET /api/health/services: server-side Prometheus proxy + each service's fault state.
//   The browser never talks to Prometheus or the demo services directly.
// - POST /api/fault/:service: forwards to the service's /admin/fault or /admin/restart.
// - GET /api/debug/outage, POST /api/debug/simulate-outage: the one-shot "AI outage" demo switch.
// All three live in one router so they can share the admin check and rate limiter.
import express from 'express';
import { requireAdmin } from './app.js';
import { createPromClient } from './promquery.js';
import { createRateLimiter } from './ratelimit.js';

const SPARKLINE_WINDOW_S = 5 * 60;
const SPARKLINE_STEP_S = 15;
const ERROR_RATE_DOWN = 0.5; // matches prometheus/alert.rules.yml HighErrorRate
const LATENCY_DEGRADED_S = 1; // matches HighLatency
const MEMORY_DEGRADED_BYTES = 300 * 1024 * 1024; // matches HighMemory

const FAULT_ACTIONS = {
  error: { mode: 'error', rate: 0.9 },
  latency: { mode: 'latency', rate: 1 },
  memory: { mode: 'memory', rate: 1 },
  crash: { mode: 'crash', rate: 1 },
};

const errorRateQuery = (s) => `sum(rate(http_requests_total{job="demo", service="${s}", status=~"5.."}[30s])) / sum(rate(http_requests_total{job="demo", service="${s}"}[30s]))`;
const latencyQuery = (s) => `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="demo", service="${s}"}[1m])))`;
const memoryQuery = (s) => `max(process_resident_memory_bytes{job="demo", service="${s}"})`;

const scalar = (vector) => {
  const v = Number(vector?.[0]?.value?.[1]);
  return Number.isFinite(v) ? v : null;
};
const series = (matrix) => (matrix?.[0]?.values || []).map(([t, v]) => ({ t: Number(t) * 1000, v: Number(v) || 0 }));

function statusOf({ errorRate, latencyS, memoryBytes, faultMode, reachable }) {
  if (!reachable || faultMode === 'crash' || (errorRate ?? 0) > ERROR_RATE_DOWN) return 'down';
  if (faultMode && faultMode !== 'none') return 'degraded';
  if ((latencyS ?? 0) > LATENCY_DEGRADED_S || (memoryBytes ?? 0) > MEMORY_DEGRADED_BYTES) return 'degraded';
  return 'healthy';
}

export function createHealthRouter({ config, logger, fetchImpl = fetch, outageSwitch = null }) {
  const router = express.Router();
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
  const admin = requireAdmin(config.adminToken);
  const limiter = createRateLimiter({ windowMs: 10_000, max: 10 });
  const prom = createPromClient({ baseUrl: config.prometheusUrl, fetchImpl });
  const timeoutMs = config.actionTimeoutMs ?? 5000;

  async function faultState(baseUrl) {
    try {
      const res = await fetchImpl(`${baseUrl}/admin/state`, {
        headers: { 'x-admin-token': config.adminToken },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { mode: null, reachable: false };
      const body = await res.json();
      return { mode: body.mode ?? null, reachable: true };
    } catch (err) {
      logger.warn('fault state unreachable', { err: err.message });
      return { mode: null, reachable: false };
    }
  }

  async function serviceHealth(service) {
    const baseUrl = config.actionTargets[service];
    const now = Math.floor(Date.now() / 1000);
    const start = now - SPARKLINE_WINDOW_S;
    const [errorRate, latencyS, memoryBytes, errorSpark, latencySpark, memorySpark, fault] = await Promise.all([
      prom.instant(errorRateQuery(service)).then(scalar).catch(() => null),
      prom.instant(latencyQuery(service)).then(scalar).catch(() => null),
      prom.instant(memoryQuery(service)).then(scalar).catch(() => null),
      prom.range(errorRateQuery(service), start, now, SPARKLINE_STEP_S).then(series).catch(() => []),
      prom.range(latencyQuery(service), start, now, SPARKLINE_STEP_S).then(series).catch(() => []),
      prom.range(memoryQuery(service), start, now, SPARKLINE_STEP_S).then(series).catch(() => []),
      faultState(baseUrl),
    ]);
    return {
      service,
      status: statusOf({ errorRate, latencyS, memoryBytes, faultMode: fault.mode, reachable: fault.reachable }),
      error_rate: errorRate,
      p95_latency_s: latencyS,
      memory_bytes: memoryBytes,
      fault_mode: fault.mode,
      sparklines: { error_rate: errorSpark, p95_latency_s: latencySpark, memory_bytes: memorySpark },
    };
  }

  router.get('/api/health/services', wrap(async (req, res) => {
    const names = Object.keys(config.actionTargets);
    const results = await Promise.all(names.map(serviceHealth));
    res.json(results);
  }));

  router.post('/api/fault/:service', admin, limiter, wrap(async (req, res) => {
    const service = req.params.service;
    const baseUrl = config.actionTargets[service];
    if (!baseUrl) return res.status(404).json({ error: `service "${service}" is not known` });
    const action = req.body?.action;
    const heal = action === 'heal';
    if (!heal && !Object.hasOwn(FAULT_ACTIONS, action)) {
      return res.status(400).json({ error: `action must be one of ${[...Object.keys(FAULT_ACTIONS), 'heal'].join('|')}` });
    }
    const path = heal ? '/admin/restart' : '/admin/fault';
    const body = heal ? {} : FAULT_ACTIONS[action];
    try {
      const upstream = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': config.adminToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return res.status(502).json({ error: `service returned HTTP ${upstream.status}` });
      logger.info('demo fault control', { service, action });
      res.json({ service, action, ...json });
    } catch (err) {
      const message = err.name === 'TimeoutError' ? `${path} timed out after ${timeoutMs}ms` : err.message;
      logger.warn('demo fault control failed', { service, action, err: message });
      res.status(502).json({ error: message });
    }
  }));

  if (outageSwitch) {
    router.get('/api/debug/outage', (req, res) => res.json({ armed: outageSwitch.armed }));
    router.post('/api/debug/simulate-outage', admin, limiter, (req, res) => {
      outageSwitch.arm();
      logger.info('demo: next diagnosis will simulate an AI outage');
      res.json({ armed: true });
    });
  }

  return router;
}
