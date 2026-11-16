import { nanoid } from 'nanoid';
import type { RunEvent, RunEventType, RunStatus, WorkflowRun } from '@sf/shared';
import { getDb, nowIso } from '../../db.js';
import { hub } from '../../events.js';

interface RunRow {
  id: string;
  card_id: string;
  workflow_id: string;
  project_id: string;
  status: RunStatus;
  current_step: string | null;
  iteration: number;
  worktree_path: string;
  branch: string;
  base_branch: string;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  summary: string | null;
  state: string;
}

export interface RunState {
  sessions: Record<string, string>;
  outputs: Record<string, string>;
  feedback: string | null;
  decisions: Array<{ iteration: number; decision: string; rationale: string }>;
}

const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  cardId: r.card_id,
  workflowId: r.workflow_id,
  projectId: r.project_id,
  status: r.status,
  currentStep: r.current_step,
  iteration: r.iteration,
  worktreePath: r.worktree_path,
  branch: r.branch,
  baseBranch: r.base_branch,
  costUsd: r.cost_usd,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
  summary: r.summary,
});

export function createRun(input: { cardId: string; workflowId: string; projectId: string; worktreePath: string; branch: string; baseBranch: string }): WorkflowRun {
  const id = nanoid(10);
  const state: RunState = { sessions: {}, outputs: {}, feedback: null, decisions: [] };
  getDb()
    .prepare('INSERT INTO runs (id, card_id, workflow_id, project_id, status, current_step, iteration, worktree_path, branch, base_branch, cost_usd, started_at, finished_at, error, summary, state) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, 0, ?, NULL, NULL, NULL, ?)')
    .run(id, input.cardId, input.workflowId, input.projectId, 'queued', input.worktreePath, input.branch, input.baseBranch, nowIso(), JSON.stringify(state));
  const run = getRun(id)!;
  hub.broadcast({ type: 'run.changed', run });
  return run;
}

export function getRun(id: string): WorkflowRun | null {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as unknown as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function getRunState(id: string): RunState {
  const row = getDb().prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string } | undefined;
  return row ? (JSON.parse(row.state) as RunState) : { sessions: {}, outputs: {}, feedback: null, decisions: [] };
}

export function saveRunState(id: string, state: RunState): void {
  getDb().prepare('UPDATE runs SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
}

export function listRuns(cardId?: string): WorkflowRun[] {
  const rows = (cardId
    ? getDb().prepare('SELECT * FROM runs WHERE card_id = ? ORDER BY started_at DESC').all(cardId)
    : getDb().prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100').all()) as unknown as RunRow[];
  return rows.map(toRun);
}

export function updateRun(id: string, patch: Partial<Pick<WorkflowRun, 'status' | 'currentStep' | 'iteration' | 'costUsd' | 'finishedAt' | 'error' | 'summary'>>): WorkflowRun | null {
  const map: Record<string, string> = { status: 'status', currentStep: 'current_step', iteration: 'iteration', costUsd: 'cost_usd', finishedAt: 'finished_at', error: 'error', summary: 'summary' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k]) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(v ?? null);
  }
  if (sets.length) getDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]), id);
  const run = getRun(id);
  if (run) hub.broadcast({ type: 'run.changed', run });
  return run;
}

export function appendEvent(runId: string, type: RunEventType, text: string, opts: { step?: string | null; role?: string | null; data?: unknown } = {}): RunEvent {
  const ts = nowIso();
  const res = getDb()
    .prepare('INSERT INTO run_events (run_id, ts, type, step, role, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, ts, type, opts.step ?? null, opts.role ?? null, text, opts.data === undefined ? null : JSON.stringify(opts.data));
  const event: RunEvent = { id: Number(res.lastInsertRowid), runId, ts, type, step: opts.step ?? null, role: opts.role ?? null, text, data: opts.data ?? null };
  hub.broadcast({ type: 'run.event', event });
  return event;
}

export function listEvents(runId: string, afterId = 0, limit = 2000): RunEvent[] {
  const rows = getDb().prepare('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?').all(runId, afterId, limit) as any[];
  return rows.map((r) => ({ id: r.id, runId: r.run_id, ts: r.ts, type: r.type, step: r.step, role: r.role, text: r.text, data: r.data ? JSON.parse(r.data) : null }));
}

/** On boot: anything still "running" belonged to a previous server process. */
export function failStaleRuns(): number {
  const res = getDb()
    .prepare("UPDATE runs SET status = 'interrupted', error = 'The server stopped while this run was in progress. Resume it from the card: the agents continue their own sessions in the same worktree.', finished_at = ? WHERE status IN ('queued', 'running', 'waiting_human')")
    .run(nowIso());
  return Number(res.changes);
}
