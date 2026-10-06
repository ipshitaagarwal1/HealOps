// Express routes. Built from injected dependencies so tests can run it without a DB.
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';

export function requireAdmin(adminToken) {
  const expected = Buffer.from(adminToken ?? '');
  return (req, res, next) => {
    const given = Buffer.from(String(req.get('x-admin-token') ?? ''));
    if (expected.length && given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

const ticketId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// dashboard (router) and metrics are optional so tests can build a minimal app.
export function createApp({ webhook, checkHealth, logger, ticketService, adminToken, dashboard, metrics }) {
  const app = express();
  app.disable('x-powered-by');
  const admin = requireAdmin(adminToken);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
  if (dashboard) app.use(dashboard);
  if (metrics) {
    app.get('/metrics', async (req, res) => {
      res.set('Content-Type', metrics.registry.contentType);
      res.send(await metrics.registry.metrics());
    });
  }

  app.post('/webhook/alertmanager', express.json({ limit: '1mb' }), webhook.route);

  app.get('/health', async (req, res) => {
    try {
      await checkHealth();
      res.json({ status: 'ok' });
    } catch (err) {
      logger.warn('health check failed', { err });
      res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
    }
  });

  for (const op of ['approve', 'reject']) {
    app.post(`/api/tickets/:id/${op}`, admin, async (req, res, next) => {
      const id = ticketId(req);
      if (!id) return res.status(400).json({ error: 'ticket id must be a positive integer' });
      try {
        const result = await ticketService[op](id);
        res.status(result.result && !result.result.ok ? 502 : 200).json(result);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
      }
    });
  }

  // Malformed JSON and anything unexpected.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error('request failed', { path: req.path, err });
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}
