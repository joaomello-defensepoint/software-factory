import { nanoid } from 'nanoid';
import type { Card, CardSource, ColumnId, RunStatus } from '@sf/shared';
import { COLUMNS } from '@sf/shared';
import { getDb, nowIso } from '../db.js';
import { hub } from '../events.js';

interface Row {
  id: string;
  source: CardSource;
  key: string | null;
  url: string | null;
  title: string;
  description: string;
  issue_type: string | null;
  priority: string | null;
  labels: string;
  epic_key: string | null;
  external_status: string | null;
  col: ColumnId;
  position: number;
  project_id: string | null;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  run_id: string | null;
  pr_url: string | null;
  pr_id: number | null;
  archived: number;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  run_status?: RunStatus | null;
  pending_requests?: number;
}

const SELECT = `
  SELECT c.*, r.status AS run_status,
    (SELECT COUNT(*) FROM human_requests h WHERE h.card_id = c.id AND h.status = 'pending') AS pending_requests
  FROM cards c LEFT JOIN runs r ON r.id = c.run_id`;

function toCard(r: Row): Card {
  return {
    id: r.id,
    source: r.source,
    key: r.key,
    url: r.url,
    title: r.title,
    description: r.description,
    issueType: r.issue_type,
    priority: r.priority,
    labels: safeJson<string[]>(r.labels, []),
    epicKey: r.epic_key,
    externalStatus: r.external_status,
    column: r.col,
    position: r.position,
    projectId: r.project_id,
    baseBranch: r.base_branch,
    branch: r.branch,
    worktreePath: r.worktree_path,
    runId: r.run_id,
    runStatus: r.run_status ?? null,
    pendingRequests: Number(r.pending_requests ?? 0),
    prUrl: r.pr_url,
    prId: r.pr_id,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    syncedAt: r.synced_at,
  };
}

const safeJson = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function listCards(opts: { archived?: boolean } = {}): Card[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE c.archived = ? ORDER BY c.col, c.position, c.updated_at DESC`)
    .all(opts.archived ? 1 : 0) as unknown as Row[];
  return rows.map(toCard);
}

export function getCard(id: string): Card | null {
  const row = getDb().prepare(`${SELECT} WHERE c.id = ?`).get(id) as unknown as Row | undefined;
  return row ? toCard(row) : null;
}

export function getCardByKey(key: string): Card | null {
  const row = getDb().prepare(`${SELECT} WHERE c.key = ?`).get(key) as unknown as Row | undefined;
  return row ? toCard(row) : null;
}

export type CardInput = Partial<Omit<Card, 'id' | 'createdAt' | 'updatedAt' | 'runStatus' | 'pendingRequests'>> & { title: string };

function nextPosition(column: ColumnId): number {
  const row = getDb().prepare('SELECT COALESCE(MAX(position), 0) AS m FROM cards WHERE col = ? AND archived = 0').get(column) as { m: number };
  return (row?.m ?? 0) + 1;
}

export function createCard(input: CardInput, notify = true): Card {
  const id = nanoid(12);
  const ts = nowIso();
  const column = input.column ?? 'backlog';
  getDb()
    .prepare(
      `INSERT INTO cards (id, source, key, url, title, description, issue_type, priority, labels, epic_key, external_status, col, position,
        project_id, base_branch, branch, worktree_path, run_id, pr_url, pr_id, archived, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.source ?? 'local',
      input.key ?? null,
      input.url ?? null,
      input.title,
      input.description ?? '',
      input.issueType ?? null,
      input.priority ?? null,
      JSON.stringify(input.labels ?? []),
      input.epicKey ?? null,
      input.externalStatus ?? null,
      column,
      input.position ?? nextPosition(column),
      input.projectId ?? null,
      input.baseBranch ?? null,
      input.branch ?? null,
      input.worktreePath ?? null,
      input.runId ?? null,
      input.prUrl ?? null,
      input.prId ?? null,
      input.archived ? 1 : 0,
      ts,
      ts,
      input.syncedAt ?? null,
    );
  if (notify) hub.broadcast({ type: 'cards.changed' });
  return getCard(id)!;
}

const COLUMN_MAP: Record<string, string> = {
  source: 'source',
  key: 'key',
  url: 'url',
  title: 'title',
  description: 'description',
  issueType: 'issue_type',
  priority: 'priority',
  labels: 'labels',
  epicKey: 'epic_key',
  externalStatus: 'external_status',
  column: 'col',
  position: 'position',
  projectId: 'project_id',
  baseBranch: 'base_branch',
  branch: 'branch',
  worktreePath: 'worktree_path',
  runId: 'run_id',
  prUrl: 'pr_url',
  prId: 'pr_id',
  archived: 'archived',
  syncedAt: 'synced_at',
};

export function updateCard(id: string, patch: Partial<Card>, notify = true): Card | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLUMN_MAP[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    if (k === 'labels') values.push(JSON.stringify(v ?? []));
    else if (k === 'archived') values.push(v ? 1 : 0);
    else values.push(v ?? null);
  }
  if (!sets.length) return getCard(id);
  sets.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  getDb().prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...(values as any[]));
  if (notify) hub.broadcast({ type: 'cards.changed' });
  return getCard(id);
}

/** Moves a card to a column at an index; re-numbers the target column. */
export function moveCard(id: string, column: ColumnId, index: number): Card | null {
  if (!COLUMNS.includes(column)) throw new Error(`Unknown column ${column}`);
  const db = getDb();
  const card = getCard(id);
  if (!card) return null;
  const siblings = (db.prepare('SELECT id FROM cards WHERE col = ? AND archived = 0 AND id != ? ORDER BY position').all(column, id) as { id: string }[]).map((r) => r.id);
  const clamped = Math.max(0, Math.min(index, siblings.length));
  siblings.splice(clamped, 0, id);
  const ts = nowIso();
  const upd = db.prepare('UPDATE cards SET position = ?, col = ?, updated_at = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    siblings.forEach((sid, i) => upd.run(i + 1, column, sid === id ? ts : (getCard(sid)?.updatedAt ?? ts), sid));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  hub.broadcast({ type: 'cards.changed' });
  return getCard(id);
}

export function deleteCard(id: string): void {
  getDb().prepare('DELETE FROM cards WHERE id = ?').run(id);
  hub.broadcast({ type: 'cards.changed' });
}

/** Archives every card currently in Done. Returns how many were archived. */
export function archiveDone(): number {
  const res = getDb().prepare(`UPDATE cards SET archived = 1, updated_at = ? WHERE col = 'done' AND archived = 0`).run(nowIso());
  hub.broadcast({ type: 'cards.changed' });
  return Number(res.changes);
}

export function restoreCard(id: string): Card | null {
  return updateCard(id, { archived: false, column: 'done' });
}
