import { createActor } from './act.js';
import { createApp } from './app.js';
import { createAudit } from './audit.js';
import { loadConfigOrExit, redact } from './config.js';
import { createPool, pingDb } from './db.js';
import { createDiagnoser } from './diagnose.js';
import { createEvents } from './events.js';
import { loadRecentActions } from './guardrail.js';
import { createIncidentStore } from './incidents.js';
import { createLogger } from './logger.js';
import { createPipeline } from './pipeline.js';
import { createRetriever } from './rag.js';
import { createTicketService, createTicketStore } from './tickets.js';
import { createWebhookHandler } from './webhook.js';

const config = loadConfigOrExit();
const logger = createLogger({ component: 'agent' }, { level: config.logLevel });
const pool = createPool(config.databaseUrl, logger);
const events = createEvents();
const audit = createAudit({ pool, events, logger });
const store = createIncidentStore(pool);
const ticketStore = createTicketStore(pool);
const execute = createActor({ config, pool });

const pipeline = createPipeline({
  retrieve: createRetriever({ config, pool }),
  diagnose: createDiagnoser({ config }),
  loadHistory: (service) => loadRecentActions(pool, service),
  execute,
  config,
  store,
  tickets: ticketStore,
  audit,
  logger,
});
const webhook = createWebhookHandler({ store, audit, logger, pipeline });
const ticketService = createTicketService({ ticketStore, execute, store, audit, logger });

const app = createApp({
  webhook, ticketService, adminToken: config.adminToken, checkHealth: () => pingDb(pool), logger,
});
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
