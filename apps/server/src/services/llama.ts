import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Card, ColumnId } from '@sf/shared';
import { env, readMcpServerEnv } from '../config.js';
import { nowIso } from '../db.js';
import { createCard, getCardByKey, updateCard } from './cards.js';
import { guessProjectForKey } from './projects.js';
import { hub } from '../events.js';
import { logger } from '../logger.js';

/**
 * Llama (ag-llama.com) client. Talks to the same `@agllama/mcp` server the user already has configured in ~/.claude.json,
 * so no second credential is needed.
 */

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

export function llamaEnv(): Record<string, string> {
  const fromClaude = readMcpServerEnv('llama');
  return {
    ...fromClaude,
    ...(env.llama.apiUrl ? { LLAMA_API_URL: env.llama.apiUrl } : {}),
    ...(env.llama.apiKey ? { LLAMA_API_KEY: env.llama.apiKey } : {}),
  };
}

export const llamaConfigured = (): boolean => !!llamaEnv().LLAMA_API_KEY;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@agllama/mcp'],
      env: { ...(process.env as Record<string, string>), ...llamaEnv() },
      stderr: 'ignore',
    });
    const c = new Client({ name: 'software-factory', version: '0.1.0' });
    await c.connect(transport);
    client = c;
    transport.onclose = () => {
      client = null;
      connecting = null;
    };
    return c;
  })();
  try {
    return await connecting;
  } catch (e) {
    connecting = null;
    throw e;
  }
}

export async function closeLlama(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) await c.close().catch(() => undefined);
}

export async function callLlama<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const c = await getClient();
  const res: any = await c.callTool({ name, arguments: { orgSlug: env.llama.org, projectKey: env.llama.project, ...args } });
  const text = (res.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
  if (res.isError) throw new Error(`Llama ${name}: ${text.slice(0, 400)}`);
  // Responses carry a "[Session: ...]" header before the JSON body.
  const jsonStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = jsonStart < 0 ? arrStart : arrStart < 0 ? jsonStart : Math.min(jsonStart, arrStart);
  if (start < 0) return text as unknown as T;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return text as unknown as T;
  }
}

export interface LlamaIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  priority: string | null;
  labels: string[];
  epicKey: string | null;
  url: string | null;
}

function mapIssue(raw: any): LlamaIssue {
  const statusName = typeof raw.status === 'string' ? raw.status : raw.status?.name || raw.statusName || '';
  return {
    key: raw.key || raw.issueKey,
    summary: raw.summary || raw.title || '',
    description: raw.description || raw.descriptionSnippet || '',
    status: statusName,
    type: raw.type || raw.issueType || '',
    priority: raw.priority || null,
    labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean) : [],
    epicKey: raw.epicKey || raw.epic?.key || raw.parentKey || null,
    url: raw.url || raw.webUrl || null,
  };
}

export async function findMyUserId(emails: string[]): Promise<string | null> {
  const members: any = await callLlama('llama_list_members');
  const list: any[] = Array.isArray(members) ? members : members?.members || members?.data || [];
  const wanted = emails.map((e) => e.toLowerCase());
  const me = list.find((m) => wanted.includes(String(m.email || m.user?.email || '').toLowerCase()));
  return me ? String(me.id || me.userId || me.user?.id) : null;
}

export async function searchMyIssues(emails: string[]): Promise<LlamaIssue[]> {
  const uid = await findMyUserId(emails);
  if (!uid) throw new Error(`Could not find a Llama member matching ${emails.join(', ')}`);
  const res: any = await callLlama('llama_search', { assigneeId: uid, projectKey: '*', limit: 50 });
  const hits: any[] = Array.isArray(res) ? res : res?.results || res?.issues || res?.hits || [];
  return hits.map(mapIssue);
}

export async function getIssue(key: string): Promise<LlamaIssue> {
  const res: any = await callLlama('llama_get_issue', { issueKey: key });
  return mapIssue(res?.issue || res);
}

export async function createIssue(input: { summary: string; description: string; type: string; priority?: string | null; epicKey?: string | null; labels?: string[]; projectKey?: string }): Promise<LlamaIssue> {
  const res: any = await callLlama('llama_create_issue', {
    summary: input.summary,
    description: input.description,
    type: input.type,
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.epicKey ? { epicKey: input.epicKey } : {}),
    ...(input.labels?.length ? { labels: input.labels } : {}),
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
  });
  return mapIssue(res?.issue || res);
}

export async function listStatuses(projectKey?: string): Promise<Array<{ id: string; name: string }>> {
  const ctx: any = await callLlama('llama_context', { compact: true, ...(projectKey ? { projectKey } : {}) });
  return (ctx?.statuses || []).map((s: any) => ({ id: s.id, name: s.name }));
}

export async function setStatus(key: string, statusName: string): Promise<void> {
  const projectKey = key.split('-')[0];
  const statuses = await listStatuses(projectKey);
  const st = statuses.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
  if (!st) throw new Error(`Status "${statusName}" not found in ${projectKey} (${statuses.map((s) => s.name).join(', ')})`);
  await callLlama('llama_update_issue', { issueKey: key, statusId: st.id, projectKey });
}

export function columnForLlamaStatus(status: string): ColumnId {
  const s = status.toLowerCase();
  if (['done', 'closed', 'released'].includes(s)) return 'done';
  if (['in review', 'unit test', 'review', 'qa'].includes(s)) return 'human_review';
  if (s === 'in progress') return 'in_progress';
  return 'backlog';
}

export function upsertLlamaCard(issue: LlamaIssue): { card: Card; created: boolean } {
  const existing = getCardByKey(issue.key);
  const col = columnForLlamaStatus(issue.status);
  const base = {
    source: 'llama' as const,
    key: issue.key,
    url: issue.url,
    title: issue.summary,
    description: issue.description,
    issueType: issue.type,
    priority: issue.priority,
    labels: issue.labels,
    epicKey: issue.epicKey,
    externalStatus: issue.status,
    syncedAt: nowIso(),
  };
  if (!existing) return { card: createCard({ ...base, column: col, projectId: guessProjectForKey(issue.key, issue.summary) }, false), created: true };
  const patch: Partial<Card> = { ...base };
  const localManaged = ['in_progress', 'human_review', 'pull_request'].includes(existing.column) && !!(existing.runId || existing.prUrl || existing.worktreePath);
  if (col === 'done' || !localManaged) patch.column = col;
  return { card: updateCard(existing.id, patch, false)!, created: false };
}

export async function syncFromLlama(emails: string[]): Promise<{ imported: number; updated: number; total: number }> {
  const issues = await searchMyIssues(emails);
  let imported = 0;
  let updated = 0;
  for (const issue of issues) {
    try {
      const full = issue.description && issue.description.length > 200 ? issue : await getIssue(issue.key).catch(() => issue);
      const r = upsertLlamaCard(full);
      if (r.created) imported++;
      else updated++;
    } catch (e) {
      logger.warn({ key: issue.key, err: String(e) }, 'llama upsert failed');
    }
  }
  hub.broadcast({ type: 'cards.changed' });
  return { imported, updated, total: issues.length };
}
