import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { commitLoggerRun, deleteLoggerRun, getLoggerRun, listLoggerRuns, loggerState, runLogger, updateLoggerConfig } from '../services/timelogger.js';

/** Logger tab: the daily Kimai time logger (state, runs, manual/preview runs, schedule settings). */
export async function loggerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/logger/state', async () => loggerState());
  app.get('/api/logger/runs', async (req) => listLoggerRuns(Number((req.query as { limit?: string }).limit) || 60));
  app.get('/api/logger/runs/:id', async (req, reply) => getLoggerRun((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Unknown run' }));
  app.delete('/api/logger/runs/:id', async (req) => ({ deleted: deleteLoggerRun((req.params as { id: string }).id) }));

  app.post('/api/logger/run', async (req) => {
    const body = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), dryRun: z.boolean().optional() }).parse(req.body ?? {});
    return runLogger({ date: body.date ?? null, dryRun: !!body.dryRun, trigger: body.dryRun ? 'preview' : 'manual' });
  });

  app.post('/api/logger/runs/:id/commit', async (req) => {
    const body = z.object({ description: z.string().nullish() }).parse(req.body ?? {});
    return commitLoggerRun((req.params as { id: string }).id, body.description ?? null);
  });

  app.patch('/api/logger/config', async (req) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        days: z.array(z.number().int().min(0).max(6)).optional(),
        catchUp: z.boolean().optional(),
        notifySlack: z.boolean().optional(),
        model: z.string().min(1).optional(),
      })
      .parse(req.body ?? {});
    return updateLoggerConfig(body);
  });
}
