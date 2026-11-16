import fs from 'node:fs';
import { logger } from '../logger.js';
import { runClaude } from './claude.js';

/**
 * MCP bridge: calls a tool exposed to the user's Claude Code (typically a claude.ai connector such as
 * the Atlassian or Fathom MCP) through a one-shot headless session and returns the raw tool result.
 * This reuses the connectors the user already authorized, so no API tokens are needed locally.
 * Cost: one small Haiku turn (≈ $0.01) and ~6 s per call.
 */

export class McpToolError extends Error {
  constructor(message: string, public readonly tool: string, public readonly raw: string) {
    super(message);
  }
}

export interface McpCallOptions {
  /** Working directory for the bridge session (defaults to the server's home). */
  cwd?: string;
  retries?: number;
  model?: string;
}

function responseToText(resp: unknown): { text: string; isError: boolean } {
  if (resp == null) return { text: '', isError: false };
  if (typeof resp === 'string') return { text: resp, isError: false };
  if (Array.isArray(resp)) return { text: resp.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join(''), isError: false };
  const r = resp as any;
  if (Array.isArray(r.content)) return { text: r.content.map((c: any) => c?.text ?? '').join(''), isError: !!r.isError || !!r.is_error };
  return { text: JSON.stringify(resp), isError: !!r.isError || !!r.is_error };
}

/** Returns the raw text of the tool result (JSON text for most connectors). */
export async function callMcpTool(tool: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const slot: { captured: { text: string; isError: boolean } | null; fallback: { text: string; isError: boolean } | null } = { captured: null, fallback: null };
    const res = await runClaude({
      cwd: opts.cwd || process.cwd(),
      model: opts.model || 'haiku',
      maxTurns: 4,
      allowedTools: [tool, 'ToolSearch'],
      minimalSystemPrompt:
        'You are a deterministic tool bridge. You call exactly the tool you are told to call, with exactly the arguments given, once. Some tools are deferred: if the tool is not in your current tool list, first run ToolSearch with the query `select:<tool name>` to load it, then call it. You never call any other tool and never change the arguments. After the tool returns, reply with the single word DONE. Only if ToolSearch cannot find the tool, reply with the single word UNAVAILABLE.',
      prompt: `Call the tool \`${tool}\` exactly once with exactly these arguments (JSON):\n${JSON.stringify(args)}\nIf it is not in your tool list yet, load it first with ToolSearch (query: select:${tool}). Then reply DONE.`,
      hooks: {
        PostToolUse: [
          {
            matcher: tool,
            hooks: [
              async (input: any) => {
                slot.captured = responseToText(input?.tool_response);
                return {};
              },
            ],
          },
        ],
      },
      onToolResult: (_id, text, isError) => {
        slot.fallback = { text, isError };
      },
      meta: { kind: 'bridge', title: tool },
    });
    const got = slot.captured ?? slot.fallback;
    if (got && !got.isError && got.text) return readSavedOutput(got.text);
    const reason = got?.isError ? `tool error: ${got.text.slice(0, 500)}` : /UNAVAILABLE/i.test(res.text) ? 'tool not available in this Claude session (is the connector authorized in claude.ai?)' : res.isError ? `session error: ${res.subtype} ${res.errors.join('; ')}` : 'no tool result captured';
    lastError = new McpToolError(`${tool}: ${reason}`, tool, got?.text ?? res.text);
    logger.warn({ tool, attempt, reason }, 'mcp bridge call failed');
    if (got?.isError && !/rate|timeout|temporar|unavailable|not available/i.test(got.text)) break; // deterministic failure: do not retry
  }
  throw lastError ?? new McpToolError(`${tool}: unknown failure`, tool, '');
}

/** Claude Code replaces oversized tool results with a notice pointing at a file; read the file when that happens. */
function readSavedOutput(text: string): string {
  const m = /Output has been saved to (\S+?\.txt)/.exec(text) || /saved to (\/[^\s"']+)/.exec(text);
  if (m) {
    try {
      const saved = fs.readFileSync(m[1], 'utf8');
      if (saved.trim()) return saved;
    } catch (e) {
      logger.warn({ path: m[1], err: String(e) }, 'could not read saved tool output');
    }
  }
  return text;
}

/** Calls a tool and parses the JSON it returns (leading non-JSON noise tolerated). */
export async function callMcpJson<T = any>(tool: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<T> {
  const text = await callMcpTool(tool, args, opts);
  return parseLooseJson<T>(text);
}

export function parseLooseJson<T = any>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const i = trimmed.search(/[{[]/);
    if (i >= 0) {
      try {
        return JSON.parse(trimmed.slice(i)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Tool returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
}
