import fs from 'node:fs';
import path from 'node:path';
import type { WorktreeInfo } from '@sf/shared';
import { git } from './shell.js';

/** Worktrees always live inside the repo's local .claude folder, matching Claude Code's own convention. */
export const worktreeRoot = (repo: string): string => path.join(repo, '.claude', 'worktrees');

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const res = await git(repo, ['worktree', 'list', '--porcelain']);
  if (res.code !== 0) return [];
  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> | null = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur?.path) out.push(finish(cur));
      cur = { path: line.slice(9).trim(), branch: null, head: null };
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
  }
  if (cur?.path) out.push(finish(cur));
  return out.map((w, i) => ({ ...w, isMain: i === 0 }));
  function finish(c: Partial<WorktreeInfo>): WorktreeInfo {
    return { path: c.path!, branch: c.branch ?? null, head: c.head ?? null, isMain: false };
  }
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Makes sure git ignores the local worktree folder (Claude Code does the same via .git/info/exclude). */
export function ensureWorktreeExclude(repo: string): void {
  try {
    const excludePath = path.join(repo, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(excludePath))) return; // not a primary checkout (could itself be a worktree)
    const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (!/^\.claude\/worktrees\/?$/m.test(current)) fs.appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}.claude/worktrees/\n`);
  } catch {
    /* best effort */
  }
}

export interface CreateWorktreeResult {
  ok: boolean;
  path: string;
  branch: string;
  message: string;
  created: boolean;
}

/**
 * Creates (or reuses) a worktree at <repo>/.claude/worktrees/<name> on branch <branch>, based on origin/<base> when it exists.
 */
export async function createWorktree(repo: string, name: string, branch: string, base: string): Promise<CreateWorktreeResult> {
  const dir = path.join(worktreeRoot(repo), slugify(name));
  ensureWorktreeExclude(repo);
  fs.mkdirSync(worktreeRoot(repo), { recursive: true });

  const existing = (await listWorktrees(repo)).find((w) => path.resolve(w.path) === path.resolve(dir));
  if (existing) return { ok: true, path: dir, branch: existing.branch || branch, message: `Reusing existing worktree ${dir}`, created: false };

  // Refresh the base branch; tolerate offline.
  await git(repo, ['fetch', 'origin', base], 60_000);
  const remoteBase = (await git(repo, ['rev-parse', '--verify', '--quiet', `origin/${base}`])).code === 0 ? `origin/${base}` : base;
  const branchExists = (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;

  const args = branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, remoteBase];
  const res = await git(repo, args, 180_000);
  if (res.code !== 0) return { ok: false, path: dir, branch, message: res.stderr.trim() || res.stdout.trim(), created: false };
  return { ok: true, path: dir, branch, message: `Created worktree ${dir} (${branch} from ${remoteBase})`, created: true };
}

export async function removeWorktree(repo: string, dir: string, force = false): Promise<{ ok: boolean; message: string }> {
  const res = await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  if (res.code !== 0) return { ok: false, message: res.stderr.trim() };
  await git(repo, ['worktree', 'prune']);
  return { ok: true, message: `Removed ${dir}` };
}

export async function worktreeStatus(dir: string): Promise<{ branch: string | null; dirty: boolean; ahead: number; behind: number; lastCommit: string | null }> {
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null;
  const status = await git(dir, ['status', '--porcelain']);
  const dirty = status.stdout.trim().length > 0;
  let ahead = 0;
  let behind = 0;
  const ab = await git(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (ab.code === 0) {
    const [b, a] = ab.stdout.trim().split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  }
  const last = await git(dir, ['log', '-1', '--pretty=%h %s']);
  return { branch, dirty, ahead, behind, lastCommit: last.code === 0 ? last.stdout.trim() : null };
}
