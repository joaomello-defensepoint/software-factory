import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { LoggerConfig, LoggerGathered, LoggerRun, LoggerRunStatus, LoggerState, LoggerTrigger } from '@sf/shared';
import { LOGGER_ENV_PATH, LOGGER_RUNS_DIR, LOGGER_SCRIPTS_DIR } from '../config.js';
import { getDb, nowIso } from '../db.js';
import { hub, toast } from '../events.js';
import { logger } from '../logger.js';
import { loadConfig, saveConfig } from './projects.js';
import { run as sh } from './shell.js';
import { runClaude } from './claude.js';

/**
 * Daily Kimai (Tempo) time logger — the local replacement for the claude.ai "Tempo Logger" routine.
 *
 * Deterministic parts run as scripts in apps/logger (lt.py gathers ADO commits + Llama items and talks to Kimai,
 * gcal_meetings.py reads the calendar through the service account, slack_context.py reads the channels with the
 * bot token). Claude is only asked to write the Summary line and pick the Slack discussions; the entry itself is
 * composed here with the gathered sections verbatim, so nothing can be invented. Secrets come from
 * ~/.claude/software-factory/logger.env and never enter the prompt.
 */

const SP_TZ = 'America/Sao_Paulo';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const SECRET_KEYS = ['ADO_PAT', 'KIMAI_TOKEN', 'LLAMA_API_KEY', 'GCAL_SA_KEY', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN'] as const;

// ---------- secrets ----------

/** KEY=VALUE lines; surrounding single/double quotes are stripped, nothing else is interpreted (the GCal key is JSON with \n escapes). */
export function readSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(LOGGER_ENV_PATH)) return out;
  for (const raw of fs.readFileSync(LOGGER_ENV_PATH, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    if (value) out[key] = value;
  }
  return out;
}

async function adoTokenFromAz(): Promise<string | null> {
  const res = await sh('az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], { timeoutMs: 30_000 });
  const tok = res.stdout.trim();
  return res.code === 0 && tok ? tok : null;
}

// ---------- dates ----------

/** YYYY-MM-DD of `d` in São Paulo. */
export function spDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function yesterdayInSp(d = new Date()): string {
  const [y, m, day] = spDate(d).split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, m - 1, day, 12));
  noonUtc.setUTCDate(noonUtc.getUTCDate() - 1);
  return noonUtc.toISOString().slice(0, 10);
}

// ---------- persistence ----------

interface Row {
  id: string;
  date: string;
  trigger: LoggerTrigger;
  dry_run: number;
  status: LoggerRunStatus;
  status_line: string | null;
  description: string | null;
  entry_id: number | null;
  session_id: string | null;
  cost_usd: number;
  gathered: string | null;
  log: string;
  error: string | null;
  notified: number;
  started_at: string;
  finished_at: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toRun = (r: Row): LoggerRun => ({
  id: r.id,
  date: r.date,
  trigger: r.trigger,
  dryRun: !!r.dry_run,
  status: r.status,
  statusLine: r.status_line,
  description: r.description,
  entryId: r.entry_id,
  sessionId: r.session_id,
  costUsd: r.cost_usd,
  gathered: parse<LoggerGathered | null>(r.gathered, null),
  log: parse<string[]>(r.log, []),
  error: r.error,
  notified: !!r.notified,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function getLoggerRun(id: string): LoggerRun | null {
  const row = getDb().prepare('SELECT * FROM logger_runs WHERE id = ?').get(id) as unknown as Row | undefined;
  return row ? toRun(row) : null;
}

export function listLoggerRuns(limit = 60): LoggerRun[] {
  return (getDb().prepare('SELECT * FROM logger_runs ORDER BY started_at DESC LIMIT ?').all(limit) as unknown as Row[]).map(toRun);
}

export function deleteLoggerRun(id: string): boolean {
  const r = getLoggerRun(id);
  if (!r || r.status === 'running') return false;
  getDb().prepare('DELETE FROM logger_runs WHERE id = ?').run(id);
  fs.rmSync(runDir(r), { recursive: true, force: true });
  hub.broadcast({ type: 'logger.changed' });
  return true;
}

function patchRun(id: string, patch: Partial<{ status: LoggerRunStatus; statusLine: string | null; description: string | null; entryId: number | null; sessionId: string | null; costUsd: number; gathered: LoggerGathered | null; log: string[]; error: string | null; notified: boolean; finishedAt: string | null }>): LoggerRun {
  const map: Record<string, string> = { status: 'status', statusLine: 'status_line', description: 'description', entryId: 'entry_id', sessionId: 'session_id', costUsd: 'cost_usd', gathered: 'gathered', log: 'log', error: 'error', notified: 'notified', finishedAt: 'finished_at' };
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!map[k]) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(k === 'gathered' || k === 'log' ? JSON.stringify(v) : k === 'notified' ? (v ? 1 : 0) : (v ?? null));
  }
  if (sets.length) getDb().prepare(`UPDATE logger_runs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as any[]), id);
  const r = getLoggerRun(id)!;
  hub.broadcast({ type: 'logger.changed', run: r });
  return r;
}

const runDir = (r: LoggerRun): string => path.join(LOGGER_RUNS_DIR, `${r.date}-${r.id}`);

// ---------- the run ----------

let current: string | null = null;
export const loggerRunning = (): boolean => current !== null;

export interface RunLoggerInput {
  /** Day to log (YYYY-MM-DD, São Paulo). Defaults to yesterday. */
  date?: string | null;
  /** Gather and compose but do not create the Kimai entry (review first, then commit). */
  dryRun?: boolean;
  trigger: LoggerTrigger;
}

/** Starts a run and returns its row immediately; progress streams as logger.changed events. */
export function runLogger(input: RunLoggerInput): LoggerRun {
  if (current) throw new Error('A logger run is already in progress');
  const date = (input.date || yesterdayInSp()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  if (date >= spDate()) throw new Error('Kimai rejects same-day entries; pick a past date');
  const id = nanoid(10);
  const dryRun = !!input.dryRun;
  getDb()
    .prepare(`INSERT INTO logger_runs (id, date, trigger, dry_run, status, cost_usd, log, notified, started_at) VALUES (?, ?, ?, ?, 'running', 0, '[]', 0, ?)`)
    .run(id, date, dryRun && input.trigger !== 'preview' ? 'preview' : input.trigger, dryRun ? 1 : 0, nowIso());
  current = id;
  const run = getLoggerRun(id)!;
  hub.broadcast({ type: 'logger.changed', run });
  void execute(run).finally(() => {
    current = null;
  });
  return run;
}

async function execute(run: LoggerRun): Promise<void> {
  const cfg = loadConfig().logger;
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    patchRun(run.id, { log: lines });
  };
  const dir = runDir(run);
  fs.mkdirSync(dir, { recursive: true });
  const secrets = readSecrets();
  const gathered: LoggerGathered = { commitTop: [], llamaLines: [], meetings: [], slackCandidates: [], slackLines: [], summary: null, warnings: [] };
  let statusLine = '';
  let status: LoggerRunStatus = 'failed';
  try {
    if (!secrets.KIMAI_TOKEN) throw new Error(`KIMAI_TOKEN missing in ${LOGGER_ENV_PATH}`);
    const env: NodeJS.ProcessEnv = { ...secrets, TARGET_DATE: run.date, TZ: SP_TZ };
    const azToken = await adoTokenFromAz();
    if (azToken) env.ADO_TOKEN = azToken;
    else if (!secrets.ADO_PAT) gathered.warnings.push('No ADO access: az CLI not logged in and no ADO_PAT in logger.env');
    log(`Logging ${run.date}${run.dryRun ? ' (preview, no Kimai write)' : ''} · ADO via ${azToken ? 'az CLI token' : secrets.ADO_PAT ? 'PAT' : 'nothing'}`);

    // Phase 0 — facts + dedup guard
    const preview = await sh('python3', [path.join(LOGGER_SCRIPTS_DIR, 'lt.py'), 'preview'], { cwd: LOGGER_SCRIPTS_DIR, env, timeoutMs: 180_000 });
    if (preview.code !== 0) throw new Error(`lt.py preview failed: ${(preview.stdout + preview.stderr).trim().slice(0, 500)}`);
    const facts = JSON.parse(preview.stdout) as { already_logged: number | null; commit_top: string[]; llama_lines: string[]; warnings?: string[] };
    fs.writeFileSync(path.join(dir, 'preview.json'), preview.stdout);
    gathered.commitTop = facts.commit_top || [];
    gathered.llamaLines = facts.llama_lines || [];
    gathered.warnings.push(...(facts.warnings || []));
    log(`ADO commits: ${gathered.commitTop.length} · Llama items: ${gathered.llamaLines.length}${facts.warnings?.length ? ` · warnings: ${facts.warnings.length}` : ''}`);
    if (facts.already_logged) {
      statusLine = `SKIPPED-DUPLICATE: ${run.date} already logged (id ${facts.already_logged})`;
      status = 'skipped_duplicate';
      patchRun(run.id, { entryId: facts.already_logged });
      log(statusLine);
      await finish(run, status, statusLine, gathered, cfg, secrets, log);
      return;
    }

    // Phase 1 — calendar (best effort)
    if (secrets.GCAL_SA_KEY) {
      const cal = await sh('python3', [path.join(LOGGER_SCRIPTS_DIR, 'gcal_meetings.py')], { cwd: LOGGER_SCRIPTS_DIR, env, timeoutMs: 90_000 });
      gathered.meetings = cal.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      if (cal.stderr.trim()) gathered.warnings.push(cal.stderr.trim().split('\n')[0]);
      log(`Calendar meetings: ${gathered.meetings.length}`);
    } else gathered.warnings.push('GCAL_SA_KEY missing: no [Calendar] section');

    // Phase 2 — Slack discussions (best effort): read as the user (SLACK_USER_TOKEN) so the bot stays out of the channels
    const slackReader = secrets.SLACK_USER_TOKEN ? 'user' : secrets.SLACK_BOT_TOKEN ? 'bot' : null;
    if (slackReader && cfg.slackUserId && Object.keys(cfg.slackChannels).length) {
      const slackEnv = { ...env, SLACK_USER_ID: cfg.slackUserId, SLACK_CHANNELS: Object.entries(cfg.slackChannels).map(([id, name]) => `${id}:${name.replace(/^#/, '')}`).join(',') };
      const sl = await sh('python3', [path.join(LOGGER_SCRIPTS_DIR, 'slack_context.py')], { cwd: LOGGER_SCRIPTS_DIR, env: slackEnv, timeoutMs: 180_000 });
      const data = parse<{ error?: string; channels: Array<{ name: string; error: string | null; discussions: Array<{ messages: Array<{ name: string; time: string; text: string }> }> }> }>(sl.stdout, { channels: [] });
      fs.writeFileSync(path.join(dir, 'slack.json'), sl.stdout || '{}');
      if (data.error) gathered.warnings.push(`Slack: ${data.error}`);
      const errors = new Set(data.channels.filter((c) => c.error).map((c) => c.error as string));
      if (errors.size)
        gathered.warnings.push(
          slackReader === 'user'
            ? `Slack channels unreadable as you (${[...errors].join(', ')}): the user token needs the user scopes channels:history, groups:history and users:read (reinstall the app after adding them)`
            : `Slack channels unreadable (${[...errors].join(', ')}): no SLACK_USER_TOKEN in logger.env, and the bot token can only read channels it is a member of with channels:history, groups:history and users:read`,
        );
      for (const ch of data.channels) {
        for (const d of ch.discussions) {
          const text = d.messages.map((m) => `${m.name}: ${m.text}`).join(' | ');
          gathered.slackCandidates.push(`#${ch.name} ${d.messages[0]?.time ?? ''} ${text.length > 700 ? `${text.slice(0, 700)}…` : text}`);
        }
      }
      log(`Slack (read as ${slackReader}) discussions with you: ${gathered.slackCandidates.length}${errors.size ? ' (channels unreadable, see warnings)' : ''}`);
    } else gathered.warnings.push('Slack reading skipped (no SLACK_USER_TOKEN/SLACK_BOT_TOKEN, user id or channels configured)');

    // Empty rule
    if (!gathered.commitTop.length && !gathered.llamaLines.length && !gathered.meetings.length && !gathered.slackCandidates.length) {
      statusLine = `SKIPPED-EMPTY: no activity for ${run.date}`;
      status = 'skipped_empty';
      log(statusLine);
      await finish(run, status, statusLine, gathered, cfg, secrets, log);
      return;
    }

    // Phase 3 — Summary + Slack picks by Claude; the sections themselves stay verbatim
    log(`Asking ${cfg.model} for the Summary line…`);
    const composed = await compose(run, gathered, cfg.model);
    if (composed) {
      gathered.summary = composed.summary;
      gathered.slackLines = composed.slack;
      patchRun(run.id, { sessionId: composed.sessionId, costUsd: composed.costUsd });
      log(`Summary written (${composed.summary.length} chars) · Slack lines kept: ${composed.slack.length}`);
    } else {
      gathered.warnings.push('Claude could not write the Summary; entry composed from the gathered sections only');
      log('Claude failed; falling back to a deterministic description');
    }
    const description = buildDescription(gathered);
    fs.writeFileSync(path.join(dir, 'desc.txt'), description);
    patchRun(run.id, { description, gathered });

    if (run.dryRun) {
      statusLine = `PREVIEWED: ${run.date} — review the entry and press "Log this entry"`;
      status = 'previewed';
      log(statusLine);
      await finish(run, status, statusLine, gathered, cfg, secrets, log);
      return;
    }

    // Phase 4 — create
    const created = await createEntry(run, description, env);
    statusLine = created.statusLine;
    status = created.ok ? 'created' : 'failed';
    if (created.entryId) patchRun(run.id, { entryId: created.entryId });
    log(statusLine);
    await finish(run, status, statusLine, gathered, cfg, secrets, log);
  } catch (e: any) {
    const msg = String(e?.message || e);
    statusLine = `ERROR: ${msg}`;
    log(statusLine);
    logger.error({ err: e, run: run.id }, 'logger run failed');
    patchRun(run.id, { error: msg });
    await finish(run, 'failed', statusLine, gathered, cfg, secrets, log).catch(() => undefined);
  }
}

async function createEntry(run: LoggerRun, description: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; statusLine: string; entryId: number | null }> {
  const file = path.join(runDir(run), 'desc.txt');
  fs.mkdirSync(runDir(run), { recursive: true });
  fs.writeFileSync(file, description);
  const res = await sh('python3', [path.join(LOGGER_SCRIPTS_DIR, 'lt.py'), 'create', file], { cwd: LOGGER_SCRIPTS_DIR, env, timeoutMs: 120_000 });
  const line = (res.stdout + res.stderr).trim().split('\n').filter(Boolean).pop() || `ERROR: lt.py create exited ${res.code}`;
  const m = /entry id (\d+)/.exec(line);
  return { ok: res.code === 0 && line.startsWith('CREATED'), statusLine: line, entryId: m ? Number(m[1]) : null };
}

async function finish(run: LoggerRun, status: LoggerRunStatus, statusLine: string, gathered: LoggerGathered, cfg: LoggerConfig, secrets: Record<string, string>, log: (l: string) => void): Promise<void> {
  let notified = false;
  const announce = !run.dryRun && status !== 'previewed';
  if (announce && cfg.notifySlack && secrets.SLACK_BOT_TOKEN && cfg.slackUserId) {
    notified = await notifySlack(secrets.SLACK_BOT_TOKEN, cfg.slackUserId, `🕒 Kimai auto-log: ${statusLine}`);
    log(notified ? 'Status sent to you on Slack' : 'Slack DM failed');
  }
  patchRun(run.id, { status, statusLine, gathered, notified, finishedAt: nowIso() });
  if (announce) toast(status === 'created' ? 'success' : status === 'failed' ? 'error' : 'info', `Time logger: ${statusLine}`);
}

async function notifySlack(token: string, channel: string, text: string): Promise<boolean> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel, text }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) logger.warn({ error: data.error }, 'slack notify failed');
    return !!data.ok;
  } catch (e) {
    logger.warn({ err: e }, 'slack notify failed');
    return false;
  }
}

/** Entry text in the routine's exact shape: Summary first, then the gathered sections verbatim, empty ones omitted. */
export function buildDescription(g: LoggerGathered): string {
  const parts: string[] = [];
  if (g.summary) parts.push(`Summary: ${g.summary}`);
  if (g.commitTop.length) parts.push(`[Azure] Top commits (by size):\n${g.commitTop.join('\n')}`);
  if (g.llamaLines.length) parts.push(`[Llama] Worked on the following items:\n${g.llamaLines.join('\n')}`);
  if (g.meetings.length) parts.push(`[Calendar] Key meetings:\n${g.meetings.join('\n')}`);
  if (g.slackLines.length) parts.push(`[Slack] Key discussions:\n${g.slackLines.slice(0, 3).join('\n')}`);
  return parts.join('\n\n');
}

async function compose(run: LoggerRun, g: LoggerGathered, model: string): Promise<{ summary: string; slack: string[]; sessionId: string | null; costUsd: number } | null> {
  const block = (title: string, lines: string[]) => `${title}\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- (none)'}`;
  const prompt = [
    `You are the timesheet writer for João Mello. Day being logged: ${run.date} (America/Sao_Paulo). Everything below was gathered deterministically; use ONLY it.`,
    '',
    block('[Azure] commits that day (verbatim subjects, ranked by size):', g.commitTop),
    '',
    block('[Llama] tracker items updated that day:', g.llamaLines),
    '',
    block('[Calendar] meetings attended:', g.meetings),
    '',
    block('[Slack] candidate discussions João took part in (channel, time, thread excerpt):', g.slackCandidates),
    '',
    'Produce:',
    '1. "summary": AT MOST 300 characters. 1–2 plain, factual sentences naming the day\'s main accomplishment(s), synthesized from the commits, meetings and discussions. No inflation, no speculation — every claim must trace to the data above. Write impersonally (e.g. "Merged PR …", "Implemented …") — no name, no third person. Never mention personal matters (health, absences, breaks, time off, family).',
    '2. "slack": up to 3 lines, one per WORK discussion worth recording, formatted exactly "#channel: <one-line topic>". Ignore announcements, social chatter and anything personal. Return an empty list when nothing qualifies.',
  ].join('\n');
  try {
    const res = await runClaude({
      cwd: LOGGER_SCRIPTS_DIR,
      prompt,
      model,
      minimalSystemPrompt: 'You write concise, factual timesheet summaries. You never invent work and never include personal matters. Answer only with the requested JSON.',
      allowedTools: [],
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent'],
      maxTurns: 3,
      maxBudgetUsd: 1,
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string', maxLength: 300 }, slack: { type: 'array', items: { type: 'string' }, maxItems: 3 } },
        required: ['summary', 'slack'],
        additionalProperties: false,
      },
      meta: { kind: 'logger', title: `Timesheet ${run.date}` },
    });
    const out = (res.structured ?? tryJson(res.text)) as { summary?: string; slack?: string[] } | null;
    if (!out || typeof out.summary !== 'string' || !out.summary.trim()) return null;
    const summary = out.summary.trim().length > 300 ? `${out.summary.trim().slice(0, 297)}…` : out.summary.trim();
    const slack = (Array.isArray(out.slack) ? out.slack : []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 3);
    return { summary, slack, sessionId: res.sessionId, costUsd: res.costUsd };
  } catch (e) {
    logger.warn({ err: e }, 'logger compose failed');
    return null;
  }
}

function tryJson(text: string): unknown | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Creates the Kimai entry for a previewed run, with the (possibly edited) description. */
export async function commitLoggerRun(id: string, description?: string | null): Promise<LoggerRun> {
  const run = getLoggerRun(id);
  if (!run) throw new Error('Unknown run');
  if (run.status !== 'previewed') throw new Error('Only a previewed run can be logged');
  if (current) throw new Error('A logger run is already in progress');
  const desc = (description ?? run.description ?? '').trim();
  if (!desc) throw new Error('The description is empty');
  const cfg = loadConfig().logger;
  const secrets = readSecrets();
  current = run.id;
  const lines = [...run.log];
  const log = (line: string) => {
    lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    patchRun(run.id, { log: lines });
  };
  try {
    patchRun(run.id, { status: 'running', description: desc, finishedAt: null });
    const env: NodeJS.ProcessEnv = { ...secrets, TARGET_DATE: run.date, TZ: SP_TZ };
    const azToken = await adoTokenFromAz();
    if (azToken) env.ADO_TOKEN = azToken;
    // Dedup again: something may have logged the day since the preview.
    const preview = await sh('python3', [path.join(LOGGER_SCRIPTS_DIR, 'lt.py'), 'preview'], { cwd: LOGGER_SCRIPTS_DIR, env, timeoutMs: 180_000 });
    const facts = preview.code === 0 ? (JSON.parse(preview.stdout) as { already_logged: number | null }) : { already_logged: null };
    if (facts.already_logged) {
      const line = `SKIPPED-DUPLICATE: ${run.date} already logged (id ${facts.already_logged})`;
      log(line);
      patchRun(run.id, { entryId: facts.already_logged });
      await finish({ ...run, dryRun: false }, 'skipped_duplicate', line, run.gathered ?? emptyGathered(), cfg, secrets, log);
      return getLoggerRun(id)!;
    }
    const created = await createEntry(run, desc, env);
    if (created.entryId) patchRun(run.id, { entryId: created.entryId });
    log(created.statusLine);
    await finish({ ...run, dryRun: false }, created.ok ? 'created' : 'failed', created.statusLine, run.gathered ?? emptyGathered(), cfg, secrets, log);
    return getLoggerRun(id)!;
  } finally {
    current = null;
  }
}

const emptyGathered = (): LoggerGathered => ({ commitTop: [], llamaLines: [], meetings: [], slackCandidates: [], slackLines: [], summary: null, warnings: [] });

// ---------- schedule ----------

let timer: NodeJS.Timeout | null = null;
let firedSlot: string | null = null;

/** Next scheduled firing at or after `from` (local time), or null when disabled. */
export function nextScheduled(cfg: LoggerConfig, from = new Date()): Date | null {
  if (!cfg.enabled || !cfg.days.length) return null;
  const [hh, mm] = cfg.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, hh || 0, mm || 0, 0, 0);
    if (cfg.days.includes(d.getDay()) && d.getTime() >= from.getTime()) return d;
  }
  return null;
}

/** Most recent scheduled slot at or before `from` (for catch-up after sleep). */
function lastScheduled(cfg: LoggerConfig, from = new Date()): Date | null {
  if (!cfg.enabled || !cfg.days.length) return null;
  const [hh, mm] = cfg.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i, hh || 0, mm || 0, 0, 0);
    if (cfg.days.includes(d.getDay()) && d.getTime() <= from.getTime()) return d;
  }
  return null;
}

const slotKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;

/** A real (non-preview) run already settled that day. */
function dayHandled(date: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM logger_runs WHERE date = ? AND dry_run = 0 AND status IN ('created','skipped_duplicate','skipped_empty') LIMIT 1").get(date);
  return !!row;
}

function tick(catchUp: boolean): void {
  const cfg = loadConfig().logger;
  if (!cfg.enabled) return;
  const slot = lastScheduled(cfg);
  if (!slot) return;
  const key = slotKey(slot);
  if (firedSlot === key) return;
  const ageMs = Date.now() - slot.getTime();
  const fresh = ageMs < 2 * 60_000; // the slot just arrived
  const today = slot.toDateString() === new Date().toDateString();
  if (!fresh && !(catchUp && cfg.catchUp && today)) {
    firedSlot = key; // old slot: don't fire it later
    return;
  }
  firedSlot = key;
  const date = yesterdayInSp(slot);
  if (dayHandled(date)) {
    logger.info(`time logger: ${date} already handled, skipping slot ${key}`);
    return;
  }
  if (loggerRunning()) return;
  logger.info(`time logger: firing for ${date} (${fresh ? 'schedule' : 'catch-up'})`);
  try {
    runLogger({ date, trigger: fresh ? 'schedule' : 'catchup' });
  } catch (e) {
    logger.warn({ err: e }, 'time logger could not start');
  }
}

export function startLoggerSchedule(): void {
  stopLoggerSchedule();
  const cfg = loadConfig().logger;
  const next = nextScheduled(cfg);
  logger.info(cfg.enabled ? `time logger: ${cfg.time} on days [${cfg.days.join(',')}] · next ${next?.toLocaleString() ?? 'n/a'}` : 'time logger disabled');
  setTimeout(() => tick(true), 45_000).unref(); // catch-up shortly after boot
  timer = setInterval(() => tick(false), 60_000);
  timer.unref();
}

export function stopLoggerSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function updateLoggerConfig(patch: Partial<LoggerConfig>): LoggerConfig {
  const cfg = loadConfig();
  const next = { ...cfg, logger: { ...cfg.logger, ...patch } };
  saveConfig(next);
  startLoggerSchedule();
  hub.broadcast({ type: 'logger.changed' });
  return next.logger;
}

export async function loggerState(): Promise<LoggerState> {
  const cfg = loadConfig().logger;
  const secrets = readSecrets();
  const next = nextScheduled(cfg);
  const res = await sh('az', ['account', 'show', '-o', 'none'], { timeoutMs: 15_000 });
  return {
    config: cfg,
    secrets: Object.fromEntries(SECRET_KEYS.map((k) => [k, !!secrets[k]])),
    secretsPath: LOGGER_ENV_PATH,
    adoViaAz: res.code === 0,
    running: loggerRunning(),
    nextRunAt: next ? next.toISOString() : null,
    nextTargetDate: next ? yesterdayInSp(next) : null,
    lastRun: listLoggerRuns(1)[0] ?? null,
  };
}
