import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import YAML from 'yaml';
import { CONFIG_PATH } from '../config.js';
import { getProjectConfig, listProjects, loadConfig, saveConfig } from '../services/projects.js';
import { openInVsCode } from '../services/vscode.js';
import { createWorktree, listWorktrees, removeWorktree, worktreeStatus } from '../services/worktrees.js';
import { hub } from '../events.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => listProjects());

  app.get('/api/config', async () => loadConfig());
  app.put('/api/config', async (req) => {
    const body = req.body as ReturnType<typeof loadConfig>;
    saveConfig(body);
    hub.broadcast({ type: 'projects.changed' });
    return loadConfig();
  });

  app.get('/api/config/raw', async () => {
    loadConfig();
    return { path: CONFIG_PATH, content: fs.readFileSync(CONFIG_PATH, 'utf8') };
  });
  app.put('/api/config/raw', async (req) => {
    const { content } = z.object({ content: z.string().min(2) }).parse(req.body);
    const parsed = YAML.parse(content);
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('config must contain a projects list');
    saveConfig(parsed);
    hub.broadcast({ type: 'projects.changed' });
    return { ok: true };
  });

  app.post('/api/projects/:id/open', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProjectConfig(id);
    if (!p) return reply.code(404).send({ error: 'Unknown project' });
    const body = (req.body as { path?: string } | undefined) ?? {};
    return openInVsCode(body.path || p.path);
  });

  app.post('/api/open', async (req) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
    return openInVsCode(path);
  });

  app.get('/api/projects/:id/worktrees', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProjectConfig(id);
    if (!p) return reply.code(404).send({ error: 'Unknown project' });
    const list = await listWorktrees(p.path);
    return Promise.all(list.map(async (w) => ({ ...w, status: w.isMain ? null : await worktreeStatus(w.path).catch(() => null) })));
  });

  app.post('/api/projects/:id/worktrees', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProjectConfig(id);
    if (!p) return reply.code(404).send({ error: 'Unknown project' });
    const body = z.object({ name: z.string().min(1), branch: z.string().min(1), base: z.string().min(1) }).parse(req.body);
    const res = await createWorktree(p.path, body.name, body.branch, body.base);
    hub.broadcast({ type: 'projects.changed' });
    return res;
  });

  app.delete('/api/projects/:id/worktrees', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProjectConfig(id);
    if (!p) return reply.code(404).send({ error: 'Unknown project' });
    const body = z.object({ path: z.string().min(1), force: z.boolean().optional() }).parse(req.body);
    const res = await removeWorktree(p.path, body.path, body.force);
    hub.broadcast({ type: 'projects.changed' });
    return res;
  });
}
