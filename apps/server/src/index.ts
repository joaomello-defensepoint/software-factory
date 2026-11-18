import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PORT, REPO_ROOT, SF_HOME, ensureDirs } from './config.js';
import { getDb } from './db.js';
import { logger } from './logger.js';
import { systemRoutes } from './routes/system.js';
import { projectRoutes } from './routes/projects.js';
import { cardRoutes } from './routes/cards.js';
import { wsRoutes } from './routes/ws.js';
import { registerIntegrations } from './routes/integrations.js';
import { failStaleRuns } from './services/workflow/runs.js';
import { dismissOrphanRequests } from './services/workflow/requests.js';
import { seedDefaultWorkflows } from './services/workflow/definitions.js';
import { loadConfig } from './services/projects.js';
import { abortAllRuns } from './services/workflow/engine.js';
import { closeLlama } from './services/llama.js';
import { abortAllChats, failStaleSessions } from './services/sessions.js';
import { sessionRoutes } from './routes/sessions.js';
import { uploadRoutes } from './routes/uploads.js';
import { startAutoSync, stopAutoSync } from './services/autosync.js';
import { loggerRoutes } from './routes/logger.js';
import { startLoggerSchedule, stopLoggerSchedule } from './services/timelogger.js';

async function main(): Promise<void> {
  ensureDirs();
  getDb();
  loadConfig();
  seedDefaultWorkflows();
  const stale = failStaleRuns();
  if (stale) logger.warn(`${stale} run(s) were interrupted by a previous shutdown and marked failed`);
  dismissOrphanRequests();
  failStaleSessions();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((err: any, _req, reply) => {
    logger.error({ err }, 'request failed');
    const notConfigured = /not configured/i.test(String(err?.message || ''));
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : notConfigured ? 400 : 500;
    reply.code(status).send({ error: err?.message || 'Internal error' });
  });

  await app.register(systemRoutes);
  await app.register(projectRoutes);
  await app.register(cardRoutes);
  await app.register(wsRoutes);
  await registerIntegrations(app);
  await app.register(sessionRoutes);
  await app.register(uploadRoutes);
  await app.register(loggerRoutes);

  app.get('/api/health', async () => ({ ok: true, home: SF_HOME, ts: new Date().toISOString() }));

  // Serve the built web app when present (production mode).
  const webDist = path.join(REPO_ROOT, 'apps', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: PORT, host: '127.0.0.1' });
  logger.info(`Software Factory server listening on http://127.0.0.1:${PORT} (state in ${SF_HOME})`);
  startAutoSync();
  startLoggerSchedule();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopAutoSync();
    stopLoggerSchedule();
    const aborted = abortAllRuns() + abortAllChats();
    logger.info(`${signal}: shutting down${aborted ? ` (aborting ${aborted} running workflow session(s))` : ''}`);
    await closeLlama().catch(() => undefined);
    await app.close().catch(() => undefined);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP')); // Terminal window closed
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
