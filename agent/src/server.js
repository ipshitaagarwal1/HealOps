import { createApp } from './app.js';
import { createAudit } from './audit.js';
import { loadConfigOrExit, redact } from './config.js';
import { createPool, pingDb } from './db.js';
import { createEvents } from './events.js';
import { createIncidentStore } from './incidents.js';
import { createLogger } from './logger.js';
import { createDiagnoser } from './diagnose.js';
import { loadRecentActions } from './guardrail.js';
import { createPipeline } from './pipeline.js';
import { createRetriever } from './rag.js';
import { createTicketStore } from './tickets.js';
import { createWebhookHandler } from './webhook.js';

const config = loadConfigOrExit();
const logger = createLogger({ component: 'agent' }, { level: config.logLevel });
const pool = createPool(config.databaseUrl, logger);
const events = createEvents();
const audit = createAudit({ pool, events, logger });
const store = createIncidentStore(pool);
const pipeline = createPipeline({
  retrieve: createRetriever({ config, pool }),
  diagnose: createDiagnoser({ config }),
  loadHistory: (service) => loadRecentActions(pool, service),
  config,
  store,
  tickets: createTicketStore(pool),
  audit,
  logger,
});
const webhook = createWebhookHandler({ store, audit, logger, pipeline });

const app = createApp({ webhook, checkHealth: () => pingDb(pool), logger });
const server = app.listen(config.port, () => {
  logger.info('agent listening', { port: config.port, config: redact(config) });
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close();
  await webhook.drain();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled rejection', { err }));
