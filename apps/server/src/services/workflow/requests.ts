import { nanoid } from 'nanoid';
import type { HumanRequest, HumanRequestQuestion } from '@sf/shared';
import { getDb, nowIso } from '../../db.js';
import { hub } from '../../events.js';
import { getCard } from '../cards.js';

interface Row {
  id: string;
  run_id: string;
  card_id: string;
  step: string | null;
  role: string | null;
  questions: string;
  status: HumanRequest['status'];
  answers: string | null;
  created_at: string;
  answered_at: string | null;
}

interface StoredQuestions {
  kind: HumanRequest['kind'];
  toolName: string | null;
  toolInput: unknown;
  questions: HumanRequestQuestion[];
}

function toRequest(r: Row): HumanRequest {
  const stored = JSON.parse(r.questions) as StoredQuestions;
  const card = getCard(r.card_id);
  return {
    id: r.id,
    runId: r.run_id,
    cardId: r.card_id,
    cardKey: card?.key ?? null,
    cardTitle: card?.title ?? '(card removed)',
    step: r.step,
    role: r.role,
    kind: stored.kind,
    toolName: stored.toolName,
    toolInput: stored.toolInput,
    questions: stored.questions,
    status: r.status,
    answers: r.answers ? (JSON.parse(r.answers) as Record<string, string>) : null,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

const pending = new Map<string, { resolve: (answers: Record<string, string> | null) => void }>();

export function listRequests(status?: HumanRequest['status']): HumanRequest[] {
  const rows = (status
    ? getDb().prepare('SELECT * FROM human_requests WHERE status = ? ORDER BY created_at DESC').all(status)
    : getDb().prepare('SELECT * FROM human_requests ORDER BY created_at DESC LIMIT 200').all()) as unknown as Row[];
  return rows.map(toRequest);
}

export function getRequest(id: string): HumanRequest | null {
  const row = getDb().prepare('SELECT * FROM human_requests WHERE id = ?').get(id) as unknown as Row | undefined;
  return row ? toRequest(row) : null;
}

/** Creates a request and returns a promise resolved when the human answers (null when dismissed). */
export function askHuman(input: { runId: string; cardId: string; step: string | null; role: string | null; kind: HumanRequest['kind']; toolName?: string | null; toolInput?: unknown; questions: HumanRequestQuestion[]; signal?: AbortSignal }): { id: string; answer: Promise<Record<string, string> | null> } {
  const id = nanoid(10);
  const stored: StoredQuestions = { kind: input.kind, toolName: input.toolName ?? null, toolInput: input.toolInput ?? null, questions: input.questions };
  getDb()
    .prepare('INSERT INTO human_requests (id, run_id, card_id, step, role, questions, status, answers, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)')
    .run(id, input.runId, input.cardId, input.step, input.role, JSON.stringify(stored), 'pending', nowIso());
  const request = getRequest(id)!;
  hub.broadcast({ type: 'request.created', request });
  hub.broadcast({ type: 'cards.changed' });
  const answer = new Promise<Record<string, string> | null>((resolve) => {
    pending.set(id, { resolve });
    input.signal?.addEventListener('abort', () => {
      if (pending.has(id)) {
        pending.delete(id);
        dismissRequest(id, false);
        resolve(null);
      }
    });
  });
  return { id, answer };
}

export function answerRequest(id: string, answers: Record<string, string>): HumanRequest | null {
  const row = getRequest(id);
  if (!row) return null;
  getDb().prepare("UPDATE human_requests SET status = 'answered', answers = ?, answered_at = ? WHERE id = ?").run(JSON.stringify(answers), nowIso(), id);
  const updated = getRequest(id)!;
  hub.broadcast({ type: 'request.answered', request: updated });
  hub.broadcast({ type: 'cards.changed' });
  pending.get(id)?.resolve(answers);
  pending.delete(id);
  return updated;
}

export function dismissRequest(id: string, resolvePending = true): HumanRequest | null {
  const row = getRequest(id);
  if (!row) return null;
  getDb().prepare("UPDATE human_requests SET status = 'dismissed', answered_at = ? WHERE id = ?").run(nowIso(), id);
  const updated = getRequest(id)!;
  hub.broadcast({ type: 'request.answered', request: updated });
  hub.broadcast({ type: 'cards.changed' });
  if (resolvePending) {
    pending.get(id)?.resolve(null);
    pending.delete(id);
  }
  return updated;
}

/** On boot: requests whose run died with the server are no longer answerable. */
export function dismissOrphanRequests(): void {
  getDb().prepare("UPDATE human_requests SET status = 'dismissed', answered_at = ? WHERE status = 'pending'").run(nowIso());
}
