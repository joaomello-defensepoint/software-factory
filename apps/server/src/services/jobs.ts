import { nanoid } from 'nanoid';
import type { Job } from '@sf/shared';
import { hub } from '../events.js';
import { nowIso } from '../db.js';
import { logger } from '../logger.js';

const jobs = new Map<string, Job>();
const MAX_LINES = 2000;

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 50);
}

export const getJob = (id: string): Job | undefined => jobs.get(id);

/** Starts a background job whose progress streams to the UI as job.log / job.done events. */
export function startJob(kind: string, title: string, work: (log: (line: string) => void) => Promise<string | void>): Job {
  const job: Job = { id: nanoid(10), kind, title, status: 'running', lines: [], result: null, startedAt: nowIso(), finishedAt: null };
  jobs.set(job.id, job);
  const log = (line: string) => {
    job.lines.push(line);
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
    hub.broadcast({ type: 'job.log', jobId: job.id, line });
  };
  void (async () => {
    try {
      const result = await work(log);
      job.status = 'succeeded';
      job.result = typeof result === 'string' ? result : null;
      job.finishedAt = nowIso();
      hub.broadcast({ type: 'job.done', jobId: job.id, ok: true, message: job.result ?? undefined });
    } catch (e: any) {
      logger.error({ err: e, job: job.id }, 'job failed');
      job.status = 'failed';
      job.result = String(e?.message || e);
      job.finishedAt = nowIso();
      log(`ERROR: ${job.result}`);
      hub.broadcast({ type: 'job.done', jobId: job.id, ok: false, message: job.result });
    }
  })();
  return job;
}
