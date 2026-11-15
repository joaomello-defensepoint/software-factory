import fs from 'node:fs';
import path from 'node:path';
import type { BrainPage, BrainVault, FathomMeetingSummary } from '@sf/shared';
import { DEFAULT_VAULT_ROOT } from '../config.js';
import { kvGet, kvSet } from '../db.js';
import { hub } from '../events.js';
import { runClaude } from './claude.js';
import { getMeeting, listMeetings, renderMeetingExport } from './fathom.js';
import { startJob } from './jobs.js';
import { existingDesignDocs, getProjectConfig, loadConfig } from './projects.js';
import { slugify } from './worktrees.js';

/** Second brain = the LLM-wiki vaults the user already maintains with the second-brain-* skills. */

export function listVaults(): BrainVault[] {
  const roots = new Set<string>();
  if (fs.existsSync(DEFAULT_VAULT_ROOT)) for (const d of fs.readdirSync(DEFAULT_VAULT_ROOT)) roots.add(path.join(DEFAULT_VAULT_ROOT, d));
  for (const p of loadConfig().projects) if (p.vault) roots.add(p.vault);
  return [...roots]
    .filter((dir) => fs.existsSync(path.join(dir, 'wiki')) || fs.existsSync(path.join(dir, 'raw')))
    .map((dir) => {
      const rawDir = path.join(dir, 'raw');
      const wikiDir = path.join(dir, 'wiki');
      const logPath = path.join(wikiDir, 'log.md');
      let lastLog: string | null = null;
      if (fs.existsSync(logPath)) {
        const m = [...fs.readFileSync(logPath, 'utf8').matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]/gm)];
        lastLog = m.length ? m[m.length - 1][1] : null;
      }
      return {
        id: path.basename(dir),
        name: path.basename(dir),
        path: dir,
        exists: true,
        rawCount: fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => !f.startsWith('.') && fs.statSync(path.join(rawDir, f)).isFile()).length : 0,
        wikiCount: countMd(wikiDir),
        lastLog,
      };
    });
}

function countMd(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countMd(path.join(dir, e.name));
    else if (e.name.endsWith('.md')) n++;
  }
  return n;
}

export function getVault(id: string): BrainVault | undefined {
  return listVaults().find((v) => v.id === id);
}

export function listPages(vault: BrainVault): BrainPage[] {
  const wikiDir = path.join(vault.path, 'wiki');
  const out: BrainPage[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(wikiDir, full);
        const section = (rel.split(path.sep)[0] as BrainPage['section']) || 'other';
        const head = fs.readFileSync(full, 'utf8').slice(0, 2000);
        const title = /^#\s+(.+)$/m.exec(head)?.[1]?.trim() || e.name.replace(/\.md$/, '');
        const updated = /^updated:\s*(.+)$/m.exec(head)?.[1]?.trim() || null;
        out.push({ path: rel, title, section: ['sources', 'entities', 'concepts', 'synthesis'].includes(section) ? section : 'other', updated });
      }
    }
  };
  walk(wikiDir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function readPage(vault: BrainVault, rel: string): string {
  const wikiDir = path.join(vault.path, 'wiki');
  const full = path.resolve(wikiDir, rel);
  if (!full.startsWith(wikiDir + path.sep) && full !== wikiDir) throw new Error('Invalid path');
  return fs.readFileSync(full, 'utf8');
}

/** Compact knowledge pack for agents: the vault index plus the synthesis dashboards (trimmed). */
export function contextPack(vaultPath: string | null, maxChars = 24_000): string {
  if (!vaultPath || !fs.existsSync(vaultPath)) return '';
  const parts: string[] = [];
  const index = path.join(vaultPath, 'wiki', 'index.md');
  if (fs.existsSync(index)) parts.push(`### Wiki index (${path.basename(vaultPath)})\n${fs.readFileSync(index, 'utf8')}`);
  const synth = path.join(vaultPath, 'wiki', 'synthesis');
  if (fs.existsSync(synth)) {
    for (const f of fs.readdirSync(synth).filter((x) => x.endsWith('.md'))) {
      const body = fs.readFileSync(path.join(synth, f), 'utf8');
      parts.push(`### ${f}\n${body.slice(0, 6000)}${body.length > 6000 ? '\n…(truncated)' : ''}`);
    }
  }
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}

// ---------- Fathom ingestion ----------

const ingestedKey = (recordingId: string) => `fathom:${recordingId}`;

export async function listFathomMeetings(days: number): Promise<FathomMeetingSummary[]> {
  const after = new Date(Date.now() - days * 864e5).toISOString();
  const meetings = await listMeetings({ createdAfter: after, maxPages: 5 });
  return meetings.map((m) => {
    const started = m.startedAt ? new Date(m.startedAt) : null;
    const ended = m.endedAt ? new Date(m.endedAt) : null;
    return {
      recordingId: m.recordingId,
      title: m.title,
      url: m.shareUrl || m.url,
      createdAt: m.createdAt,
      recordedBy: m.recordedBy,
      invitees: m.invitees,
      durationMin: started && ended ? Math.round((ended.getTime() - started.getTime()) / 60000) : null,
      ingested: !!kvGet<string | null>(ingestedKey(m.recordingId), null),
    };
  });
}

export function ingestMeetingJob(vaultId: string, recordingId: string, createdAtHint?: string) {
  const vault = getVault(vaultId);
  if (!vault) throw new Error(`Unknown vault ${vaultId}`);
  return startJob('brain.ingest', `Ingest Fathom ${recordingId} → ${vault.name}`, async (log) => {
    log(`Fetching meeting ${recordingId} from Fathom…`);
    const meeting = await getMeeting(recordingId, createdAtHint);
    if (!meeting) throw new Error('Meeting not found (check FATHOM_API_KEY and that the recording is visible to this user)');
    const date = (meeting.startedAt || meeting.createdAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const file = `${date}-${slugify(meeting.title).slice(0, 40) || 'meeting'}.txt`;
    const rawPath = path.join(vault.path, 'raw', file);
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, renderMeetingExport(meeting), 'utf8');
    kvSet(ingestedKey(recordingId), rawPath);
    log(`Saved raw transcript → raw/${file} (${meeting.transcript?.length ?? 0} lines)`);
    log('Running /second-brain-ingest in the vault…');
    const res = await runClaude({
      cwd: vault.path,
      prompt: `/second-brain-ingest raw/${file}\n\nThis is an unattended run: do NOT pause to discuss takeaways or wait for confirmation. Complete every step (source page, entities, concepts, synthesis dashboards, index.md and log.md) and finish with a short summary of the pages you created or updated.`,
      model: 'opus',
      maxTurns: 150,
      onText: (t) => log(t),
      onTool: (name, input) => log(`→ ${name} ${summarizeInput(input)}`),
    });
    hub.broadcast({ type: 'brain.changed', vaultId });
    return res.text.slice(-2000);
  });
}

export function indexRepoJob(vaultId: string, projectId: string) {
  const vault = getVault(vaultId);
  const project = getProjectConfig(projectId);
  if (!vault) throw new Error(`Unknown vault ${vaultId}`);
  if (!project) throw new Error(`Unknown project ${projectId}`);
  const docs = existingDesignDocs(project, project.path);
  return startJob('brain.index', `Index ${project.name} → ${vault.name}`, async (log) => {
    log(`Design docs found: ${docs.length ? docs.join(', ') : '(none configured)'}`);
    const res = await runClaude({
      cwd: vault.path,
      additionalDirectories: [project.path],
      model: 'opus',
      maxTurns: 200,
      prompt: [
        `You are maintaining this wiki (follow CLAUDE.md in this vault exactly: frontmatter, [[links]], index.md and log.md conventions).`,
        `Index the source code repository at ${project.path} (branch currently checked out) so agents working on tickets get accurate architectural context.`,
        `Design docs and rules to read first: ${docs.map((d) => path.join(project.path, d)).join(', ')}. Then survey the repository structure (solutions, projects, main folders, build/run commands, test layout).`,
        `Create or refresh these wiki pages (kebab-case filenames, Title Case H1):`,
        `- wiki/entities/${project.id}-repository.md — architecture overview, module map, tech stack and versions, how to build/run/test, branch model, PR conventions.`,
        `- wiki/concepts/${project.id}-design-rules.md — the non-negotiable design rules and ADRs agents must follow (quote the ADR ids/titles; link to the source doc paths).`,
        `- wiki/concepts/${project.id}-domain-glossary.md — the key domain concepts and where they live in code.`,
        `Update wiki/index.md and append a "## [${new Date().toISOString().slice(0, 10)}] ingest | Repository index: ${project.name}" entry in wiki/log.md.`,
        `Do not copy large documents verbatim; summarize and link to file paths. Do not modify anything inside ${project.path}. Unattended run: never ask questions.`,
      ].join('\n'),
      onText: (t) => log(t),
      onTool: (name, input) => log(`→ ${name} ${summarizeInput(input)}`),
    });
    hub.broadcast({ type: 'brain.changed', vaultId });
    return res.text.slice(-2000);
  });
}

export function lintJob(vaultId: string) {
  const vault = getVault(vaultId);
  if (!vault) throw new Error(`Unknown vault ${vaultId}`);
  return startJob('brain.lint', `Lint ${vault.name}`, async (log) => {
    const res = await runClaude({
      cwd: vault.path,
      prompt: '/second-brain-lint\n\nUnattended run: fix what is safe to fix (broken links, missing index entries, stale frontmatter), report the rest. Never ask questions.',
      model: 'opus',
      maxTurns: 120,
      onText: (t) => log(t),
      onTool: (name, input) => log(`→ ${name} ${summarizeInput(input)}`),
    });
    hub.broadcast({ type: 'brain.changed', vaultId });
    return res.text.slice(-4000);
  });
}

export function queryJob(vaultId: string, question: string) {
  const vault = getVault(vaultId);
  if (!vault) throw new Error(`Unknown vault ${vaultId}`);
  return startJob('brain.query', `Ask ${vault.name}: ${question.slice(0, 60)}`, async (log) => {
    const res = await runClaude({
      cwd: vault.path,
      prompt: `/second-brain-query ${question}\n\nAnswer directly with citations to wiki pages ([[Page]]). Unattended run: never ask questions.`,
      model: 'opus',
      maxTurns: 60,
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      onText: (t) => log(t),
      onTool: (name, input) => log(`→ ${name} ${summarizeInput(input)}`),
    });
    return res.text;
  });
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return '';
  }
}
