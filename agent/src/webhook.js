// POST /webhook/alertmanager: answer 202 at once, then process each alert in the
// background. Firing alerts open an incident unless one is already open for the same
// fingerprint; resolved alerts close the open incident.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Returns null if the body looks like an Alertmanager webhook, else an error string.
export function validatePayload(body) {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  if (!Array.isArray(body.alerts)) return 'body.alerts must be an array';
  return null;
}

const validDate = (s) => {
  const d = new Date(s);
  // Alertmanager uses 0001-01-01 for "not set".
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 ? null : d;
};

// Pull out what the agent needs from one alert, or explain why it can't be handled.
export function parseAlert(alert) {
  const labels = alert?.labels ?? {};
  if (!alert?.fingerprint) return { ok: false, reason: 'missing fingerprint' };
  if (!['firing', 'resolved'].includes(alert.status)) return { ok: false, reason: `unknown status ${alert.status}` };
  if (!labels.alertname) return { ok: false, reason: 'missing alertname label' };
  if (!labels.service) return { ok: false, reason: 'missing service label' };
  return {
    ok: true,
    fingerprint: String(alert.fingerprint),
    status: alert.status,
    alertname: String(labels.alertname),
    service: String(labels.service),
    severity: labels.severity ?? null,
    startsAt: validDate(alert.startsAt),
    endsAt: validDate(alert.endsAt),
  };
}

// pipeline is optional so the webhook can be tested on its own.
export function createWebhookHandler({ store, audit, logger, pipeline = null, now = () => new Date() }) {
  const pending = new Set();

  async function onFiring(a, raw) {
    const started = performance.now();
    const result = await store.createIfNotOpen({
      id: randomUUID(),
      fingerprint: a.fingerprint,
      service: a.service,
      alertname: a.alertname,
      payload: raw,
      firedAt: a.startsAt ?? now(),
    });
    const log = logger.child({ incident_id: result.id });
    if (!result.created) {
      log.info('alert repeat ignored: incident still open', { fingerprint: a.fingerprint, alertname: a.alertname });
      return;
    }
    await audit(result.id, 'webhook', {
      alertname: a.alertname, service: a.service, severity: a.severity,
      fingerprint: a.fingerprint, fired_at: a.startsAt,
    }, performance.now() - started);
    log.info('incident received', { alertname: a.alertname, service: a.service, fingerprint: a.fingerprint });
    if (pipeline) await pipeline.run({ id: result.id, service: a.service, alertname: a.alertname, alert: raw });
    return result.id;
  }

  async function onResolved(a) {
    const started = performance.now();
    // endsAt is when Prometheus saw the alert clear; it is the true recovery time.
    const at = a.endsAt && a.endsAt <= now() ? a.endsAt : now();
    const closed = await store.resolveOpen({ fingerprint: a.fingerprint, resolvedAt: at });
    if (!closed) {
      logger.info('resolved alert has no open incident', { fingerprint: a.fingerprint, alertname: a.alertname });
      return;
    }
    const recoveryMs = closed.firedAt ? at - new Date(closed.firedAt) : null;
    await audit(closed.id, 'resolve', {
      alertname: a.alertname, service: a.service, resolved_at: at, time_to_recovery_ms: recoveryMs,
    }, performance.now() - started);
    logger.child({ incident_id: closed.id }).info('incident resolved', { time_to_recovery_ms: recoveryMs });
  }

  async function processAlert(raw) {
    const a = parseAlert(raw);
    if (!a.ok) {
      logger.warn('alert skipped', { reason: a.reason, fingerprint: raw?.fingerprint ?? null });
      return;
    }
    try {
      if (a.status === 'firing') await onFiring(a, raw);
      else await onResolved(a);
    } catch (err) {
      logger.error('alert processing failed', { fingerprint: a.fingerprint, status: a.status, err });
    }
  }

  async function processPayload(payload) {
    for (const alert of payload.alerts) await processAlert(alert);
  }

  function route(req, res) {
    const error = validatePayload(req.body);
    if (error) return res.status(400).json({ error });
    res.status(202).json({ accepted: req.body.alerts.length });
    const task = processPayload(req.body)
      .catch((err) => logger.error('webhook processing failed', { err }))
      .finally(() => pending.delete(task));
    pending.add(task);
  }

  // Lets shutdown (and tests) wait for background work to finish.
  const drain = () => Promise.all([...pending]);

  return { route, processPayload, drain };
}
