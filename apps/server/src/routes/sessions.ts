import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsageReport, UsagePeriod } from '@sf/shared';
import { getDb, kvGet, kvList } from '../db.js';
import { getProjectConfig } from '../services/projects.js';
import { endChat, externalSessionMessages, getSession, isChatLive, listExternalSessions, listMessages, listSessions, resumeSessionAsChat, sendChatMessage, startChat } from '../services/sessions.js';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sessions', async (req) => {
    const q = req.query as { includeBridge?: string; runId?: string; cardId?: string; limit?: string };
    return listSessions({ includeBridge: q.includeBridge === '1', runId: q.runId, cardId: q.cardId, limit: Number(q.limit || 100) }).map((s) => ({ ...s, live: isChatLive(s.id) }));
  });

  app.get('/api/sessions/external', async (req) => {
    const q = req.query as { dir?: string; limit?: string };
    return listExternalSessions({ dir: q.dir || undefined, limit: Number(q.limit || 40) });
  });
  app.get('/api/sessions/external/:id/messages', async (req) => {
    const q = req.query as { dir?: string };
    return externalSessionMessages((req.params as { id: string }).id, q.dir || undefined);
  });

  app.post('/api/sessions/chat', async (req, reply) => {
    const body = z
      .object({
        prompt: z.string().min(1),
        title: z.string().optional(),
        model: z.string().nullable().optional(),
        projectId: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        resume: z.string().nullable().optional(),
        cardId: z.string().nullable().optional(),
      })
      .parse(req.body);
    const project = body.projectId ? getProjectConfig(body.projectId) : undefined;
    const cwd = body.cwd || project?.path;
    if (!cwd || !fs.existsSync(cwd)) return reply.code(400).send({ error: 'Pick a project or an existing folder for the session' });
    const title = body.title?.trim() || body.prompt.slice(0, 60);
    return startChat({ cwd, title, prompt: body.prompt, model: body.model ?? null, resume: body.resume ?? null, projectPath: project?.path ?? null, cardId: body.cardId ?? null });
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: 'Unknown session' });
    const q = req.query as { after?: string };
    return { session: { ...session, live: isChatLive(id) }, messages: listMessages(id, Number(q.after || 0)) };
  });
  app.get('/api/sessions/:id/messages', async (req) => {
    const q = req.query as { after?: string };
    return listMessages((req.params as { id: string }).id, Number(q.after || 0));
  });
  app.post('/api/sessions/:id/send', async (req) => {
    const body = z.object({ text: z.string().min(1).max(20000) }).parse(req.body);
    return sendChatMessage((req.params as { id: string }).id, body.text);
  });
  app.post('/api/sessions/:id/end', async (req) => ({ ended: endChat((req.params as { id: string }).id) }));
  app.post('/api/sessions/:id/resume', async (req) => {
    const body = (req.body as { prompt?: string } | undefined) ?? {};
    return resumeSessionAsChat((req.params as { id: string }).id, body.prompt);
  });

  app.get('/api/usage', async (): Promise<UsageReport> => buildUsageReport());
}

function period(label: string, sinceIso: string | null): UsagePeriod {
  const db = getDb();
  const where = sinceIso ? 'WHERE started_at >= ?' : '';
  const args = sinceIso ? [sinceIso] : [];
  const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS out, COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw FROM sessions ${where}`).get(...(args as any[])) as any;
  const kinds = db.prepare(`SELECT kind, COUNT(*) AS n, COALESCE(SUM(cost_usd),0) AS cost FROM sessions ${where} GROUP BY kind`).all(...(args as any[])) as any[];
  return {
    label,
    sessions: Number(totals.n),
    costUsd: Number(totals.cost),
    inputTokens: Number(totals.inp),
    outputTokens: Number(totals.out),
    cacheReadTokens: Number(totals.cr),
    cacheWriteTokens: Number(totals.cw),
    byKind: Object.fromEntries(kinds.map((k) => [k.kind, { sessions: Number(k.n), costUsd: Number(k.cost) }])),
  };
}

export function buildUsageReport(): UsageReport {
  const db = getDb();
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const d7 = new Date(now - 7 * 864e5).toISOString();
  const d30 = new Date(now - 30 * 864e5).toISOString();
  const rateLimits = kvList<any>('claude:ratelimit:').map(({ value }) => ({
    type: String(value.rateLimitType || 'unknown'),
    status: String(value.status || 'unknown'),
    utilization: typeof value.utilization === 'number' ? value.utilization : null,
    resetsAt: value.resetsAt ? new Date(Number(value.resetsAt) * (Number(value.resetsAt) < 1e12 ? 1000 : 1)).toISOString() : null,
    observedAt: String(value.observedAt || ''),
  }));
  const ingests = kvList<any>('fathom:');
  const ingestDates = ingests.map(({ value }) => (typeof value === 'object' && value?.at ? String(value.at) : null)).filter((x): x is string => !!x).sort();
  const bridge = db.prepare("SELECT title, COUNT(*) AS n FROM sessions WHERE kind = 'bridge' AND started_at >= ? GROUP BY title").all(d7) as any[];
  const bridgeCalls: Record<string, number> = {};
  for (const b of bridge) {
    const group = /Atlassian/i.test(b.title) ? 'Jira (Atlassian connector)' : /Fathom/i.test(b.title) ? 'Fathom connector' : String(b.title).split('__')[2] || b.title;
    bridgeCalls[group] = (bridgeCalls[group] || 0) + Number(b.n);
  }
  const runs = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS recent, COALESCE(AVG(cost_usd),0) AS avg FROM runs").get(d7) as any;
  return {
    generatedAt: new Date().toISOString(),
    claude: { account: kvGet('claude:account', null), rateLimits },
    periods: [period('today', dayStart.toISOString()), period('last 7 days', d7), period('last 30 days', d30), period('all time', null)],
    integrations: {
      fathomIngested: ingests.length,
      fathomIngestedLast7Days: ingestDates.filter((d) => d >= d7).length,
      lastFathomIngest: ingestDates.length ? ingestDates[ingestDates.length - 1] : null,
      jiraSyncs: kvGet<number>('jira:syncs', 0),
      jiraLastSync: kvGet<string | null>('jira:lastSync', null),
      bridgeCallsLast7Days: bridgeCalls,
    },
    runs: { total: Number(runs.total || 0), succeeded: Number(runs.ok || 0), failed: Number(runs.failed || 0), last7Days: Number(runs.recent || 0), avgCostUsd: Number(runs.avg || 0) },
  };
}
