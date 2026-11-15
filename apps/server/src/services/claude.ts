import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, HookCallbackMatcher, HookEvent, Options, PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';
import { nowIso } from '../db.js';
import { appendMessage, probeAccount, recordRateLimit, registerSession, updateSession, usageFromResult, type SessionMeta } from './sessions.js';

/**
 * Thin wrapper over the Claude Agent SDK: one call = one headless Claude Code session in `cwd`.
 * The user's ~/.claude settings, skills and the project's CLAUDE.md load as they would in the terminal.
 */

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  /** Appended to the Claude Code system prompt (role instructions). */
  systemPromptAppend?: string;
  model?: string | null;
  /** Pre-approved tools (names or `Bash(git *)` style patterns). */
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  mcpServers?: Record<string, any>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string | null;
  /** JSON schema for structured output (result.structured). */
  outputSchema?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  canUseTool?: CanUseTool;
  abortController?: AbortController;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Disable the Claude Code preset and use a minimal custom system prompt (fast, for tool bridging). */
  minimalSystemPrompt?: string;
  /** Registers the session in the Sessions tab (kind, title, card/run links). */
  meta?: Omit<SessionMeta, 'cwd'> & { cwd?: string };
  onInit?: (info: { sessionId: string; model: string; tools: string[]; skills: string[]; mcpServers: string[] }) => void;
  onText?: (text: string) => void;
  onTool?: (name: string, input: unknown, toolUseId: string) => void;
  onToolResult?: (toolUseId: string, content: string, isError: boolean) => void;
}

export interface RunClaudeResult {
  text: string;
  structured: unknown | null;
  sessionId: string | null;
  costUsd: number;
  numTurns: number;
  subtype: string;
  isError: boolean;
  errors: string[];
}

/** Default policy for unattended jobs: allow tools, refuse questions (the job prompt tells Claude to decide by itself). */
export const unattendedCanUseTool: CanUseTool = async (toolName, input) => {
  if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: 'Unattended run: there is no human available. Decide yourself using the available context and state your assumption.' };
  return { behavior: 'allow', updatedInput: input };
};

export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const options: Options = {
    cwd: opts.cwd,
    model: opts.model || undefined,
    systemPrompt: opts.minimalSystemPrompt
      ? opts.minimalSystemPrompt
      : opts.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
    hooks: opts.hooks,
    permissionMode: opts.permissionMode ?? 'acceptEdits',
    canUseTool: opts.canUseTool ?? unattendedCanUseTool,
    settingSources: ['user', 'project', 'local'],
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    additionalDirectories: opts.additionalDirectories,
    mcpServers: opts.mcpServers,
    maxTurns: opts.maxTurns ?? 100,
    maxBudgetUsd: opts.maxBudgetUsd,
    resume: opts.resume || undefined,
    abortController: opts.abortController,
    outputFormat: opts.outputSchema ? ({ type: 'json_schema', schema: opts.outputSchema } as any) : undefined,
    env: { ...process.env },
    stderr: (data) => logger.debug({ claude: data.trim() }, 'claude stderr'),
  };

  const texts: string[] = [];
  let sessionId: string | null = null;
  let final: RunClaudeResult | null = null;
  const record = opts.meta ? registerSession({ ...opts.meta, cwd: opts.meta.cwd || opts.cwd, model: opts.meta.model ?? opts.model ?? null }) : null;
  if (record) appendMessage(record.id, 'user', opts.prompt.length > 6000 ? `${opts.prompt.slice(0, 6000)}…` : opts.prompt);

  const q = query({ prompt: opts.prompt, options });
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    const m = msg as any;
    if (m.session_id && !sessionId) sessionId = m.session_id;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (record) updateSession(record.id, { status: 'running', claudeSessionId: m.session_id, model: m.model });
          probeAccount(q);
          opts.onInit?.({ sessionId: m.session_id, model: m.model, tools: m.tools || [], skills: m.skills || [], mcpServers: (m.mcp_servers || []).map((s: any) => `${s.name}:${s.status}`) });
        }
        break;
      case 'rate_limit_event':
        recordRateLimit(m.rate_limit_info);
        break;
      case 'assistant': {
        if (m.parent_tool_use_id) break; // subagent chatter is not part of the role's transcript
        for (const block of m.message?.content || []) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
            opts.onText?.(block.text);
            if (record) {
              appendMessage(record.id, 'assistant', block.text);
              updateSession(record.id, { lastText: block.text.slice(0, 300) });
            }
          } else if (block.type === 'tool_use') {
            opts.onTool?.(block.name, block.input, block.id);
            if (record) appendMessage(record.id, 'tool_use', `${block.name} ${safeJson(block.input, 300)}`, { name: block.name, id: block.id });
          }
        }
        break;
      }
      case 'user': {
        if (m.parent_tool_use_id) break;
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const text = Array.isArray(block.content) ? block.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('') : String(block.content ?? '');
              opts.onToolResult?.(block.tool_use_id, text, !!block.is_error);
              if (record && opts.meta?.kind !== 'bridge') appendMessage(record.id, 'tool_result', text.length > 1500 ? `${text.slice(0, 1500)}…` : text, { id: block.tool_use_id, isError: !!block.is_error });
            }
          }
        }
        break;
      }
      case 'result': {
        if (record) {
          const u = usageFromResult(m);
          updateSession(record.id, { status: m.subtype === 'success' ? 'done' : 'failed', endedAt: nowIso(), costUsd: Number(m.total_cost_usd || 0), turns: Number(m.num_turns || 0), ...u });
        }
        final = {
          text: m.subtype === 'success' && typeof m.result === 'string' && m.result ? m.result : texts.join('\n\n'),
          structured: m.structured_output ?? null,
          sessionId: m.session_id || sessionId,
          costUsd: Number(m.total_cost_usd || 0),
          numTurns: Number(m.num_turns || 0),
          subtype: m.subtype,
          isError: !!m.is_error || m.subtype !== 'success',
          errors: Array.isArray(m.errors) ? m.errors : [],
        };
        break;
      }
      default:
        break;
    }
  }
  if (!final) {
    final = { text: texts.join('\n\n'), structured: null, sessionId, costUsd: 0, numTurns: 0, subtype: 'no_result', isError: true, errors: ['Session ended without a result message'] };
    if (record) updateSession(record.id, { status: opts.abortController?.signal.aborted ? 'cancelled' : 'failed', endedAt: nowIso() });
  }
  return final;
}

function safeJson(v: unknown, max: number): string {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return '';
  }
}
