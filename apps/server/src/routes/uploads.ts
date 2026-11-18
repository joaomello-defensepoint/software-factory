import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { UPLOADS_DIR } from '../config.js';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' };

/** Files dropped or pasted into a chat land in ~/.claude/software-factory/uploads; the agent reads them by path. */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/uploads', { bodyLimit: 40 * 1024 * 1024 }, async (req) => {
    const body = z.object({ name: z.string().min(1).max(200), dataBase64: z.string().min(1) }).parse(req.body);
    const safe = body.name.replace(/[^\w.-]+/g, '_').replace(/^_+/, '') || 'file';
    const ext = path.extname(safe).toLowerCase() || '.bin';
    const file = `${new Date().toISOString().slice(0, 10)}-${nanoid(6)}-${safe.endsWith(ext) ? safe : `${safe}${ext}`}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const full = path.join(UPLOADS_DIR, file);
    fs.writeFileSync(full, Buffer.from(body.dataBase64, 'base64'));
    return { path: full, url: `/api/uploads/${encodeURIComponent(file)}`, name: safe, size: fs.statSync(full).size };
  });

  app.get('/api/uploads/:file', async (req, reply) => {
    const file = path.basename((req.params as { file: string }).file);
    const full = path.join(UPLOADS_DIR, file);
    if (!fs.existsSync(full)) return reply.code(404).send({ error: 'Not found' });
    return reply.type(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream').send(fs.createReadStream(full));
  });
}
