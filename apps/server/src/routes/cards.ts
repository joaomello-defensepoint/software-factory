import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COLUMNS } from '@sf/shared';
import { archiveDone, createCard, deleteCard, getCard, listCards, moveCard, restoreCard, updateCard } from '../services/cards.js';
import { openInVsCode } from '../services/vscode.js';
import { ensureCardWorktree, removeCardWorktree } from '../services/cardWorktree.js';
import { loadConfig } from '../services/projects.js';
import { cancelRun, isRunActive, startRun } from '../services/workflow/engine.js';
import { addNote, listNotes } from '../services/notes.js';
import { toast } from '../events.js';

const columnSchema = z.enum(COLUMNS);

export async function cardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/cards', async (req) => {
    const q = req.query as { archived?: string };
    return listCards({ archived: q.archived === '1' || q.archived === 'true' });
  });

  app.get('/api/cards/:id', async (req, reply) => {
    const card = getCard((req.params as { id: string }).id);
    return card ?? reply.code(404).send({ error: 'Not found' });
  });

  app.post('/api/cards', async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        column: columnSchema.optional(),
        projectId: z.string().nullable().optional(),
        baseBranch: z.string().nullable().optional(),
        issueType: z.string().nullable().optional(),
        priority: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
      })
      .parse(req.body);
    return createCard({ ...body, source: 'local' });
  });

  app.patch('/api/cards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        projectId: z.string().nullable().optional(),
        baseBranch: z.string().nullable().optional(),
        priority: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        column: columnSchema.optional(),
        prUrl: z.string().nullable().optional(),
      })
      .parse(req.body);
    const card = updateCard(id, patch);
    return card ?? reply.code(404).send({ error: 'Not found' });
  });

  app.post('/api/cards/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ column: columnSchema, index: z.number().int().min(0) }).parse(req.body);
    const before = getCard(id);
    const card = moveCard(id, body.column, body.index);
    if (!card) return reply.code(404).send({ error: 'Not found' });
    const active = !!card.runId && isRunActive(card.runId);
    const cfg = loadConfig().board;
    if (body.column === 'in_progress' && before?.column !== 'in_progress' && !active && cfg.autoStart) {
      if (!card.projectId) toast('warning', `${card.key || card.title}: pick a project in the card to start the ${cfg.defaultWorkflow} workflow`);
      else {
        toast('info', `${card.key || card.title}: starting ${cfg.defaultWorkflow}…`);
        startRun({ cardId: card.id, workflowId: cfg.defaultWorkflow }).catch((e) => toast('error', `${card.key || card.title}: ${String(e.message || e)}`));
      }
    } else if (body.column !== 'in_progress' && active && card.runId) {
      cancelRun(card.runId);
      toast('info', `${card.key || card.title}: workflow cancelled (card left In Progress)`);
    }
    return card;
  });

  /** Steering notes: reach the running agent at its next tool call and every later step's prompt. */
  app.get('/api/cards/:id/notes', async (req) => listNotes((req.params as { id: string }).id));
  app.post('/api/cards/:id/notes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const card = getCard(id);
    if (!card) return reply.code(404).send({ error: 'Not found' });
    return addNote(id, card.runId && isRunActive(card.runId) ? card.runId : null, body.text);
  });

  app.delete('/api/cards/:id', async (req) => {
    deleteCard((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/cards/archive-done', async () => ({ archived: archiveDone() }));
  app.post('/api/cards/:id/restore', async (req) => restoreCard((req.params as { id: string }).id));

  /** Opens the card's worktree in VS Code, creating or adopting the worktree first (never the main checkout). */
  app.post('/api/cards/:id/open', async (req, reply) => {
    const card = getCard((req.params as { id: string }).id);
    if (!card) return reply.code(404).send({ error: 'Not found' });
    const body = (req.body as { projectId?: string; baseBranch?: string } | undefined) ?? {};
    const wt = await ensureCardWorktree(card.id, { projectId: body.projectId, baseBranch: body.baseBranch });
    const opened = await openInVsCode(wt.path);
    return { ...opened, message: `${wt.message}. ${opened.message}`, worktree: wt };
  });

  /** Ensures the worktree exists without opening it. */
  app.post('/api/cards/:id/worktree', async (req) => {
    const body = (req.body as { projectId?: string; baseBranch?: string } | undefined) ?? {};
    return ensureCardWorktree((req.params as { id: string }).id, { projectId: body.projectId, baseBranch: body.baseBranch });
  });
  app.delete('/api/cards/:id/worktree', async (req) => {
    const body = (req.body as { force?: boolean } | undefined) ?? {};
    return removeCardWorktree((req.params as { id: string }).id, !!body.force);
  });
}
