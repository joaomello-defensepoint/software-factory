import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@sf/shared';

class Hub extends EventEmitter {
  broadcast(event: ServerEvent): void {
    this.emit('event', event);
  }
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const hub = new Hub();
hub.setMaxListeners(100);

export const toast = (level: 'info' | 'success' | 'warning' | 'error', message: string): void =>
  hub.broadcast({ type: 'toast', level, message });
