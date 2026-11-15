import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { WorkflowDefinition, WorkflowRole, WorkflowStep } from '@sf/shared';
import { WORKFLOWS_DIR, ensureDirs } from '../../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.resolve(here, '..', '..', '..', 'templates', 'workflows');

/** Copies the bundled default workflows into ~/.claude/software-factory/workflows when they are missing. */
export function seedDefaultWorkflows(): void {
  ensureDirs();
  if (!fs.existsSync(TEMPLATES_DIR)) return;
  for (const name of fs.readdirSync(TEMPLATES_DIR)) {
    const src = path.join(TEMPLATES_DIR, name);
    const dst = path.join(WORKFLOWS_DIR, name);
    if (!fs.statSync(src).isDirectory() || fs.existsSync(dst)) continue;
    fs.cpSync(src, dst, { recursive: true });
  }
}

function parseFrontmatter(md: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { data: {}, body: md };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { data, body: m[2] };
}

export function loadRole(file: string): WorkflowRole {
  const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const id = data.name || path.basename(file, '.md');
  return {
    id,
    name: data.name ? data.name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : id,
    model: data.model || null,
    tools: data.tools ? data.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
    prompt: body.trim(),
    file,
  };
}

export function loadWorkflow(dir: string): WorkflowDefinition {
  const yamlPath = path.join(dir, 'workflow.yaml');
  const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf8')) || {};
  const rolesDir = path.join(dir, 'roles');
  const roles: WorkflowRole[] = fs.existsSync(rolesDir)
    ? fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md')).map((f) => loadRole(path.join(rolesDir, f)))
    : [];
  const steps: WorkflowStep[] = (raw.steps || []).map((s: any) => ({
    id: String(s.id),
    name: s.name || s.id,
    kind: s.kind || 'agent',
    roles: s.roles || [],
    prompt: s.prompt || '',
    rounds: s.rounds,
    outcomes: s.outcomes,
    maxTurns: s.maxTurns,
    resumeSession: !!s.resumeSession,
    command: s.command,
  }));
  return {
    id: raw.id || path.basename(dir),
    name: raw.name || path.basename(dir),
    description: raw.description || '',
    version: Number(raw.version || 1),
    defaultModel: raw.defaultModel || 'opus',
    maxIterations: Number(raw.maxIterations || 3),
    roles,
    steps,
    dir,
  };
}

export function listWorkflows(): WorkflowDefinition[] {
  seedDefaultWorkflows();
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  const out: WorkflowDefinition[] = [];
  for (const name of fs.readdirSync(WORKFLOWS_DIR)) {
    const dir = path.join(WORKFLOWS_DIR, name);
    if (!fs.existsSync(path.join(dir, 'workflow.yaml'))) continue;
    try {
      out.push(loadWorkflow(dir));
    } catch (e) {
      out.push({ id: name, name: `${name} (invalid: ${String((e as Error).message)})`, description: '', version: 0, defaultModel: 'opus', maxIterations: 0, roles: [], steps: [], dir });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return listWorkflows().find((w) => w.id === id);
}

export interface WorkflowFile {
  path: string;
  content: string;
}

const safeJoin = (dir: string, rel: string): string => {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(dir + path.sep)) throw new Error('Invalid path');
  return full;
};

export function listWorkflowFiles(id: string): WorkflowFile[] {
  const dir = path.join(WORKFLOWS_DIR, id);
  if (!fs.existsSync(dir)) throw new Error(`Unknown workflow ${id}`);
  const files: WorkflowFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ya?ml|md)$/.test(e.name)) files.push({ path: path.relative(dir, full), content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return files.sort((a, b) => (a.path === 'workflow.yaml' ? -1 : b.path === 'workflow.yaml' ? 1 : a.path.localeCompare(b.path)));
}

export function saveWorkflowFile(id: string, rel: string, content: string): void {
  const dir = path.join(WORKFLOWS_DIR, id);
  if (!fs.existsSync(dir)) throw new Error(`Unknown workflow ${id}`);
  if (!/\.(ya?ml|md)$/.test(rel)) throw new Error('Only .yaml and .md files can be edited');
  const full = safeJoin(dir, rel);
  if (rel === 'workflow.yaml') YAML.parse(content); // validate before writing
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

export function deleteWorkflowFile(id: string, rel: string): void {
  const dir = path.join(WORKFLOWS_DIR, id);
  const full = safeJoin(dir, rel);
  if (rel === 'workflow.yaml') throw new Error('workflow.yaml cannot be deleted');
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

export function duplicateWorkflow(sourceId: string, newId: string, newName: string): WorkflowDefinition {
  const src = path.join(WORKFLOWS_DIR, sourceId);
  const dst = path.join(WORKFLOWS_DIR, newId);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(newId)) throw new Error('Workflow id must be kebab-case (a-z, 0-9, -)');
  if (!fs.existsSync(src)) throw new Error(`Unknown workflow ${sourceId}`);
  if (fs.existsSync(dst)) throw new Error(`Workflow ${newId} already exists`);
  fs.cpSync(src, dst, { recursive: true });
  const yamlPath = path.join(dst, 'workflow.yaml');
  const raw = YAML.parse(fs.readFileSync(yamlPath, 'utf8')) || {};
  raw.id = newId;
  raw.name = newName;
  fs.writeFileSync(yamlPath, YAML.stringify(raw), 'utf8');
  return loadWorkflow(dst);
}

export function deleteWorkflow(id: string): void {
  const dir = path.join(WORKFLOWS_DIR, id);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
