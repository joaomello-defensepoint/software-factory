import type { Card, ColumnId } from '@sf/shared';
import { env } from '../config.js';
import { nowIso } from '../db.js';
import { createCard, getCardByKey, listCards, updateCard } from './cards.js';
import { guessProjectForKey, loadConfig } from './projects.js';
import { hub } from '../events.js';
import { logger } from '../logger.js';

export const jiraConfigured = (): boolean => !!(env.jira.baseUrl && env.jira.email && env.jira.token);

async function jiraFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!jiraConfigured()) throw new Error('Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)');
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
  const raw = await jiraFetch<any>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(',')}`);
  return mapIssue(raw);
}

export async function myself(): Promise<{ accountId: string; displayName: string; emailAddress?: string }> {
  return jiraFetch('/rest/api/3/myself');
}

export async function projectIssueTypes(projectKey: string): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
  const p = await jiraFetch<any>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  return (p.issueTypes || []).map((t: any) => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
}

export async function listTransitions(key: string): Promise<Array<{ id: string; name: string; to: string }>> {
  const r = await jiraFetch<any>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  return (r.transitions || []).map((t: any) => ({ id: t.id, name: t.name, to: t.to?.name || '' }));
}

export async function transitionIssue(key: string, transitionIdOrName: string): Promise<void> {
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
  const known = listCards().filter((c) => c.source === 'jira' && c.key && !issues.some((i) => i.key === c.key));
  for (const c of known.slice(0, 50)) {
    try {
      upsertIssueAsCard(await getIssue(c.key!));
      updated++;
    } catch (e) {
      logger.warn({ key: c.key, err: String(e) }, 'refresh failed');
    }
  }
  hub.broadcast({ type: 'cards.changed' });
  return { imported, updated, total: issues.length };
}
