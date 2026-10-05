// Express routes. Built from injected dependencies so tests can run it without a DB.
import express from 'express';

export function createApp({ webhook, checkHealth, logger }) {
  const app = express();
  app.disable('x-powered-by');

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

  // Malformed JSON and anything unexpected.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error('request failed', { path: req.path, err });
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}
