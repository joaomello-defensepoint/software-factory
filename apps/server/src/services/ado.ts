import { env } from '../config.js';
import { run, git } from './shell.js';
import type { ProjectConfig } from './projects.js';

/** Azure DevOps via the az CLI (`az login --allow-no-subscriptions`; azure-devops extension). */

export const ADO_DEFAULT_ORG = 'https://dev.azure.com/IndySoft';
export const adoOrgUrl = (): string => env.ado.orgUrl || ADO_DEFAULT_ORG;

export async function adoLoggedIn(): Promise<boolean> {
  const res = await run('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '-o', 'json'], { timeoutMs: 30_000 });
  return res.code === 0;
}

export interface PullRequestInfo {
  id: number;
  url: string;
  title: string;
  status: string;
  isDraft: boolean;
  mergeStatus: string | null;
  sourceBranch: string;
  targetBranch: string;
  reviewers: Array<{ name: string; vote: number }>;
}

function mapPr(raw: any, project: string, repo: string): PullRequestInfo {
  const id = Number(raw.pullRequestId);
  return {
    id,
    url: `${adoOrgUrl()}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`,
    title: raw.title || '',
    status: raw.status || '',
    isDraft: !!raw.isDraft,
    mergeStatus: raw.mergeStatus || null,
    sourceBranch: String(raw.sourceRefName || '').replace('refs/heads/', ''),
    targetBranch: String(raw.targetRefName || '').replace('refs/heads/', ''),
    reviewers: (raw.reviewers || []).map((r: any) => ({ name: r.displayName || r.uniqueName || '', vote: Number(r.vote || 0) })),
  };
}

function parseJson(stdout: string): any {
  const cleaned = stdout.replace(/^﻿/, '').trim();
  return cleaned ? JSON.parse(cleaned) : null;
}

export async function findActivePr(p: ProjectConfig, sourceBranch: string): Promise<PullRequestInfo | null> {
  if (!p.ado) return null;
  const res = await run('az', ['repos', 'pr', 'list', '--organization', adoOrgUrl(), '--project', p.ado.project, '--repository', p.ado.repo, '--source-branch', sourceBranch, '--status', 'active', '-o', 'json'], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'az repos pr list failed');
  const list = parseJson(res.stdout) || [];
  return list.length ? mapPr(list[0], p.ado.project, p.ado.repo) : null;
}

export async function getPr(p: ProjectConfig, id: number): Promise<PullRequestInfo> {
  if (!p.ado) throw new Error('Project has no ADO mapping');
  const res = await run('az', ['repos', 'pr', 'show', '--organization', adoOrgUrl(), '--id', String(id), '-o', 'json'], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'az repos pr show failed');
  return mapPr(parseJson(res.stdout), p.ado.project, p.ado.repo);
}

export interface CreatePrInput {
  worktree: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  draft: boolean;
}

export async function pushBranch(worktree: string, branch: string): Promise<void> {
  const res = await git(worktree, ['push', '-u', 'origin', branch], 300_000);
  if (res.code !== 0) throw new Error(`git push failed: ${res.stderr.trim()}`);
}

export async function createPr(p: ProjectConfig, input: CreatePrInput): Promise<PullRequestInfo> {
  if (!p.ado) throw new Error('Project has no ADO mapping');
  await pushBranch(input.worktree, input.sourceBranch);
  const existing = await findActivePr(p, input.sourceBranch);
  if (existing) return existing;
  const args = [
    'repos', 'pr', 'create',
    '--organization', adoOrgUrl(),
    '--project', p.ado.project,
    '--repository', p.ado.repo,
    '--source-branch', input.sourceBranch,
    '--target-branch', input.targetBranch,
    '--title', input.title.slice(0, 250),
    '--description', input.description.slice(0, 4000),
    '--draft', input.draft ? 'true' : 'false',
    '-o', 'json',
  ];
  const res = await run('az', args, { timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'az repos pr create failed');
  return mapPr(parseJson(res.stdout), p.ado.project, p.ado.repo);
}
