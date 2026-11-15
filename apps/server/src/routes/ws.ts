import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '@sf/shared';
import { hub } from '../events.js';
import { getSystemStats } from '../services/system.js';
import { logger } from '../logger.js';

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  const clients = new Set<{ send: (s: string) => void; readyState: number }>();

  hub.onEvent((event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const c of clients) {
      try {
        if (c.readyState === 1) c.send(payload);
      } catch {
        /* ignore */
      }
    }
  });

  // System stats ticker: only runs while someone is connected.
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (!clients.size) return;
    try {
      hub.broadcast({ type: 'system.stats', stats: await getSystemStats() });
    } catch (e) {
      logger.warn({ err: e }, 'system stats failed');
    }
  };
  const ensureTimer = () => {
    if (!timer) timer = setInterval(tick, 2000);
  };
  const maybeStop = () => {
    if (timer && !clients.size) {
      clearInterval(timer);
      timer = null;
    }
  };

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket as any);
    ensureTimer();
    void tick();
    socket.on('close', () => {
      clients.delete(socket as any);
      maybeStop();
    });
    socket.on('error', () => {
      clients.delete(socket as any);
      maybeStop();
    });
  });
}
