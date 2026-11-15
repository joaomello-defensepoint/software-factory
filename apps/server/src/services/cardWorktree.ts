import fs from 'node:fs';
import path from 'node:path';
import type { Card } from '@sf/shared';
import { getCard, updateCard } from './cards.js';
import { getProjectConfig, type ProjectConfig } from './projects.js';
import { createWorktree, findWorktree, removeWorktree, slugify } from './worktrees.js';
import { hub } from '../events.js';

/** Branch for a card, following each repo's convention (overridable with branchTemplate / defectBranchTemplate). */
export function branchNameFor(project: ProjectConfig, card: Card): string {
  const key = card.key || slugify(card.title).slice(0, 40) || card.id;
  const isDefect = /defect|bug/i.test(card.issueType || '');
  const slug = slugify(card.title).slice(0, 40);
  const tpl = isDefect ? (project as any).defectBranchTemplate : (project as any).branchTemplate;
  if (typeof tpl === 'string' && tpl) return tpl.replace('{key}', key).replace('{keyLower}', key.toLowerCase()).replace('{slug}', slug);
  if (project.id === 'new-customer-portal') return `${key.toLowerCase()}-${slug}`;
  if (project.id === 'enterprise-kiosk') return `Task/${key}`;
  if (!card.key) return `feature/${key}`;
  return isDefect ? `Defect/${key}` : `Feature/${key}`;
}

export interface EnsureResult {
  ok: boolean;
  path: string;
  branch: string;
  message: string;
  created: boolean;
  isMain: boolean;
}

/**
 * Makes sure the card has a worktree and remembers it on the card. Order: the card's recorded worktree (if it still
 * exists) → an existing worktree on the ticket's branch or named after the key → a new one under .claude/worktrees.
 */
export async function ensureCardWorktree(cardId: string, opts: { projectId?: string | null; baseBranch?: string | null } = {}): Promise<EnsureResult> {
  const card = getCard(cardId);
  if (!card) throw new Error('Card not found');
  const projectId = opts.projectId || card.projectId;
  if (!projectId) throw new Error('Pick a project for this card first');
  const project = getProjectConfig(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  if (!fs.existsSync(project.path)) throw new Error(`Project folder missing: ${project.path}`);
  const baseBranch = opts.baseBranch || card.baseBranch || project.baseBranches[0];

  if (card.worktreePath && card.branch && fs.existsSync(card.worktreePath)) {
    const isMain = path.resolve(card.worktreePath) === path.resolve(project.path);
    return { ok: true, path: card.worktreePath, branch: card.branch, message: isMain ? `Branch ${card.branch} lives in the main checkout of ${project.name}` : `Using the card's worktree ${card.worktreePath}`, created: false, isMain };
  }

  const branch = branchNameFor(project, card);
  const existing = await findWorktree(project.path, { branch, key: card.key });
  if (existing) {
    updateCard(card.id, { projectId: project.id, baseBranch, branch: existing.branch || branch, worktreePath: existing.path });
    hub.broadcast({ type: 'projects.changed' });
    return { ok: true, path: existing.path, branch: existing.branch || branch, message: existing.isMain ? `Branch ${existing.branch} is checked out in the main checkout; using it` : `Reusing existing worktree ${existing.path} (${existing.branch})`, created: false, isMain: existing.isMain };
  }

  const name = card.key || slugify(card.title).slice(0, 40) || card.id;
  const wt = await createWorktree(project.path, name, branch, baseBranch);
  if (!wt.ok) throw new Error(`Worktree failed: ${wt.message}`);
  updateCard(card.id, { projectId: project.id, baseBranch, branch: wt.branch, worktreePath: wt.path });
  hub.broadcast({ type: 'projects.changed' });
  return { ok: true, path: wt.path, branch: wt.branch, message: wt.message, created: wt.created, isMain: false };
}

export async function removeCardWorktree(cardId: string, force = false): Promise<{ ok: boolean; message: string }> {
  const card = getCard(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.worktreePath || !card.projectId) return { ok: false, message: 'Card has no worktree' };
  const project = getProjectConfig(card.projectId);
  if (!project) throw new Error(`Unknown project ${card.projectId}`);
  if (fs.existsSync(card.worktreePath) && card.worktreePath !== project.path) {
    const res = await removeWorktree(project.path, card.worktreePath, force);
    if (!res.ok) return res;
  }
  updateCard(card.id, { worktreePath: null, branch: null });
  hub.broadcast({ type: 'projects.changed' });
  return { ok: true, message: 'Worktree removed (the branch is kept)' };
}
