import { getCard } from './cards.js';
import { ensureCardWorktree } from './cardWorktree.js';
import { existingDesignDocs, getProjectConfig } from './projects.js';
import { contextPack } from './brain.js';
import { notesBlock } from './notes.js';
import { listRuns } from './workflow/runs.js';
import { computeDiff } from './workflow/engine.js';
import { startChat } from './sessions.js';
import type { SessionSummary } from '@sf/shared';

/**
 * "Take over": opens an interactive chat in the card's worktree with the brief the workflow roles had
 * (ticket, design docs, second-brain pack, steering notes, last run summary and the current diff stat).
 */
export async function startCardChat(cardId: string, opts: { model?: string | null; prompt?: string } = {}): Promise<SessionSummary> {
  const card = getCard(cardId);
  if (!card) throw new Error('Card not found');
  if (!card.projectId) throw new Error('Pick a project for this card first');
  const project = getProjectConfig(card.projectId);
  if (!project) throw new Error(`Unknown project ${card.projectId}`);
  const baseBranch = card.baseBranch || project.baseBranches[0];
  const wt = await ensureCardWorktree(card.id, { projectId: project.id, baseBranch });
  const designDocs = existingDesignDocs(project, wt.path);
  const lastRun = listRuns(card.id)[0];
  const diff = await computeDiff(wt.path, baseBranch).catch(() => ({ diff: '', stat: '' }));
  const notes = notesBlock(card.id);

  const brief = [
    `## Ticket ${card.key || '(local)'}: ${card.title}`,
    card.url || '',
    '',
    card.description || '(no description)',
    '',
    `## Project`,
    `${project.name} — base branch \`${baseBranch}\`. You are in the git worktree for this ticket (branch \`${wt.branch}\`); work only here.`,
    '',
    `## Design docs to follow`,
    designDocs.length ? designDocs.map((d) => `- ${d}`).join('\n') : '- (none configured)',
    '',
    `## Knowledge from the second brain`,
    contextPack(project.vault) || '(empty)',
    lastRun ? `\n## Last workflow run (${lastRun.workflowId}, ${lastRun.status})\n${lastRun.summary || lastRun.error || '(no summary)'}` : '',
    diff.stat && diff.stat !== '(no changes)' ? `\n## Changes on this branch vs \`${baseBranch}\`\n${diff.stat}` : '',
    notes ? `\n## Notes from the human\n${notes}` : '',
    '',
    opts.prompt?.trim() || 'You are taking over this ticket from the automated workflow. Read the current state of the branch (git log, git diff against the base branch) before touching anything. Summarize in a few lines what is done, what is missing and anything that looks wrong, then wait for my instructions.',
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  return startChat({ cwd: wt.path, title: `${card.key ? `${card.key} · ` : ''}${card.title}`.slice(0, 120), prompt: brief, model: opts.model ?? null, projectPath: project.path, cardId: card.id });
}
