import { nanoid } from 'nanoid';
import { getSessionMessages, listSessions as sdkListSessions, query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ExternalSession, HumanRequestQuestion, SessionKind, SessionMessageLine, SessionStatus, SessionSummary } from '@sf/shared';
import { getDb, kvGet, kvSet, nowIso } from '../db.js';
import { hub, toast } from '../events.js';
import { logger } from '../logger.js';
import { readProjectMcpServers } from '../config.js';
import { askHuman } from './workflow/requests.js';

/**
 * Session registry: every headless Claude session the factory starts (workflow roles, brain jobs, MCP bridge calls,
 * free chats) is recorded here with its transcript, so the Sessions tab can show what is running and what ran.
 */

interface Row {
  id: string;
  provider: string;
  kind: SessionKind;
  title: string;
  cwd: string;
  model: string | null;
  card_id: string | null;
  run_id: string | null;
  role: string | null;
  step: string | null;
  claude_session_id: string | null;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  cost_usd: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  last_text: string | null;
  interactive: number;
}

const toSummary = (r: Row): SessionSummary => ({
  id: r.id,
  provider: 'claude',
  kind: r.kind,
  title: r.title,
  cwd: r.cwd,
  model: r.model,
  cardId: r.card_id,
  runId: r.run_id,
  role: r.role,
  step: r.step,
  claudeSessionId: r.claude_session_id,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  costUsd: r.cost_usd,
  turns: r.turns,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  lastText: r.last_text,
  interactive: !!r.interactive,
});

export interface SessionMeta {
  kind: SessionKind;
  title: string;
  cwd: string;
  model?: string | null;
  cardId?: string | null;
  runId?: string | null;
  role?: string | null;
  step?: string | null;
  interactive?: boolean;
}

export function registerSession(meta: SessionMeta): SessionSummary {
  const id = nanoid(10);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, provider, kind, title, cwd, model, card_id, run_id, role, step, claude_session_id, status, started_at, ended_at, cost_usd, turns, last_text, interactive)
       VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'starting', ?, NULL, 0, 0, NULL, ?)`,
    )
    .run(id, meta.kind, meta.title, meta.cwd, meta.model ?? null, meta.cardId ?? null, meta.runId ?? null, meta.role ?? null, meta.step ?? null, nowIso(), meta.interactive ? 1 : 0);
  const s = getSession(id)!;
  hub.broadcast({ type: 'session.changed', session: s });
  return s;
}

export function getSession(id: string): SessionSummary | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as Row | undefined;
  return row ? toSummary(row) : null;
}

export interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function updateSession(id: string, patch: Partial<{ status: SessionStatus; claudeSessionId: string | null; costUsd: number; turns: number; lastText: string | null; endedAt: string | null; model: string | null } & UsageCounters>): SessionSummary | null {
  const map: Record<string, string> = { status: 'status', claudeSessionId: 'claude_session_id', costUsd: 'cost_usd', turns: 'turns', lastText: 'last_text', endedAt: 'ended_at', model: 'model', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k]) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(v ?? null);
  }
  if (sets.length) getDb().prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]), id);
  const s = getSession(id);
  if (s) hub.broadcast({ type: 'session.changed', session: s });
  return s;
}

export function listSessions(opts: { includeBridge?: boolean; limit?: number; runId?: string; cardId?: string } = {}): SessionSummary[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (!opts.includeBridge) where.push("kind != 'bridge'");
  if (opts.runId) {
    where.push('run_id = ?');
    vals.push(opts.runId);
  }
  if (opts.cardId) {
    where.push('card_id = ?');
    vals.push(opts.cardId);
  }
  const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
  vals.push(opts.limit ?? 100);
  return (getDb().prepare(sql).all(...(vals as any[])) as unknown as Row[]).map(toSummary);
}

export function appendMessage(sessionId: string, type: SessionMessageLine['type'], text: string, data?: unknown): SessionMessageLine {
  const ts = nowIso();
  const res = getDb().prepare('INSERT INTO session_messages (session_id, ts, type, text, data) VALUES (?, ?, ?, ?, ?)').run(sessionId, ts, type, text, data === undefined ? null : JSON.stringify(data));
  const message: SessionMessageLine = { id: Number(res.lastInsertRowid), sessionId, ts, type, text, data: data ?? null };
  hub.broadcast({ type: 'session.message', message });
  return message;
}

export function listMessages(sessionId: string, afterId = 0, limit = 1000): SessionMessageLine[] {
  const rows = getDb().prepare('SELECT * FROM session_messages WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?').all(sessionId, afterId, limit) as any[];
  return rows.map((r) => ({ id: r.id, sessionId: r.session_id, ts: r.ts, type: r.type, text: r.text, data: r.data ? JSON.parse(r.data) : null }));
}

/** On boot: sessions still marked live belonged to a previous server process. */
export function failStaleSessions(): number {
  const res = getDb().prepare("UPDATE sessions SET status = 'interrupted', ended_at = ? WHERE status IN ('starting', 'running', 'waiting_human')").run(nowIso());
  return Number(res.changes);
}

/** Token counters from a result message (main loop usage plus per-model usage when present). */
export function usageFromResult(m: any): UsageCounters {
  const mu = m?.modelUsage && typeof m.modelUsage === 'object' ? Object.values(m.modelUsage as Record<string, any>) : [];
  if (mu.length) {
    return {
      inputTokens: mu.reduce((a: number, x: any) => a + Number(x.inputTokens || 0), 0),
      outputTokens: mu.reduce((a: number, x: any) => a + Number(x.outputTokens || 0), 0),
      cacheReadTokens: mu.reduce((a: number, x: any) => a + Number(x.cacheReadInputTokens || 0), 0),
      cacheWriteTokens: mu.reduce((a: number, x: any) => a + Number(x.cacheCreationInputTokens || 0), 0),
    };
  }
  const u = m?.usage || {};
  return { inputTokens: Number(u.input_tokens || 0), outputTokens: Number(u.output_tokens || 0), cacheReadTokens: Number(u.cache_read_input_tokens || 0), cacheWriteTokens: Number(u.cache_creation_input_tokens || 0) };
}

/** Remembers the latest plan-limit status Claude reported (five_hour / seven_day …) for the AI Usage panel. */
export function recordRateLimit(info: any): void {
  if (!info) return;
  const observedAt = nowIso();
  const windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? (info.unifiedWindows as Record<string, any>) : null;
  if (windows) {
    for (const [type, w] of Object.entries(windows)) {
      if (!w || typeof w !== 'object') continue;
      kvSet(`claude:ratelimit:${type}`, { rateLimitType: type, status: w.status ?? info.status, utilization: w.utilization ?? null, resetsAt: w.resetsAt ?? null, isUsingOverage: !!info.isUsingOverage, observedAt });
    }
    return;
  }
  const type = String(info.rateLimitType || 'unknown');
  kvSet(`claude:ratelimit:${type}`, { rateLimitType: type, status: info.status, utilization: info.utilization ?? null, resetsAt: info.resetsAt ?? null, isUsingOverage: !!info.isUsingOverage, observedAt });
}

/** Stores who Claude Code is logged in as (email, org, plan) once per server lifetime. */
export function probeAccount(q: any): void {
  if (kvGet('claude:account', null)) return;
  Promise.resolve()
    .then(() => q?.accountInfo?.())
    .then((a: any) => a && kvSet('claude:account', { email: a.email, organization: a.organization, subscriptionType: a.subscriptionType, apiProvider: a.apiProvider, observedAt: nowIso() }))
    .catch(() => undefined);
}

// ---------- Interactive chat sessions (streaming input) ----------

interface LiveChat {
  id: string;
  queue: string[];
  waiters: Array<() => void>;
  closed: boolean;
  /** Set when the server is shutting down: the chat ends as 'interrupted' so it can be continued after restart. */
  interrupted?: boolean;
  abort: AbortController;
  busy: boolean;
}

const chats = new Map<string, LiveChat>();

export const isChatLive = (id: string): boolean => chats.has(id);

async function* userMessages(chat: LiveChat): AsyncGenerator<any> {
  while (!chat.closed) {
    if (chat.queue.length) {
      const text = chat.queue.shift()!;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
      continue;
    }
    await new Promise<void>((resolve) => chat.waiters.push(resolve));
  }
}

const wake = (chat: LiveChat) => {
  const w = chat.waiters.splice(0);
  for (const r of w) r();
};

export interface StartChatInput {
  cwd: string;
  title: string;
  /** First message; omit to open the chat and wait for the human's first message. */
  prompt?: string | null;
  model?: string | null;
  resume?: string | null;
  projectPath?: string | null;
  cardId?: string | null;
  allowedTools?: string[];
  /** Continue on an existing session row (same transcript) instead of registering a new one. */
  sessionId?: string | null;
}

/** Starts a free-form session that keeps accepting messages until ended. Questions/permissions go to the Requests tab. */
export function startChat(input: StartChatInput): SessionSummary {
  const session = input.sessionId
    ? getSession(input.sessionId)!
    : registerSession({ kind: 'chat', title: input.title, cwd: input.cwd, model: input.model ?? null, cardId: input.cardId ?? null, interactive: true });
  const chat: LiveChat = { id: session.id, queue: input.prompt ? [input.prompt] : [], waiters: [], closed: false, abort: new AbortController(), busy: false };
  chats.set(session.id, chat);
  if (input.sessionId) {
    updateSession(session.id, { status: 'running', endedAt: null });
    appendMessage(session.id, 'system', input.resume ? 'Session resumed' : 'Session restarted');
  }
  if (input.prompt) appendMessage(session.id, 'user', input.prompt);

  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    if (toolName === 'AskUserQuestion') {
      const questions = ((toolInput as any).questions || []) as HumanRequestQuestion[];
      appendMessage(session.id, 'question', questions.map((q) => q.question).join(' | '), toolInput);
      updateSession(session.id, { status: 'waiting_human' });
      const { answer } = askHuman({ runId: `session:${session.id}`, cardId: input.cardId ?? '', step: null, role: 'chat', kind: 'question', questions, signal: options.signal });
      const answers = await answer;
      updateSession(session.id, { status: 'running' });
      if (!answers) return { behavior: 'deny', message: 'The human dismissed the question; continue with your best judgement.' };
      appendMessage(session.id, 'user', `(answer) ${Object.values(answers).join(' | ')}`);
      return { behavior: 'allow', updatedInput: { ...toolInput, answers } };
    }
    const summary = `${toolName} ${JSON.stringify(toolInput).slice(0, 160)}`;
    updateSession(session.id, { status: 'waiting_human' });
    const { answer } = askHuman({
      runId: `session:${session.id}`,
      cardId: input.cardId ?? '',
      step: null,
      role: 'chat',
      kind: 'permission',
      toolName,
      toolInput,
      questions: [{ question: `Allow ${summary}?`, header: 'Permission', options: [{ label: 'Allow', description: 'Run this call once' }, { label: 'Allow for this session', description: 'Do not ask again for this tool' }, { label: 'Deny', description: 'Refuse' }], multiSelect: false }],
      signal: options.signal,
    });
    const answers = await answer;
    updateSession(session.id, { status: 'running' });
    const choice = answers ? Object.values(answers)[0] : 'Deny';
    if (!answers || choice === 'Deny') return { behavior: 'deny', message: 'The human denied this tool call.' };
    if (choice === 'Allow for this session') return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: options.suggestions };
    return { behavior: 'allow', updatedInput: toolInput };
  };

  const mcpServers = input.projectPath ? readProjectMcpServers(input.projectPath) : {};
  const options: Options = {
    cwd: input.cwd,
    model: input.model || undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
    canUseTool,
    settingSources: ['user', 'project', 'local'],
    allowedTools: input.allowedTools?.length ? input.allowedTools : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill', 'TodoWrite'],
    mcpServers: Object.keys(mcpServers).length ? (mcpServers as any) : undefined,
    resume: input.resume || undefined,
    abortController: chat.abort,
    maxTurns: 400,
    env: { ...process.env },
  };

  void (async () => {
    let cost = getSession(session.id)?.costUsd ?? 0;
    let turns = getSession(session.id)?.turns ?? 0;
    try {
      updateSession(session.id, { status: 'running' });
      const q = query({ prompt: userMessages(chat), options });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const m = msg as any;
        if (m.type === 'system' && m.subtype === 'init') {
          updateSession(session.id, { claudeSessionId: m.session_id, model: m.model });
          probeAccount(q);
        }
        else if (m.type === 'assistant' && !m.parent_tool_use_id) {
          chat.busy = true;
          for (const block of m.message?.content || []) {
            if (block.type === 'text' && block.text) {
              appendMessage(session.id, 'assistant', block.text);
              updateSession(session.id, { lastText: block.text.slice(0, 300) });
            } else if (block.type === 'tool_use') appendMessage(session.id, 'tool_use', `${block.name} ${JSON.stringify(block.input).slice(0, 300)}`, { name: block.name, input: block.input, id: block.id });
          }
        } else if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            if (block.type === 'tool_result') {
              const text = Array.isArray(block.content) ? block.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : String(block.content ?? '');
              appendMessage(session.id, 'tool_result', text.length > 1500 ? `${text.slice(0, 1500)}…` : text, { id: block.tool_use_id, isError: !!block.is_error });
            }
          }
        } else if (m.type === 'rate_limit_event') {
          recordRateLimit(m.rate_limit_info);
        } else if (m.type === 'result') {
          chat.busy = false;
          cost += Number(m.total_cost_usd || 0);
          turns += Number(m.num_turns || 0);
          const u = usageFromResult(m);
          updateSession(session.id, { costUsd: cost, turns, status: chat.closed ? 'done' : 'running', inputTokens: (getSession(session.id)?.inputTokens ?? 0) + u.inputTokens, outputTokens: (getSession(session.id)?.outputTokens ?? 0) + u.outputTokens });
          if (m.subtype !== 'success') appendMessage(session.id, 'system', `turn ended: ${m.subtype}${Array.isArray(m.errors) && m.errors.length ? ` — ${m.errors.join('; ')}` : ''}`);
        }
      }
      if (chat.interrupted) appendMessage(session.id, 'system', 'Server stopped; continue this chat after restart');
      updateSession(session.id, { status: chat.interrupted ? 'interrupted' : 'done', endedAt: nowIso(), costUsd: cost, turns });
    } catch (e: any) {
      const cancelled = chat.abort.signal.aborted;
      appendMessage(session.id, 'system', chat.interrupted ? 'Server stopped; continue this chat after restart' : cancelled ? 'Session ended' : `Session failed: ${String(e?.message || e)}`);
      updateSession(session.id, { status: chat.interrupted ? 'interrupted' : chat.closed ? 'done' : cancelled ? 'cancelled' : 'failed', endedAt: nowIso(), costUsd: cost, turns });
      if (!cancelled) {
        logger.error({ err: e, session: session.id }, 'chat session failed');
        toast('error', `${input.title}: ${String(e?.message || e)}`);
      }
    } finally {
      chats.delete(session.id);
    }
  })();

  return getSession(session.id) ?? session;
}

/**
 * Continues an ended/interrupted session on the same Claude session id.
 * Chats continue in place (same row, same transcript, composer reopens; no prompt is sent unless given).
 * Other kinds (workflow roles, brain jobs, bridges) become a new interactive chat that picks up the context.
 */
export function resumeSessionAsChat(id: string, prompt?: string): SessionSummary {
  const s = getSession(id);
  if (!s) throw new Error('Unknown session');
  if (!s.claudeSessionId) throw new Error('This session has no Claude session id to resume');
  if (isChatLive(id)) throw new Error('Session is still live');
  const text = prompt?.trim() || null;
  if (s.kind === 'chat' && s.interactive) {
    return startChat({ sessionId: s.id, cwd: s.cwd, title: s.title, prompt: s.status === 'interrupted' && !text ? INTERRUPTED_PROMPT : text, model: s.model, resume: s.claudeSessionId, cardId: s.cardId });
  }
  return startChat({
    cwd: s.cwd,
    title: s.title.startsWith('Resumed: ') ? s.title : `Resumed: ${s.title}`,
    prompt: text || (s.status === 'interrupted' ? INTERRUPTED_PROMPT : 'Continue where we left off. Summarize the current state in two lines, then wait for my instructions.'),
    model: s.model,
    resume: s.claudeSessionId,
    cardId: s.cardId,
  });
}

const INTERRUPTED_PROMPT = 'The server was interrupted while you were working. Summarize in a few lines where you stopped and what remains, then continue; if a human decision is needed, ask.';

export function sendChatMessage(id: string, text: string): SessionMessageLine {
  const chat = chats.get(id);
  if (!chat) throw new Error('Session is not live (ended or never interactive); start a new one or resume it');
  chat.queue.push(text);
  wake(chat);
  return appendMessage(id, 'user', text);
}

export function endChat(id: string): boolean {
  const chat = chats.get(id);
  if (!chat) return false;
  chat.closed = true;
  wake(chat);
  // The generator ends on its next loop; abort too in case a turn is mid-flight.
  setTimeout(() => chat.abort.abort(), 500);
  return true;
}

export function abortAllChats(): number {
  let n = 0;
  for (const [id, chat] of [...chats.entries()]) {
    chat.interrupted = true;
    if (endChat(id)) n++;
  }
  return n;
}

// ---------- Claude Code sessions on disk (terminal, factory, anything) ----------

export async function listExternalSessions(opts: { dir?: string; limit?: number } = {}): Promise<ExternalSession[]> {
  const list = await sdkListSessions({ dir: opts.dir, limit: opts.limit ?? 40, includeWorktrees: true, includeProgrammatic: true } as any);
  return list.map((s: any) => ({
    sessionId: s.sessionId,
    summary: s.customTitle || s.summary || s.firstPrompt || '(untitled)',
    firstPrompt: s.firstPrompt ?? null,
    customTitle: s.customTitle ?? null,
    cwd: s.cwd ?? null,
    gitBranch: s.gitBranch ?? null,
    lastModified: s.lastModified ? new Date(s.lastModified).toISOString() : null,
    createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
  }));
}

export async function externalSessionMessages(sessionId: string, dir?: string, limit = 400): Promise<SessionMessageLine[]> {
  const msgs = await getSessionMessages(sessionId, { dir, limit } as any);
  const out: SessionMessageLine[] = [];
  let i = 0;
  for (const m of msgs as any[]) {
    if (m.parent_tool_use_id) continue;
    const content = m.message?.content;
    if (typeof content === 'string') out.push({ id: ++i, sessionId, ts: '', type: m.type === 'user' ? 'user' : 'assistant', text: content, data: null });
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) out.push({ id: ++i, sessionId, ts: '', type: m.type === 'user' ? 'user' : 'assistant', text: block.text, data: null });
        else if (block.type === 'tool_use') out.push({ id: ++i, sessionId, ts: '', type: 'tool_use', text: `${block.name} ${JSON.stringify(block.input).slice(0, 300)}`, data: null });
        else if (block.type === 'tool_result') {
          const text = Array.isArray(block.content) ? block.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : String(block.content ?? '');
          out.push({ id: ++i, sessionId, ts: '', type: 'tool_result', text: text.length > 800 ? `${text.slice(0, 800)}…` : text, data: null });
        }
      }
    }
  }
  return out;
}
