import type { FastifyInstance } from 'fastify';
import { getSystemStats } from '../services/system.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/system/stats', async () => getSystemStats());
}
