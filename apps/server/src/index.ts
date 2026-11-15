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

async function main(): Promise<void> {
  ensureDirs();
  getDb();
  loadConfig();
  seedDefaultWorkflows();
  const stale = failStaleRuns();
  if (stale) logger.warn(`${stale} run(s) were interrupted by a previous shutdown and marked failed`);
  dismissOrphanRequests();

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((err: any, _req, reply) => {
    logger.error({ err }, 'request failed');
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err?.message || 'Internal error' });
  });

  await app.register(systemRoutes);
  await app.register(projectRoutes);
  await app.register(cardRoutes);
  await app.register(wsRoutes);
  await registerIntegrations(app);

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
}

main().catch((e) => {
  logger.error(e);
  process.exit(1);
});
