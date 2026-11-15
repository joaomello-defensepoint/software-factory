import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerEvent, SystemStats } from '@sf/shared';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connected = false;
let latestStats: SystemStats | null = null;
const connListeners = new Set<() => void>();

function notifyConn() {
  for (const l of connListeners) l();
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = () => {
    connected = true;
    notifyConn();
  };
  socket.onclose = () => {
    connected = false;
    notifyConn();
    setTimeout(connect, 2000);
  };
  socket.onerror = () => socket?.close();
  socket.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as ServerEvent;
      if (event.type === 'system.stats') {
        latestStats = event.stats;
        notifyConn();
      }
      for (const l of listeners) l(event);
    } catch {
      /* ignore */
    }
  };
}

export function useServerEvents(listener?: Listener): void {
  const qc = useQueryClient();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    connect();
    const l: Listener = (event) => {
      switch (event.type) {
        case 'cards.changed':
          qc.invalidateQueries({ queryKey: ['cards'] });
          break;
        case 'projects.changed':
          qc.invalidateQueries({ queryKey: ['projects'] });
          break;
        case 'run.changed':
          qc.invalidateQueries({ queryKey: ['runs'] });
          qc.invalidateQueries({ queryKey: ['cards'] });
          break;
        case 'request.created':
        case 'request.answered':
          qc.invalidateQueries({ queryKey: ['requests'] });
          qc.invalidateQueries({ queryKey: ['cards'] });
          break;
        case 'brain.changed':
          qc.invalidateQueries({ queryKey: ['brain'] });
          break;
        default:
          break;
      }
      ref.current?.(event);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [qc]);
}

export function useConnection(): { connected: boolean; stats: SystemStats | null } {
  const subscribe = (cb: () => void) => {
    connListeners.add(cb);
    return () => {
      connListeners.delete(cb);
    };
  };
  const snap = useSyncExternalStore(subscribe, () => `${connected}|${latestStats?.ts ?? ''}`);
  void snap;
  return { connected, stats: latestStats };
}
