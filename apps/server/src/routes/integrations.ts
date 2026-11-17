import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationStatus } from '@sf/shared';
import { IDENTITY_EMAILS, env } from '../config.js';
import { run as runShell } from '../services/shell.js';
import * as jira from '../services/jira.js';
import * as llama from '../services/llama.js';
import * as ado from '../services/ado.js';
import { fathomConfigured, fathomMode } from '../services/fathom.js';
import * as brain from '../services/brain.js';
import { getJob, listJobs } from '../services/jobs.js';
import { deleteWorkflow, deleteWorkflowFile, duplicateWorkflow, getWorkflow, listWorkflowFiles, listWorkflows, saveWorkflowFile } from '../services/workflow/definitions.js';
import { cancelRun, computeDiff, isRunActive, resumeRun, startRun } from '../services/workflow/engine.js';
import { getRun, listEvents, listRuns } from '../services/workflow/runs.js';
import { answerRequest, dismissRequest, listRequests } from '../services/workflow/requests.js';
import { getCard, updateCard } from '../services/cards.js';
import { getProjectConfig, loadConfig } from '../services/projects.js';
import { hub } from '../events.js';
import { runSync, syncState } from '../services/autosync.js';


export async function registerIntegrations(app: FastifyInstance): Promise<void> {
  // ----- status -----
  app.get('/api/integrations/status', async (): Promise<IntegrationStatus> => {
    const claude = await runShell('claude', ['--version'], { timeoutMs: 10_000 });
    return {
      jira: { configured: jira.jiraConfigured(), mode: jira.jiraMode(), email: env.jira.email || null, baseUrl: env.jira.baseUrl || null, project: env.jira.project || null, sync: syncState('jira') },
      fathom: { configured: fathomConfigured(), mode: fathomMode() },
      ado: { configured: true, orgUrl: ado.adoOrgUrl(), loggedIn: await ado.adoLoggedIn().catch(() => false) },
      llama: { configured: llama.llamaConfigured(), org: env.llama.org, project: env.llama.project, sync: syncState('llama') },
      claude: { version: claude.code === 0 ? claude.stdout.trim() : null },
    };
  });

  // ----- Jira -----
  app.post('/api/jira/sync', async (req) => {
    const body = (req.body as { jql?: string } | undefined) ?? {};
    return runSync('jira', { jql: body.jql || undefined, trigger: 'manual' });
  });
  /** Verifies the Jira connection end to end (one bridge call) and reports who the connector is authorized as. */
  app.post('/api/integrations/jira/check', async () => {
    const me = await jira.myself();
    return { ok: true, mode: jira.jiraMode(), accountId: me.accountId, displayName: me.displayName, email: me.emailAddress ?? null };
  });
  app.get('/api/jira/issue-types', async (req) => {
    const q = req.query as { project?: string };
    return jira.projectIssueTypes(q.project || env.jira.project);
  });
  app.post('/api/jira/issues', async (req) => {
    const body = z
      .object({
        projectKey: z.string().default(env.jira.project),
        summary: z.string().min(3),
        description: z.string().default(''),
        issueType: z.string().default('Story'),
        epicKey: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        priority: z.string().nullable().optional(),
        assignToMe: z.boolean().default(true),
        localProjectId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const issue = await jira.createIssue(body);
    const { card } = jira.upsertIssueAsCard(issue);
    if (body.localProjectId) updateCard(card.id, { projectId: body.localProjectId }, false);
    hub.broadcast({ type: 'cards.changed' });
    return { issue, card: getCard(card.id) };
  });
  app.get('/api/jira/transitions/:key', async (req) => jira.listTransitions((req.params as { key: string }).key));
  app.post('/api/jira/transitions/:key', async (req) => {
    const { key } = req.params as { key: string };
    const body = z.object({ transition: z.string().min(1) }).parse(req.body);
    await jira.transitionIssue(key, body.transition);
    const issue = await jira.getIssue(key);
    jira.upsertIssueAsCard(issue);
    hub.broadcast({ type: 'cards.changed' });
    return { ok: true, status: issue.status };
  });

  // ----- Llama -----
  app.post('/api/llama/sync', async () => runSync('llama', { trigger: 'manual' }));
  /** Last sync time/result/error per source, for the board indicator. */
  app.get('/api/sync/state', async () => ({ jira: syncState('jira'), llama: syncState('llama') }));
  app.post('/api/llama/issues', async (req) => {
    const body = z
      .object({
        projectKey: z.string().default(env.llama.project),
        summary: z.string().min(3),
        description: z.string().default(''),
        type: z.enum(['EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK', 'TECHNICAL_TASK']).default('STORY'),
        priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'TRIVIAL']).nullable().optional(),
        epicKey: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        localProjectId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const issue = await llama.createIssue(body);
    const { card } = llama.upsertLlamaCard(issue);
    if (body.localProjectId) updateCard(card.id, { projectId: body.localProjectId }, false);
    hub.broadcast({ type: 'cards.changed' });
    return { issue, card: getCard(card.id) };
  });
  app.get('/api/llama/statuses', async (req) => llama.listStatuses((req.query as { project?: string }).project));
  app.post('/api/llama/status/:key', async (req) => {
    const { key } = req.params as { key: string };
    const body = z.object({ status: z.string().min(1) }).parse(req.body);
    await llama.setStatus(key, body.status);
    const issue = await llama.getIssue(key);
    llama.upsertLlamaCard(issue);
    hub.broadcast({ type: 'cards.changed' });
    return { ok: true, status: issue.status };
  });

  // ----- Second brain -----
  app.get('/api/brain/vaults', async () => brain.listVaults());
  app.get('/api/brain/vaults/:id/pages', async (req, reply) => {
    const v = brain.getVault((req.params as { id: string }).id);
    return v ? brain.listPages(v) : reply.code(404).send({ error: 'Unknown vault' });
  });
  app.get('/api/brain/vaults/:id/page', async (req, reply) => {
    const v = brain.getVault((req.params as { id: string }).id);
    if (!v) return reply.code(404).send({ error: 'Unknown vault' });
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path required' });
    return { path: q.path, content: brain.readPage(v, q.path) };
  });
  app.get('/api/brain/fathom/meetings', async (req) => {
    const q = req.query as { days?: string; refresh?: string };
    return brain.listFathomMeetings(Math.min(120, Math.max(1, Number(q.days || 7))), q.refresh === '1');
  });
  /** Fetches a meeting through Fathom and returns the export that an ingest would write (no vault changes). */
  app.get('/api/brain/fathom/meetings/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { url?: string; title?: string; createdAt?: string };
    const { getMeeting, renderMeetingExport } = await import('../services/fathom.js');
    const meeting = await getMeeting(id, { url: q.url, title: q.title, createdAt: q.createdAt });
    if (!meeting) return reply.code(404).send({ error: 'Meeting not found' });
    const text = renderMeetingExport(meeting);
    return { recordingId: id, title: meeting.title, chars: text.length, hasSummary: !!meeting.summaryMarkdown, preview: text.slice(0, 4000) };
  });
  app.post('/api/brain/vaults/:id/ingest', async (req) => {
    const body = z.object({ recordingId: z.string().min(1), createdAt: z.string().optional(), url: z.string().optional(), title: z.string().optional() }).parse(req.body);
    return brain.ingestMeetingJob((req.params as { id: string }).id, body.recordingId, { createdAt: body.createdAt, url: body.url, title: body.title });
  });
  app.post('/api/brain/vaults/:id/index-repo', async (req) => {
    const body = z.object({ projectId: z.string().min(1) }).parse(req.body);
    return brain.indexRepoJob((req.params as { id: string }).id, body.projectId);
  });
  app.post('/api/brain/vaults/:id/lint', async (req) => brain.lintJob((req.params as { id: string }).id));
  app.post('/api/brain/vaults/:id/query', async (req) => {
    const body = z.object({ question: z.string().min(2) }).parse(req.body);
    return brain.queryJob((req.params as { id: string }).id, body.question);
  });
  app.post('/api/brain/vaults/:id/open', async (req, reply) => {
    const v = brain.getVault((req.params as { id: string }).id);
    if (!v) return reply.code(404).send({ error: 'Unknown vault' });
    const { openInVsCode } = await import('../services/vscode.js');
    return openInVsCode(v.path);
  });

  // ----- Jobs -----
  app.get('/api/jobs', async () => listJobs());
  app.get('/api/jobs/:id', async (req, reply) => getJob((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Unknown job' }));

  // ----- Workflows -----
  app.get('/api/workflows', async () => listWorkflows());
  app.get('/api/workflows/:id', async (req, reply) => getWorkflow((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Unknown workflow' }));
  app.get('/api/workflows/:id/files', async (req) => listWorkflowFiles((req.params as { id: string }).id));
  app.put('/api/workflows/:id/files', async (req) => {
    const body = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body);
    saveWorkflowFile((req.params as { id: string }).id, body.path, body.content);
    return { ok: true, workflow: getWorkflow((req.params as { id: string }).id) };
  });
  app.delete('/api/workflows/:id/files', async (req) => {
    const body = z.object({ path: z.string().min(1) }).parse(req.body);
    deleteWorkflowFile((req.params as { id: string }).id, body.path);
    return { ok: true };
  });
  app.post('/api/workflows/:id/duplicate', async (req) => {
    const body = z.object({ newId: z.string().min(2), newName: z.string().min(2) }).parse(req.body);
    return duplicateWorkflow((req.params as { id: string }).id, body.newId, body.newName);
  });
  app.delete('/api/workflows/:id', async (req) => {
    deleteWorkflow((req.params as { id: string }).id);
    return { ok: true };
  });

  // ----- Runs -----
  app.post('/api/runs', async (req) => {
    const body = z.object({ cardId: z.string().min(1), workflowId: z.string().min(1), projectId: z.string().nullable().optional(), baseBranch: z.string().nullable().optional() }).parse(req.body);
    return startRun(body);
  });
  app.get('/api/runs', async (req) => {
    const q = req.query as { cardId?: string };
    return listRuns(q.cardId).map((r) => ({ ...r, active: isRunActive(r.id) }));
  });
  app.get('/api/runs/:id', async (req, reply) => {
    const run = getRun((req.params as { id: string }).id);
    return run ? { ...run, active: isRunActive(run.id) } : reply.code(404).send({ error: 'Unknown run' });
  });
  app.get('/api/runs/:id/events', async (req) => {
    const q = req.query as { after?: string };
    return listEvents((req.params as { id: string }).id, Number(q.after || 0));
  });
  app.post('/api/runs/:id/cancel', async (req) => ({ cancelled: cancelRun((req.params as { id: string }).id) }));
  app.post('/api/runs/:id/resume', async (req) => resumeRun((req.params as { id: string }).id));
  app.get('/api/runs/:id/diff', async (req, reply) => {
    const run = getRun((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'Unknown run' });
    return computeDiff(run.worktreePath, run.baseBranch);
  });

  // ----- Human requests -----
  app.get('/api/requests', async (req) => {
    const q = req.query as { status?: 'pending' | 'answered' | 'dismissed' };
    return listRequests(q.status);
  });
  app.post('/api/requests/:id/answer', async (req, reply) => {
    const body = z.object({ answers: z.record(z.string(), z.string()) }).parse(req.body);
    return answerRequest((req.params as { id: string }).id, body.answers) ?? reply.code(404).send({ error: 'Unknown request' });
  });
  app.post('/api/requests/:id/dismiss', async (req, reply) => dismissRequest((req.params as { id: string }).id) ?? reply.code(404).send({ error: 'Unknown request' }));

  // ----- Pull requests (Azure DevOps) -----
  app.post('/api/cards/:id/pr', async (req, reply) => {
    const card = getCard((req.params as { id: string }).id);
    if (!card) return reply.code(404).send({ error: 'Not found' });
    const project = card.projectId ? getProjectConfig(card.projectId) : undefined;
    if (!project?.ado) return reply.code(400).send({ error: 'Card has no project with an Azure DevOps mapping' });
    if (!card.worktreePath || !card.branch) return reply.code(400).send({ error: 'Card has no worktree/branch yet (run a workflow first)' });
    const body = z.object({ draft: z.boolean().default(true), targetBranch: z.string().optional(), title: z.string().optional(), description: z.string().optional() }).parse(req.body ?? {});
    const lastRun = listRuns(card.id)[0];
    const title = body.title || `${card.key ? `${card.key} - ` : ''}${card.title}`.slice(0, 250);
    const description = body.description || defaultPrDescription(card, lastRun?.summary || null);
    const pr = await ado.createPr(project, { worktree: card.worktreePath, sourceBranch: card.branch, targetBranch: body.targetBranch || card.baseBranch || project.baseBranches[0], title, description, draft: body.draft });
    updateCard(card.id, { prUrl: pr.url, prId: pr.id, column: 'pull_request' });
    // Best effort: move the tracker along with the card (e.g. IWC "Ready for Code Review").
    const transition = loadConfig().board.columnToJiraTransition.pull_request;
    if (card.source === 'jira' && card.key && transition && !body.draft) {
      jira.transitionIssue(card.key, transition).then(async () => jira.upsertIssueAsCard(await jira.getIssue(card.key!))).catch((e) => app.log.warn(`transition failed: ${String(e)}`));
    }
    return pr;
  });
  app.post('/api/cards/:id/pr/refresh', async (req, reply) => {
    const card = getCard((req.params as { id: string }).id);
    if (!card) return reply.code(404).send({ error: 'Not found' });
    const project = card.projectId ? getProjectConfig(card.projectId) : undefined;
    if (!project?.ado || !card.prId) return reply.code(400).send({ error: 'No PR on this card' });
    const pr = await ado.getPr(project, card.prId);
    if (pr.status === 'completed' && card.column === 'pull_request') updateCard(card.id, { column: 'done' });
    return pr;
  });
}

function defaultPrDescription(card: { key: string | null; title: string; url: string | null; description: string }, summary: string | null): string {
  const lines = [
    `## Summary`,
    card.title,
    '',
    `## Ticket Link`,
    card.url || card.key || '(local card)',
    '',
    `## Tasks Completed`,
    summary ? summary.slice(0, 2500) : '- See commits',
    '',
    `## How to Test`,
    '- See the implementer summary above',
    '',
    '🤖 Prepared by Software Factory',
  ];
  return lines.join('\n').slice(0, 4000);
}
