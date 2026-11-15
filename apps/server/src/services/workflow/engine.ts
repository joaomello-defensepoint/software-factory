import fs from 'node:fs';
import path from 'node:path';
import type { Card, HumanRequestQuestion, WorkflowDefinition, WorkflowRole, WorkflowRun, WorkflowStep } from '@sf/shared';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { readProjectMcpServers } from '../../config.js';
import { nowIso } from '../../db.js';
import { hub, toast } from '../../events.js';
import { logger } from '../../logger.js';
import { contextPack } from '../brain.js';
import { getCard, updateCard } from '../cards.js';
import { runClaude } from '../claude.js';
import { existingDesignDocs, getProjectConfig, loadConfig, type ProjectConfig } from '../projects.js';
import { git, run as runShell } from '../shell.js';
import { ensureCardWorktree } from '../cardWorktree.js';
import * as jira from '../jira.js';
import * as llama from '../llama.js';
import { getWorkflow } from './definitions.js';
import { markDelivered, notesBlock, undeliveredNotes } from '../notes.js';
import { askHuman } from './requests.js';
import { appendEvent, createRun, getRun, getRunState, saveRunState, updateRun, type RunState } from './runs.js';
import { renderTemplate } from './template.js';

const active = new Map<string, AbortController>();

export const isRunActive = (runId: string): boolean => active.has(runId);

/** Aborts every running session (used on shutdown so no Claude process outlives the server). */
export function abortAllRuns(): number {
  let n = 0;
  for (const ac of active.values()) {
    ac.abort();
    n++;
  }
  return n;
}

// ---------- Public API ----------

export async function startRun(input: { cardId: string; workflowId: string; projectId?: string | null; baseBranch?: string | null }): Promise<WorkflowRun> {
  const card = getCard(input.cardId);
  if (!card) throw new Error('Card not found');
  if (card.runId && isRunActive(card.runId)) throw new Error('This card already has an active run');
  const workflow = getWorkflow(input.workflowId);
  if (!workflow) throw new Error(`Unknown workflow ${input.workflowId}`);
  if (!workflow.steps.length) throw new Error('Workflow has no steps');
  const projectId = input.projectId || card.projectId;
  if (!projectId) throw new Error('Pick a project for this card first');
  const project = getProjectConfig(projectId);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  if (!fs.existsSync(project.path)) throw new Error(`Project folder missing: ${project.path}`);
  const baseBranch = input.baseBranch || card.baseBranch || project.baseBranches[0];

  const wt = await ensureCardWorktree(card.id, { projectId: project.id, baseBranch });
  if (wt.isMain) throw new Error(`Branch ${wt.branch} is checked out in the main checkout of ${project.name}; switch it to another branch (or remove that checkout) so the factory can use a worktree`);

  const run = createRun({ cardId: card.id, workflowId: workflow.id, projectId: project.id, worktreePath: wt.path, branch: wt.branch, baseBranch });
  updateCard(card.id, { runId: run.id, column: 'in_progress' });
  appendEvent(run.id, 'run_started', `Run started with workflow "${workflow.name}" in ${wt.path} (${wt.message})`);

  void execute(run.id, workflow, project, card).catch((e) => logger.error({ err: e, run: run.id }, 'run crashed'));
  return getRun(run.id)!;
}

export function cancelRun(runId: string): boolean {
  const ac = active.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

// ---------- Execution ----------

interface StepContext {
  ticket: { key: string; title: string; description: string; url: string; type: string };
  project: { name: string; path: string; baseBranch: string; designDocs: string; worktree: string };
  brain: string;
  diff: string;
  diffStat: string;
  /** Diff stat of uncommitted changes already present in the worktree when the run started (a previous attempt). */
  priorWork: string;
  /** Steering notes the human wrote for this card (oldest first). */
  notes: string;
  iteration: number;
  maxIterations: number;
  feedback: string | null;
  steps: Record<string, { output: string }>;
}

async function execute(runId: string, workflow: WorkflowDefinition, project: ProjectConfig, card: Card): Promise<void> {
  const ac = new AbortController();
  active.set(runId, ac);
  const run = getRun(runId)!;
  const state = getRunState(runId);
  let costUsd = 0;
  updateRun(runId, { status: 'running' });
  await moveTrackerToInProgress(card, runId);

  const mcpServers = readProjectMcpServers(project.path);
  const designDocs = existingDesignDocs(project, run.worktreePath);
  const brain = contextPack(project.vault);
  const prior = await computeDiff(run.worktreePath, run.baseBranch).catch(() => ({ diff: '', stat: '' }));
  const priorWork = prior.stat && prior.stat !== '(no changes)' ? prior.stat : '';
  if (priorWork) appendEvent(runId, 'log', `The worktree already has changes from a previous attempt:\n${priorWork.slice(0, 1500)}`);
  const roleById = new Map(workflow.roles.map((r) => [r.id, r]));

  const baseCtx = (): StepContext => ({
    ticket: { key: card.key || '(local)', title: card.title, description: card.description || '(no description)', url: card.url || '', type: card.issueType || '' },
    project: {
      name: project.name,
      path: project.path,
      baseBranch: run.baseBranch,
      designDocs: designDocs.length ? designDocs.map((d) => `- ${d}`).join('\n') : '- (no design docs configured for this project)',
      worktree: run.worktreePath,
    },
    brain,
    diff: '',
    diffStat: '',
    priorWork,
    notes: notesBlock(card.id),
    iteration: run.iteration,
    maxIterations: workflow.maxIterations,
    feedback: state.feedback,
    steps: Object.fromEntries(Object.entries(state.outputs).map(([k, v]) => [k, { output: v }])),
  });

  const canUseTool = (step: WorkflowStep, role: WorkflowRole | null): CanUseTool => async (toolName, input, options) => {
    if (toolName === 'AskUserQuestion') {
      const questions = ((input as any).questions || []) as HumanRequestQuestion[];
      appendEvent(runId, 'human_request', `${role?.name ?? 'agent'} asks the human: ${questions.map((q) => q.question).join(' | ')}`, { step: step.id, role: role?.id, data: input });
      updateRun(runId, { status: 'waiting_human' });
      const { answer } = askHuman({ runId, cardId: card.id, step: step.id, role: role?.id ?? null, kind: 'question', questions, signal: options.signal });
      const answers = await answer;
      updateRun(runId, { status: 'running' });
      if (!answers) return { behavior: 'deny', message: 'The human dismissed the question. Proceed with your best judgement and state the assumption.' };
      appendEvent(runId, 'human_answer', `Human answered: ${Object.values(answers).join(' | ')}`, { step: step.id, role: role?.id, data: answers });
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    // Any other tool that is not pre-approved: ask the human for permission.
    const summary = summarizeTool(toolName, input);
    appendEvent(runId, 'human_request', `${role?.name ?? 'agent'} needs permission: ${summary}`, { step: step.id, role: role?.id, data: { toolName, input } });
    updateRun(runId, { status: 'waiting_human' });
    const { answer } = askHuman({
      runId,
      cardId: card.id,
      step: step.id,
      role: role?.id ?? null,
      kind: 'permission',
      toolName,
      toolInput: input,
      questions: [{ question: `Allow ${summary}?`, header: 'Permission', options: [{ label: 'Allow', description: 'Run this call once' }, { label: 'Allow for this run', description: 'Do not ask again for this tool during this run' }, { label: 'Deny', description: 'Refuse; the agent must find another way' }], multiSelect: false }],
      signal: options.signal,
    });
    const answers = await answer;
    updateRun(runId, { status: 'running' });
    const choice = answers ? Object.values(answers)[0] : 'Deny';
    appendEvent(runId, 'human_answer', `Permission ${choice}: ${summary}`, { step: step.id, role: role?.id });
    if (choice === 'Deny' || !answers) return { behavior: 'deny', message: 'The human denied this tool call.' };
    if (choice === 'Allow for this run') return { behavior: 'allow', updatedInput: input, updatedPermissions: options.suggestions };
    return { behavior: 'allow', updatedInput: input };
  };

  /** Renders a step prompt; steering notes are appended unless the template places {{notes}} itself. */
  const renderStep = (step: WorkflowStep, template: string, ctx: StepContext): string => {
    const rendered = renderTemplate(template, ctx as any);
    if (!ctx.notes || /\{\{\s*notes\s*\}\}/.test(template)) return rendered;
    return `${rendered}\n\n## Steering notes from the human (oldest first — follow them, they override earlier instructions)\n${ctx.notes}`;
  };

  const runRole = async (step: WorkflowStep, role: WorkflowRole, prompt: string, extra: { outputSchema?: Record<string, unknown>; resume?: string | null } = {}) => {
    const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    const sessionKey = `${step.id}:${role.id}:${run.iteration}`;
    // Notes written while the session runs reach the agent right after its next tool call.
    markDelivered(undeliveredNotes(card.id, sessionKey).map((n) => n.id), sessionKey); // notes already in the prompt
    const steeringHook = async () => {
      const fresh = undeliveredNotes(card.id, sessionKey);
      if (!fresh.length) return {};
      markDelivered(fresh.map((n) => n.id), sessionKey);
      appendEvent(runId, 'human_note', `Delivered ${fresh.length} note(s) to ${role.name}`, { step: step.id, role: role.id, data: fresh.map((n) => n.text) });
      return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: `New steering note(s) from the human — follow them from now on:\n${fresh.map((n) => `- ${n.text}`).join('\n')}` } };
    };
    const allowed = role.tools.length ? role.tools : undefined;
    const disallowed = role.tools.length ? editTools.filter((t) => !role.tools.includes(t)) : undefined;
    appendEvent(runId, 'log', `${role.name} starts (${role.model || workflow.defaultModel})${extra.resume ? ' — resuming previous session' : ''}`, { step: step.id, role: role.id });
    const res = await runClaude({
      cwd: run.worktreePath,
      prompt,
      systemPromptAppend: role.prompt,
      model: role.model || workflow.defaultModel,
      allowedTools: allowed,
      disallowedTools: disallowed,
      mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
      maxTurns: step.maxTurns ?? 100,
      resume: extra.resume ?? null,
      outputSchema: extra.outputSchema,
      canUseTool: canUseTool(step, role),
      abortController: ac,
      hooks: { PostToolUse: [{ hooks: [steeringHook as any] }] },
      meta: { kind: 'workflow', title: `${card.key || card.title.slice(0, 40)} · ${role.name} (${step.name}, iteration ${run.iteration})`, cardId: card.id, runId, role: role.id, step: step.id },
      onInit: (info) => appendEvent(runId, 'log', `session ${info.sessionId} · model ${info.model} · ${info.skills.length} skills · mcp: ${info.mcpServers.join(', ') || 'none'}`, { step: step.id, role: role.id }),
      onText: (t) => appendEvent(runId, 'assistant_text', t.length > 4000 ? `${t.slice(0, 4000)}…` : t, { step: step.id, role: role.id }),
      onTool: (name, input, id) => appendEvent(runId, 'tool_use', `${name} ${summarizeTool(name, input)}`, { step: step.id, role: role.id, data: { id, name, input: truncate(input) } }),
    });
    costUsd += res.costUsd;
    updateRun(runId, { costUsd });
    if (res.sessionId) {
      state.sessions[role.id] = res.sessionId;
      saveRunState(runId, state);
    }
    if (res.isError && res.subtype !== 'error_max_turns') throw new Error(`${role.name} failed: ${res.subtype}${res.errors.length ? ` — ${res.errors.join('; ')}` : ''}`);
    if (res.subtype === 'error_max_turns') appendEvent(runId, 'log', `${role.name} hit the turn limit; using what it produced so far`, { step: step.id, role: role.id });
    return res;
  };

  try {
    let stepIndex = 0;
    let decided = false;
    while (stepIndex < workflow.steps.length) {
      if (ac.signal.aborted) throw new Error('cancelled');
      const step = workflow.steps[stepIndex];
      updateRun(runId, { currentStep: step.id, iteration: run.iteration });
      const ctx = baseCtx();
      if (step.kind !== 'shell' && /\{\{\s*diff(Stat)?\s*\}\}/.test(step.prompt)) {
        const d = await computeDiff(run.worktreePath, run.baseBranch);
        ctx.diff = d.diff;
        ctx.diffStat = d.stat;
      }
      appendEvent(runId, 'step_started', `Step "${step.name}" (${step.kind}) — iteration ${run.iteration}`, { step: step.id });

      if (step.kind === 'agent') {
        const role = roleById.get(step.roles[0]);
        if (!role) throw new Error(`Step ${step.id}: unknown role ${step.roles[0]}`);
        const res = await runRole(step, role, renderStep(step, step.prompt, ctx), { resume: step.resumeSession ? state.sessions[role.id] || null : null });
        state.outputs[step.id] = res.text;
        saveRunState(runId, state);
      } else if (step.kind === 'debate') {
        const roles = step.roles.map((id) => roleById.get(id)).filter((r): r is WorkflowRole => !!r);
        if (roles.length < 2) throw new Error(`Step ${step.id}: a debate needs at least two roles`);
        const basePrompt = renderStep(step, step.prompt, ctx);
        // Round 0: independent positions, in parallel.
        const first = await Promise.all(roles.map((r) => runRole(step, r, basePrompt).then((res) => ({ role: r, res }))));
        const positions = new Map(first.map(({ role, res }) => [role.id, res.text]));
        for (let round = 1; round <= (step.rounds ?? 1); round++) {
          if (ac.signal.aborted) throw new Error('cancelled');
          appendEvent(runId, 'log', `Debate round ${round}`, { step: step.id });
          const replies = await Promise.all(
            roles.map((r) => {
              const others = roles.filter((o) => o.id !== r.id).map((o) => `### ${o.name}\n${positions.get(o.id)}`).join('\n\n');
              const prompt = `${basePrompt}\n\n## Your previous position\n${positions.get(r.id)}\n\n## The other advocate's concerns\n${others}\n\nRespond to each of their concerns (agree / disagree with evidence / refine) and restate your final ranked list and BLOCKING line.`;
              return runRole(step, r, prompt, { resume: state.sessions[r.id] || null }).then((res) => ({ role: r, res }));
            }),
          );
          for (const { role, res } of replies) positions.set(role.id, res.text);
        }
        state.outputs[step.id] = roles.map((r) => `## ${r.name} — final position\n${positions.get(r.id)}`).join('\n\n');
        saveRunState(runId, state);
      } else if (step.kind === 'decision') {
        const role = roleById.get(step.roles[0]);
        if (!role) throw new Error(`Step ${step.id}: unknown role ${step.roles[0]}`);
        const outcomes = step.outcomes?.length ? step.outcomes : ['done', 'rework', 'ask_human'];
        const schema = {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: outcomes },
            rationale: { type: 'string' },
            instructions: { type: 'string', description: 'Numbered, concrete instructions for the implementer when decision=rework' },
            question: { type: 'string', description: 'The question for the human when decision=ask_human' },
            options: { type: 'array', items: { type: 'string' }, description: '2-4 options when decision=ask_human' },
            recommendation: { type: 'string' },
          },
          required: ['decision', 'rationale'],
          additionalProperties: false,
        };
        const res = await runRole(step, role, renderStep(step, step.prompt, ctx), { outputSchema: schema });
        const verdict = (res.structured as any) || parseDecisionFallback(res.text, outcomes);
        state.outputs[step.id] = `Decision: ${verdict.decision}\n\n${verdict.rationale || ''}${verdict.instructions ? `\n\nInstructions:\n${verdict.instructions}` : ''}`;
        state.decisions.push({ iteration: run.iteration, decision: verdict.decision, rationale: verdict.rationale || '' });
        saveRunState(runId, state);
        appendEvent(runId, 'decision', `Maestro: ${verdict.decision} — ${(verdict.rationale || '').slice(0, 500)}`, { step: step.id, role: role.id, data: verdict });

        if (verdict.decision === 'rework') {
          if (run.iteration >= workflow.maxIterations) {
            appendEvent(runId, 'log', `Max iterations (${workflow.maxIterations}) reached; handing over to the human with the maestro's remaining instructions`, { step: step.id });
            state.feedback = null;
            state.outputs[step.id] += `\n\n(Max iterations reached — the following instructions were NOT applied and need human attention:)\n${verdict.instructions || ''}`;
            saveRunState(runId, state);
            decided = true;
          } else {
            state.feedback = verdict.instructions || verdict.rationale;
            run.iteration += 1;
            saveRunState(runId, state);
            appendEvent(runId, 'iteration', `Rework requested → iteration ${run.iteration}`, { step: step.id, data: { instructions: state.feedback } });
            stepIndex = 0;
            continue;
          }
        } else if (verdict.decision === 'ask_human') {
          const options = (verdict.options || []).slice(0, 4).map((o: string) => ({ label: o.slice(0, 60), description: '' }));
          appendEvent(runId, 'human_request', `Maestro asks: ${verdict.question}`, { step: step.id, role: role.id, data: verdict });
          updateRun(runId, { status: 'waiting_human' });
          const { answer } = askHuman({
            runId,
            cardId: card.id,
            step: step.id,
            role: role.id,
            kind: 'question',
            questions: [{ question: verdict.question || 'The maestro needs a decision', header: 'Maestro', options: options.length >= 2 ? options : [{ label: 'Proceed as recommended', description: verdict.recommendation || '' }, { label: 'Stop here', description: 'Finish the run and let me take over' }], multiSelect: false }],
            signal: ac.signal,
          });
          const answers = await answer;
          updateRun(runId, { status: 'running' });
          const chosen = answers ? Object.values(answers).join(', ') : null;
          appendEvent(runId, 'human_answer', chosen ? `Human: ${chosen}` : 'Human dismissed the question', { step: step.id, role: role.id, data: answers });
          if (!chosen || /^stop here$/i.test(chosen)) {
            decided = true;
          } else {
            state.feedback = `The human decided on the open question.\nQuestion: ${verdict.question}\nAnswer: ${chosen}\n${verdict.recommendation ? `(Maestro's recommendation was: ${verdict.recommendation})` : ''}\nApply this decision.`;
            run.iteration += 1;
            saveRunState(runId, state);
            appendEvent(runId, 'iteration', `Applying the human's decision → iteration ${run.iteration}`, { step: step.id });
            stepIndex = 0;
            continue;
          }
        } else {
          decided = true;
        }
      } else if (step.kind === 'shell') {
        if (!step.command) throw new Error(`Step ${step.id}: shell step without command`);
        const cmd = renderTemplate(step.command, ctx as any);
        appendEvent(runId, 'shell', `$ ${cmd}`, { step: step.id });
        const res = await runShell('/bin/sh', ['-lc', cmd], { cwd: run.worktreePath, timeoutMs: 600_000 });
        const out = `${res.stdout}${res.stderr}`.trim();
        appendEvent(runId, 'shell', out ? out.slice(-4000) : `(exit ${res.code})`, { step: step.id, data: { code: res.code } });
        state.outputs[step.id] = out;
        saveRunState(runId, state);
        if (res.code !== 0) throw new Error(`Command failed (exit ${res.code}): ${cmd}`);
      } else if (step.kind === 'gate') {
        updateRun(runId, { status: 'waiting_human' });
        const { answer } = askHuman({ runId, cardId: card.id, step: step.id, role: null, kind: 'question', questions: [{ question: renderTemplate(step.prompt || 'Continue?', ctx as any), header: 'Gate', options: [{ label: 'Continue', description: '' }, { label: 'Stop', description: 'Finish the run here' }], multiSelect: false }], signal: ac.signal });
        const answers = await answer;
        updateRun(runId, { status: 'running' });
        if (!answers || /stop/i.test(Object.values(answers)[0] || '')) {
          appendEvent(runId, 'log', 'Stopped at gate by the human', { step: step.id });
          break;
        }
      }
      appendEvent(runId, 'step_finished', `Step "${step.name}" finished`, { step: step.id });
      stepIndex++;
    }

    const last = state.outputs[workflow.steps.find((s) => s.kind === 'decision')?.id || ''] || state.outputs[workflow.steps[0].id] || '';
    const summary = `${decided ? 'Maestro decision recorded. ' : ''}${last}`.slice(0, 8000);
    updateRun(runId, { status: 'succeeded', finishedAt: nowIso(), summary, currentStep: null, costUsd });
    updateCard(card.id, { column: 'human_review' });
    appendEvent(runId, 'run_finished', `Run finished — card moved to Human Review (cost ≈ $${costUsd.toFixed(2)})`);
    toast('success', `${card.key || card.title}: workflow finished, ready for your review`);
  } catch (e: any) {
    const cancelled = ac.signal.aborted || /cancelled|aborted/i.test(String(e?.message));
    const msg = cancelled ? 'Cancelled by the user' : String(e?.message || e);
    updateRun(runId, { status: cancelled ? 'cancelled' : 'failed', finishedAt: nowIso(), error: msg, currentStep: null, costUsd });
    appendEvent(runId, cancelled ? 'log' : 'error', msg);
    toast(cancelled ? 'info' : 'error', `${card.key || card.title}: ${msg}`);
  } finally {
    active.delete(runId);
    hub.broadcast({ type: 'cards.changed' });
  }
}

async function moveTrackerToInProgress(card: Card, runId: string): Promise<void> {
  try {
    if (card.source === 'jira' && card.key && jira.jiraConfigured()) {
      const name = loadConfig().board.columnToJiraTransition.in_progress;
      if (name && (card.externalStatus || '').toLowerCase() !== 'in progress') {
        await jira.transitionIssue(card.key, name);
        updateCard(card.id, { externalStatus: 'In Progress' }, false);
        appendEvent(runId, 'log', `Jira ${card.key} → In Progress`);
      }
    } else if (card.source === 'llama' && card.key && llama.llamaConfigured()) {
      if ((card.externalStatus || '').toLowerCase() !== 'in progress') {
        await llama.setStatus(card.key, 'In Progress');
        updateCard(card.id, { externalStatus: 'In Progress' }, false);
        appendEvent(runId, 'log', `Llama ${card.key} → In Progress`);
      }
    }
  } catch (e) {
    appendEvent(runId, 'log', `Could not move ${card.key} to In Progress in the tracker: ${String((e as Error).message)}`);
  }
}

export async function computeDiff(worktree: string, baseBranch: string): Promise<{ diff: string; stat: string }> {
  await git(worktree, ['add', '-A']);
  const remote = (await git(worktree, ['rev-parse', '--verify', '--quiet', `origin/${baseBranch}`])).code === 0 ? `origin/${baseBranch}` : baseBranch;
  const mb = (await git(worktree, ['merge-base', 'HEAD', remote])).stdout.trim() || 'HEAD';
  const stat = (await git(worktree, ['diff', '--cached', '--stat', mb])).stdout.trim();
  const full = (await git(worktree, ['diff', '--cached', mb])).stdout;
  const MAX = 80_000;
  const diff = full.length > MAX ? `${full.slice(0, MAX)}\n…(diff truncated at ${MAX} chars; read the files for the rest)` : full;
  return { diff: diff || '(no changes)', stat: stat || '(no changes)' };
}

function parseDecisionFallback(text: string, outcomes: string[]): { decision: string; rationale: string; instructions?: string; question?: string; options?: string[]; recommendation?: string } {
  const m = /```json\s*([\s\S]*?)```/.exec(text);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through */
    }
  }
  const lower = text.toLowerCase();
  const found = outcomes.find((o) => new RegExp(`\\b${o.replace('_', '[_ ]')}\\b`).test(lower));
  return { decision: found || outcomes[0], rationale: text.slice(0, 2000), instructions: found === 'rework' ? text : undefined };
}

function summarizeTool(name: string, input: unknown): string {
  const i = (input || {}) as Record<string, any>;
  if (name === 'Bash') return `Bash: ${String(i.command || '').slice(0, 200)}`;
  if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(name)) return `${name} ${String(i.file_path || i.path || '').replace(/^.*?\/\.claude\/worktrees\/[^/]+\//, '')}`;
  if (name === 'Glob' || name === 'Grep') return `${name} ${String(i.pattern || '')}`;
  try {
    const s = JSON.stringify(input);
    return `${name} ${s.length > 160 ? `${s.slice(0, 160)}…` : s}`;
  } catch {
    return name;
  }
}

function truncate(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : v;
  } catch {
    return String(v);
  }
}

