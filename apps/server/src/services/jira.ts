import type { Card, ColumnId } from '@sf/shared';
import { SF_HOME, env } from '../config.js';
import { kvGet, kvSet, nowIso } from '../db.js';
import { callMcpJson, callMcpTool, parseLooseJson } from './mcp.js';
import { createCard, getCardByKey, listCards, updateCard } from './cards.js';
import { guessProjectForKey, loadConfig } from './projects.js';
import { hub } from '../events.js';
import { logger } from '../logger.js';

export const jiraMode = (): 'mcp' | 'rest' => env.jira.mode;
const restConfigured = (): boolean => !!(env.jira.baseUrl && env.jira.email && env.jira.token);
/** MCP mode needs nothing locally: it goes through the claude.ai Atlassian connector the user authorized. */
export const jiraConfigured = (): boolean => (jiraMode() === 'mcp' ? true : restConfigured());

async function jiraFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!restConfigured()) throw new Error('Jira REST is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
  const auth = Buffer.from(`${env.jira.email}:${env.jira.token}`).toString('base64');
  const res = await fetch(`${env.jira.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// ---------- ADF (Atlassian Document Format) helpers ----------

export function adfToText(node: any, depth = 0): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const children = (node.content || []).map((c: any) => adfToText(c, depth + 1));
  switch (node.type) {
    case 'doc':
      return children.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    case 'paragraph':
      return children.join('');
    case 'text': {
      let t = node.text || '';
      for (const m of node.marks || []) {
        if (m.type === 'code') t = `\`${t}\``;
        if (m.type === 'strong') t = `**${t}**`;
        if (m.type === 'link' && m.attrs?.href) t = `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'heading':
      return `${'#'.repeat(node.attrs?.level || 1)} ${children.join('')}`;
    case 'bulletList':
      return children.join('\n');
    case 'orderedList':
      return children.map((c: string, i: number) => c.replace(/^- /, `${i + 1}. `)).join('\n');
    case 'listItem':
      return `- ${children.join('\n').replace(/\n/g, '\n  ')}`;
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language || ''}\n${children.join('')}\n\`\`\``;
    case 'blockquote':
      return children.map((c: string) => `> ${c}`).join('\n');
    case 'rule':
      return '---';
    case 'mention':
      return `@${node.attrs?.text || node.attrs?.id || ''}`;
    case 'inlineCard':
      return node.attrs?.url || '';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[attachment]';
    case 'table':
      return children.join('\n');
    case 'tableRow':
      return `| ${children.join(' | ')} |`;
    case 'tableHeader':
    case 'tableCell':
      return children.join(' ');
    case 'panel':
      return children.join('\n');
    default:
      return children.join('');
  }
}

/** Minimal markdown → ADF: headings, bullet lists, code fences, paragraphs. */
export function textToAdf(text: string): any {
  const lines = text.replace(/\r/g, '').split('\n');
  const content: any[] = [];
  let i = 0;
  const para = (t: string) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      content.push({ type: 'heading', attrs: { level: h[1].length }, content: [{ type: 'text', text: h[2] }] });
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', attrs: lang ? { language: lang } : {}, content: [{ type: 'text', text: buf.join('\n') }] });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: any[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*[-*]\s+/, ''))] });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: any[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*\d+\.\s+/, ''))] });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) buf.push(lines[i++]);
    content.push(para(buf.join(' ')));
  }
  return { type: 'doc', version: 1, content: content.length ? content : [para('')] };
}

// ---------- MCP (claude.ai Atlassian connector) ----------

const mcpTool = (name: string): string => `${env.jira.mcpPrefix}${name}`;
const mcpOpts = { cwd: SF_HOME };

/** The connector returns issues as { issues: { nodes: [...], pageInfo } } or { issues: [...] }; normalise. */
function mcpIssueNodes(res: any): { nodes: any[]; nextCursor: string | null } {
  const container = res?.issues ?? res?.data?.issues ?? res;
  if (Array.isArray(container)) return { nodes: container, nextCursor: res?.nextPageToken ?? null };
  const nodes: any[] = container?.nodes ?? container?.issues ?? [];
  const pageInfo = container?.pageInfo ?? res?.pageInfo;
  const nextCursor = pageInfo?.hasNextPage ? pageInfo.endCursor ?? null : res?.nextPageToken ?? null;
  return { nodes, nextCursor };
}

function mcpFindIssue(res: any): any {
  if (res?.key && res?.fields) return res;
  for (const k of ['issue', 'data', 'result']) if (res?.[k]?.key && res[k].fields) return res[k];
  const { nodes } = mcpIssueNodes(res);
  if (nodes[0]?.key) return nodes[0];
  throw new Error(`Unexpected issue shape from the Atlassian MCP: ${JSON.stringify(res).slice(0, 200)}`);
}

async function mcpSearchIssues(jql: string, max: number): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let token: string | null = null;
  do {
    const res = await callMcpJson(mcpTool('searchJiraIssuesUsingJql'), { cloudId: env.jira.cloudId, jql, maxResults: 20, fields: FIELDS, ...(token ? { nextPageToken: token } : {}) }, mcpOpts);
    const { nodes, nextCursor } = mcpIssueNodes(res);
    out.push(...nodes.map(mapIssue));
    token = nextCursor;
  } while (token && out.length < max);
  return out;
}

async function mcpGetIssue(key: string): Promise<JiraIssue> {
  const res = await callMcpJson(mcpTool('getJiraIssue'), { cloudId: env.jira.cloudId, issueIdOrKey: key, fields: FIELDS, fieldsByKeys: true }, mcpOpts);
  return mapIssue(mcpFindIssue(res));
}

async function mcpMyself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
  const res = await callMcpJson(mcpTool('atlassianUserInfo'), {}, mcpOpts);
  const d = res?.data ?? res;
  return { accountId: d.accountId, displayName: d.displayName || d.name || '', emailAddress: d.email || d.emailAddress };
}

let discovered: Record<string, string> = {};

/** Resolves an operation name through the connector's discover tool (names differ per server version). */
async function mcpOperation(query: string, preferred: string[]): Promise<string> {
  if (discovered[query]) return discovered[query];
  const text = await callMcpTool(mcpTool('discover'), { query }, mcpOpts);
  const names = [...text.matchAll(/"name"\s*:\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
  const found = preferred.find((p) => names.includes(p) || text.includes(p)) || names[0];
  if (!found) throw new Error(`Atlassian MCP: no operation found for "${query}"`);
  discovered[query] = found;
  return found;
}

async function mcpListTransitions(key: string): Promise<Array<{ id: string; name: string; to: string }>> {
  const name = await mcpOperation('list transitions for a jira issue', ['listJiraIssueTransitions', 'getTransitionsForJiraIssue']);
  const text = await callMcpTool(mcpTool('executeRead'), { name, cloudId: env.jira.cloudId, inputs: { issueIdOrKey: key } }, mcpOpts);
  const res = parseLooseJson<any>(text);
  const list: any[] = res?.transitions ?? res?.data?.transitions ?? (Array.isArray(res) ? res : res?.data ?? []);
  return list.map((t: any) => ({ id: String(t.id), name: t.name, to: t.to?.name || t.toStatus || t.to || '' }));
}

async function mcpTransition(key: string, transitionIdOrName: string): Promise<void> {
  const byId = /^\d+$/.test(transitionIdOrName);
  await callMcpTool(mcpTool('transitionJiraIssue'), { cloudId: env.jira.cloudId, issueIdOrKey: key, ...(byId ? { transitionId: transitionIdOrName } : { transitionName: transitionIdOrName }) }, mcpOpts);
}

async function mcpCreateIssue(input: CreateIssueInput): Promise<JiraIssue> {
  const args: Record<string, unknown> = { cloudId: env.jira.cloudId, projectKey: input.projectKey, issueType: input.issueType, summary: input.summary, description: input.description || '' };
  if (input.labels?.length) args.labels = input.labels;
  if (input.epicKey) args.parent = input.epicKey;
  if (input.priority) args.priority = input.priority;
  if (input.assignToMe) args.assignee = (await mcpMyself()).accountId;
  const res = await callMcpJson(mcpTool('createJiraIssue'), args, mcpOpts);
  const key = res?.key ?? res?.issue?.key ?? res?.data?.key ?? res?.issueKey;
  if (!key) throw new Error(`createJiraIssue returned no key: ${JSON.stringify(res).slice(0, 300)}`);
  return mcpGetIssue(String(key));
}

async function mcpProjectIssueTypes(projectKey: string): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
  const name = await mcpOperation('list issue types for a jira project', ['listJiraProjectIssueTypesMetadata', 'getJiraProjectIssueTypesMetadata']);
  const res = parseLooseJson<any>(await callMcpTool(mcpTool('executeRead'), { name, cloudId: env.jira.cloudId, inputs: { projectIdOrKey: projectKey, projectKey } }, mcpOpts));
  const list: any[] = res?.issueTypes ?? res?.data?.issueTypes ?? res?.data ?? (Array.isArray(res) ? res : []);
  return list.map((t: any) => ({ id: String(t.id), name: t.name, subtask: !!t.subtask }));
}

// ---------- API ----------

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  epicKey: string | null;
  updated: string;
  url: string;
}

const FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'parent', 'customfield_10014', 'updated'];

function mapIssue(raw: any): JiraIssue {
  const f = raw.fields || {};
  const parent = f.parent;
  const epicKey = parent?.fields?.issuetype?.name === 'Epic' ? parent.key : f.customfield_10014 || parent?.key || null;
  return {
    key: raw.key,
    summary: f.summary || '',
    description: typeof f.description === 'string' ? f.description : adfToText(f.description),
    status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.name || '',
    issueType: f.issuetype?.name || '',
    priority: f.priority?.name && f.priority.name !== 'Unset' ? f.priority.name : null,
    labels: f.labels || [],
    epicKey,
    updated: f.updated || '',
    url: `${env.jira.baseUrl}/browse/${raw.key}`,
  };
}

export async function searchIssues(jql: string, max = 200): Promise<JiraIssue[]> {
  if (jiraMode() === 'mcp') return mcpSearchIssues(jql, max);
  const out: JiraIssue[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ jql, maxResults: '100', fields: FIELDS.join(',') });
    if (token) params.set('nextPageToken', token);
    const page = await jiraFetch<{ issues: any[]; nextPageToken?: string; isLast?: boolean }>(`/rest/api/3/search/jql?${params}`);
    out.push(...(page.issues || []).map(mapIssue));
    token = page.isLast ? undefined : page.nextPageToken;
  } while (token && out.length < max);
  return out;
}

export async function getIssue(key: string): Promise<JiraIssue> {
  if (jiraMode() === 'mcp') return mcpGetIssue(key);
  const raw = await jiraFetch<any>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
  return mapIssue(raw);
}

export async function myself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
  if (jiraMode() === 'mcp') return mcpMyself();
  return jiraFetch('/rest/api/3/myself');
}

export async function projectIssueTypes(projectKey: string): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
  if (jiraMode() === 'mcp') return mcpProjectIssueTypes(projectKey);
  const p = await jiraFetch<any>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  return (p.issueTypes || []).map((t: any) => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
}

export async function listTransitions(key: string): Promise<Array<{ id: string; name: string; to: string }>> {
  if (jiraMode() === 'mcp') return mcpListTransitions(key);
  const r = await jiraFetch<any>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (r.transitions || []).map((t: any) => ({ id: t.id, name: t.name, to: t.to?.name || '' }));
}

export async function transitionIssue(key: string, transitionIdOrName: string): Promise<void> {
  if (jiraMode() === 'mcp') return mcpTransition(key, transitionIdOrName);
  const transitions = await listTransitions(key);
  const t = transitions.find((x) => x.id === transitionIdOrName) || transitions.find((x) => x.name.toLowerCase() === transitionIdOrName.toLowerCase());
  if (!t) throw new Error(`Transition "${transitionIdOrName}" not available for ${key} (available: ${transitions.map((x) => x.name).join(', ')})`);
  await jiraFetch(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: JSON.stringify({ transition: { id: t.id } }) });
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  issueType: string;
  epicKey?: string | null;
  labels?: string[];
  priority?: string | null;
  assignToMe?: boolean;
}

export async function createIssue(input: CreateIssueInput): Promise<JiraIssue> {
  if (jiraMode() === 'mcp') return mcpCreateIssue(input);
  const fields: any = {
    project: { key: input.projectKey },
    summary: input.summary,
    description: textToAdf(input.description || ''),
    issuetype: { name: input.issueType },
  };
  if (input.labels?.length) fields.labels = input.labels;
  if (input.epicKey) fields.parent = { key: input.epicKey };
  if (input.priority) fields.priority = { name: input.priority };
  if (input.assignToMe) {
    const me = await myself();
    fields.assignee = { accountId: me.accountId };
  }
  const created = await jiraFetch<{ key: string }>('/rest/api/3/issue', { method: 'POST', body: JSON.stringify({ fields }) });
  return getIssue(created.key);
}

// ---------- Board sync ----------

export function columnForJiraStatus(status: string, category: string): ColumnId {
  const map = loadConfig().board.jiraStatusToColumn;
  const s = status.toLowerCase();
  for (const [col, names] of Object.entries(map)) if (names.some((n) => n.toLowerCase() === s)) return col as ColumnId;
  const c = category.toLowerCase();
  if (c === 'done') return 'done';
  if (c === 'in progress' || c === 'indeterminate') return 'in_progress';
  return 'backlog';
}

const LOCALLY_MANAGED: ColumnId[] = ['in_progress', 'human_review', 'pull_request'];

export function upsertIssueAsCard(issue: JiraIssue): { card: Card; created: boolean } {
  const existing = getCardByKey(issue.key);
  const col = columnForJiraStatus(issue.status, issue.statusCategory);
  const base = {
    source: 'jira' as const,
    key: issue.key,
    url: issue.url,
    title: issue.summary,
    description: issue.description,
    issueType: issue.issueType,
    priority: issue.priority,
    labels: issue.labels,
    epicKey: issue.epicKey,
    externalStatus: issue.status,
    syncedAt: nowIso(),
  };
  if (!existing) {
    const card = createCard({ ...base, column: col, projectId: guessProjectForKey(issue.key, issue.summary) }, false);
    return { card, created: true };
  }
  const patch: Partial<Card> = { ...base };
  // Jira wins for passive columns (backlog/done); local workflow columns are only overridden when Jira says it is done.
  const localManaged = LOCALLY_MANAGED.includes(existing.column) && !!(existing.runId || existing.prUrl || existing.worktreePath);
  if (col === 'done' || !localManaged) patch.column = col;
  if (existing.archived && col !== 'done') patch.archived = false;
  const card = updateCard(existing.id, patch, false)!;
  return { card, created: false };
}

export async function syncFromJira(jql = env.jira.jql): Promise<{ imported: number; updated: number; total: number }> {
  const issues = await searchIssues(jql);
  let imported = 0;
  let updated = 0;
  for (const issue of issues) {
    const r = upsertIssueAsCard(issue);
    if (r.created) imported++;
    else updated++;
  }
  // Refresh cards we already track but that fell out of the query (e.g. moved to Done by QA).
  const known = listCards().filter((c) => c.source === 'jira' && c.key && !issues.some((i) => i.key === c.key)).slice(0, 50);
  if (known.length) {
    try {
      const refreshed = await searchIssues(`key in (${known.map((c) => c.key).join(', ')})`, 100);
      for (const issue of refreshed) {
        upsertIssueAsCard(issue);
        updated++;
      }
    } catch (e) {
      logger.warn({ err: String(e) }, 'refresh of known cards failed');
    }
  }
  kvSet('jira:lastSync', nowIso());
  kvSet('jira:syncs', kvGet<number>('jira:syncs', 0) + 1);
  hub.broadcast({ type: 'cards.changed' });
  return { imported, updated, total: issues.length };
}
