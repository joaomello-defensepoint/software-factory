import { IDENTITY_EMAILS } from '../config.js';
import { logger } from '../logger.js';
import { hub } from '../events.js';
import { kvGet, kvSet } from '../db.js';
import { loadConfig } from './projects.js';
import * as jira from './jira.js';
import * as llama from './llama.js';

export type SyncSource = 'jira' | 'llama';

export interface SyncState {
  running: boolean;
  lastSync: string | null;
  lastError: string | null;
  lastResult: { imported: number; updated: number; total: number } | null;
  intervalMinutes: number;
}

const running = new Set<SyncSource>();
let timer: NodeJS.Timeout | null = null;

/** Runs one sync, guarded against overlap; records the outcome in kv for the UI. */
export async function runSync(source: SyncSource, opts: { jql?: string; trigger: 'manual' | 'auto' }): Promise<{ imported: number; updated: number; total: number }> {
  if (running.has(source)) throw new Error(`${source} sync is already running`);
  running.add(source);
  hub.broadcast({ type: 'sync.changed', source, running: true });
  try {
    const result = source === 'jira' ? await jira.syncFromJira(opts.jql) : await llama.syncFromLlama(IDENTITY_EMAILS);
    kvSet(`${source}:lastSync`, new Date().toISOString());
    kvSet(`${source}:lastResult`, result);
    kvSet(`${source}:lastError`, null);
    if (opts.trigger === 'auto' && result.imported) hub.broadcast({ type: 'toast', level: 'info', message: `${source === 'jira' ? 'Jira' : 'Llama'}: ${result.imported} new issue(s) on the board` });
    return result;
  } catch (e: any) {
    const msg = String(e?.message || e);
    kvSet(`${source}:lastError`, `${new Date().toISOString()} ${msg}`);
    logger.warn({ err: msg, source, trigger: opts.trigger }, 'sync failed');
    throw e;
  } finally {
    running.delete(source);
    hub.broadcast({ type: 'sync.changed', source, running: false });
  }
}

export function syncState(source: SyncSource): SyncState {
  return {
    running: running.has(source),
    lastSync: kvGet<string | null>(`${source}:lastSync`, null),
    lastError: kvGet<string | null>(`${source}:lastError`, null),
    lastResult: kvGet<SyncState['lastResult']>(`${source}:lastResult`, null),
    intervalMinutes: loadConfig().board.syncIntervalMinutes,
  };
}

async function tick(): Promise<void> {
  const sources: SyncSource[] = [];
  if (jira.jiraConfigured()) sources.push('jira');
  if (llama.llamaConfigured()) sources.push('llama');
  for (const s of sources) {
    if (running.has(s)) continue;
    await runSync(s, { trigger: 'auto' }).catch(() => undefined);
  }
}

/** Starts the periodic board sync (board.syncIntervalMinutes in config.yaml; 0 disables). First run shortly after boot. */
export function startAutoSync(): void {
  stopAutoSync();
  const minutes = loadConfig().board.syncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('auto sync disabled (board.syncIntervalMinutes = 0)');
    return;
  }
  logger.info(`auto sync every ${minutes} min`);
  setTimeout(() => void tick(), 15_000).unref();
  timer = setInterval(() => void tick(), minutes * 60_000);
  timer.unref();
}

export function stopAutoSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
